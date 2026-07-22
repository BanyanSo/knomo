import type { App } from "obsidian";

import type { MemoMutation, MemoRecord } from "../types/memo";
import type { KnomoSettings } from "../types/settings";
import { formatMonthPeriod } from "../utils/date";
import { getTimeBuoyTargetPeriod } from "../utils/timeBuoyDate";
import { extractTimeBuoyDates, getTimeBuoyRevision } from "../utils/timeBuoyParser";
import type { MemoIndexStore } from "./MemoIndexStore";
import { MarkdownBlockService } from "./MarkdownBlockService";
import type { SelfWriteTracker } from "./SelfWriteTracker";
import { TimeBuoyIndexStore } from "./TimeBuoyIndexStore";
import type { TimeBuoyMemoIndexChange } from "./TimeBuoyIndexStore";
import { TimeBuoyQueryService } from "./TimeBuoyQueryService";
import type { TimeBuoyAllQueryResult, TimeBuoyQueryResult } from "./TimeBuoyQueryService";
import { TimeBuoyRebuildService } from "./TimeBuoyRebuildService";
import type { TimeBuoyRebuildOptions, TimeBuoyRebuildResult } from "./TimeBuoyRebuildService";

export type TimeBuoyMaintenanceOutcome =
	| { status: "disabled"; dates: string[] }
	| { status: "synced"; dates: string[] }
	| { status: "failed"; dates: string[]; error: unknown };

type GetSettings = () => KnomoSettings;

export class TimeBuoyService {
	private readonly indexStore: TimeBuoyIndexStore;
	private readonly queryService: TimeBuoyQueryService;
	private readonly rebuildService: TimeBuoyRebuildService;
	private readonly failedMemoIds = new Set<string>();
	private readonly pendingChanges = new Map<string, TimeBuoyMemoIndexChange>();
	private retryRunning = false;
	private rebuildRequired = false;
	private rebuildInProgress = false;
	private rebuildChanges: TimeBuoyMemoIndexChange[] = [];
	private rebuildPromise: Promise<TimeBuoyRebuildResult> | null = null;

	constructor(
		app: App,
		private readonly getSettings: GetSettings,
		memoIndexStore: MemoIndexStore,
		selfWriteTracker?: SelfWriteTracker,
	) {
		this.indexStore = new TimeBuoyIndexStore(app, selfWriteTracker);
		this.queryService = new TimeBuoyQueryService(getSettings, this.indexStore, memoIndexStore);
		this.rebuildService = new TimeBuoyRebuildService(
			app,
			getSettings,
			memoIndexStore,
			this.indexStore,
			new MarkdownBlockService(),
		);
	}

	isEnabled(): boolean {
		return this.getSettings().timeBuoyEnabled;
	}

	async needsStartupRebuild(): Promise<boolean> {
		if (!this.isEnabled()) {
			return false;
		}
		const folder = this.getSettings().monthlyMemoFolder;
		const storedPeriods = this.indexStore.listStoredPeriods(folder);
		if (this.hasAnyConflictFiles()) {
			return true;
		}
		try {
			const state = await this.indexStore.loadState(folder);
			return state === null
				? storedPeriods.length > 0
				: state.dirty || !areStringArraysEqual(state.expectedPeriods, storedPeriods);
		} catch {
			return true;
		}
	}

	async syncMutation(mutation: MemoMutation): Promise<TimeBuoyMaintenanceOutcome> {
		if (mutation.type === "create") {
			return this.syncMemoRecords(null, mutation.memo);
		}
		return this.syncMemoRecords(mutation.previousMemo, mutation.memo);
	}

	async syncMemoRecords(
		previousMemo: MemoRecord | null,
		nextMemo: MemoRecord | null,
	): Promise<TimeBuoyMaintenanceOutcome> {
		const activePreviousMemo = previousMemo?.status === "active" ? previousMemo : null;
		const activeNextMemo = nextMemo?.status === "active" ? nextMemo : null;
		const previousDates = normalizeDates(activePreviousMemo === null ? [] : extractTimeBuoyDates(activePreviousMemo.contentSnapshot));
		const nextDates = normalizeDates(activeNextMemo === null ? [] : extractTimeBuoyDates(activeNextMemo.contentSnapshot));
		if (!this.isEnabled()) {
			if (previousMemo !== null || nextMemo !== null) {
				this.rebuildRequired = true;
			}
			return { status: "disabled", dates: nextDates };
		}
		const identityMemo = activeNextMemo ?? activePreviousMemo;
		if (identityMemo === null) {
			return { status: "synced", dates: nextDates };
		}
		if (areStringArraysEqual(previousDates, nextDates)) {
			void this.retryPendingChanges();
			return { status: "synced", dates: nextDates };
		}
		const change: TimeBuoyMemoIndexChange = {
			memoId: identityMemo.id,
			sourcePeriod: formatMonthPeriod(new Date(identityMemo.createdAt)),
			buoyRevision: getTimeBuoyRevision(activeNextMemo?.contentSnapshot ?? ""),
			previousDates,
			nextDates,
		};
		if (this.rebuildInProgress) {
			this.rebuildChanges.push(change);
		}
		const settings = this.getSettings();
		const canFinalizeState = await this.canFinalizeIncrementalState(settings.monthlyMemoFolder);
		if (!canFinalizeState) {
			this.rebuildRequired = true;
		}
		try {
			await this.indexStore.markDirty(
				settings.monthlyMemoFolder,
				[identityMemo.id],
				getAffectedPeriods(change),
			);
			await this.indexStore.applyMemoChange(settings.monthlyMemoFolder, change);
			this.failedMemoIds.delete(identityMemo.id);
			this.pendingChanges.delete(identityMemo.id);
			if (canFinalizeState && !this.rebuildInProgress && this.failedMemoIds.size === 0) {
				await this.indexStore.markClean(settings.monthlyMemoFolder, this.indexStore.listStoredPeriods(settings.monthlyMemoFolder));
			}
			void this.retryPendingChanges();
			return { status: "synced", dates: nextDates };
		} catch (error) {
			this.failedMemoIds.add(identityMemo.id);
			this.rememberPendingChange(change);
			void this.retryPendingChanges();
			return { status: "failed", dates: nextDates, error };
		}
	}

	async queryDate(targetDate: string): Promise<TimeBuoyQueryResult> {
		if (!this.isEnabled()) {
			return { items: [], stale: [], missingPeriods: [] };
		}
		const targetPeriod = getTimeBuoyTargetPeriod(targetDate);
		const periods = [targetPeriod].filter((period): period is string => period !== null);
		const expectedPeriods = await this.loadHealthyExpectedPeriods();
		if (expectedPeriods === null || periods.some((period) => !expectedPeriods.includes(period))) {
			return { items: [], stale: [], missingPeriods: periods };
		}
		try {
			return await this.trackStale(await this.queryService.queryDate(targetDate), periods);
		} catch {
			await this.recordReadFailure(periods);
			return { items: [], stale: [], missingPeriods: periods };
		}
	}

	async queryAll(): Promise<TimeBuoyAllQueryResult> {
		if (!this.isEnabled()) {
			return { items: [], stale: [], missingPeriods: [], complete: true };
		}
		const periods = await this.loadHealthyExpectedPeriods();
		if (periods === null) {
			return { items: [], stale: [], missingPeriods: await this.listIncompletePeriods(), complete: false };
		}
		try {
			const result = await this.queryService.queryAll(periods);
			const tracked = await this.trackStale(result, periods);
			return {
				...tracked,
				complete: result.complete && tracked.missingPeriods.length === 0 && tracked.stale.length === 0,
			};
		} catch {
			await this.recordReadFailure(periods);
			return { items: [], stale: [], missingPeriods: periods, complete: false };
		}
	}

	async rebuild(options: TimeBuoyRebuildOptions = {}): Promise<TimeBuoyRebuildResult> {
		if (this.rebuildPromise !== null) {
			return this.rebuildPromise;
		}
		const rebuildPromise = this.runRebuild(options);
		this.rebuildPromise = rebuildPromise;
		try {
			return await rebuildPromise;
		} finally {
			if (this.rebuildPromise === rebuildPromise) {
				this.rebuildPromise = null;
			}
		}
	}

	markRebuildRequired(): void {
		this.rebuildRequired = true;
		void this.persistDirty(
			this.getSettings().monthlyMemoFolder,
			[],
			this.listStoredPeriods(),
		);
	}

	listStoredPeriods(): string[] {
		if (!this.isEnabled()) {
			return [];
		}
		return this.indexStore.listStoredPeriods(this.getSettings().monthlyMemoFolder);
	}

	private hasAnyConflictFiles(): boolean {
		return this.indexStore.listPotentialSyncConflictFiles(this.getSettings().monthlyMemoFolder).length > 0;
	}

	private async trackStale(result: TimeBuoyQueryResult, periods: readonly string[]): Promise<TimeBuoyQueryResult> {
		for (const instance of result.stale) {
			this.failedMemoIds.add(instance.memoId);
		}
		if (result.stale.length === 0) {
			return result;
		}
		this.rebuildRequired = true;
		await this.persistDirty(
			this.getSettings().monthlyMemoFolder,
			result.stale.map((instance) => instance.memoId),
			periods,
		);
		return { ...result, missingPeriods: [...new Set([...result.missingPeriods, ...periods])] };
	}

	private async retryPendingChanges(): Promise<void> {
		if (this.retryRunning || this.rebuildInProgress || !this.isEnabled() || this.pendingChanges.size === 0) {
			return;
		}
		this.retryRunning = true;
		try {
			const folder = this.getSettings().monthlyMemoFolder;
			for (const [memoId, change] of [...this.pendingChanges]) {
				try {
					await this.indexStore.markDirty(folder, [memoId], getAffectedPeriods(change));
					await this.indexStore.applyMemoChange(folder, change);
					this.pendingChanges.delete(memoId);
					this.failedMemoIds.delete(memoId);
				} catch {
					// 保留待修复任务，后续增量写入或显式重建会再次处理。
				}
			}
			if (!this.rebuildRequired && this.pendingChanges.size === 0 && this.failedMemoIds.size === 0) {
				await this.indexStore.markClean(folder, this.indexStore.listStoredPeriods(folder));
				this.rebuildRequired = false;
			}
		} finally {
			this.retryRunning = false;
		}
	}

	private async runRebuild(options: TimeBuoyRebuildOptions): Promise<TimeBuoyRebuildResult> {
		this.rebuildInProgress = true;
		this.rebuildChanges = [];
		const folder = this.getSettings().monthlyMemoFolder;
		try {
			await this.indexStore.markDirty(folder, [], this.indexStore.listStoredPeriods(folder));
			const result = await this.rebuildService.rebuild({
				...options,
				isCancelled: () => !this.isEnabled() || options.isCancelled?.() === true,
			});
			if (result.status !== "completed") {
				this.rebuildRequired = true;
				return result;
			}
			if (!this.isEnabled()) {
				this.rebuildRequired = true;
				return {
					status: "cancelled",
					total: result.total,
					indexed: result.indexed,
					skipped: result.skipped,
					periods: [],
				};
			}
			for (let index = 0; index < this.rebuildChanges.length; index += 1) {
				const change = this.rebuildChanges[index];
				try {
					await this.indexStore.applyMemoChange(folder, change);
					this.failedMemoIds.delete(change.memoId);
					this.pendingChanges.delete(change.memoId);
				} catch (error) {
					this.failedMemoIds.add(change.memoId);
					this.rememberPendingChange(change);
					throw error;
				}
			}
			const cleanup = await this.indexStore.trashPotentialSyncConflictFiles(folder);
			if (cleanup.failed > 0) {
				throw new Error(`Failed to remove Time buoy sync conflict file: ${cleanup.firstFailedPath ?? "unknown"}`);
			}
			await this.indexStore.markClean(folder, this.indexStore.listStoredPeriods(folder));
			this.failedMemoIds.clear();
			this.pendingChanges.clear();
			this.rebuildRequired = false;
			return result;
		} catch (error) {
			this.rebuildRequired = true;
			throw error;
		} finally {
			this.rebuildInProgress = false;
			this.rebuildChanges = [];
			void this.retryPendingChanges();
		}
	}

	private async canFinalizeIncrementalState(monthlyMemoFolder: string): Promise<boolean> {
		try {
			const state = await this.indexStore.loadState(monthlyMemoFolder);
			return state !== null
				&& !state.dirty
				&& areStringArraysEqual(state.expectedPeriods, this.indexStore.listStoredPeriods(monthlyMemoFolder));
		} catch {
			return false;
		}
	}

	private async loadHealthyExpectedPeriods(): Promise<string[] | null> {
		const folder = this.getSettings().monthlyMemoFolder;
		const storedPeriods = this.indexStore.listStoredPeriods(folder);
		if (this.rebuildRequired || this.failedMemoIds.size > 0 || this.hasAnyConflictFiles()) {
			await this.persistDirty(folder, [...this.failedMemoIds], storedPeriods);
			return null;
		}
		try {
			const state = await this.indexStore.loadState(folder);
			if (
				state === null
				|| state.dirty
				|| !areStringArraysEqual(state.expectedPeriods, storedPeriods)
			) {
				this.rebuildRequired = true;
				await this.persistDirty(
					folder,
					state?.affectedMemoIds ?? [],
					[...(state?.expectedPeriods ?? []), ...storedPeriods],
				);
				return null;
			}
			return state.expectedPeriods;
		} catch {
			await this.recordReadFailure(storedPeriods);
			return null;
		}
	}

	private async recordReadFailure(periods: readonly string[]): Promise<void> {
		this.rebuildRequired = true;
		await this.persistDirty(
			this.getSettings().monthlyMemoFolder,
			[],
			periods,
		);
	}

	private async listIncompletePeriods(): Promise<string[]> {
		const folder = this.getSettings().monthlyMemoFolder;
		const storedPeriods = this.indexStore.listStoredPeriods(folder);
		try {
			const state = await this.indexStore.loadState(folder);
			return [...new Set([...(state?.expectedPeriods ?? []), ...storedPeriods])].sort();
		} catch {
			return storedPeriods;
		}
	}

	private async persistDirty(
		monthlyMemoFolder: string,
		affectedMemoIds: readonly string[],
		expectedPeriods: readonly string[],
	): Promise<void> {
		try {
			await this.indexStore.markDirty(monthlyMemoFolder, affectedMemoIds, expectedPeriods);
		} catch {
			// 查询与刷新不能因派生状态文件写入失败而中断，内存脏状态仍会阻止读取不完整索引。
		}
	}

	private rememberPendingChange(change: TimeBuoyMemoIndexChange): void {
		const pending = this.pendingChanges.get(change.memoId);
		this.pendingChanges.set(change.memoId, pending === undefined ? change : {
			...change,
			previousDates: pending.previousDates,
		});
	}
}

function normalizeDates(dates: readonly string[]): string[] {
	return [...new Set(dates)].sort();
}

function areStringArraysEqual(left: readonly string[], right: readonly string[]): boolean {
	return left.length === right.length && left.every((value, index) => value === right[index]);
}

function getAffectedPeriods(change: TimeBuoyMemoIndexChange): string[] {
	return [...new Set([...change.previousDates, ...change.nextDates]
		.map((date) => getTimeBuoyTargetPeriod(date))
		.filter((period): period is string => period !== null))].sort();
}
