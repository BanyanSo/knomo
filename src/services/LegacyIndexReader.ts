import { normalizePath, TFile, TFolder, Vault } from "obsidian";
import type { App } from "obsidian";

import type {
	LegacyArtifactKind,
	LegacyIndexDiagnostic,
	LegacyIndexMemo,
	LegacyIndexLoadRuntime,
	LegacyIndexSnapshot,
	LegacyIndexSource,
	LegacyIndexSourcePresence,
	LegacyIndexSourceResult,
} from "../types/legacyIndex";
import { formatDatePart, parseMemoCalendarDate } from "../utils/date";
import { isRecord } from "../utils/object";
import { getLegacySystemRootPath } from "../utils/path";
import {
	canonicalJson,
	sha256Text,
} from "../utils/canonicalJson";
import { classifyLegacyArtifactPath } from "./LegacyArtifactInventory";
import { CooperativeYieldController } from "./CooperativeTask";

const LEGACY_MEMO_ID_PATTERN = /^\d{16}$/u;
const HASH_PATTERN = /^fnv1a-[a-f0-9]{8}$/u;
const DATE_PATTERN = /^\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])$/u;
const PERIOD_PATTERN = /^\d{4}-(?:0[1-9]|1[0-2])$/u;

interface LegacyArtifact {
	artifactKind: LegacyArtifactKind;
	path: string;
	period: string | null;
	bytes: Uint8Array | null;
}

interface LegacyArtifactInventory {
	artifacts: LegacyArtifact[];
	legacySystemRoot: string;
	legacySystemRootPresent: boolean;
	unknownPaths: string[];
}

interface ParsedLegacyData {
	memos: LegacyIndexMemo[];
	diagnostics: LegacyIndexDiagnostic[];
}

interface LegacyIndexLoadContext {
	assertActive(): void;
	yieldController: CooperativeYieldController | null;
}

export class LegacyIndexReader implements LegacyIndexSource {
	constructor(
		private readonly app: App,
		private readonly getMonthlyFolder: () => string | null,
	) {}

	inspect(): LegacyIndexSourcePresence {
		const monthlyFolder = this.getConfiguredRoot();
		if (monthlyFolder === null) return { kind: "missing" };
		const legacySystemRoot = getLegacySystemRootPath(monthlyFolder);
		return this.app.vault.getAbstractFileByPath(legacySystemRoot) instanceof TFolder
			? { kind: "present", legacySystemRoot, sourceId: `legacy-index:${monthlyFolder}` }
			: { kind: "missing" };
	}

	async load(runtime: LegacyIndexLoadRuntime = {}): Promise<LegacyIndexSourceResult> {
		const context = createLoadContext(runtime);
		context.assertActive();
		const presence = this.inspect();
		if (presence.kind === "missing") return presence;
		const inventory = await this.collectArtifacts(presence.legacySystemRoot, context);
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
			await checkpoint(context);
		}
		let recognizedArtifactCount = 0;
		for (const artifact of artifacts) {
			await checkpoint(context);
			switch (artifact.artifactKind) {
				case "memo_index":
					recognizedArtifactCount += 1;
					await this.parseMemoIndex(artifact, parsed, context);
					break;
				case "repair_candidate":
					recognizedArtifactCount += 1;
					parsed.diagnostics.push(diagnostic(
						"legacy_repair_candidate_ignored",
						artifact.path,
						null,
						"Legacy repair candidates are not supported Trash records.",
					));
					break;
				case "pending_create":
				case "memo_summary":
				case "time_buoy_index":
				case "time_buoy_state":
				case "backup":
					recognizedArtifactCount += 1;
					break;
			}
		}

		if (recognizedArtifactCount === 0) {
			return inventory.unknownPaths.length === 0
				? { kind: "missing" }
				: { kind: "attention", diagnostics: parsed.diagnostics.sort(compareDiagnostic) };
		}
		const memos = await mergeMemos(parsed.memos, parsed.diagnostics, context);
		if (memos.length === 0 && parsed.diagnostics.length > 0) {
			return { kind: "attention", diagnostics: parsed.diagnostics };
		}
		const revisionJson = await serializeCanonicalArray(memos, context);
		context.assertActive();
		const sourceRevision = await sha256Text(revisionJson);
		context.assertActive();
		const snapshot: LegacyIndexSnapshot = {
			sourceId: presence.sourceId,
			sourceRevision,
			legacySystemRoot: inventory.legacySystemRoot,
			legacySystemRootPresent: inventory.legacySystemRootPresent,
			memos,
			diagnostics: parsed.diagnostics.sort(compareDiagnostic),
		};
		return { kind: "ready", snapshot };
	}

	private async parseMemoIndex(
		artifact: LegacyArtifact,
		result: ParsedLegacyData,
		context: LegacyIndexLoadContext,
	): Promise<void> {
		if (isEmptyArtifact(artifact)) return;
		const parsed = parseJson(artifact, result.diagnostics);
		if (!isRecord(parsed)
			|| parsed.schemaVersion !== 2
			|| typeof parsed.period !== "string"
			|| !PERIOD_PATTERN.test(parsed.period)
			|| (artifact.period !== null && parsed.period !== artifact.period)
			|| !isRecord(parsed.memos)) {
			result.diagnostics.push(diagnostic("legacy_memo_index_invalid", artifact.path, null, "Legacy Memo Index structure is invalid."));
			return;
		}
		for (const [memoId, value] of Object.entries(parsed.memos)) {
			await checkpoint(context);
			const memo = parseMemoRecord(memoId, value);
			if (memo === null) {
				// 明确属于活动记录或派生错误状态时，不以旧索引损坏阻塞 Trash。
				if (isRecord(value) && (value.status === "active" || value.status === "error")) continue;
				result.diagnostics.push(diagnostic("legacy_memo_record_invalid", artifact.path, memoId, "Legacy memo record or memoId is invalid."));
				continue;
			}
			result.memos.push(memo);
		}
	}

	private async collectArtifacts(
		legacyRoot: string,
		context: LegacyIndexLoadContext,
	): Promise<LegacyArtifactInventory> {
		const artifacts: LegacyArtifact[] = [];
		const unknownPaths: string[] = [];
		const folder = this.app.vault.getAbstractFileByPath(legacyRoot);
		if (folder instanceof TFolder) {
			const files: TFile[] = [];
			Vault.recurseChildren(folder, (child) => {
				if (child instanceof TFile) files.push(child);
			});
			for (const file of files.sort((left, right) => left.path.localeCompare(right.path))) {
				await checkpoint(context);
				const classification = classifyLegacyArtifactPath(legacyRoot, file.path);
				if (classification === null) {
					unknownPaths.push(file.path);
					continue;
				}
				const needsContent = classification.artifactKind === "memo_index";
				artifacts.push({
					artifactKind: classification.artifactKind,
					path: file.path,
					period: classification.period,
					bytes: needsContent ? new Uint8Array(await this.app.vault.readBinary(file)) : null,
				});
			}
		}
		return {
			artifacts: artifacts.sort((left, right) => left.path.localeCompare(right.path)),
			legacySystemRoot: legacyRoot,
			legacySystemRootPresent: folder instanceof TFolder,
			unknownPaths: unknownPaths.sort((left, right) => left.localeCompare(right)),
		};
	}

	private getConfiguredRoot(): string | null {
		const value = this.getMonthlyFolder();
		return value === null ? null : normalizePath(value);
	}
}

function parseMemoRecord(memoId: string, value: unknown): LegacyIndexMemo | null {
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
	const deletedRawBlock = typeof value.deletedDailyBlock === "string" && value.deletedDailyBlock.length > 0
		? value.deletedDailyBlock
		: dailyRef.lastKnownBlock;
	return {
		memoId,
		status: value.status,
		deletedPayload: value.status === "deleted" ? {
			deletedAt: isDateTime(value.deletedAt) ? value.deletedAt : value.updatedAt,
			sourcePath: normalizePath(dailyRef.path),
			logicalDate: readLogicalDate(dailyRef.path, value.createdAt),
			section: dailyRef.sectionType === "root" ? null : dailyRef.heading as string | null,
			rawBlock: deletedRawBlock,
		} : null,
	};
}

async function mergeMemos(
	values: readonly LegacyIndexMemo[],
	diagnostics: LegacyIndexDiagnostic[],
	context: LegacyIndexLoadContext,
): Promise<LegacyIndexMemo[]> {
	const byMemoId = await groupByMemoId(values, context);
	const result: LegacyIndexMemo[] = [];
	for (const [memoId, candidates] of [...byMemoId.entries()].sort(compareEntry)) {
		await checkpoint(context);
		const unique = dedupeByCanonical(candidates, memoRecoveryKey);
		if (unique.length !== 1) {
			diagnostics.push(diagnostic("legacy_record_conflict", null, memoId, "Legacy index contains conflicting records for one memoId."));
			continue;
		}
		result.push(unique[0] as LegacyIndexMemo);
	}
	return result;
}

function memoRecoveryKey(value: LegacyIndexMemo): unknown {
	return { memoId: value.memoId, status: value.status, deletedPayload: value.deletedPayload };
}

async function groupByMemoId<T extends { memoId: string }>(
	values: readonly T[],
	context: LegacyIndexLoadContext,
): Promise<Map<string, T[]>> {
	const result = new Map<string, T[]>();
	for (const value of values) {
		const candidates = result.get(value.memoId) ?? [];
		candidates.push(value);
		result.set(value.memoId, candidates);
		await checkpoint(context);
	}
	return result;
}

async function serializeCanonicalArray(
	values: readonly unknown[],
	context: LegacyIndexLoadContext,
): Promise<string> {
	const serialized: string[] = [];
	for (const value of values) {
		serialized.push(canonicalJson(value));
		await checkpoint(context);
	}
	return `[${serialized.join(",")}]`;
}

function createLoadContext(runtime: LegacyIndexLoadRuntime): LegacyIndexLoadContext {
	const assertActive = () => {
		if (runtime.cancellationSignal?.aborted === true) {
			throw new Error("Legacy index load was cancelled.");
		}
	};
	return {
		assertActive,
		yieldController: runtime.yieldControl === undefined ? null : new CooperativeYieldController({
			yieldControl: async () => {
				assertActive();
				await runtime.yieldControl?.();
				assertActive();
			},
			sliceBudgetMs: runtime.sliceBudgetMs,
			maxOperationsPerSlice: 128,
			now: runtime.now,
		}),
	};
}

async function checkpoint(context: LegacyIndexLoadContext): Promise<void> {
	context.assertActive();
	if (context.yieldController?.shouldYield() === true) {
		await context.yieldController.yieldNow();
	}
}

function dedupeByCanonical<T>(values: readonly T[], select: (value: T) => unknown): T[] {
	const unique = new Map<string, T>();
	for (const value of values) unique.set(canonicalJson(select(value)), value);
	return [...unique.values()];
}

function parseJson(artifact: LegacyArtifact, diagnostics: LegacyIndexDiagnostic[]): unknown {
	try {
		if (artifact.bytes === null) throw new Error("Legacy artifact content was not loaded.");
		const text = new TextDecoder("utf-8", { fatal: true }).decode(artifact.bytes).replace(/^\uFEFF/u, "");
		return JSON.parse(text) as unknown;
	} catch {
		diagnostics.push(diagnostic("legacy_json_invalid", artifact.path, null, "Legacy data file is not valid JSON."));
		return null;
	}
}

function isEmptyArtifact(artifact: LegacyArtifact): boolean {
	if (artifact.bytes === null) return false;
	return new TextDecoder("utf-8").decode(artifact.bytes).trim().length === 0;
}

function readLogicalDate(path: string, createdAt: string): string {
	const fromPath = /(?:^|\/)(\d{4}-\d{2}-\d{2})(?:\.[^/]*)?$/u.exec(path)?.[1];
	if (fromPath !== undefined && DATE_PATTERN.test(fromPath)) return fromPath;
	const date = parseMemoCalendarDate(createdAt);
	return date === null ? createdAt.slice(0, 10) : formatDatePart(date);
}

function isDateTime(value: unknown): value is string {
	return typeof value === "string" && value.length > 0 && Number.isFinite(Date.parse(value));
}

function isPositiveInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isInteger(value) && value >= 1;
}

function isVaultPath(value: unknown): value is string {
	return typeof value === "string" && value.length > 0 && !value.startsWith("/") && !value.includes("\\")
		&& !/(^|\/)\.{1,2}(\/|$)/u.test(value) && !/[\u0000-\u001f]/u.test(value);
}

function createParsedLegacyData(): ParsedLegacyData {
	return { memos: [], diagnostics: [] };
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
