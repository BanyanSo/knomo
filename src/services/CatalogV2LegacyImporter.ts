import type {
	DeletedMemoPayload,
	LegacyArtifactInput,
	LegacyArtifactReceipt,
	LegacyImportResult,
	MigrationDeletedRecord,
	MigrationDiagnostic,
	MigrationIdentityClaim,
	MigrationPackage,
	MigrationPayloadPreview,
	MigrationPendingCreate,
	MigrationRelation,
	MigrationReview,
	QuarantineReceipt,
} from "../types/catalogV2";
import { hashMemoContent } from "../utils/hash";
import { isRecord } from "../utils/object";
import {
	getCatalogDeletedPayloadPath,
	getCatalogUpgradeIssuePath,
	getCatalogUpgradePackagePath,
} from "../utils/path";
import { canonicalJson, canonicalJsonFileBytes, compareText, sha256Bytes, sha256Text } from "./CatalogV2Protocol";

const IMPORTER_VERSION = 1;
const MEMO_ID_PATTERN = /^[^/\\\u0000-\u001f]{1,200}$/;
const LEGACY_HASH_PATTERN = /^fnv1a-[a-f0-9]{8}$/;
const PERIOD_PATTERN = /^\d{4}-(?:0[1-9]|1[0-2])$/;
const DATE_PATTERN = /^\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])$/;
const TIME_PATTERN = /^(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?$/;

interface ImportAccumulator {
	legacySchemaVersion: number | null;
	period: string | null;
	recordCount: number;
	identityClaims: MigrationIdentityClaim[];
	deletedRecords: MigrationDeletedRecord[];
	relations: MigrationRelation[];
	reviews: MigrationReview[];
	pendingCreates: MigrationPendingCreate[];
	diagnostics: MigrationDiagnostic[];
	deletedPayloads: MigrationPayloadPreview[];
	preservedRecordDigests: string[];
	invalid: boolean;
}

export class CatalogV2LegacyImporter {
	async importArtifact(input: LegacyArtifactInput): Promise<LegacyImportResult> {
		const artifactDigest = await sha256Bytes(input.bytes);
		let parsed: unknown;
		try {
			const text = new TextDecoder("utf-8", { fatal: true }).decode(input.bytes).replace(/^\uFEFF/, "");
			parsed = JSON.parse(text) as unknown;
		} catch {
			return this.buildQuarantine(input, artifactDigest, "invalid_json", 0, []);
		}

		const accumulator = createAccumulator();
		try {
			switch (input.artifactKind) {
				case "memo_index":
					await importMemoIndex(parsed, input, artifactDigest, accumulator);
					break;
				case "pending_create":
					await importPendingCreates(parsed, accumulator);
					break;
				case "plugin_data":
					await importPluginData(parsed, accumulator);
					break;
				case "time_buoy_index":
					await importTimeBuoyIndex(parsed, accumulator);
					break;
				case "time_buoy_state":
					await importTimeBuoyState(parsed, accumulator);
					break;
				case "repair_candidate":
					accumulator.invalid = true;
					break;
			}
		} catch {
			accumulator.invalid = true;
		}

		if (accumulator.invalid) {
			return this.buildQuarantine(
				input,
				artifactDigest,
				"legacy_schema_invalid",
				accumulator.preservedRecordDigests.length,
				accumulator.preservedRecordDigests,
				accumulator.legacySchemaVersion,
			);
		}

		sortPackageArrays(accumulator);
		const packageValue: MigrationPackage = {
			kind: "knomo.catalog-v2.migration-package",
			schemaVersion: 1,
			importerVersion: IMPORTER_VERSION,
			source: {
				artifactDigest,
				artifactKind: input.artifactKind,
				byteLength: input.bytes.byteLength,
				legacySchemaVersion: accumulator.legacySchemaVersion,
				period: accumulator.period,
				recordCount: accumulator.recordCount,
			},
			identityClaims: accumulator.identityClaims,
			deletedRecords: accumulator.deletedRecords,
			relations: accumulator.relations,
			reviews: accumulator.reviews,
			pendingCreates: accumulator.pendingCreates,
			diagnostics: accumulator.diagnostics,
			counts: {
				identityClaims: accumulator.identityClaims.length,
				deletedRecords: accumulator.deletedRecords.length,
				relations: accumulator.relations.length,
				reviewOrdinals: accumulator.reviews.reduce((sum, review) => sum + review.reviewCount, 0),
				pendingCreates: accumulator.pendingCreates.length,
				diagnostics: accumulator.diagnostics.length,
			},
		};
		const packagePath = getCatalogUpgradePackagePath("", input.artifactKind, artifactDigest);
		const packageBytes = canonicalJsonFileBytes(packageValue);
		const packageSha256 = await sha256Bytes(packageBytes);
		const receipt: LegacyArtifactReceipt = {
			path: input.path,
			artifactKind: input.artifactKind,
			byteLength: input.bytes.byteLength,
			mtime: input.mtime,
			sha256: artifactDigest,
			legacySchemaVersion: accumulator.legacySchemaVersion,
			readableRecordCount: accumulator.recordCount,
			disposition: "imported",
			requiredArtifact: { path: packagePath, sha256: packageSha256, byteLength: packageBytes.byteLength },
			errorCode: null,
		};
		return {
			kind: "imported",
			receipt,
			package: packageValue,
			packageBytes,
			packageSha256,
			packagePath,
			deletedPayloads: accumulator.deletedPayloads,
		};
	}

	private async buildQuarantine(
		input: LegacyArtifactInput,
		artifactDigest: string,
		errorCode: string,
		recoverableRecordCount: number,
		preservedRecordDigests: string[],
		legacySchemaVersion: number | null = null,
	): Promise<LegacyImportResult> {
		const receipt: QuarantineReceipt = {
			kind: "knomo.catalog-v2.quarantine-receipt",
			schemaVersion: 1,
			artifactDigest,
			artifactKind: input.artifactKind,
			byteLength: input.bytes.byteLength,
			errorCode,
			recoverableRecordCount,
			preservedRecordDigests: [...new Set(preservedRecordDigests)].sort(compareText),
		};
		const path = getCatalogUpgradeIssuePath("", input.artifactKind, artifactDigest);
		const receiptBytes = canonicalJsonFileBytes(receipt);
		const receiptSha256 = await sha256Bytes(receiptBytes);
		return {
			kind: "quarantined",
			receipt,
			receiptBytes,
			receiptSha256,
			path,
			inventory: {
				path: input.path,
				artifactKind: input.artifactKind,
				byteLength: input.bytes.byteLength,
				mtime: input.mtime,
				sha256: artifactDigest,
				legacySchemaVersion,
				readableRecordCount: recoverableRecordCount,
				disposition: "quarantined",
				requiredArtifact: { path, sha256: receiptSha256, byteLength: receiptBytes.byteLength },
				errorCode,
			},
		};
	}
}

async function importMemoIndex(
	value: unknown,
	input: LegacyArtifactInput,
	artifactDigest: string,
	accumulator: ImportAccumulator,
): Promise<void> {
	if (!isRecord(value) || !readNonNegativeInteger(value.schemaVersion) || !isRecord(value.memos)) {
		accumulator.invalid = true;
		return;
	}
	accumulator.legacySchemaVersion = value.schemaVersion;
	accumulator.period = readPeriod(value.period);
	if (accumulator.period === null) accumulator.invalid = true;
	const records = Object.entries(value.memos);
	accumulator.recordCount = records.length;
	for (const [mapKey, record] of records) {
		const digest = await legacyRecordDigest(`memos/${mapKey}`, record);
		if (!isValidMemoRecord(mapKey, record)) {
			accumulator.invalid = true;
			continue;
		}
		accumulator.preservedRecordDigests.push(digest);
		if (record.status === "active" || record.status === "error") {
			accumulator.identityClaims.push({
				memoId: mapKey,
				legacyStatus: record.status,
				legacyRecordDigest: digest,
				evidence: buildLegacyEvidence(record),
			});
		}
		if (record.status === "deleted") {
			const deletedBlock = readString(record.deletedDailyBlock);
			const rawBlock = deletedBlock !== null && deletedBlock.length > 0 ? deletedBlock : readDailyBlock(record);
			if (rawBlock === null) {
				accumulator.invalid = true;
				continue;
			}
			const deleteOpId = await createLegacyEntryId("delete", input.artifactKind, artifactDigest, mapKey, digest, null);
			const payload: DeletedMemoPayload = {
				kind: "knomo.catalog-v2.deleted-payload",
				schemaVersion: 1,
				memoId: mapKey,
				deleteOpId,
				deletedAt: readDateTime(record.deletedAt) ?? readDateTime(record.updatedAt) ?? readDateTime(record.createdAt) ?? "1970-01-01T00:00:00.000Z",
				sourcePath: readDailyPath(record) ?? "unknown.md",
				logicalDate: readLogicalDate(record),
				section: readSection(record),
				rawBlock,
				contentHash: readLegacyHash(record.contentHash) ?? hashMemoContent(rawBlock),
				sourceMemoId: readMemoIdOrNull(record.sourceMemoId),
			};
			const bytes = canonicalJsonFileBytes(payload);
			const sha256 = await sha256Bytes(bytes);
			const path = getCatalogDeletedPayloadPath("", mapKey, deleteOpId);
			const preview = { payload, bytes, sha256, path } satisfies MigrationPayloadPreview;
			accumulator.deletedPayloads.push(preview);
			accumulator.deletedRecords.push({
				memoId: mapKey,
				deleteOpId,
				deletedAt: readDateTime(record.deletedAt),
				deleteSource: readString(record.deleteSource),
				legacyRecordDigest: digest,
				payload: { path, sha256, byteLength: bytes.byteLength },
			});
		}
		const sourceMemoId = readMemoIdOrNull(record.sourceMemoId);
		if (sourceMemoId !== null) {
			accumulator.relations.push({ memoId: mapKey, sourceMemoId, legacyRecordDigest: digest });
		}
	}
}

async function importPendingCreates(value: unknown, accumulator: ImportAccumulator): Promise<void> {
	if (!isRecord(value) || value.schemaVersion !== 1 || !isRecord(value.operations)) {
		accumulator.invalid = true;
		return;
	}
	accumulator.legacySchemaVersion = 1;
	const records = Object.entries(value.operations);
	accumulator.recordCount = records.length;
	for (const [mapKey, operation] of records) {
		const digest = await legacyRecordDigest(`operations/${mapKey}`, operation);
		if (!isValidPendingCreate(mapKey, operation)) {
			accumulator.invalid = true;
			continue;
		}
		accumulator.preservedRecordDigests.push(digest);
		accumulator.pendingCreates.push({
			memoId: mapKey,
			legacyOpId: operation.opId,
			createdAt: operation.createdAt,
			rawBlock: operation.block,
			contentHash: hashMemoContent(operation.content),
			dailyPath: operation.dailyWrite.path,
			dailyBeforeHash: operation.dailyWrite.beforeHash,
			dailyAfterHash: operation.dailyWrite.afterHash,
			source: operation.source,
			sourceMemoId: readMemoIdOrNull(operation.sourceMemoId),
			legacyRecordDigest: digest,
		});
	}
}

async function importPluginData(value: unknown, accumulator: ImportAccumulator): Promise<void> {
	if (!isRecord(value)) {
		accumulator.invalid = true;
		return;
	}
	accumulator.legacySchemaVersion = null;
	const states = value.randomReunionReviewStates;
	if (states === undefined) return;
	if (!isRecord(states)) {
		accumulator.invalid = true;
		return;
	}
	const records = Object.entries(states);
	accumulator.recordCount = records.length;
	for (const [mapKey, review] of records) {
		const digest = await legacyRecordDigest(`randomReunionReviewStates/${mapKey}`, review);
		if (!isRecord(review) || review.memoId !== mapKey || !isMemoId(mapKey)
			|| !Number.isInteger(review.reviewCount) || typeof review.reviewCount !== "number" || review.reviewCount < 0
			|| (review.lastReviewedAt !== null && readDateTime(review.lastReviewedAt) === null)) {
			accumulator.invalid = true;
			continue;
		}
		accumulator.preservedRecordDigests.push(digest);
		accumulator.reviews.push({
			memoId: mapKey,
			reviewCount: review.reviewCount,
			lastReviewedAt: readDateTime(review.lastReviewedAt),
			legacyRecordDigest: digest,
		});
	}
}

async function importTimeBuoyIndex(value: unknown, accumulator: ImportAccumulator): Promise<void> {
	if (!isRecord(value) || !readNonNegativeInteger(value.schemaVersion) || !isRecord(value.dates)) {
		accumulator.invalid = true;
		return;
	}
	const period = readPeriod(value.targetPeriod);
	if (period === null) {
		accumulator.invalid = true;
		return;
	}
	accumulator.legacySchemaVersion = value.schemaVersion;
	accumulator.period = period;
	for (const [date, entries] of Object.entries(value.dates)) {
		if (!DATE_PATTERN.test(date) || !isRecord(entries)) {
			accumulator.invalid = true;
			continue;
		}
		for (const [memoId, entry] of Object.entries(entries)) {
			const digest = await legacyRecordDigest(`dates/${date}/${memoId}`, entry);
			accumulator.recordCount += 1;
			if (!isMemoId(memoId) || !isRecord(entry) || readPeriod(entry.sourcePeriod) === null || typeof entry.buoyRevision !== "string" || entry.buoyRevision.length === 0) {
				accumulator.invalid = true;
				continue;
			}
			accumulator.preservedRecordDigests.push(digest);
		}
	}
}

async function importTimeBuoyState(value: unknown, accumulator: ImportAccumulator): Promise<void> {
	if (!isRecord(value) || value.schemaVersion !== 1 || typeof value.dirty !== "boolean"
		|| !Array.isArray(value.affectedMemoIds) || !value.affectedMemoIds.every(isMemoId)
		|| !Array.isArray(value.expectedPeriods) || !value.expectedPeriods.every((item) => typeof item === "string" && PERIOD_PATTERN.test(item))) {
		accumulator.invalid = true;
		return;
	}
	accumulator.legacySchemaVersion = 1;
	const records: Array<[string, unknown]> = [
		...value.affectedMemoIds.map((memoId) => [`affectedMemoIds/${memoId}`, memoId] as [string, unknown]),
		...value.expectedPeriods.map((period) => [`expectedPeriods/${period}`, period] as [string, unknown]),
	];
	accumulator.recordCount = records.length;
	for (const [key, record] of records) accumulator.preservedRecordDigests.push(await legacyRecordDigest(key, record));
}

function isValidMemoRecord(mapKey: string, value: unknown): value is Record<string, unknown> {
	if (!isRecord(value) || value.id !== mapKey || !isMemoId(mapKey)
		|| !["active", "deleted", "error"].includes(readString(value.status) ?? "")
		|| readDateTime(value.createdAt) === null || readDateTime(value.updatedAt) === null
		|| readLegacyHash(value.contentHash) === null || !isRecord(value.dailyRef)) return false;
	const dailyRef = value.dailyRef;
	return isVaultPath(dailyRef.path)
		&& typeof dailyRef.lastKnownBlock === "string" && dailyRef.lastKnownBlock.length > 0
		&& readLegacyHash(dailyRef.lastKnownHash) !== null
		&& (dailyRef.heading === null || typeof dailyRef.heading === "string")
		&& (dailyRef.lineNumberHint === null || (typeof dailyRef.lineNumberHint === "number" && Number.isInteger(dailyRef.lineNumberHint) && dailyRef.lineNumberHint >= 1))
		&& (value.sourceMemoId === null || isMemoId(value.sourceMemoId));
}

function isValidPendingCreate(mapKey: string, value: unknown): value is Record<string, unknown> & {
	opId: string;
	createdAt: string;
	content: string;
	block: string;
	source: "plugin_input" | "daily_scan" | "quote_create";
	dailyWrite: Record<string, unknown> & { path: string; beforeHash: string; afterHash: string };
} {
	return isRecord(value) && value.memoId === mapKey && isMemoId(mapKey)
		&& typeof value.opId === "string" && value.opId.length > 0 && value.opId.length <= 200
		&& readDateTime(value.createdAt) !== null
		&& typeof value.content === "string" && typeof value.block === "string" && value.block.length > 0
		&& (value.source === "plugin_input" || value.source === "daily_scan" || value.source === "quote_create")
		&& (value.sourceMemoId === null || isMemoId(value.sourceMemoId))
		&& isRecord(value.dailyWrite) && isVaultPath(value.dailyWrite.path)
		&& readLegacyHash(value.dailyWrite.beforeHash) !== null && readLegacyHash(value.dailyWrite.afterHash) !== null;
}

function buildLegacyEvidence(record: Record<string, unknown>): MigrationIdentityClaim["evidence"] {
	const rawBlock = readDailyBlock(record) ?? "";
	return {
		sourcePath: readDailyPath(record) ?? "unknown.md",
		logicalDate: readLogicalDate(record),
		section: readSection(record),
		time: readMemoTime(rawBlock, readDateTime(record.createdAt)),
		contentHash: readLegacyHash(record.contentHash) ?? hashMemoContent(rawBlock),
		lastKnownBlockHash: readDailyHash(record) ?? hashMemoContent(rawBlock),
		existingBlockId: readTrailingBlockId(rawBlock),
		lineNumberHint: readDailyLineHint(record),
	};
}

function readDailyPath(record: Record<string, unknown>): string | null {
	return isRecord(record.dailyRef) && isVaultPath(record.dailyRef.path) ? record.dailyRef.path : null;
}

function readDailyBlock(record: Record<string, unknown>): string | null {
	return isRecord(record.dailyRef) ? readString(record.dailyRef.lastKnownBlock) : null;
}

function readDailyHash(record: Record<string, unknown>): string | null {
	return isRecord(record.dailyRef) ? readLegacyHash(record.dailyRef.lastKnownHash) : null;
}

function readDailyLineHint(record: Record<string, unknown>): number | null {
	const value = isRecord(record.dailyRef) ? record.dailyRef.lineNumberHint : null;
	return typeof value === "number" && Number.isInteger(value) && value >= 1 ? value : null;
}

function readSection(record: Record<string, unknown>): string | null {
	if (!isRecord(record.dailyRef) || record.dailyRef.sectionType === "root") return null;
	return readString(record.dailyRef.heading);
}

function readLogicalDate(record: Record<string, unknown>): string {
	const path = readDailyPath(record);
	const pathMatch = path?.match(/(?:^|\/)(\d{4}-\d{2}-\d{2})(?:\.[^/]*)?$/)?.[1];
	if (pathMatch !== undefined && DATE_PATTERN.test(pathMatch)) return pathMatch;
	return readDateTime(record.createdAt)?.slice(0, 10) ?? "1970-01-01";
}

function readMemoTime(rawBlock: string, createdAt: string | null): string {
	const match = /^\s*-\s+((?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?)(?:\s|$)/.exec(rawBlock);
	if (match?.[1] !== undefined && TIME_PATTERN.test(match[1])) return match[1];
	return createdAt?.slice(11, 19) ?? "00:00:00";
}

function readTrailingBlockId(rawBlock: string): string | null {
	return /(?:^|\s)\^([A-Za-z0-9-]+)\s*$/.exec(rawBlock)?.[1] ?? null;
}

async function legacyRecordDigest(recordKey: string, recordValue: unknown): Promise<string> {
	return sha256Text(canonicalJson({ recordKey, recordValue }));
}

export async function createLegacyEntryId(
	domain: string,
	artifactKind: LegacyArtifactInput["artifactKind"],
	artifactDigest: string,
	memoId: string,
	legacyRecordDigestValue: string,
	ordinal: number | null,
): Promise<string> {
	return `l_${await sha256Text(canonicalJson({
		importerVersion: IMPORTER_VERSION,
		domain,
		artifactKind,
		artifactDigest,
		memoId,
		legacyRecordDigest: legacyRecordDigestValue,
		ordinal,
	}))}`;
}

export async function createLegacyReviewOrdinalId(memoId: string, ordinal: number): Promise<string> {
	return `l_${await sha256Text(canonicalJson({
		importerVersion: IMPORTER_VERSION,
		domain: "review",
		memoId,
		ordinal,
	}))}`;
}

function sortPackageArrays(accumulator: ImportAccumulator): void {
	accumulator.identityClaims.sort(byKeys((item) => [item.memoId, item.legacyRecordDigest]));
	accumulator.deletedRecords.sort(byKeys((item) => [item.memoId, item.deleteOpId, item.legacyRecordDigest]));
	accumulator.relations.sort(byKeys((item) => [item.memoId, item.sourceMemoId, item.legacyRecordDigest]));
	accumulator.reviews.sort(byKeys((item) => [item.memoId, item.legacyRecordDigest]));
	accumulator.pendingCreates.sort(byKeys((item) => [item.memoId, item.legacyOpId, item.legacyRecordDigest]));
	accumulator.diagnostics.sort(byKeys((item) => [item.entryKey, item.code, item.memoId ?? ""]));
	accumulator.deletedPayloads.sort(byKeys((item) => [item.path, item.sha256]));
}

function byKeys<T>(getKeys: (value: T) => string[]): (left: T, right: T) => number {
	return (left, right) => compareText(getKeys(left).join("\u0000"), getKeys(right).join("\u0000"));
}

function createAccumulator(): ImportAccumulator {
	return {
		legacySchemaVersion: null,
		period: null,
		recordCount: 0,
		identityClaims: [],
		deletedRecords: [],
		relations: [],
		reviews: [],
		pendingCreates: [],
		diagnostics: [],
		deletedPayloads: [],
		preservedRecordDigests: [],
		invalid: false,
	};
}

function readString(value: unknown): string | null {
	return typeof value === "string" ? value : null;
}

function readDateTime(value: unknown): string | null {
	return typeof value === "string" && value.length > 0 && Number.isFinite(Date.parse(value)) ? value : null;
}

function readPeriod(value: unknown): string | null {
	return typeof value === "string" && PERIOD_PATTERN.test(value) ? value : null;
}

function readLegacyHash(value: unknown): string | null {
	return typeof value === "string" && LEGACY_HASH_PATTERN.test(value) ? value : null;
}

function readNonNegativeInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function readMemoIdOrNull(value: unknown): string | null {
	return isMemoId(value) ? value : null;
}

function isMemoId(value: unknown): value is string {
	return typeof value === "string" && MEMO_ID_PATTERN.test(value);
}

function isVaultPath(value: unknown): value is string {
	return typeof value === "string" && value.length > 0 && !value.startsWith("/") && !value.includes("\\")
		&& !/(^|\/)\.{1,2}(\/|$)/.test(value) && !/[\u0000-\u001f]/.test(value);
}
