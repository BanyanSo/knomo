import { normalizePath, TFile, TFolder, Vault } from "obsidian";
import type { App } from "obsidian";

import type {
	LegacyArtifactKind,
	LegacyIndexDiagnostic,
	LegacyIndexMemo,
	LegacyIndexSnapshot,
	LegacyIndexSource,
	LegacyIndexSourceResult,
	LegacyPendingMemo,
	LegacyReviewState,
} from "../types/legacyIndex";
import { hashMemoContent, hashText } from "../utils/hash";
import { extractTrailingBlockId, findLastEffectiveLineIndex, splitMarkdownLines } from "../utils/markdown";
import { isRecord } from "../utils/object";
import { getLegacySystemRootPath } from "../utils/path";
import {
	canonicalIdentityLedgerJson,
	sha256IdentityLedgerText,
} from "./IdentityLedgerProtocol";
import { classifyLegacyArtifactPath, classifyPluginDataPath } from "./LegacyArtifactInventory";

const LEGACY_MEMO_ID_PATTERN = /^\d{16}$/u;
const HASH_PATTERN = /^fnv1a-[a-f0-9]{8}$/u;
const DATE_PATTERN = /^\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])$/u;
const PERIOD_PATTERN = /^\d{4}-(?:0[1-9]|1[0-2])$/u;
const TIME_PATTERN = /^(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?$/u;
const MAX_LEGACY_REVIEW_COUNT = 1000;

interface LegacyArtifact {
	artifactKind: LegacyArtifactKind;
	path: string;
	bytes: Uint8Array;
}

interface LegacyArtifactInventory {
	artifacts: LegacyArtifact[];
	legacySystemRoot: string;
	legacySystemRootPresent: boolean;
	unknownPaths: string[];
}

interface ParsedLegacyData {
	memos: ParsedLegacyMemo[];
	pendingMemos: LegacyPendingMemo[];
	reviews: LegacyReviewState[];
	diagnostics: LegacyIndexDiagnostic[];
}

interface ParsedLegacyMemo extends LegacyIndexMemo {
	contentSnapshot: string;
	referenceMemoId: string | null;
	rawBlock: string;
}

interface LegacyBlockReferenceCandidate {
	linkPath: string;
	blockId: string;
	sourceMemoIdAlias: string | null;
}

export class LegacyIndexReader implements LegacyIndexSource {
	constructor(
		private readonly app: App,
		private readonly pluginId: string,
		private readonly getKnomoDataRoot: () => string | null,
	) {}

	async load(): Promise<LegacyIndexSourceResult> {
		const knomoDataRoot = this.getConfiguredRoot();
		if (knomoDataRoot === null) return { kind: "missing" };
		const inventory = await this.collectArtifacts(knomoDataRoot);
		if (!inventory.legacySystemRootPresent) return { kind: "missing" };
		const { artifacts } = inventory;
		if (artifacts.length === 0 && inventory.unknownPaths.length === 0) return { kind: "missing" };

		const parsed = createParsedLegacyData();
		for (const path of inventory.unknownPaths) {
			parsed.diagnostics.push(diagnostic(
				"legacy_inventory_unknown_file",
				path,
				null,
				"The legacy system folder contains a file that Knomo 1.2.9 does not recognize.",
			));
		}
		let relevantArtifactCount = 0;
		for (const artifact of artifacts) {
			switch (artifact.artifactKind) {
				case "memo_index":
				relevantArtifactCount += 1;
					this.parseMemoIndex(artifact, parsed);
					break;
				case "pending_create":
					relevantArtifactCount += 1;
					this.parsePendingCreates(artifact, parsed);
					break;
				case "plugin_data":
					relevantArtifactCount += this.parsePluginData(artifact, parsed) ? 1 : 0;
					break;
				case "repair_candidate":
					parsed.diagnostics.push(diagnostic(
						"legacy_repair_candidate_ignored",
						artifact.path,
						null,
						"Legacy repair candidates cannot establish stable identity.",
					));
					break;
				case "time_buoy_index":
				case "time_buoy_state":
					break;
			}
		}

		if (relevantArtifactCount === 0) {
			return inventory.unknownPaths.length === 0
				? { kind: "missing" }
				: { kind: "attention", diagnostics: parsed.diagnostics.sort(compareDiagnostic) };
		}
		const mergedMemos = mergeMemos(parsed.memos, parsed.diagnostics);
		const memos = recoverLegacySourceMemoIds(mergedMemos, (linkPath, sourcePath) => {
			if (linkPath.length === 0) return sourcePath;
			const file = this.app.metadataCache.getFirstLinkpathDest(linkPath, sourcePath);
			return file instanceof TFile ? file.path : null;
		});
		const pendingMemos = mergePendingMemos(parsed.pendingMemos, new Set(memos.map((memo) => memo.memoId)), parsed.diagnostics);
		const reviews = mergeReviews(parsed.reviews, parsed.diagnostics);
		if (memos.length === 0 && pendingMemos.length === 0 && reviews.length === 0) {
			return { kind: "attention", diagnostics: parsed.diagnostics };
		}
		const sourceRevision = await sha256IdentityLedgerText(canonicalIdentityLedgerJson({
			memos,
			pendingMemos,
			reviews,
		}));
		const snapshot: LegacyIndexSnapshot = {
			sourceId: `legacy-index:${knomoDataRoot}`,
			sourceRevision,
			legacySystemRoot: inventory.legacySystemRoot,
			legacySystemRootPresent: inventory.legacySystemRootPresent,
			memos,
			pendingMemos,
			reviews,
			diagnostics: parsed.diagnostics.sort(compareDiagnostic),
		};
		return { kind: "ready", snapshot };
	}

	isSourcePath(path: string): boolean {
		const knomoDataRoot = this.getConfiguredRoot();
		if (knomoDataRoot === null) return false;
		const normalized = normalizePath(path);
		const legacyRoot = getLegacySystemRootPath(knomoDataRoot);
		if (normalized.startsWith(`${legacyRoot}/`)) return true;
		return classifyPluginDataPath(this.getConfigDir(), this.pluginId, normalized) !== null;
	}

	private parseMemoIndex(artifact: LegacyArtifact, result: ParsedLegacyData): void {
		const parsed = parseJson(artifact, result.diagnostics);
		if (!isRecord(parsed)
			|| parsed.schemaVersion !== 2
			|| typeof parsed.period !== "string"
			|| !PERIOD_PATTERN.test(parsed.period)
			|| !isRecord(parsed.memos)) {
			result.diagnostics.push(diagnostic("legacy_memo_index_invalid", artifact.path, null, "Legacy Memo Index structure is invalid."));
			return;
		}
		for (const [memoId, value] of Object.entries(parsed.memos)) {
			const memo = parseMemoRecord(memoId, value);
			if (memo === null) {
				result.diagnostics.push(diagnostic("legacy_memo_record_invalid", artifact.path, memoId, "Legacy memo record or memoId is invalid."));
				continue;
			}
			result.memos.push(memo);
		}
	}

	private parsePendingCreates(artifact: LegacyArtifact, result: ParsedLegacyData): void {
		const parsed = parseJson(artifact, result.diagnostics);
		if (!isRecord(parsed) || parsed.schemaVersion !== 1 || !isRecord(parsed.operations)) {
			result.diagnostics.push(diagnostic("legacy_pending_create_invalid", artifact.path, null, "Legacy pending-create journal is invalid."));
			return;
		}
		for (const [memoId, value] of Object.entries(parsed.operations)) {
			const pendingMemo = parsePendingMemo(memoId, value);
			if (pendingMemo === null) {
				result.diagnostics.push(diagnostic("legacy_pending_record_invalid", artifact.path, memoId, "Legacy pending-create record is invalid."));
				continue;
			}
			result.pendingMemos.push(pendingMemo);
		}
	}

	private parsePluginData(artifact: LegacyArtifact, result: ParsedLegacyData): boolean {
		const parsed = parseJson(artifact, result.diagnostics);
		if (!isRecord(parsed) || !("randomReunionReviewStates" in parsed)) return false;
		if (!isRecord(parsed.randomReunionReviewStates)) {
			result.diagnostics.push(diagnostic("legacy_review_state_invalid", artifact.path, null, "Legacy random-reunion review state is invalid."));
			return true;
		}
		for (const [memoId, value] of Object.entries(parsed.randomReunionReviewStates)) {
			const review = parseReviewState(memoId, value);
			if (review === null) {
				result.diagnostics.push(diagnostic("legacy_review_record_invalid", artifact.path, memoId, "Legacy review record is invalid."));
				continue;
			}
			result.reviews.push(review);
		}
		return true;
	}

	private async collectArtifacts(knomoDataRoot: string): Promise<LegacyArtifactInventory> {
		const artifacts: LegacyArtifact[] = [];
		const unknownPaths: string[] = [];
		const legacyRoot = getLegacySystemRootPath(knomoDataRoot);
		const folder = this.app.vault.getAbstractFileByPath(legacyRoot);
		if (folder instanceof TFolder) {
			const files: TFile[] = [];
			Vault.recurseChildren(folder, (child) => {
				if (child instanceof TFile) files.push(child);
			});
			for (const file of files.sort((left, right) => left.path.localeCompare(right.path))) {
				const classification = classifyLegacyArtifactPath(legacyRoot, file.path);
				if (classification === null) {
					unknownPaths.push(file.path);
					continue;
				}
				const bytes = new Uint8Array(await this.app.vault.readBinary(file));
				artifacts.push({
					artifactKind: classification.artifactKind,
					path: file.path,
					bytes,
				});
			}
		}
		const pluginData = await this.readPluginData();
		if (pluginData !== null) artifacts.push(pluginData);
		return {
			artifacts: artifacts.sort((left, right) => left.path.localeCompare(right.path)),
			legacySystemRoot: legacyRoot,
			legacySystemRootPresent: folder instanceof TFolder,
			unknownPaths: unknownPaths.sort((left, right) => left.localeCompare(right)),
		};
	}

	private async readPluginData(): Promise<LegacyArtifact | null> {
		const path = normalizePath(`${this.getConfigDir()}/plugins/${this.pluginId}/data.json`);
		if (!await this.app.vault.adapter.exists(path)) return null;
		try {
			const bytes = new Uint8Array(await this.app.vault.adapter.readBinary(path));
			return {
				artifactKind: "plugin_data",
				path,
				bytes,
			};
		} catch (error) {
			throw new Error(`Failed to read legacy plugin data at ${path}: ${errorMessage(error)}`);
		}
	}

	private getConfiguredRoot(): string | null {
		const value = this.getKnomoDataRoot();
		return value === null ? null : normalizePath(value);
	}

	private getConfigDir(): string {
		return (this.app.vault as App["vault"] & { configDir?: string }).configDir ?? ".obsidian";
	}
}

function parseMemoRecord(memoId: string, value: unknown): ParsedLegacyMemo | null {
	if (!LEGACY_MEMO_ID_PATTERN.test(memoId)
		|| !isRecord(value)
		|| value.id !== memoId
		|| (value.status !== "active" && value.status !== "deleted" && value.status !== "error")
		|| !isDateTime(value.createdAt)
		|| !isDateTime(value.updatedAt)
		|| typeof value.contentHash !== "string"
		|| !HASH_PATTERN.test(value.contentHash)
		|| !isRecord(value.dailyRef)) return null;
	const dailyRef = value.dailyRef;
	if (!isVaultPath(dailyRef.path)
		|| typeof dailyRef.lastKnownBlock !== "string"
		|| dailyRef.lastKnownBlock.length === 0
		|| typeof dailyRef.lastKnownHash !== "string"
		|| !HASH_PATTERN.test(dailyRef.lastKnownHash)
		|| (dailyRef.heading !== null && typeof dailyRef.heading !== "string")
		|| (dailyRef.sectionType !== undefined && dailyRef.sectionType !== "heading" && dailyRef.sectionType !== "root")
		|| (dailyRef.lineNumberHint !== null && !isPositiveInteger(dailyRef.lineNumberHint))) return null;
	const sourceMemoId = parseLegacyMemoIdOrNull(value.sourceMemoId);
	if (value.sourceMemoId !== null && sourceMemoId === null) return null;
	const evidence = {
		sourcePath: normalizePath(dailyRef.path),
		logicalDate: readLogicalDate(dailyRef.path, value.createdAt),
		section: dailyRef.sectionType === "root" ? null : dailyRef.heading as string | null,
		time: readMemoTime(dailyRef.lastKnownBlock, value.createdAt),
		contentHash: value.contentHash,
		lastKnownBlockHash: dailyRef.lastKnownHash,
		lineNumberHint: dailyRef.lineNumberHint === null ? null : dailyRef.lineNumberHint,
	};
	const deletedRawBlock = typeof value.deletedDailyBlock === "string" && value.deletedDailyBlock.length > 0
		? value.deletedDailyBlock
		: dailyRef.lastKnownBlock;
	return {
		memoId,
		status: value.status,
		createdAt: value.createdAt,
		updatedAt: value.updatedAt,
		evidence,
		sourceMemoId,
		deletedPayload: value.status === "deleted" ? {
			deletedAt: isDateTime(value.deletedAt) ? value.deletedAt : value.updatedAt,
			sourcePath: evidence.sourcePath,
			logicalDate: evidence.logicalDate,
			section: evidence.section,
			rawBlock: deletedRawBlock,
			contentHash: value.contentHash,
			sourceMemoId,
		} : null,
		contentSnapshot: typeof value.contentSnapshot === "string" ? value.contentSnapshot : "",
		referenceMemoId: readLegacyReferenceMemoId(value.references),
		rawBlock: dailyRef.lastKnownBlock,
	};
}

function parsePendingMemo(memoId: string, value: unknown): LegacyPendingMemo | null {
	if (!LEGACY_MEMO_ID_PATTERN.test(memoId)
		|| !isRecord(value)
		|| value.memoId !== memoId
		|| !isDateTime(value.createdAt)
		|| typeof value.content !== "string"
		|| typeof value.block !== "string"
		|| value.block.length === 0
		|| !isRecord(value.dailyWrite)
		|| !isVaultPath(value.dailyWrite.path)) return null;
	const sourceMemoId = parseLegacyMemoIdOrNull(value.sourceMemoId);
	if (value.sourceMemoId !== null && sourceMemoId === null) return null;
	const ref = isRecord(value.dailyWrite.ref) ? value.dailyWrite.ref : null;
	const heading = ref !== null && (ref.heading === null || typeof ref.heading === "string") ? ref.heading : null;
	const section = ref?.sectionType === "root" ? null : heading;
	const lineNumberHint = ref !== null && isPositiveInteger(ref.lineNumberHint) ? ref.lineNumberHint : null;
	return {
		memoId,
		createdAt: value.createdAt,
		evidence: {
			sourcePath: normalizePath(value.dailyWrite.path),
			logicalDate: readLogicalDate(value.dailyWrite.path, value.createdAt),
			section,
			time: readMemoTime(value.block, value.createdAt),
			contentHash: hashMemoContent(value.content),
			lastKnownBlockHash: hashText(normalizeNewlines(value.block)),
			lineNumberHint,
		},
		sourceMemoId,
	};
}

function parseReviewState(memoId: string, value: unknown): LegacyReviewState | null {
	if (!LEGACY_MEMO_ID_PATTERN.test(memoId)
		|| !isRecord(value)
		|| value.memoId !== memoId
		|| !isNonNegativeInteger(value.reviewCount)
		|| value.reviewCount > MAX_LEGACY_REVIEW_COUNT
		|| (value.lastReviewedAt !== null && value.lastReviewedAt !== undefined && !isDateTime(value.lastReviewedAt))) return null;
	return {
		memoId,
		reviewCount: value.reviewCount,
		lastReviewedAt: value.lastReviewedAt === undefined ? null : value.lastReviewedAt,
	};
}

function mergeMemos(values: readonly ParsedLegacyMemo[], diagnostics: LegacyIndexDiagnostic[]): ParsedLegacyMemo[] {
	const byMemoId = groupByMemoId(values);
	const result: ParsedLegacyMemo[] = [];
	for (const [memoId, candidates] of [...byMemoId.entries()].sort(compareEntry)) {
		const unique = dedupeByCanonical(candidates, memoIdentityKey);
		if (unique.length !== 1) {
			diagnostics.push(diagnostic("legacy_identity_conflict", null, memoId, "Legacy index contains conflicting records for one memoId."));
			continue;
		}
		result.push(unique[0] as ParsedLegacyMemo);
	}
	return result;
}

function mergePendingMemos(
	values: readonly LegacyPendingMemo[],
	indexedMemoIds: ReadonlySet<string>,
	diagnostics: LegacyIndexDiagnostic[],
): LegacyPendingMemo[] {
	const byMemoId = groupByMemoId(values);
	const result: LegacyPendingMemo[] = [];
	for (const [memoId, candidates] of [...byMemoId.entries()].sort(compareEntry)) {
		if (indexedMemoIds.has(memoId)) continue;
		const unique = dedupeByCanonical(candidates, (value) => value);
		if (unique.length !== 1) {
			diagnostics.push(diagnostic("legacy_pending_conflict", null, memoId, "Legacy pending-create data conflicts for one memoId."));
			continue;
		}
		result.push(unique[0] as LegacyPendingMemo);
	}
	return result;
}

function mergeReviews(values: readonly LegacyReviewState[], diagnostics: LegacyIndexDiagnostic[]): LegacyReviewState[] {
	const byMemoId = groupByMemoId(values);
	const result: LegacyReviewState[] = [];
	for (const [memoId, candidates] of [...byMemoId.entries()].sort(compareEntry)) {
		const unique = dedupeByCanonical(candidates, (value) => value);
		if (unique.length !== 1) {
			diagnostics.push(diagnostic("legacy_review_conflict", null, memoId, "Legacy review state conflicts for one memoId."));
			continue;
		}
		result.push(unique[0] as LegacyReviewState);
	}
	return result;
}

function memoIdentityKey(value: ParsedLegacyMemo): unknown {
	return {
		memoId: value.memoId,
		status: value.status,
		createdAt: value.createdAt,
		evidence: value.evidence,
		sourceMemoId: value.sourceMemoId,
		deletedPayload: value.deletedPayload,
		contentSnapshot: value.contentSnapshot,
		referenceMemoId: value.referenceMemoId,
		rawBlock: value.rawBlock,
	};
}

function recoverLegacySourceMemoIds(
	values: readonly ParsedLegacyMemo[],
	resolveLinkPath: (linkPath: string, sourcePath: string) => string | null,
): LegacyIndexMemo[] {
	const sourceMemoIdsByTarget = buildLegacySourceMemoIdsByTarget(values);
	const sourceMemoIdsByTimestamp = buildLegacySourceMemoIdsByTimestamp(values);
	return values.map((value) => {
		const recoveredSourceMemoId = value.sourceMemoId
			?? value.referenceMemoId
			?? resolveLegacyReferenceCandidate(value, sourceMemoIdsByTarget, sourceMemoIdsByTimestamp, resolveLinkPath);
		return {
			memoId: value.memoId,
			status: value.status,
			createdAt: value.createdAt,
			updatedAt: value.updatedAt,
			evidence: value.evidence,
			sourceMemoId: recoveredSourceMemoId,
			deletedPayload: value.deletedPayload === null ? null : {
				...value.deletedPayload,
				sourceMemoId: value.deletedPayload.sourceMemoId ?? recoveredSourceMemoId,
			},
		};
	});
}

function resolveLegacyReferenceCandidate(
	memo: ParsedLegacyMemo,
	sourceMemoIdsByTarget: ReadonlyMap<string, ReadonlySet<string>>,
	sourceMemoIdsByTimestamp: ReadonlyMap<string, ReadonlySet<string>>,
	resolveLinkPath: (linkPath: string, sourcePath: string) => string | null,
): string | null {
	const resolved = new Set<string>();
	for (const candidate of parseLegacyBlockReferenceCandidates(memo.contentSnapshot)) {
		const resolvedPath = resolveLinkPath(candidate.linkPath, memo.evidence.sourcePath);
		const targetMemoIds = resolvedPath === null
			? undefined
			: sourceMemoIdsByTarget.get(`${resolvedPath}#^${candidate.blockId}`);
		const targetMemoId = targetMemoIds?.size === 1 ? [...targetMemoIds][0] ?? null : null;
		const sourceMemoId = targetMemoId
			?? resolveLegacyMemoIdAlias(candidate.sourceMemoIdAlias, sourceMemoIdsByTimestamp);
		if (sourceMemoId !== null) resolved.add(sourceMemoId);
	}
	return resolved.size === 1 ? [...resolved][0] ?? null : null;
}

function buildLegacySourceMemoIdsByTarget(values: readonly ParsedLegacyMemo[]): Map<string, Set<string>> {
	const result = new Map<string, Set<string>>();
	for (const value of values) {
		const lines = splitMarkdownLines(value.rawBlock);
		const lastLineIndex = findLastEffectiveLineIndex(lines);
		const blockId = lastLineIndex === -1 ? null : extractTrailingBlockId(lines[lastLineIndex] ?? "").blockId;
		if (blockId === null) continue;
		const key = `${value.evidence.sourcePath}#^${blockId}`;
		const memoIds = result.get(key) ?? new Set<string>();
		memoIds.add(value.memoId);
		result.set(key, memoIds);
	}
	return result;
}

function buildLegacySourceMemoIdsByTimestamp(values: readonly ParsedLegacyMemo[]): Map<string, Set<string>> {
	const result = new Map<string, Set<string>>();
	for (const value of values) {
		const timestamp = value.memoId.slice(0, 14);
		const memoIds = result.get(timestamp) ?? new Set<string>();
		memoIds.add(value.memoId);
		result.set(timestamp, memoIds);
	}
	return result;
}

function parseLegacyBlockReferenceCandidates(content: string): LegacyBlockReferenceCandidate[] {
	const candidates: LegacyBlockReferenceCandidate[] = [];
	let codeFence: "`" | "~" | null = null;
	for (const line of splitMarkdownLines(content)) {
		const fence = line.trim().match(/^(`{3,}|~{3,})/u)?.[1]?.charAt(0) as "`" | "~" | undefined;
		if (fence !== undefined) {
			codeFence = codeFence === null ? fence : codeFence === fence ? null : codeFence;
			continue;
		}
		if (codeFence !== null || /^\s*>/u.test(line)) continue;
		const pattern = /!?\[\[([^\]]+#\^[^\]]+)\]\]/gu;
		let match = pattern.exec(line);
		while (match !== null) {
			const value = match[1] ?? "";
			const separatorIndex = value.indexOf("|");
			const target = separatorIndex === -1 ? value : value.slice(0, separatorIndex);
			const alias = separatorIndex === -1 ? null : value.slice(separatorIndex + 1);
			const fragmentIndex = target.lastIndexOf("#^");
			if (fragmentIndex !== -1 && fragmentIndex + 2 < target.length) {
				candidates.push({
					linkPath: target.slice(0, fragmentIndex),
					blockId: target.slice(fragmentIndex + 2),
					sourceMemoIdAlias: parseLegacyMemoIdAlias(alias),
				});
			}
			match = pattern.exec(line);
		}
	}
	return candidates;
}

function parseLegacyMemoIdAlias(alias: string | null): string | null {
	if (alias === null) return null;
	if (/^\d{14}(?:\d{2})?$/u.test(alias)) return alias;
	const formatted = /^(\d{8})-(\d{6})(?:-(\d{2}))?$/u.exec(alias);
	return formatted === null ? null : `${formatted[1]}${formatted[2]}${formatted[3] ?? ""}`;
}

function resolveLegacyMemoIdAlias(
	alias: string | null,
	sourceMemoIdsByTimestamp: ReadonlyMap<string, ReadonlySet<string>>,
): string | null {
	if (alias === null || LEGACY_MEMO_ID_PATTERN.test(alias)) return alias;
	const memoIds = sourceMemoIdsByTimestamp.get(alias);
	return memoIds?.size === 1 ? [...memoIds][0] ?? null : null;
}

function readLegacyReferenceMemoId(value: unknown): string | null {
	if (!Array.isArray(value) || !isRecord(value[0])) return null;
	return parseLegacyMemoIdOrNull(value[0].memoId);
}

function groupByMemoId<T extends { memoId: string }>(values: readonly T[]): Map<string, T[]> {
	const result = new Map<string, T[]>();
	for (const value of values) {
		const candidates = result.get(value.memoId) ?? [];
		candidates.push(value);
		result.set(value.memoId, candidates);
	}
	return result;
}

function dedupeByCanonical<T>(values: readonly T[], select: (value: T) => unknown): T[] {
	const unique = new Map<string, T>();
	for (const value of values) unique.set(canonicalIdentityLedgerJson(select(value)), value);
	return [...unique.values()];
}

function parseJson(artifact: LegacyArtifact, diagnostics: LegacyIndexDiagnostic[]): unknown {
	try {
		const text = new TextDecoder("utf-8", { fatal: true }).decode(artifact.bytes).replace(/^\uFEFF/u, "");
		return JSON.parse(text) as unknown;
	} catch {
		diagnostics.push(diagnostic("legacy_json_invalid", artifact.path, null, "Legacy data file is not valid JSON."));
		return null;
	}
}

function readLogicalDate(path: string, createdAt: string): string {
	const fromPath = /(?:^|\/)(\d{4}-\d{2}-\d{2})(?:\.[^/]*)?$/u.exec(path)?.[1];
	if (fromPath !== undefined && DATE_PATTERN.test(fromPath)) return fromPath;
	return createdAt.slice(0, 10);
}

function readMemoTime(rawBlock: string, createdAt: string): string {
	const value = /^\s*-\s+((?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?)(?:\s|$)/u.exec(rawBlock)?.[1]
		?? createdAt.slice(11, 19);
	return TIME_PATTERN.test(value) ? value : "00:00:00";
}

function parseLegacyMemoIdOrNull(value: unknown): string | null {
	return typeof value === "string" && LEGACY_MEMO_ID_PATTERN.test(value) ? value : null;
}

function isDateTime(value: unknown): value is string {
	return typeof value === "string" && value.length > 0 && Number.isFinite(Date.parse(value));
}

function isNonNegativeInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function isPositiveInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isInteger(value) && value >= 1;
}

function isVaultPath(value: unknown): value is string {
	return typeof value === "string" && value.length > 0 && !value.startsWith("/") && !value.includes("\\")
		&& !/(^|\/)\.{1,2}(\/|$)/u.test(value) && !/[\u0000-\u001f]/u.test(value);
}

function normalizeNewlines(value: string): string {
	return value.replace(/\r\n/gu, "\n").replace(/\r/gu, "\n");
}

function createParsedLegacyData(): ParsedLegacyData {
	return { memos: [], pendingMemos: [], reviews: [], diagnostics: [] };
}

function diagnostic(code: string, sourcePath: string | null, memoId: string | null, detail: string): LegacyIndexDiagnostic {
	return { code, sourcePath, memoId, detail };
}

function compareDiagnostic(left: LegacyIndexDiagnostic, right: LegacyIndexDiagnostic): number {
	return `${left.code}\u0000${left.sourcePath ?? ""}\u0000${left.memoId ?? ""}`
		.localeCompare(`${right.code}\u0000${right.sourcePath ?? ""}\u0000${right.memoId ?? ""}`);
}

function compareEntry<T>(left: readonly [string, T], right: readonly [string, T]): number {
	return left[0].localeCompare(right[0]);
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
