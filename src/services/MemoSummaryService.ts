import { Component, TFile } from "obsidian";
import type { App } from "obsidian";

import type { KnomoSettings } from "../types/settings";
import { isSupportedMemoImage } from "../utils/markdown";
import { getMemoContentStats } from "../utils/memoContentStats";
import { isRecord } from "../utils/object";
import { getIndexFolderPath } from "../utils/path";
import { normalizeTagKey } from "../utils/tags";
import { ensureTextFile } from "../utils/vault";
import type { MemoIndexStore } from "./MemoIndexStore";

const MEMO_SUMMARY_SCHEMA_VERSION = 1;
const MEMO_INDEX_SCHEMA_VERSION = 2;
const MEMO_SUMMARY_CHECKPOINT_PERIODS = 12;

interface MemoSummaryFingerprint {
	mtime: number;
	size: number;
}

export interface MemoPeriodSummary {
	indexFingerprint: MemoSummaryFingerprint;
	activeMemoCount: number;
	deletedMemoCount: number;
	deletedMemoIds: string[];
	imageCount: number;
	wordCount: number;
	tagCounts: Record<string, number>;
}

interface MemoSummaryFile {
	schemaVersion: 1;
	sourceSchemaVersion: 2;
	updatedAt: string;
	periods: Record<string, MemoPeriodSummary>;
}

export type MemoSummaryStatus = "idle" | "building" | "ready" | "partial";

export interface MemoSummarySnapshot {
	status: MemoSummaryStatus;
	activeMemoCount: number;
	deletedMemoCount: number;
	deletedMemoIds: ReadonlySet<string>;
	imageCount: number;
	wordCount: number;
	tagCounts: ReadonlyMap<string, number>;
	periods: ReadonlyMap<string, MemoPeriodSummary>;
}

export class MemoSummaryService extends Component {
	private snapshot = createEmptySnapshot("idle");
	private buildPromise: Promise<MemoSummarySnapshot> | null = null;
	private sourceRevision = 0;
	private loadedFolder = "";
	private readonly dirtyPeriodRevisions = new Map<string, number>();
	private readonly listeners = new Set<() => void>();

	constructor(
		private readonly app: App,
		private readonly getSettings: () => KnomoSettings,
		private readonly memoIndexStore: MemoIndexStore,
	) {
		super();
	}

	onload(): void {
		const invalidateFile = (file: unknown): void => {
			if (file instanceof TFile) {
				this.invalidatePath(file.path);
			}
		};
		this.registerEvent(this.app.vault.on("create", invalidateFile));
		this.registerEvent(this.app.vault.on("modify", invalidateFile));
		this.registerEvent(this.app.vault.on("delete", invalidateFile));
		this.registerEvent(this.app.vault.on("rename", (file, oldPath) => {
			this.invalidatePath(oldPath);
			invalidateFile(file);
		}));
	}

	getSnapshot(): MemoSummarySnapshot {
		return this.snapshot;
	}

	subscribe(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	invalidatePeriod(period: string): void {
		this.sourceRevision += 1;
		this.dirtyPeriodRevisions.set(period, this.sourceRevision);
		if (this.snapshot.status === "ready" || this.snapshot.status === "partial") {
			void this.ensureReady();
		}
	}

	async ensureReady(yieldToUi?: () => Promise<void>): Promise<MemoSummarySnapshot> {
		const folder = this.getSettings().monthlyMemoFolder;
		if (folder !== this.loadedFolder) {
			this.loadedFolder = folder;
			this.sourceRevision += 1;
			this.dirtyPeriodRevisions.clear();
			this.snapshot = createEmptySnapshot("idle");
		}
		if (this.buildPromise !== null) {
			return this.buildPromise;
		}
		this.buildPromise = this.rebuildUntilCurrent(folder, yieldToUi).finally(() => {
			this.buildPromise = null;
		});
		return this.buildPromise;
	}

	private async rebuildUntilCurrent(
		folder: string,
		yieldToUi?: () => Promise<void>,
	): Promise<MemoSummarySnapshot> {
		let completedRevision: number;
		do {
			completedRevision = this.sourceRevision;
			this.snapshot = { ...this.snapshot, status: "building" };
			this.notify();
			this.snapshot = await this.buildSnapshot(folder, completedRevision, yieldToUi);
			this.notify();
		} while (completedRevision !== this.sourceRevision && folder === this.getSettings().monthlyMemoFolder);
		if (folder !== this.getSettings().monthlyMemoFolder) {
			this.snapshot = createEmptySnapshot("idle");
		}
		return this.snapshot;
	}

	private async buildSnapshot(
		folder: string,
		buildRevision: number,
		yieldToUi?: () => Promise<void>,
	): Promise<MemoSummarySnapshot> {
		const stored = await this.readStoredSummary(folder);
		const nextPeriods: Record<string, MemoPeriodSummary> = {};
		let partial = false;
		let changed = stored === null;
		let rebuiltSinceCheckpoint = 0;
		const storedPeriods = this.memoIndexStore.listStoredPeriods(folder);
		for (const period of storedPeriods) {
			const file = this.app.vault.getAbstractFileByPath(this.memoIndexStore.getIndexFilePath(folder, period));
			if (!(file instanceof TFile)) {
				partial = true;
				continue;
			}
			let fingerprint = { mtime: file.stat.mtime, size: file.stat.size };
			const cached = stored?.periods[period];
			const dirtyRevision = this.dirtyPeriodRevisions.get(period);
			if (
				cached !== undefined
				&& (dirtyRevision === undefined || dirtyRevision > buildRevision)
				&& hasSameFingerprint(cached.indexFingerprint, fingerprint)
			) {
				nextPeriods[period] = cached;
				continue;
			}
			try {
				let index = await this.memoIndexStore.loadExistingPeriod(folder, period);
				if (index === null) {
					partial = true;
					continue;
				}
				const fingerprintAfterRead = { mtime: file.stat.mtime, size: file.stat.size };
				if (!hasSameFingerprint(fingerprint, fingerprintAfterRead)) {
					const retryFingerprint = fingerprintAfterRead;
					index = await this.memoIndexStore.loadExistingPeriod(folder, period);
					if (index === null) {
						partial = true;
						continue;
					}
					fingerprint = { mtime: file.stat.mtime, size: file.stat.size };
					if (!hasSameFingerprint(retryFingerprint, fingerprint)) {
						this.sourceRevision += 1;
						partial = true;
						continue;
					}
				}
				nextPeriods[period] = summarizePeriod(Object.values(index.memos), fingerprint);
				if (
					dirtyRevision !== undefined
					&& dirtyRevision <= buildRevision
					&& this.dirtyPeriodRevisions.get(period) === dirtyRevision
				) {
					this.dirtyPeriodRevisions.delete(period);
				}
				changed = true;
				rebuiltSinceCheckpoint += 1;
				if (rebuiltSinceCheckpoint >= MEMO_SUMMARY_CHECKPOINT_PERIODS) {
					await this.tryWriteSummary(folder, { ...stored?.periods, ...nextPeriods });
					rebuiltSinceCheckpoint = 0;
				}
			} catch {
				partial = true;
			}
			await yieldToUi?.();
		}
		if (stored !== null) {
			changed ||= Object.keys(stored.periods).some((period) => nextPeriods[period] === undefined);
		}
		for (const [period, revision] of this.dirtyPeriodRevisions) {
			if (revision <= buildRevision && !storedPeriods.includes(period)) {
				this.dirtyPeriodRevisions.delete(period);
			}
		}
		if (changed && !partial) {
			await this.tryWriteSummary(folder, nextPeriods);
		}
		return aggregatePeriods(nextPeriods, partial ? "partial" : "ready");
	}

	private async readStoredSummary(folder: string): Promise<MemoSummaryFile | null> {
		const file = this.app.vault.getAbstractFileByPath(getSummaryPath(folder));
		if (!(file instanceof TFile)) {
			return null;
		}
		try {
			return parseMemoSummary(await this.app.vault.cachedRead(file));
		} catch {
			return null;
		}
	}

	private async writeSummary(folder: string, periods: Record<string, MemoPeriodSummary>): Promise<void> {
		const file = await ensureTextFile(this.app, getSummaryPath(folder));
		const summary: MemoSummaryFile = {
			schemaVersion: MEMO_SUMMARY_SCHEMA_VERSION,
			sourceSchemaVersion: MEMO_INDEX_SCHEMA_VERSION,
			updatedAt: new Date().toISOString(),
			periods,
		};
		const serialized = `${JSON.stringify(summary, null, "\t")}\n`;
		await this.app.vault.process(file, (data) => data === serialized ? data : serialized);
	}

	private async tryWriteSummary(folder: string, periods: Record<string, MemoPeriodSummary>): Promise<void> {
		try {
			await this.writeSummary(folder, periods);
		} catch {
			// 摘要写入失败不影响月度索引作为事实来源，本次会话仍可使用内存结果。
		}
	}

	private invalidatePath(path: string): void {
		const indexFolder = getIndexFolderPath(this.getSettings().monthlyMemoFolder);
		const match = path.match(/\/memo-index-(\d{4}-\d{2})\.json$/);
		if (!path.startsWith(`${indexFolder}/`) || match === null) {
			return;
		}
		this.invalidatePeriod(match[1]);
	}

	private notify(): void {
		for (const listener of this.listeners) {
			listener();
		}
	}
}

function getSummaryPath(folder: string): string {
	return `${getIndexFolderPath(folder)}/memo-summary.json`;
}

function summarizePeriod(
	memos: readonly import("../types/memo").MemoRecord[],
	indexFingerprint: MemoSummaryFingerprint,
): MemoPeriodSummary {
	let activeMemoCount = 0;
	let deletedMemoCount = 0;
	const deletedMemoIds: string[] = [];
	let imageCount = 0;
	let wordCount = 0;
	const tagCounts: Record<string, number> = {};
	for (const memo of memos) {
		if (memo.status === "deleted") {
			deletedMemoCount += 1;
			deletedMemoIds.push(memo.id);
			continue;
		}
		activeMemoCount += 1;
		imageCount += memo.images.filter(isSupportedMemoImage).length;
		wordCount += getMemoContentStats(memo).wordCount;
		for (const tag of memo.tags) {
			const key = normalizeTagKey(tag);
			if (key.length > 0) {
				tagCounts[key] = (tagCounts[key] ?? 0) + 1;
			}
		}
	}
	return { indexFingerprint, activeMemoCount, deletedMemoCount, deletedMemoIds, imageCount, wordCount, tagCounts };
}

function aggregatePeriods(
	periods: Record<string, MemoPeriodSummary>,
	status: "ready" | "partial",
): MemoSummarySnapshot {
	let activeMemoCount = 0;
	let deletedMemoCount = 0;
	const deletedMemoIds = new Set<string>();
	let imageCount = 0;
	let wordCount = 0;
	const tagCounts = new Map<string, number>();
	for (const summary of Object.values(periods)) {
		activeMemoCount += summary.activeMemoCount;
		deletedMemoCount += summary.deletedMemoCount;
		for (const memoId of summary.deletedMemoIds) {
			deletedMemoIds.add(memoId);
		}
		imageCount += summary.imageCount;
		wordCount += summary.wordCount;
		for (const [key, count] of Object.entries(summary.tagCounts)) {
			tagCounts.set(key, (tagCounts.get(key) ?? 0) + count);
		}
	}
	return {
		status,
		activeMemoCount,
		deletedMemoCount,
		deletedMemoIds,
		imageCount,
		wordCount,
		tagCounts,
		periods: new Map(Object.entries(periods)),
	};
}

function createEmptySnapshot(status: MemoSummaryStatus): MemoSummarySnapshot {
	return {
		status,
		activeMemoCount: 0,
		deletedMemoCount: 0,
		deletedMemoIds: new Set(),
		imageCount: 0,
		wordCount: 0,
		tagCounts: new Map(),
		periods: new Map(),
	};
}

function hasSameFingerprint(left: MemoSummaryFingerprint, right: MemoSummaryFingerprint): boolean {
	return left.mtime === right.mtime && left.size === right.size;
}

function parseMemoSummary(data: string): MemoSummaryFile | null {
	const parsed: unknown = JSON.parse(data);
	if (
		!isRecord(parsed)
		|| parsed.schemaVersion !== MEMO_SUMMARY_SCHEMA_VERSION
		|| parsed.sourceSchemaVersion !== MEMO_INDEX_SCHEMA_VERSION
		|| typeof parsed.updatedAt !== "string"
		|| !isRecord(parsed.periods)
	) {
		return null;
	}
	const periods: Record<string, MemoPeriodSummary> = {};
	for (const [period, value] of Object.entries(parsed.periods)) {
		if (!isMemoPeriodSummary(value)) {
			return null;
		}
		periods[period] = value;
	}
	return {
		schemaVersion: MEMO_SUMMARY_SCHEMA_VERSION,
		sourceSchemaVersion: MEMO_INDEX_SCHEMA_VERSION,
		updatedAt: parsed.updatedAt,
		periods,
	};
}

function isMemoPeriodSummary(value: unknown): value is MemoPeriodSummary {
	return isRecord(value)
		&& isRecord(value.indexFingerprint)
		&& typeof value.indexFingerprint.mtime === "number"
		&& typeof value.indexFingerprint.size === "number"
		&& typeof value.activeMemoCount === "number"
		&& typeof value.deletedMemoCount === "number"
		&& Array.isArray(value.deletedMemoIds)
		&& value.deletedMemoIds.every((memoId) => typeof memoId === "string")
		&& typeof value.imageCount === "number"
		&& typeof value.wordCount === "number"
		&& isRecord(value.tagCounts)
		&& Object.values(value.tagCounts).every((count) => typeof count === "number");
}
