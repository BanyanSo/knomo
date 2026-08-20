import { normalizePath, TFile, TFolder, Vault } from "obsidian";
import type { App } from "obsidian";

import type {
	ArtifactRef,
	LegacyImportResult,
	MigrationCommitDomainCounts,
	MigrationCommitVerification,
	MigrationDomainCounts,
	MigrationCommit,
	MigrationPackage,
	QuarantineReceipt,
} from "../types/catalogV2";
import { isRecord } from "../utils/object";
import {
	getCatalogDeletedRootPath,
	getCatalogUpgradeCheckpointsRootPath,
	getCatalogUpgradeIssuesRootPath,
	getCatalogUpgradePackagesRootPath,
} from "../utils/path";
import { ensureFolder, getParentFolderPath } from "../utils/vault";
import {
	canonicalJson,
	sha256Bytes,
} from "./CatalogV2Protocol";
import type { AvailableMigrationArtifact, BuiltMigrationCommit } from "./CatalogV2Migration";

const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const WRITER_ID_PATTERN = /^w_[a-f0-9]{32}$/u;
const STATE_ENTRY_ID_PATTERN = /^(?:o_[a-f0-9]{32}|l_[a-f0-9]{64})$/u;
const MEMO_ID_PATTERN = /^[^/\\\u0000-\u001f]{1,200}$/u;
const LEGACY_HASH_PATTERN = /^fnv1a-[a-f0-9]{8}$/u;
const PERIOD_PATTERN = /^\d{4}-(?:0[1-9]|1[0-2])$/u;
const DATE_PATTERN = /^\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])$/u;
const TIME_PATTERN = /^(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?$/u;
const LEGACY_ARTIFACT_KINDS = new Set([
	"memo_index",
	"pending_create",
	"plugin_data",
	"time_buoy_index",
	"time_buoy_state",
	"repair_candidate",
]);

export interface StoredMigrationPackage {
	path: string;
	bytes: Uint8Array;
	value: MigrationPackage;
}

export interface StoredMigrationCommit {
	path: string;
	bytes: Uint8Array;
	value: MigrationCommit;
}

export class CatalogV2MigrationArtifactStore {
	constructor(
		private readonly app: App,
		private readonly catalogDataRoot: string | (() => string),
	) {}

	async persistImportResults(results: readonly LegacyImportResult[]): Promise<void> {
		for (const result of results) {
			if (result.kind === "imported") {
				await this.writeImmutable(result.packagePath, result.packageBytes);
				for (const payload of result.deletedPayloads) await this.writeImmutable(payload.path, payload.bytes);
			} else {
				await this.writeImmutable(result.path, result.receiptBytes);
			}
		}
	}

	async persistCommit(commit: BuiltMigrationCommit): Promise<void> {
		await this.writeImmutable(commit.path, commit.bytes);
	}

	async listAvailableArtifacts(): Promise<AvailableMigrationArtifact[]> {
		const paths = [
			...this.listFilesUnder(getCatalogUpgradePackagesRootPath("")),
			...this.listFilesUnder(getCatalogUpgradeIssuesRootPath("")),
			...this.listFilesUnder(getCatalogDeletedRootPath("")),
		].sort((left, right) => left.localeCompare(right));
		const artifacts: AvailableMigrationArtifact[] = [];
		for (const path of paths) {
			const file = this.getFile(path);
			artifacts.push({ path, bytes: new Uint8Array(await this.app.vault.readBinary(file)) });
		}
		return artifacts;
	}

	async listPackages(): Promise<StoredMigrationPackage[]> {
		const values: StoredMigrationPackage[] = [];
		for (const path of this.listFilesUnder(getCatalogUpgradePackagesRootPath("")).sort((left, right) => left.localeCompare(right))) {
			const bytes = new Uint8Array(await this.app.vault.readBinary(this.getFile(path)));
			values.push({ path, bytes, value: parseCanonicalMigrationPackage(path, bytes) });
		}
		return values;
	}

	async readPackage(path: string): Promise<StoredMigrationPackage | null> {
		const normalized = normalizeArtifactRelativePath(path);
		const file = this.app.vault.getAbstractFileByPath(this.absolutePath(normalized));
		if (!(file instanceof TFile)) return null;
		const bytes = new Uint8Array(await this.app.vault.readBinary(file));
		return { path: normalized, bytes, value: parseCanonicalMigrationPackage(normalized, bytes) };
	}

	async listCommits(): Promise<StoredMigrationCommit[]> {
		const values: StoredMigrationCommit[] = [];
		for (const path of this.listFilesUnder(getCatalogUpgradeCheckpointsRootPath("")).sort((left, right) => left.localeCompare(right))) {
			const bytes = new Uint8Array(await this.app.vault.readBinary(this.getFile(path)));
			values.push({ path, bytes, value: parseCanonicalMigrationCommit(path, bytes) });
		}
		return values;
	}

	async readCommit(path: string): Promise<StoredMigrationCommit | null> {
		const normalized = normalizeArtifactRelativePath(path);
		const file = this.app.vault.getAbstractFileByPath(this.absolutePath(normalized));
		if (!(file instanceof TFile)) return null;
		const bytes = new Uint8Array(await this.app.vault.readBinary(file));
		return { path: normalized, bytes, value: parseCanonicalMigrationCommit(normalized, bytes) };
	}

	async verifyArtifact(path: string, sha256: string, byteLength: number): Promise<boolean> {
		const file = this.app.vault.getAbstractFileByPath(this.absolutePath(path));
		if (!(file instanceof TFile)) return false;
		const bytes = new Uint8Array(await this.app.vault.readBinary(file));
		return bytes.byteLength === byteLength && await sha256Bytes(bytes) === sha256;
	}

	private async writeImmutable(relativePath: string, bytes: Uint8Array): Promise<void> {
		const path = this.absolutePath(relativePath);
		const existing = this.app.vault.getAbstractFileByPath(path);
		if (existing instanceof TFile) {
			const current = new Uint8Array(await this.app.vault.readBinary(existing));
			if (!equalBytes(current, bytes)) throw new Error(`Immutable migration artifact mismatch: ${relativePath}`);
			return;
		}
		if (existing !== null) throw new Error(`Migration artifact path is not a file: ${relativePath}`);
		const parent = getParentFolderPath(path);
		if (parent !== null) await ensureFolder(this.app, parent);
		const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
		const created = await this.app.vault.create(path, text);
		const stored = new Uint8Array(await this.app.vault.readBinary(created));
		if (!equalBytes(stored, bytes)) throw new Error(`Migration artifact verification failed: ${relativePath}`);
	}

	private listFilesUnder(relativeFolder: string): string[] {
		const folder = this.app.vault.getAbstractFileByPath(this.absolutePath(relativeFolder));
		if (!(folder instanceof TFolder)) return [];
		const paths: string[] = [];
		Vault.recurseChildren(folder, (child) => {
			if (child instanceof TFile) paths.push(this.relativePath(child.path));
		});
		return paths;
	}

	private getFile(relativePath: string): TFile {
		const file = this.app.vault.getAbstractFileByPath(this.absolutePath(relativePath));
		if (!(file instanceof TFile)) throw new Error(`Migration artifact is missing: ${relativePath}`);
		return file;
	}

	private absolutePath(relativePath: string): string {
		const relative = normalizeArtifactRelativePath(relativePath);
		return normalizePath(`${this.resolveCatalogDataRoot()}/${relative}`);
	}

	private relativePath(absolutePath: string): string {
		const root = this.resolveCatalogDataRoot();
		if (!absolutePath.startsWith(`${root}/`)) throw new Error(`Artifact is outside system root: ${absolutePath}`);
		return normalizeArtifactRelativePath(absolutePath.slice(root.length + 1));
	}

	private resolveCatalogDataRoot(): string {
		return normalizePath((typeof this.catalogDataRoot === "function"
			? this.catalogDataRoot()
			: this.catalogDataRoot).replace(/\/$/u, ""));
	}
}

export function parseCanonicalMigrationPackage(path: string, bytes: Uint8Array): MigrationPackage {
	const value = parseCanonicalJson(path, bytes);
	assertMigrationPackage(value);
	return value;
}

export function parseCanonicalMigrationCommit(path: string, bytes: Uint8Array): MigrationCommit {
	const value = parseCanonicalJson(path, bytes);
	assertMigrationCommit(value);
	return value;
}

export function assertMigrationPackage(value: unknown): asserts value is MigrationPackage {
	if (!isRecord(value) || value.kind !== "knomo.catalog-v2.migration-package"
		|| value.schemaVersion !== 1 || value.importerVersion !== 1 || !isRecord(value.source)
		|| !SHA256_PATTERN.test(readString(value.source.artifactDigest))
		|| !isLegacyArtifactKind(value.source.artifactKind) || !isPositiveInteger(value.source.byteLength)
		|| (value.source.legacySchemaVersion !== null && !isNonNegativeInteger(value.source.legacySchemaVersion))
		|| (value.source.period !== null && !PERIOD_PATTERN.test(readString(value.source.period)))
		|| !isNonNegativeInteger(value.source.recordCount)
		|| !Array.isArray(value.identityClaims) || !Array.isArray(value.deletedRecords)
		|| !Array.isArray(value.relations) || !Array.isArray(value.reviews)
		|| !Array.isArray(value.pendingCreates) || !Array.isArray(value.diagnostics)
		|| !isMigrationDomainCounts(value.counts)) {
		throw new Error("Invalid migration package.");
	}
	for (const item of value.identityClaims) {
		if (!isRecord(item) || !isMemoId(item.memoId)
			|| (item.legacyStatus !== "active" && item.legacyStatus !== "error")
			|| !SHA256_PATTERN.test(readString(item.legacyRecordDigest)) || !isLegacyEvidence(item.evidence)) {
			throw new Error("Invalid migration identity claim.");
		}
	}
	for (const item of value.deletedRecords) {
		if (!isRecord(item) || !isMemoId(item.memoId)
			|| !STATE_ENTRY_ID_PATTERN.test(readString(item.deleteOpId))
			|| (item.deletedAt !== null && !isDateTime(item.deletedAt))
			|| (item.deleteSource !== null && typeof item.deleteSource !== "string")
			|| !SHA256_PATTERN.test(readString(item.legacyRecordDigest)) || !isArtifactRef(item.payload)) {
			throw new Error("Invalid migration deleted record.");
		}
	}
	for (const item of value.relations) {
		if (!isRecord(item) || !isMemoId(item.memoId) || !isMemoId(item.sourceMemoId)
			|| !SHA256_PATTERN.test(readString(item.legacyRecordDigest))) {
			throw new Error("Invalid migration relation.");
		}
	}
	for (const item of value.reviews) {
		if (!isRecord(item) || !isMemoId(item.memoId) || !isNonNegativeInteger(item.reviewCount)
			|| (item.lastReviewedAt !== null && !isDateTime(item.lastReviewedAt))
			|| !SHA256_PATTERN.test(readString(item.legacyRecordDigest))) {
			throw new Error("Invalid migration review.");
		}
	}
	for (const item of value.pendingCreates) {
		if (!isRecord(item) || !isMemoId(item.memoId)
			|| typeof item.legacyOpId !== "string" || item.legacyOpId.length === 0 || item.legacyOpId.length > 200
			|| !isDateTime(item.createdAt) || typeof item.rawBlock !== "string" || item.rawBlock.length === 0
			|| !LEGACY_HASH_PATTERN.test(readString(item.contentHash)) || !isVaultPath(item.dailyPath)
			|| !LEGACY_HASH_PATTERN.test(readString(item.dailyBeforeHash))
			|| !LEGACY_HASH_PATTERN.test(readString(item.dailyAfterHash))
			|| (item.source !== "plugin_input" && item.source !== "daily_scan" && item.source !== "quote_create")
			|| (item.sourceMemoId !== null && !isMemoId(item.sourceMemoId))
			|| !SHA256_PATTERN.test(readString(item.legacyRecordDigest))) {
			throw new Error("Invalid migration pending create.");
		}
	}
	for (const item of value.diagnostics) {
		if (!isRecord(item) || typeof item.entryKey !== "string" || item.entryKey.length === 0
			|| (item.severity !== "info" && item.severity !== "attention")
			|| typeof item.code !== "string" || item.code.length === 0
			|| (item.memoId !== null && !isMemoId(item.memoId))
			|| !Array.isArray(item.fieldNames)
			|| item.fieldNames.some((fieldName) => typeof fieldName !== "string" || fieldName.length === 0)) {
			throw new Error("Invalid migration diagnostic.");
		}
	}
	const counts = value.counts as MigrationDomainCounts;
	if (counts.identityClaims !== value.identityClaims.length
		|| counts.deletedRecords !== value.deletedRecords.length
		|| counts.relations !== value.relations.length
		|| counts.reviewOrdinals !== value.reviews.reduce((sum, item) => sum + Number((item as Record<string, unknown>).reviewCount), 0)
		|| counts.pendingCreates !== value.pendingCreates.length
		|| counts.diagnostics !== value.diagnostics.length) {
		throw new Error("Migration package domain counts do not match its records.");
	}
}

export function assertMigrationCommit(value: unknown): asserts value is MigrationCommit {
	if (!isRecord(value) || value.kind !== "knomo.catalog-v2.migration-commit"
		|| value.schemaVersion !== 1 || value.importerVersion !== 1
		|| !SHA256_PATTERN.test(readString(value.generationDigest))
		|| !WRITER_ID_PATTERN.test(readString(value.writerId)) || !isIsoDate(value.committedAt)
		|| !Array.isArray(value.legacySources) || value.legacySources.length === 0
		|| !Array.isArray(value.requiredArtifacts) || value.requiredArtifacts.length === 0
		|| !isMigrationCommitDomainCounts(value.domainCounts)
		|| !isMigrationCommitVerification(value.verification)) {
		throw new Error("Invalid migration commit.");
	}
	const sourceKeys = new Set<string>();
	for (const source of value.legacySources) {
		if (!isRecord(source) || !SHA256_PATTERN.test(readString(source.artifactDigest))
			|| !isLegacyArtifactKind(source.artifactKind)
			|| (source.disposition !== "imported" && source.disposition !== "quarantined")
			|| !isArtifactRef(source.receipt)) {
			throw new Error("Invalid migration commit legacy source.");
		}
		const key = `${source.artifactKind}\u0000${source.artifactDigest}`;
		if (sourceKeys.has(key)) throw new Error("Duplicate migration commit legacy source.");
		sourceKeys.add(key);
	}
	const requiredKeys = new Set<string>();
	for (const artifact of value.requiredArtifacts) {
		if (!isRecord(artifact)
			|| (artifact.artifactKind !== "migration_package"
				&& artifact.artifactKind !== "quarantine_receipt"
				&& artifact.artifactKind !== "deleted_payload")
			|| !isArtifactRef(artifact)) {
			throw new Error("Invalid migration commit artifact reference.");
		}
		const key = `${artifact.artifactKind}\u0000${artifact.path}`;
		if (requiredKeys.has(key)) throw new Error("Duplicate migration commit artifact reference.");
		requiredKeys.add(key);
	}
	for (const source of value.legacySources) {
		const expectedKind = source.disposition === "imported" ? "migration_package" : "quarantine_receipt";
		if (!value.requiredArtifacts.some((artifact) => artifact.artifactKind === expectedKind
			&& sameArtifactRef(artifact, source.receipt))) {
			throw new Error("Migration source receipt is not required by its commit.");
		}
	}
	for (const artifact of value.requiredArtifacts) {
		if (artifact.artifactKind === "deleted_payload") continue;
		const expectedDisposition = artifact.artifactKind === "migration_package" ? "imported" : "quarantined";
		if (!value.legacySources.some((source) => source.disposition === expectedDisposition
			&& sameArtifactRef(source.receipt, artifact))) {
			throw new Error("Migration commit contains an unowned required artifact.");
		}
	}
}

export function assertQuarantineReceipt(value: unknown): asserts value is QuarantineReceipt {
	if (!isRecord(value) || value.kind !== "knomo.catalog-v2.quarantine-receipt" || value.schemaVersion !== 1
		|| !SHA256_PATTERN.test(readString(value.artifactDigest)) || !isLegacyArtifactKind(value.artifactKind)
		|| !isNonNegativeInteger(value.byteLength) || typeof value.errorCode !== "string" || value.errorCode.length === 0
		|| !isNonNegativeInteger(value.recoverableRecordCount) || !Array.isArray(value.preservedRecordDigests)
		|| value.preservedRecordDigests.some((digest) => !SHA256_PATTERN.test(readString(digest)))
		|| !isSortedUniqueStrings(value.preservedRecordDigests)) {
		throw new Error("Invalid migration quarantine receipt.");
	}
}

function parseCanonicalJson(path: string, bytes: Uint8Array): unknown {
	const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
	if (text.length === 0 || text.charCodeAt(0) === 0xfeff || !text.endsWith("\n")) {
		throw new Error(`Invalid migration artifact bytes: ${path}`);
	}
	const value: unknown = JSON.parse(text.slice(0, -1));
	if (`${canonicalJson(value)}\n` !== text) throw new Error(`Migration artifact is not canonical JSON: ${path}`);
	return value;
}

function normalizeArtifactRelativePath(path: string): string {
	const normalized = normalizePath(path.trim()).replace(/^\/+|\/+$/gu, "");
	const allowedRoots = [
		getCatalogUpgradePackagesRootPath(""),
		getCatalogUpgradeCheckpointsRootPath(""),
		getCatalogUpgradeIssuesRootPath(""),
		getCatalogDeletedRootPath(""),
	];
	if (!allowedRoots.some((root) => normalized === root || normalized.startsWith(`${root}/`)) || normalized.includes("\\")
		|| /(^|\/)\.{1,2}(\/|$)/u.test(normalized) || /[\u0000-\u001f]/u.test(normalized)) {
		throw new Error(`Invalid migration artifact path: ${path}`);
	}
	return normalized;
}

function isMigrationDomainCounts(value: unknown): value is MigrationDomainCounts {
	return isRecord(value)
		&& isNonNegativeInteger(value.identityClaims)
		&& isNonNegativeInteger(value.deletedRecords)
		&& isNonNegativeInteger(value.relations)
		&& isNonNegativeInteger(value.reviewOrdinals)
		&& isNonNegativeInteger(value.pendingCreates)
		&& isNonNegativeInteger(value.diagnostics);
}

function isMigrationCommitDomainCounts(value: unknown): value is MigrationCommitDomainCounts {
	return isMigrationDomainCounts(value)
		&& isRecord(value)
		&& isNonNegativeInteger(value.quarantinedArtifacts);
}

function isMigrationCommitVerification(value: unknown): value is MigrationCommitVerification {
	if (!isRecord(value) || !isRecord(value.structure) || !isRecord(value.runtime) || !isRecord(value.catalog)) {
		return false;
	}
	const structure = value.structure;
	const runtime = value.runtime;
	const catalog = value.catalog;
	return structure.requiredArtifactsVerified === true
		&& structure.existingMemoIdsPreserved === true
		&& structure.domainCountsVerified === true
		&& structure.deletedPayloadsVerified === true
		&& structure.dailyHashesUnchanged === true
		&& runtime.v2ColdStartPassed === true
		&& runtime.outboxDrained === true
		&& runtime.legacyReadsDisabled === true
		&& runtime.legacyWriterRemoved === true
		&& catalog.coverage === "complete"
		&& isNonNegativeInteger(catalog.observationCount)
		&& isNonNegativeInteger(catalog.identifiedCount)
		&& isNonNegativeInteger(catalog.observedCount)
		&& isNonNegativeInteger(catalog.ambiguousCount)
		&& Number(catalog.observationCount) === Number(catalog.identifiedCount)
			+ Number(catalog.observedCount) + Number(catalog.ambiguousCount)
		&& Array.isArray(catalog.failedPaths)
		&& catalog.failedPaths.length === 0;
}

function isLegacyEvidence(value: unknown): boolean {
	return isRecord(value) && isVaultPath(value.sourcePath)
		&& DATE_PATTERN.test(readString(value.logicalDate))
		&& (value.section === null || typeof value.section === "string")
		&& TIME_PATTERN.test(readString(value.time))
		&& LEGACY_HASH_PATTERN.test(readString(value.contentHash))
		&& LEGACY_HASH_PATTERN.test(readString(value.lastKnownBlockHash))
		&& (value.existingBlockId === null
			|| (typeof value.existingBlockId === "string" && value.existingBlockId.length > 0))
		&& (value.lineNumberHint === null || isPositiveInteger(value.lineNumberHint));
}

function isArtifactRef(value: unknown): value is ArtifactRef {
	return isRecord(value) && isVaultPath(value.path)
		&& SHA256_PATTERN.test(readString(value.sha256)) && isPositiveInteger(value.byteLength);
}

function sameArtifactRef(left: ArtifactRef, right: ArtifactRef): boolean {
	return left.path === right.path && left.sha256 === right.sha256 && left.byteLength === right.byteLength;
}

function isLegacyArtifactKind(value: unknown): boolean {
	return typeof value === "string" && LEGACY_ARTIFACT_KINDS.has(value);
}

function isMemoId(value: unknown): value is string {
	return typeof value === "string" && MEMO_ID_PATTERN.test(value);
}

function isVaultPath(value: unknown): value is string {
	return typeof value === "string" && value.length > 0 && normalizePath(value) === value
		&& !value.startsWith("/") && !/(^|\/)\.{1,2}(\/|$)/u.test(value)
		&& !/[\\\u0000-\u001f]/u.test(value);
}

function isDateTime(value: unknown): value is string {
	return typeof value === "string" && value.length > 0 && Number.isFinite(Date.parse(value));
}

function isIsoDate(value: unknown): value is string {
	return typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u.test(value)
		&& Number.isFinite(Date.parse(value));
}

function isNonNegativeInteger(value: unknown): boolean {
	return Number.isInteger(value) && Number(value) >= 0;
}

function isPositiveInteger(value: unknown): boolean {
	return Number.isInteger(value) && Number(value) > 0;
}

function isSortedUniqueStrings(value: unknown[]): value is string[] {
	return value.every((item) => typeof item === "string")
		&& value.every((item, index) => index === 0 || String(value[index - 1]) < item);
}

function readString(value: unknown): string {
	return typeof value === "string" ? value : "";
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
	return left.byteLength === right.byteLength && left.every((value, index) => value === right[index]);
}
