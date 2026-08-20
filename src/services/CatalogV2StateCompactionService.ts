import { normalizePath, TFile } from "obsidian";
import type { App } from "obsidian";

import type { ArtifactRef, ParsedStateSegment, StateOperationEnvelope } from "../types/catalogV2";
import { ensureFolder, getParentFolderPath } from "../utils/vault";
import {
	buildStateCompactionCommit,
	buildStateSnapshot,
	canonicalJson,
	sha256Bytes,
	sha256Text,
} from "./CatalogV2Protocol";
import { CatalogV2StateReducer } from "./CatalogV2StateReducer";
import type { CatalogV2CommittedStateSnapshot } from "./CatalogV2StateTransport";
import { CatalogV2StateTransport } from "./CatalogV2StateTransport";
import type { IndexedDbCatalogV2StateStore } from "./IndexedDbCatalogV2StateStore";

const DEFAULT_SEALED_SEGMENT_THRESHOLD = 32;
const DEFAULT_SEALED_BYTE_THRESHOLD = 16 * 1024 * 1024;
const DEFAULT_QUIET_WINDOW_MS = 24 * 60 * 60 * 1000;
const CANONICAL_SEGMENT_PATH = /\/segment-\d{6}\.jsonl$/u;

export interface CatalogV2StateCompactionOptions {
	sealedSegmentThreshold?: number;
	sealedByteThreshold?: number;
	quietWindowMs?: number;
	now?: () => number;
}

export interface CatalogV2StateCompactionResult {
	createdSnapshots: number;
	retiredSegments: number;
}

export class CatalogV2StateCompactionService {
	private readonly sealedSegmentThreshold: number;
	private readonly sealedByteThreshold: number;
	private readonly quietWindowMs: number;
	private readonly now: () => number;
	private readonly sharedCompactionEnabled: boolean = false;

	constructor(
		private readonly app: App,
		private readonly catalogDataRoot: string,
		private readonly store: IndexedDbCatalogV2StateStore,
		options: CatalogV2StateCompactionOptions = {},
	) {
		this.sealedSegmentThreshold = positiveInteger(options.sealedSegmentThreshold, DEFAULT_SEALED_SEGMENT_THRESHOLD);
		this.sealedByteThreshold = positiveInteger(options.sealedByteThreshold, DEFAULT_SEALED_BYTE_THRESHOLD);
		this.quietWindowMs = Math.max(0, Math.trunc(options.quietWindowMs ?? DEFAULT_QUIET_WINDOW_MS));
		this.now = options.now ?? Date.now;
	}

	async maintain(): Promise<CatalogV2StateCompactionResult> {
		// 阶段 0：旧 compaction 同时会写 snapshot/commit 并物理删除 segment。
		// 在 protocol-v2 generation 提供跨设备 GC 安全点前，整个共享 compaction 通道保持关闭。
		if (!this.sharedCompactionEnabled) return { createdSnapshots: 0, retiredSegments: 0 };
		if (this.store.isFallbackActive()) return { createdSnapshots: 0, retiredSegments: 0 };
		const transport = new CatalogV2StateTransport(this.app, this.catalogDataRoot);
		const invalidPaths: string[] = [];
		const segmentFiles = transport.listSegmentFiles();
		const commitValues = await transport.listCompactionCommits((path) => invalidPaths.push(path));
		if (invalidPaths.length > 0) return { createdSnapshots: 0, retiredSegments: 0 };
		const availablePaths = new Set(segmentFiles.map((file) => file.path));
		const hasRetirementCandidate = commitValues.some(({ commit }) =>
			commit.coveredSegments.every((segment) => availablePaths.has(this.absolutePath(segment.path))));
		const writers = unique(segmentFiles.map((file) => writerIdFromPath(file.path)).filter(Boolean));
		const hasBuildCandidate = writers.some((sourceWriterId) => {
			const canonical = segmentFiles
				.filter((file) => writerIdFromPath(file.path) === sourceWriterId && CANONICAL_SEGMENT_PATH.test(file.path))
				.sort((left, right) => left.path.localeCompare(right.path));
			const sealed = canonical.slice(0, -1);
			return sealed.length >= this.sealedSegmentThreshold
				|| sum(sealed, (file) => file.stat.size) >= this.sealedByteThreshold;
		});
		if (!hasRetirementCandidate && !hasBuildCandidate) return { createdSnapshots: 0, retiredSegments: 0 };
		const rawSegments = await transport.readSegments([], true, (path) => invalidPaths.push(path));
		if (invalidPaths.length > 0) return { createdSnapshots: 0, retiredSegments: 0 };
		const inputSet = await transport.prepareInputSet((path) => invalidPaths.push(path));
		const effectiveSegments = await transport.readInputSet(inputSet, [], true, (path) => invalidPaths.push(path));
		if (invalidPaths.length > 0) return { createdSnapshots: 0, retiredSegments: 0 };
		const committed = await transport.listCommittedSnapshots((path) => invalidPaths.push(path));
		if (invalidPaths.length > 0) return { createdSnapshots: 0, retiredSegments: 0 };
		const writerId = await this.store.getOrCreateWriterId();
		let createdSnapshots = 0;
		let retiredSegments = 0;
		for (const sourceWriterId of unique(rawSegments.map((segment) => segment.writerId))) {
			if (sourceWriterId.length === 0 || hasWriterConflict(rawSegments, sourceWriterId)) continue;
			const canonical = rawSegments
				.filter((segment) => segment.writerId === sourceWriterId && CANONICAL_SEGMENT_PATH.test(segment.path))
				.sort((left, right) => left.firstSequence - right.firstSequence || left.path.localeCompare(right.path));
			if (canonical.length < 2) continue;
			const active = canonical[canonical.length - 1];
			if (active === undefined) continue;
			const sealed = canonical.slice(0, -1);
			let candidate = latestCommittedSnapshot(committed, sourceWriterId);
			const baseLastSequence = candidate?.snapshot.lastSequence ?? 0;
			const newSealed = sealed.filter((segment) => segment.lastSequence > baseLastSequence);
			const shouldCreate = newSealed.length >= this.sealedSegmentThreshold
				|| sum(newSealed, (segment) => segment.byteLength) >= this.sealedByteThreshold;
			if (shouldCreate) {
				candidate = await this.createSnapshotCandidate(
					sourceWriterId,
					writerId,
					candidate,
					newSealed,
				);
				if (candidate !== null) createdSnapshots += 1;
			}
			if (candidate === null || candidate === undefined) continue;
			retiredSegments += await this.verifyAndRetire(candidate, effectiveSegments, active.path);
		}
		return { createdSnapshots, retiredSegments };
	}

	private async createSnapshotCandidate(
		sourceWriterId: string,
		committingWriterId: string,
		base: CatalogV2CommittedStateSnapshot | null,
		newSegments: readonly ParsedStateSegment[],
	): Promise<CatalogV2CommittedStateSnapshot | null> {
		const operations = [
			...(base?.snapshot.operations ?? []),
			...newSegments.flatMap((segment) => segment.operations.map((item) => item.operation)),
		];
		const coveredSegments = [
			...(base?.snapshot.coveredSegments ?? []),
			...newSegments.map(toArtifactRef),
		];
		if (operations.length === 0 || coveredSegments.length === 0) return null;
		let builtSnapshot;
		try {
			builtSnapshot = await buildStateSnapshot({ sourceWriterId, coveredSegments, operations });
		} catch {
			return null;
		}
		await this.writeImmutable(builtSnapshot.path, builtSnapshot.bytes);
		const snapshotRef: ArtifactRef = {
			path: builtSnapshot.path,
			sha256: builtSnapshot.digest,
			byteLength: builtSnapshot.bytes.byteLength,
		};
		const commit = await buildStateCompactionCommit({
			snapshot: snapshotRef,
			snapshotValue: builtSnapshot.snapshot,
			committingWriterId,
			committedAt: new Date(this.now()).toISOString(),
		});
		await this.writeImmutable(commit.path, commit.bytes);
		const snapshotFile = this.getFile(builtSnapshot.path);
		const commitFile = this.getFile(commit.path);
		return { snapshotFile, commitFile, snapshot: builtSnapshot.snapshot, commit: commit.commit };
	}

	private async verifyAndRetire(
		candidate: CatalogV2CommittedStateSnapshot,
		effectiveSegments: readonly ParsedStateSegment[],
		activePath: string,
	): Promise<number> {
		const coveredPaths = new Set(candidate.snapshot.coveredSegments.map((segment) => this.absolutePath(segment.path)));
		if (coveredPaths.has(activePath)) return 0;
		const coveredFiles: Array<{ file: TFile; reference: ArtifactRef }> = [];
		for (const reference of candidate.snapshot.coveredSegments) {
			const path = this.absolutePath(reference.path);
			if (!CANONICAL_SEGMENT_PATH.test(path)) return 0;
			const file = this.app.vault.getAbstractFileByPath(path);
			if (!(file instanceof TFile)) return 0;
			coveredFiles.push({ file, reference });
		}
		const inputSignature = await sha256Text(canonicalJson(
			coveredFiles.map(({ file, reference }) => ({ path: file.path, mtime: file.stat.mtime, size: file.stat.size, sha256: reference.sha256 })),
		));
		const recovered = await new CatalogV2StateReducer().reduce([
			...effectiveSegments.flatMap((segment) => segment.operations).filter((item) => !coveredPaths.has(item.sourcePath)),
			...snapshotEnvelopes(candidate),
		]);
		const current = await new CatalogV2StateReducer().reduce(effectiveSegments.flatMap((segment) => segment.operations));
		if (canonicalJson(recovered) !== canonicalJson(current)) return 0;
		const verification = await this.store.loadCompactionVerification(candidate.snapshot.sourceWriterId);
		if (verification === null || verification.snapshotSha256 !== candidate.commit.snapshot.sha256
			|| verification.inputSignature !== inputSignature) {
			await this.store.saveCompactionVerification(candidate.snapshot.sourceWriterId, {
				snapshotSha256: candidate.commit.snapshot.sha256,
				inputSignature,
				verifiedAt: this.now(),
			});
			return 0;
		}
		if (this.now() - verification.verifiedAt < this.quietWindowMs) return 0;
		for (const { file, reference } of coveredFiles) {
			const bytes = new Uint8Array(await this.app.vault.readBinary(file));
			if (bytes.byteLength !== reference.byteLength || await sha256Bytes(bytes) !== reference.sha256) return 0;
		}
		let retired = 0;
		for (const { file } of coveredFiles) {
			await this.app.fileManager.trashFile(file);
			retired += 1;
		}
		return retired;
	}

	private async writeImmutable(relativePath: string, bytes: Uint8Array): Promise<void> {
		const path = this.absolutePath(relativePath);
		const existing = this.app.vault.getAbstractFileByPath(path);
		if (existing instanceof TFile) {
			const current = new Uint8Array(await this.app.vault.readBinary(existing));
			if (!equalBytes(current, bytes)) throw new Error(`Immutable state artifact mismatch: ${relativePath}`);
			return;
		}
		if (existing !== null) throw new Error(`State artifact path is not a file: ${relativePath}`);
		const parent = getParentFolderPath(path);
		if (parent !== null) await ensureFolder(this.app, parent);
		const created = await this.app.vault.create(path, new TextDecoder("utf-8", { fatal: true }).decode(bytes));
		const stored = new Uint8Array(await this.app.vault.readBinary(created));
		if (!equalBytes(stored, bytes)) throw new Error(`State artifact verification failed: ${relativePath}`);
	}

	private getFile(relativePath: string): TFile {
		const file = this.app.vault.getAbstractFileByPath(this.absolutePath(relativePath));
		if (!(file instanceof TFile)) throw new Error(`State artifact is missing: ${relativePath}`);
		return file;
	}

	private absolutePath(path: string): string {
		const normalized = normalizePath(path);
		const root = normalizePath(this.catalogDataRoot).replace(/\/$/u, "");
		return normalized.startsWith(`${root}/`) ? normalized : normalizePath(`${root}/${normalized}`);
	}
}

function latestCommittedSnapshot(
	values: readonly CatalogV2CommittedStateSnapshot[],
	writerId: string,
): CatalogV2CommittedStateSnapshot | null {
	return values.filter((value) => value.snapshot.sourceWriterId === writerId)
		.sort((left, right) => right.snapshot.lastSequence - left.snapshot.lastSequence
			|| left.commit.snapshot.sha256.localeCompare(right.commit.snapshot.sha256))[0] ?? null;
}

function snapshotEnvelopes(candidate: CatalogV2CommittedStateSnapshot): StateOperationEnvelope[] {
	const digestByOpId = new Map(candidate.snapshot.operationDigests.map((item) => [item.opId, item.sha256]));
	return candidate.snapshot.operations.map((operation) => ({
		operation,
		digest: digestByOpId.get(operation.opId) ?? "",
		sourcePath: candidate.snapshotFile.path,
	}));
}

function toArtifactRef(segment: ParsedStateSegment): ArtifactRef {
	return { path: segment.path, sha256: segment.sha256, byteLength: segment.byteLength };
}

function hasWriterConflict(segments: readonly ParsedStateSegment[], writerId: string): boolean {
	return segments.some((segment) => segment.writerId === writerId && !CANONICAL_SEGMENT_PATH.test(segment.path));
}

function writerIdFromPath(path: string): string {
	return path.split("/").find((part) => /^w_[a-f0-9]{32}$/u.test(part)) ?? "";
}

function unique(values: readonly string[]): string[] {
	return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function sum<T>(values: readonly T[], read: (value: T) => number): number {
	return values.reduce((total, value) => total + read(value), 0);
}

function positiveInteger(value: number | undefined, fallback: number): number {
	return value === undefined || !Number.isInteger(value) || value < 1 ? fallback : value;
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
	return left.byteLength === right.byteLength && left.every((value, index) => value === right[index]);
}
