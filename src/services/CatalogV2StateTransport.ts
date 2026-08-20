import { normalizePath, TFile, TFolder, Vault } from "obsidian";
import type { App } from "obsidian";

import type {
	ArtifactRef,
	ParsedStateSegment,
	StateCompactionCommit,
	StateOperation,
	StateSegmentCheckpoint,
	StateSnapshot,
} from "../types/catalogV2";
import {
	getCatalogDevicePath,
	getCatalogDevicesRootPath,
	getCatalogStateCheckpointPath,
	getCatalogStateCheckpointsRootPath,
	getCatalogStateSegmentPath,
} from "../utils/path";
import { isLikelySyncConflictPath } from "../utils/syncConflict";
import { ensureTextFile } from "../utils/vault";
import {
	assertStateOperation,
	canonicalJson,
	parseStateCompactionCommit,
	parseStateSegment,
	parseStateSnapshot,
	planStateSegmentAppend,
	sha256Bytes,
} from "./CatalogV2Protocol";

const CANONICAL_SEGMENT_PATTERN = /^segment-(\d{6})\.jsonl$/;
const CONFLICT_SEGMENT_PATTERN = /^segment-(\d{6}).+\.jsonl$/;
const COMPACTION_COMMIT_PATTERN = /^commit-[a-f0-9]{64}-w_[a-f0-9]{32}\.json$/;

export interface CatalogV2CommittedStateSnapshot {
	snapshotFile: TFile;
	commitFile: TFile;
	snapshot: StateSnapshot;
	commit: StateCompactionCommit;
}

export interface CatalogV2StateInputSet {
	files: TFile[];
	snapshotsByPath: ReadonlyMap<string, { reference: ArtifactRef; commit: StateCompactionCommit }>;
}

export class CatalogV2StateTransport {
	constructor(
		private readonly app: App,
		private readonly catalogDataRoot: string,
	) {}

	listSegmentFiles(): TFile[] {
		const folderPath = getCatalogDevicesRootPath(this.catalogDataRoot);
		const folder = this.app.vault.getAbstractFileByPath(folderPath);
		if (!(folder instanceof TFolder)) return [];
		const files: TFile[] = [];
		Vault.recurseChildren(folder, (entry) => {
			if (!(entry instanceof TFile) || !isStateSegmentPath(folderPath, entry.path)) return;
			files.push(entry);
		});
		return files.sort((left, right) => left.path.localeCompare(right.path));
	}

	async readSegments(
		checkpoints: readonly StateSegmentCheckpoint[] = [],
		verifyUnchanged = false,
		onInvalid?: (path: string, error: unknown) => void,
	): Promise<ParsedStateSegment[]> {
		return this.readInputFiles({ files: this.listSegmentFiles(), snapshotsByPath: new Map() }, checkpoints, verifyUnchanged, onInvalid);
	}

	async prepareInputSet(onInvalid?: (path: string, error: unknown) => void): Promise<CatalogV2StateInputSet> {
		const segmentFiles = this.listSegmentFiles();
		const availablePaths = new Set(segmentFiles.map((file) => file.path));
		const commits = await this.listCompactionCommits(onInvalid);
		const selectedByWriter = new Map<string, { commitFile: TFile; commit: StateCompactionCommit }>();
		for (const candidate of commits) {
			if (candidate.commit.coveredSegments.every((segment) => availablePaths.has(this.absoluteArtifactPath(segment.path)))) continue;
			const snapshotPath = this.absoluteArtifactPath(candidate.commit.snapshot.path);
			if (!(this.app.vault.getAbstractFileByPath(snapshotPath) instanceof TFile)) {
				onInvalid?.(candidate.commitFile.path, new Error(`State snapshot is missing: ${snapshotPath}`));
				continue;
			}
			const current = selectedByWriter.get(candidate.commit.sourceWriterId);
			if (current === undefined || candidate.commit.lastSequence > current.commit.lastSequence
				|| (candidate.commit.lastSequence === current.commit.lastSequence
					&& candidate.commit.snapshot.sha256.localeCompare(current.commit.snapshot.sha256) < 0)) {
				selectedByWriter.set(candidate.commit.sourceWriterId, candidate);
			}
		}
		const snapshotInputs = new Map<string, { file: TFile; reference: ArtifactRef; commit: StateCompactionCommit }>();
		for (const candidate of selectedByWriter.values()) {
			const path = this.absoluteArtifactPath(candidate.commit.snapshot.path);
			const file = this.app.vault.getAbstractFileByPath(path);
			if (!(file instanceof TFile)) continue;
			snapshotInputs.set(path, { file, reference: candidate.commit.snapshot, commit: candidate.commit });
		}
		const coveredPaths = new Set([...snapshotInputs.values()].flatMap((input) =>
			input.commit.coveredSegments.map((segment) => this.absoluteArtifactPath(segment.path))));
		return {
			files: [
				...segmentFiles.filter((file) => !coveredPaths.has(file.path)),
				...[...snapshotInputs.values()].map((input) => input.file),
			].sort((left, right) => left.path.localeCompare(right.path)),
			snapshotsByPath: new Map([...snapshotInputs].map(([path, input]) => [path, {
				reference: input.reference,
				commit: input.commit,
			}])),
		};
	}

	async readInputSet(
		inputSet: CatalogV2StateInputSet,
		checkpoints: readonly StateSegmentCheckpoint[] = [],
		verifyUnchanged = false,
		onInvalid?: (path: string, error: unknown) => void,
	): Promise<ParsedStateSegment[]> {
		return this.readInputFiles(inputSet, checkpoints, verifyUnchanged, onInvalid);
	}

	async listCommittedSnapshots(
		onInvalid?: (path: string, error: unknown) => void,
	): Promise<CatalogV2CommittedStateSnapshot[]> {
		const snapshots: CatalogV2CommittedStateSnapshot[] = [];
		for (const value of await this.listCompactionCommits(onInvalid)) {
			try {
				snapshots.push(await this.readCommittedSnapshot(value.commitFile, value.commit));
			} catch (error) {
				onInvalid?.(value.commitFile.path, error);
			}
		}
		return snapshots;
	}

	async listCompactionCommits(
		onInvalid?: (path: string, error: unknown) => void,
	): Promise<Array<{ commitFile: TFile; commit: StateCompactionCommit }>> {
		const folderPath = getCatalogStateCheckpointsRootPath(this.catalogDataRoot);
		const folder = this.app.vault.getAbstractFileByPath(folderPath);
		if (!(folder instanceof TFolder)) return [];
		const commitFiles: TFile[] = [];
		Vault.recurseChildren(folder, (entry) => {
			if (entry instanceof TFile && COMPACTION_COMMIT_PATTERN.test(entry.name)) commitFiles.push(entry);
		});
		const commits: Array<{ commitFile: TFile; commit: StateCompactionCommit }> = [];
		for (const commitFile of commitFiles.sort((left, right) => left.path.localeCompare(right.path))) {
			try {
				const commitBytes = new Uint8Array(await this.app.vault.readBinary(commitFile));
				const commit = parseStateCompactionCommit(commitFile.path, commitBytes);
				const expectedCommitPath = getCatalogStateCheckpointPath(this.catalogDataRoot, commit.snapshot.sha256, commit.committingWriterId);
				if (commitFile.path !== expectedCommitPath) throw new Error(`State compaction commit path mismatch: ${commitFile.path}`);
				commits.push({ commitFile, commit });
			} catch (error) {
				onInvalid?.(commitFile.path, error);
			}
		}
		return commits;
	}

	private async readInputFiles(
		inputSet: CatalogV2StateInputSet,
		checkpoints: readonly StateSegmentCheckpoint[],
		verifyUnchanged: boolean,
		onInvalid?: (path: string, error: unknown) => void,
	): Promise<ParsedStateSegment[]> {
		const checkpointByPath = new Map(checkpoints.map((checkpoint) => [checkpoint.path, checkpoint]));
		const segments: ParsedStateSegment[] = [];
		for (const file of inputSet.files) {
			const checkpoint = checkpointByPath.get(file.path);
			if (!verifyUnchanged && checkpoint !== undefined && checkpoint.byteLength === file.stat.size
				&& checkpoint.mtime !== undefined && checkpoint.mtime === file.stat.mtime) {
				continue;
			}
			try {
				const buffer = await this.app.vault.readBinary(file);
				const bytes = new Uint8Array(buffer);
				if (checkpoint !== undefined && checkpoint.byteLength === bytes.byteLength && checkpoint.sha256 === await sha256Bytes(bytes)) {
					continue;
				}
				const snapshotInput = inputSet.snapshotsByPath.get(file.path);
				const segment = snapshotInput === undefined
					? await parseStateSegment(file.path, bytes)
					: await this.toParsedSnapshot(file.path, bytes, snapshotInput);
				if (snapshotInput === undefined
					&& segment.writerId !== getWriterIdFromSegmentPath(getCatalogDevicesRootPath(this.catalogDataRoot), file.path)) {
					throw new Error(`State segment writer does not match its directory: ${file.path}`);
				}
				segments.push(segment);
			} catch (error) {
				onInvalid?.(file.path, error);
			}
		}
		return segments;
	}

	private async toParsedSnapshot(
		path: string,
		bytes: Uint8Array,
		input: { reference: ArtifactRef; commit: StateCompactionCommit },
	): Promise<ParsedStateSegment> {
		if (bytes.byteLength !== input.reference.byteLength || await sha256Bytes(bytes) !== input.reference.sha256) {
			throw new Error(`State snapshot reference mismatch: ${path}`);
		}
		const snapshot = await parseStateSnapshot(path, bytes);
		if (snapshot.sourceWriterId !== input.commit.sourceWriterId || snapshot.firstSequence !== input.commit.firstSequence
			|| snapshot.lastSequence !== input.commit.lastSequence
			|| canonicalJson(snapshot.coveredSegments) !== canonicalJson(input.commit.coveredSegments)) {
			throw new Error(`State compaction commit does not match its snapshot: ${path}`);
		}
		const digestByOpId = new Map(snapshot.operationDigests.map((item) => [item.opId, item.sha256]));
		return {
			path,
			sha256: await sha256Bytes(bytes),
			byteLength: bytes.byteLength,
			writerId: snapshot.sourceWriterId,
			firstSequence: snapshot.firstSequence,
			lastSequence: snapshot.lastSequence,
			operations: snapshot.operations.map((operation) => ({
				operation,
				digest: digestByOpId.get(operation.opId) ?? "",
				sourcePath: path,
			})),
		};
	}

	private async readCommittedSnapshot(
		commitFile: TFile,
		commit: StateCompactionCommit,
	): Promise<CatalogV2CommittedStateSnapshot> {
		const snapshotPath = this.absoluteArtifactPath(commit.snapshot.path);
		const snapshotFile = this.app.vault.getAbstractFileByPath(snapshotPath);
		if (!(snapshotFile instanceof TFile)) throw new Error(`State snapshot is missing: ${snapshotPath}`);
		const snapshotBytes = new Uint8Array(await this.app.vault.readBinary(snapshotFile));
		await this.toParsedSnapshot(snapshotPath, snapshotBytes, { reference: commit.snapshot, commit });
		return { snapshotFile, commitFile, snapshot: await parseStateSnapshot(snapshotPath, snapshotBytes), commit };
	}

	async append(operation: StateOperation): Promise<ArtifactRef> {
		assertStateOperation(operation);
		const writerFolder = getCatalogDevicePath(this.catalogDataRoot, operation.writerId);
		const existing = await this.findExistingOperation(writerFolder, operation);
		if (existing !== null) return existing;
		const candidates = this.listWriterCanonicalSegments(writerFolder);
		let segmentNumber = candidates[candidates.length - 1]?.segmentNumber ?? 1;
		let path = getCatalogStateSegmentPath(this.catalogDataRoot, operation.writerId, segmentNumber);
		let file = await ensureTextFile(this.app, path);
		let currentContent = await this.app.vault.cachedRead(file);
		assertAppendableContent(currentContent, operation);
		let plan = planStateSegmentAppend(currentContent, operation);
		if (plan.action === "rotate") {
			segmentNumber += 1;
			path = getCatalogStateSegmentPath(this.catalogDataRoot, operation.writerId, segmentNumber);
			file = await ensureTextFile(this.app, path);
			currentContent = await this.app.vault.cachedRead(file);
			if (currentContent.length > 0) throw new Error(`State segment rotation target is not empty: ${path}`);
			plan = planStateSegmentAppend("", operation);
		}
		const expectedContent = currentContent;
		const written = await this.app.vault.process(file, (content) => {
			if (content !== expectedContent) throw new Error(`Concurrent state segment change: ${path}`);
			assertAppendableContent(content, operation);
			return plan.content;
		});
		const bytes = new TextEncoder().encode(written);
		return { path, sha256: await sha256Bytes(bytes), byteLength: bytes.byteLength };
	}

	async getLastSequence(writerId: string): Promise<number> {
		if (!/^w_[a-f0-9]{32}$/.test(writerId)) throw new Error("Invalid writerId.");
		const writerFolder = getCatalogDevicePath(this.catalogDataRoot, writerId);
		const candidates = this.listWriterCanonicalSegments(writerFolder);
		for (let index = candidates.length - 1; index >= 0; index -= 1) {
			const candidate = candidates[index];
			if (candidate === undefined) continue;
			const content = await this.app.vault.cachedRead(candidate.file);
			if (content.length === 0) continue;
			const segment = await parseStateSegment(candidate.file.path, content);
			if (segment.writerId !== writerId) {
				throw new Error(`State segment writer does not match its directory: ${candidate.file.path}`);
			}
			return segment.lastSequence;
		}
		return 0;
	}

	private async findExistingOperation(writerFolder: string, operation: StateOperation): Promise<ArtifactRef | null> {
		const expected = canonicalJson(operation);
		const candidates = this.listWriterCanonicalSegments(writerFolder);
		for (let index = candidates.length - 1; index >= 0; index -= 1) {
			const candidate = candidates[index];
			if (candidate === undefined) continue;
			const content = await this.app.vault.cachedRead(candidate.file);
			if (content.length === 0) continue;
			const segment = await parseStateSegment(candidate.file.path, content);
			const matched = segment.operations.find((item) => item.operation.opId === operation.opId);
			if (matched === undefined) return null;
			if (canonicalJson(matched.operation) !== expected) {
				throw new Error(`State operation opId collision: ${operation.opId}`);
			}
			const bytes = new TextEncoder().encode(content);
			return {
				path: candidate.file.path,
				sha256: await sha256Bytes(bytes),
				byteLength: bytes.byteLength,
			};
		}
		return null;
	}

	private listWriterCanonicalSegments(writerFolder: string): Array<{ file: TFile; segmentNumber: number }> {
		const folder = this.app.vault.getAbstractFileByPath(writerFolder);
		if (!(folder instanceof TFolder)) return [];
		return folder.children.flatMap((entry) => {
			if (!(entry instanceof TFile)) return [];
			const match = CANONICAL_SEGMENT_PATTERN.exec(entry.name);
			return match?.[1] === undefined ? [] : [{ file: entry, segmentNumber: Number(match[1]) }];
		}).sort((left, right) => left.segmentNumber - right.segmentNumber);
	}

	private absoluteArtifactPath(path: string): string {
		const normalized = normalizePath(path);
		const root = normalizePath(this.catalogDataRoot).replace(/\/$/u, "");
		return normalized.startsWith(`${root}/`) ? normalized : normalizePath(`${root}/${normalized}`);
	}
}

export function isStateSegmentPath(writersRoot: string, path: string): boolean {
	const root = normalizePath(writersRoot);
	const candidate = normalizePath(path);
	if (!candidate.startsWith(`${root}/`)) return false;
	const relative = candidate.slice(root.length + 1);
	const parts = relative.split("/");
	if (parts.length !== 2 || !/^w_[a-f0-9]{32}$/.test(parts[0] ?? "")) return false;
	const fileName = parts[1] ?? "";
	if (CANONICAL_SEGMENT_PATTERN.test(fileName)) return true;
	return CONFLICT_SEGMENT_PATTERN.test(fileName) && isLikelySyncConflictPath(fileName);
}

function assertAppendableContent(content: string, operation: StateOperation): void {
	if (content.length === 0) return;
	if (content.charCodeAt(0) === 0xfeff || !content.endsWith("\n")) {
		throw new Error("Current state segment has invalid bytes.");
	}
	const lines = content.slice(0, -1).split("\n");
	let lastSequence = 0;
	for (const line of lines) {
		if (line.length === 0) throw new Error("Current state segment contains a blank line.");
		const parsed: unknown = JSON.parse(line);
		assertStateOperation(parsed);
		if (canonicalJson(parsed) !== line) throw new Error("Current state segment is not canonical JSONL.");
		if (parsed.writerId !== operation.writerId || parsed.sequence <= lastSequence) {
			throw new Error("Current state segment writer or sequence is invalid.");
		}
		lastSequence = parsed.sequence;
	}
	if (operation.sequence <= lastSequence) {
		throw new Error("State operation sequence does not advance the current segment.");
	}
}

function getWriterIdFromSegmentPath(writersRoot: string, path: string): string {
	return normalizePath(path).slice(normalizePath(writersRoot).length + 1).split("/")[0] ?? "";
}
