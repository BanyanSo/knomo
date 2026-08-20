import { normalizePath, TFile, TFolder, Vault } from "obsidian";
import type { App } from "obsidian";

import type {
	ArtifactRef,
	CatalogV2LayoutMigrationReport,
	CatalogV2LegacyV2ArtifactKind,
	CatalogV2LegacyV2Receipt,
	MigrationCommit,
	MigrationPackage,
	StateOperation,
	StateSnapshot,
} from "../types/catalogV2";
import {
	getCatalogDeletedPayloadPath,
	getCatalogSnapshotPath,
	getCatalogSnapshotsRootPath,
	getCatalogStateCheckpointPath,
	getCatalogStateSegmentPath,
	getCatalogUpgradeCheckpointPath,
	getCatalogUpgradeIssuePath,
	getCatalogUpgradePackagePath,
} from "../utils/path";
import { isRecord } from "../utils/object";
import { ensureFolder, getParentFolderPath } from "../utils/vault";
import {
	parseCanonicalMigrationCommit,
	parseCanonicalMigrationPackage,
} from "./CatalogV2MigrationArtifactStore";
import {
	canonicalJson,
	canonicalJsonFileBytes,
	compareText,
	parseDeletedMemoPayload,
	parseStateCompactionCommit,
	parseStateSegment,
	parseStateSnapshot,
	serializeStateSegment,
	sha256Bytes,
	sha256Text,
} from "./CatalogV2Protocol";

interface LegacyV2Artifact {
	file: TFile;
	kind: CatalogV2LegacyV2ArtifactKind;
	relativePath: string;
	bytes: Uint8Array;
	sha256: string;
}

interface MigratedArtifact {
	relativePath: string;
	absolutePath: string;
	sha256: string;
	byteLength: number;
}

export interface CatalogV2LayoutMigrationOptions {
	allowMutableSegmentReplace?: boolean;
}

export class CatalogV2LayoutMigrationService {
	constructor(
		private readonly app: App,
		private readonly catalogDataRoot: string,
		private readonly legacySystemRoot: string,
	) {}

	async migrate(options: CatalogV2LayoutMigrationOptions = {}): Promise<CatalogV2LayoutMigrationReport> {
		const sources = await this.inventory();
		if (sources.length === 0) {
			return { legacyInventorySignature: "", receipts: [], markdownBytesSignature: "" };
		}
		const markdownBytesSignature = await this.markdownSignature();
		const migratedBySourcePath = new Map<string, MigratedArtifact>();
		const receipts: CatalogV2LegacyV2Receipt[] = [];
		for (const kind of MIGRATION_ORDER) {
			for (const source of sources.filter((item) => item.kind === kind)) {
				const migrated = await this.migrateArtifact(
					source,
					migratedBySourcePath,
					options.allowMutableSegmentReplace ?? false,
				);
				migratedBySourcePath.set(source.relativePath, migrated);
				receipts.push({
					sourcePath: source.file.path,
					sourceSha256: source.sha256,
					sourceByteLength: source.bytes.byteLength,
					target: {
						path: migrated.absolutePath,
						sha256: migrated.sha256,
						byteLength: migrated.byteLength,
					},
					artifactKind: source.kind,
				});
			}
		}
		await this.verifySourcesUnchanged(sources);
		if (await this.markdownSignature() !== markdownBytesSignature) {
			throw new Error("Markdown bytes changed during Catalog layout migration.");
		}
		receipts.sort((left, right) => left.sourcePath.localeCompare(right.sourcePath));
		return {
			legacyInventorySignature: receipts
				.map((receipt) => `${receipt.sourcePath}\u0000${receipt.sourceSha256}\u0000${receipt.sourceByteLength}`)
				.join("\u0001"),
			receipts,
			markdownBytesSignature,
		};
	}

	private async inventory(): Promise<LegacyV2Artifact[]> {
		const root = this.app.vault.getAbstractFileByPath(normalizePath(`${this.legacySystemRoot}/v2`));
		if (!(root instanceof TFolder)) return [];
		const files: TFile[] = [];
		Vault.recurseChildren(root, (child) => {
			if (child instanceof TFile) files.push(child);
		});
		const artifacts: LegacyV2Artifact[] = [];
		for (const file of files.sort((left, right) => left.path.localeCompare(right.path))) {
			const relativePath = this.toLegacyRelativePath(file.path);
			const kind = classifyLegacyV2Artifact(relativePath);
			if (kind === null) continue;
			const bytes = new Uint8Array(await this.app.vault.readBinary(file));
			if (Number.isInteger(file.stat?.size) && file.stat.size >= 0 && file.stat.size !== bytes.byteLength) {
				throw new Error(`Legacy Catalog artifact size changed while reading: ${file.path}`);
			}
			artifacts.push({ file, kind, relativePath, bytes, sha256: await sha256Bytes(bytes) });
		}
		return artifacts;
	}

	private async migrateArtifact(
		source: LegacyV2Artifact,
		migratedBySourcePath: ReadonlyMap<string, MigratedArtifact>,
		allowMutableSegmentReplace: boolean,
	): Promise<MigratedArtifact> {
		if (source.kind === "deleted_payload") {
			parseDeletedMemoPayload(source.file.path, source.bytes);
			return this.writeTarget(mapLegacyV2RelativePath(source.relativePath), source.bytes, false);
		}
		if (source.kind === "upgrade_issue") {
			const value = parseCanonicalJson(source.file.path, source.bytes);
			if (!isRecord(value) || value.kind !== "knomo.catalog-v2.quarantine-receipt"
				|| value.schemaVersion !== 1 || typeof value.artifactDigest !== "string"
				|| typeof value.artifactKind !== "string" || typeof value.byteLength !== "number"
				|| typeof value.errorCode !== "string" || !Array.isArray(value.preservedRecordDigests)) {
				throw new Error(`Invalid legacy Catalog issue receipt: ${source.file.path}`);
			}
			return this.writeTarget(mapLegacyV2RelativePath(source.relativePath), source.bytes, false);
		}
		if (source.kind === "state_segment") {
			const segment = await parseStateSegment(source.file.path, source.bytes);
			const operations = await Promise.all(segment.operations.map(async (entry) =>
				this.remapOperation(entry.operation, migratedBySourcePath)));
			const bytes = new TextEncoder().encode(serializeStateSegment(operations));
			return this.writeTarget(mapLegacyV2RelativePath(source.relativePath), bytes, allowMutableSegmentReplace);
		}
		if (source.kind === "upgrade_package") {
			const value = parseCanonicalMigrationPackage(source.file.path, source.bytes);
			const migrated = await this.remapMigrationPackage(value, migratedBySourcePath);
			return this.writeTarget(mapLegacyV2RelativePath(source.relativePath), canonicalJsonFileBytes(migrated), false);
		}
		if (source.kind === "state_snapshot") {
			const value = await parseStateSnapshot(source.file.path, source.bytes);
			const migrated = await this.remapStateSnapshot(value, migratedBySourcePath);
			const bytes = canonicalJsonFileBytes(migrated);
			const digest = await sha256Bytes(bytes);
			const path = getCatalogSnapshotPath("", migrated.sourceWriterId, migrated.firstSequence, migrated.lastSequence, digest);
			return this.writeTarget(path, bytes, false);
		}
		if (source.kind === "state_checkpoint") {
			const value = parseStateCompactionCommit(source.file.path, source.bytes);
			const snapshot = await this.remapReference(value.snapshot, migratedBySourcePath);
			const migrated = {
				...value,
				snapshot,
				coveredSegments: await Promise.all(value.coveredSegments.map((reference) =>
					this.remapReference(reference, migratedBySourcePath))),
			};
			const path = getCatalogStateCheckpointPath("", snapshot.sha256, migrated.committingWriterId);
			return this.writeTarget(path, canonicalJsonFileBytes(migrated), false);
		}
		const value = parseCanonicalMigrationCommit(source.file.path, source.bytes);
		const migrated = await this.remapMigrationCommit(value, migratedBySourcePath);
		const path = getCatalogUpgradeCheckpointPath("", migrated.generationDigest, migrated.writerId);
		return this.writeTarget(path, canonicalJsonFileBytes(migrated), false);
	}

	private async remapOperation(
		operation: StateOperation,
		migratedBySourcePath: ReadonlyMap<string, MigratedArtifact>,
	): Promise<StateOperation> {
		if (operation.type !== "lifecycle.delete") return operation;
		return {
			...operation,
			payload: {
				...operation.payload,
				deletedPayload: await this.remapReference(operation.payload.deletedPayload, migratedBySourcePath),
			},
		};
	}

	private async remapStateSnapshot(
		value: StateSnapshot,
		migratedBySourcePath: ReadonlyMap<string, MigratedArtifact>,
	): Promise<StateSnapshot> {
		const operations = await Promise.all(value.operations.map((operation) =>
			this.remapOperation(operation, migratedBySourcePath)));
		const operationDigests = await Promise.all(operations.map(async (operation) => ({
			opId: operation.opId,
			sha256: await sha256Text(canonicalJson(operation)),
		})));
		operationDigests.sort((left, right) => compareText(
			`${left.opId}\u0000${left.sha256}`,
			`${right.opId}\u0000${right.sha256}`,
		));
		const coveredSegments = await Promise.all(value.coveredSegments.map((reference) =>
			this.remapReference(reference, migratedBySourcePath)));
		coveredSegments.sort((left, right) => compareText(`${left.path}\u0000${left.sha256}`, `${right.path}\u0000${right.sha256}`));
		return { ...value, coveredSegments, operationDigests, operations };
	}

	private async remapMigrationPackage(
		value: MigrationPackage,
		migratedBySourcePath: ReadonlyMap<string, MigratedArtifact>,
	): Promise<MigrationPackage> {
		return {
			...value,
			deletedRecords: await Promise.all(value.deletedRecords.map(async (record) => ({
				...record,
				payload: await this.remapReference(record.payload, migratedBySourcePath),
			}))),
		};
	}

	private async remapMigrationCommit(
		value: MigrationCommit,
		migratedBySourcePath: ReadonlyMap<string, MigratedArtifact>,
	): Promise<MigrationCommit> {
		const legacySources = await Promise.all(value.legacySources.map(async (source) => ({
			...source,
			receipt: await this.remapReference(source.receipt, migratedBySourcePath),
		})));
		legacySources.sort((left, right) => compareText(
			`${left.artifactDigest}\u0000${left.artifactKind}\u0000${left.disposition}\u0000${left.receipt.sha256}`,
			`${right.artifactDigest}\u0000${right.artifactKind}\u0000${right.disposition}\u0000${right.receipt.sha256}`,
		));
		const requiredArtifacts = await Promise.all(value.requiredArtifacts.map(async (artifact) => ({
			...artifact,
			...await this.remapReference(artifact, migratedBySourcePath),
		})));
		requiredArtifacts.sort((left, right) => compareText(
			`${left.path}\u0000${left.artifactKind}\u0000${left.sha256}`,
			`${right.path}\u0000${right.artifactKind}\u0000${right.sha256}`,
		));
		const descriptor = {
			schemaVersion: value.schemaVersion,
			importerVersion: value.importerVersion,
			legacySources: legacySources.map((source) => ({
				artifactDigest: source.artifactDigest,
				artifactKind: source.artifactKind,
				disposition: source.disposition,
				receiptSha256: source.receipt.sha256,
			})),
			requiredArtifacts,
			domainCounts: value.domainCounts,
		};
		return {
			...value,
			generationDigest: await sha256Text(canonicalJson(descriptor)),
			legacySources,
			requiredArtifacts,
		};
	}

	private async remapReference(
		reference: ArtifactRef,
		migratedBySourcePath: ReadonlyMap<string, MigratedArtifact>,
	): Promise<ArtifactRef> {
		const sourceRelativePath = this.toLegacyRelativePath(reference.path);
		let migrated = migratedBySourcePath.get(sourceRelativePath);
		if (migrated === undefined) migrated = await this.resolveExistingTarget(sourceRelativePath);
		const targetRelativePath = migrated?.relativePath ?? mapLegacyV2RelativePath(sourceRelativePath);
		const path = this.isLegacyAbsolutePath(reference.path)
			? normalizePath(`${this.catalogDataRoot}/${targetRelativePath}`)
			: targetRelativePath;
		return migrated === undefined
			? { ...reference, path }
			: { path, sha256: migrated.sha256, byteLength: migrated.byteLength };
	}

	private async resolveExistingTarget(sourceRelativePath: string): Promise<MigratedArtifact | undefined> {
		if (/^v2\/state\/snapshots\//u.test(sourceRelativePath)) {
			const match = /^v2\/state\/snapshots\/(w_[a-f0-9]{32})\/snapshot-(\d+)-(\d+)-[a-f0-9]{64}\.json$/u.exec(sourceRelativePath);
			if (match === null) return undefined;
			const folderPath = normalizePath(`${getCatalogSnapshotsRootPath(this.catalogDataRoot)}/${match[1]}`);
			const folder = this.app.vault.getAbstractFileByPath(folderPath);
			if (!(folder instanceof TFolder)) return undefined;
			const candidates = folder.children.filter((child): child is TFile => child instanceof TFile
				&& child.name.startsWith(`snapshot-${match[2]}-${match[3]}-`));
			if (candidates.length !== 1) return undefined;
			return this.readMigratedArtifact(candidates[0]);
		}
		const targetRelativePath = mapLegacyV2RelativePath(sourceRelativePath);
		const file = this.app.vault.getAbstractFileByPath(normalizePath(`${this.catalogDataRoot}/${targetRelativePath}`));
		return file instanceof TFile ? this.readMigratedArtifact(file) : undefined;
	}

	private async writeTarget(relativePath: string, bytes: Uint8Array, allowReplace: boolean): Promise<MigratedArtifact> {
		const absolutePath = normalizePath(`${this.catalogDataRoot}/${relativePath}`);
		let file = this.app.vault.getAbstractFileByPath(absolutePath);
		if (file instanceof TFile) {
			const current = new Uint8Array(await this.app.vault.readBinary(file));
			if (!equalBytes(current, bytes)) {
				if (!allowReplace) throw new Error(`Catalog layout migration target conflicts: ${absolutePath}`);
				const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
				await this.app.vault.process(file, () => text);
			}
		} else {
			if (file !== null) throw new Error(`Catalog layout migration target is not a file: ${absolutePath}`);
			const parent = getParentFolderPath(absolutePath);
			if (parent !== null) await ensureFolder(this.app, parent);
			file = await this.app.vault.create(absolutePath, new TextDecoder("utf-8", { fatal: true }).decode(bytes));
		}
		if (!(file instanceof TFile)) throw new Error(`Catalog layout migration target is missing: ${absolutePath}`);
		const stored = new Uint8Array(await this.app.vault.readBinary(file));
		if (!equalBytes(stored, bytes)) throw new Error(`Catalog layout migration write verification failed: ${absolutePath}`);
		return {
			relativePath,
			absolutePath,
			sha256: await sha256Bytes(stored),
			byteLength: stored.byteLength,
		};
	}

	private async readMigratedArtifact(file: TFile): Promise<MigratedArtifact> {
		const bytes = new Uint8Array(await this.app.vault.readBinary(file));
		const root = normalizePath(this.catalogDataRoot).replace(/\/$/u, "");
		return {
			relativePath: file.path.slice(root.length + 1),
			absolutePath: file.path,
			sha256: await sha256Bytes(bytes),
			byteLength: bytes.byteLength,
		};
	}

	private async verifySourcesUnchanged(sources: readonly LegacyV2Artifact[]): Promise<void> {
		for (const source of sources) {
			const file = this.app.vault.getAbstractFileByPath(source.file.path);
			if (!(file instanceof TFile)) throw new Error(`Legacy Catalog artifact disappeared during migration: ${source.file.path}`);
			const bytes = new Uint8Array(await this.app.vault.readBinary(file));
			if (bytes.byteLength !== source.bytes.byteLength || await sha256Bytes(bytes) !== source.sha256) {
				throw new Error(`Legacy Catalog artifact changed during migration: ${source.file.path}`);
			}
		}
	}

	private async markdownSignature(): Promise<string> {
		const vault = this.app.vault as App["vault"] & { getMarkdownFiles?: () => TFile[]; getFiles?: () => TFile[] };
		const files = (vault.getMarkdownFiles?.() ?? vault.getFiles?.().filter((file) => file.extension === "md") ?? [])
			.sort((left, right) => left.path.localeCompare(right.path));
		const values: string[] = [];
		for (const file of files) {
			const bytes = new Uint8Array(await this.app.vault.readBinary(file));
			values.push(`${file.path}\u0000${bytes.byteLength}\u0000${await sha256Bytes(bytes)}`);
		}
		return sha256Text(values.join("\u0001"));
	}

	private toLegacyRelativePath(path: string): string {
		const normalized = normalizePath(path);
		const root = normalizePath(this.legacySystemRoot).replace(/\/$/u, "");
		if (normalized.startsWith(`${root}/`)) return normalized.slice(root.length + 1);
		if (normalized.startsWith("v2/")) return normalized;
		throw new Error(`Legacy Catalog artifact path is outside the legacy root: ${path}`);
	}

	private isLegacyAbsolutePath(path: string): boolean {
		return normalizePath(path).startsWith(`${normalizePath(this.legacySystemRoot).replace(/\/$/u, "")}/`);
	}
}

const MIGRATION_ORDER: readonly CatalogV2LegacyV2ArtifactKind[] = [
	"deleted_payload",
	"upgrade_issue",
	"state_segment",
	"upgrade_package",
	"state_snapshot",
	"state_checkpoint",
	"upgrade_checkpoint",
];

export function classifyLegacyV2Artifact(relativePath: string): CatalogV2LegacyV2ArtifactKind | null {
	if (/^v2\/state\/writers\/w_[a-f0-9]{32}\/segment-\d{6}(?:[^/]*)\.jsonl$/u.test(relativePath)) return "state_segment";
	if (/^v2\/state\/snapshots\/w_[a-f0-9]{32}\/snapshot-\d+-\d+-[a-f0-9]{64}\.json$/u.test(relativePath)) return "state_snapshot";
	if (/^v2\/state\/compactions\/commit-[a-f0-9]{64}-w_[a-f0-9]{32}\.json$/u.test(relativePath)) return "state_checkpoint";
	if (/^v2\/state\/deleted\/[^/]+\/(?:o_[a-f0-9]{32}|l_[a-f0-9]{64})\.json$/u.test(relativePath)) return "deleted_payload";
	if (/^v2\/migrations\/imports\/[^/]+-[a-f0-9]{64}\.json$/u.test(relativePath)) return "upgrade_package";
	if (/^v2\/migrations\/commits\/commit-[a-f0-9]{64}-w_[a-f0-9]{32}\.json$/u.test(relativePath)) return "upgrade_checkpoint";
	if (/^v2\/migrations\/quarantine\/[^/]+-[a-f0-9]{64}\.json$/u.test(relativePath)) return "upgrade_issue";
	return null;
}

export function isLegacyV2Path(legacySystemRoot: string, path: string): boolean {
	const root = normalizePath(legacySystemRoot).replace(/\/$/u, "");
	return normalizePath(path).startsWith(`${root}/v2/`);
}

export function mapLegacyV2RelativePath(relativePath: string): string {
	let match = /^v2\/state\/writers\/(w_[a-f0-9]{32})\/segment-(\d{6})([^/]*)\.jsonl$/u.exec(relativePath);
	if (match !== null) return `${getCatalogStateSegmentPath("", match[1] ?? "", Number(match[2])).replace(/\.jsonl$/u, "")}${match[3] ?? ""}.jsonl`;
	match = /^v2\/state\/deleted\/([^/]+)\/((?:o_[a-f0-9]{32}|l_[a-f0-9]{64}))\.json$/u.exec(relativePath);
	if (match !== null) return getCatalogDeletedPayloadPath("", match[1] ?? "", match[2] ?? "");
	match = /^v2\/migrations\/imports\/([^/]+)-([a-f0-9]{64})\.json$/u.exec(relativePath);
	if (match !== null) return getCatalogUpgradePackagePath("", match[1] ?? "", match[2] ?? "");
	match = /^v2\/migrations\/quarantine\/([^/]+)-([a-f0-9]{64})\.json$/u.exec(relativePath);
	if (match !== null) return getCatalogUpgradeIssuePath("", match[1] ?? "", match[2] ?? "");
	throw new Error(`Unsupported legacy Catalog artifact path: ${relativePath}`);
}

function parseCanonicalJson(path: string, bytes: Uint8Array): unknown {
	const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
	if (text.length === 0 || text.charCodeAt(0) === 0xfeff || !text.endsWith("\n")) {
		throw new Error(`Invalid legacy Catalog artifact bytes: ${path}`);
	}
	const value: unknown = JSON.parse(text.slice(0, -1));
	if (`${canonicalJson(value)}\n` !== text) throw new Error(`Legacy Catalog artifact is not canonical JSON: ${path}`);
	return value;
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
	return left.byteLength === right.byteLength && left.every((value, index) => value === right[index]);
}
