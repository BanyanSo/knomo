import { TFile } from "obsidian";
import type { App, Component } from "obsidian";

import type { KnomoSettings } from "../types/settings";
import type { MonthlyProjectionState } from "../types/catalogView";
import { ensureFolder, getParentFolderPath } from "../utils/vault";
import {
	buildMonthlyProjection,
	extractLegacyMonthlyArchiveMarker,
	getMonthlyArchivePath,
	hasKnomoMonthlyArchiveMarker,
} from "./MonthlyProjection";
import type { MonthlyProjectionInputBuilder } from "./MonthlyProjectionInputBuilder";
import type { MonthlyProjectionConfigurationSnapshot } from "./MonthlyProjectionInputBuilder";
import type { LowPriorityWorkRunner } from "./LowPriorityWorkQueue";
import { sha256Bytes } from "./CanonicalJson";
import type { SelfWriteTracker } from "./SelfWriteTracker";
import type { MemoCatalogStore } from "./MemoCatalogStore";

const DEFAULT_DEBOUNCE_MS = 250;
const DEFAULT_COOLDOWN_MS = 1_000;
const DEFAULT_RETRY_DELAY_MS = 5_000;
const MONTHLY_CHANGED_WORK_PRIORITY = 10;
const MONTHLY_HISTORY_WORK_PRIORITY = 40;
const MONTHLY_URGENT_PRIORITY = 0;
const MONTHLY_NORMAL_PRIORITY = 1;
export const MONTHLY_PROJECTION_CHECKPOINT_META_KEY = "monthlyProjectionCheckpoint";

export interface MonthlyProjectionMetadata {
	sourceDigest: string;
	outputHash: string;
}

export interface MonthlyProjectionCoordinatorOptions {
	inputBuilder: MonthlyProjectionInputBuilder;
	selfWriteTracker: SelfWriteTracker;
	checkpointStore?: Pick<MemoCatalogStore, "getMeta" | "setMeta">;
	listCatalogPeriods?: () => Promise<string[]>;
	debounceMs?: number;
	cooldownMs?: number;
	retryDelayMs?: number;
	now?: () => number;
	onStateChanged?: () => void;
	isProjectionAllowed?: () => boolean;
	currentPeriod?: () => string;
	yieldControl?: () => Promise<void>;
	workQueue?: LowPriorityWorkRunner;
}

interface MonthlyProjectionCheckpoint {
	dailyScopeKey: string;
	renderFingerprint: string;
	discoveryPending: boolean;
	pending: Array<{
		period: string;
		priority: number;
		invalidationVersion: number;
	}>;
	metadata: Record<string, MonthlyProjectionMetadata>;
}

// 职责：合并月份失效并更新可重建的 Monthly view；失败不得进入 Daily、Catalog 或 identity 链路。
export class MonthlyProjectionCoordinator {
	private readonly debounceMs: number;
	private readonly cooldownMs: number;
	private readonly retryDelayMs: number;
	private readonly now: () => number;
	private readonly pendingPeriods = new Set<string>();
	private readonly invalidationVersions = new Map<string, number>();
	private readonly periodPriorities = new Map<string, number>();
	private readonly failedPeriods = new Set<string>();
	private readonly lastProjectedAt = new Map<string, number>();
	private readonly metadata = new Map<string, MonthlyProjectionMetadata>();
	private readonly pathQueues = new Map<string, Promise<void>>();
	private running: Promise<{ projected: number; failed: number }> | null = null;
	private checkpointQueue: Promise<void> = Promise.resolve();
	private timer: number | null = null;
	private stopped = false;
	private discoveryPending = false;
	private projectionAllowed: boolean;
	private configuration: MonthlyProjectionConfigurationSnapshot | null = null;

	constructor(
		private readonly app: App,
		private readonly options: MonthlyProjectionCoordinatorOptions,
	) {
		this.debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS;
		this.cooldownMs = options.cooldownMs ?? DEFAULT_COOLDOWN_MS;
		this.retryDelayMs = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
		this.now = options.now ?? Date.now;
		this.projectionAllowed = this.isProjectionAllowed();
	}

	start(owner: Component): void {
		owner.registerEvent(this.app.vault.on("modify", (file) => { void this.handleFileChanged(file); }));
		owner.registerEvent(this.app.vault.on("create", (file) => { void this.handleFileChanged(file); }));
		owner.registerEvent(this.app.vault.on("delete", (file) => { void this.handleFileDeleted(file); }));
		owner.registerEvent(this.app.vault.on("rename", (file, oldPath) => { void this.handleFileRenamed(file, oldPath); }));
		owner.registerDomEvent(this.app.workspace.containerEl.doc, "visibilitychange", () => {
			if (this.app.workspace.containerEl.doc.visibilityState !== "hidden") this.scheduleRun(0);
		});
		owner.register(() => this.stop());
	}

	async initialize(): Promise<void> {
		await this.options.inputBuilder.initializeInventory();
		this.configuration = await this.options.inputBuilder.getConfigurationSnapshot();
		this.projectionAllowed = this.isProjectionAllowed();
		const checkpoint = await this.loadCheckpoint();
		const checkpointMatches = checkpoint !== null
			&& checkpoint.dailyScopeKey === this.configuration.dailyScopeKey
			&& checkpoint.renderFingerprint === this.configuration.renderFingerprint;
		if (checkpointMatches) {
			this.restoreCheckpoint(checkpoint);
		} else {
			this.pendingPeriods.clear();
			this.invalidationVersions.clear();
			this.periodPriorities.clear();
			this.metadata.clear();
			this.discoveryPending = checkpoint !== null;
		}
		this.markPending(this.getCurrentPeriod(), MONTHLY_URGENT_PRIORITY);
		await this.persistCheckpoint();
		if (this.discoveryPending) await this.discoverHistoricalPeriods(false);
		this.notifyStateChanged();
		this.scheduleRun(this.getNextDelay());
	}

	async handleConfigurationChanged(): Promise<void> {
		const previous = this.configuration;
		const next = await this.options.inputBuilder.getConfigurationSnapshot();
		const wasProjectionAllowed = this.projectionAllowed;
		this.projectionAllowed = this.isProjectionAllowed();
		this.configuration = next;
		if (previous === null) {
			await this.initialize();
			return;
		}
		const configurationChanged = previous.renderFingerprint !== next.renderFingerprint
			|| previous.dailyScopeKey !== next.dailyScopeKey;
		if (!configurationChanged) {
			if (!wasProjectionAllowed && this.projectionAllowed) {
				if (this.pendingPeriods.size === 0) this.markPending(this.getCurrentPeriod(), MONTHLY_URGENT_PRIORITY);
				await this.persistCheckpoint();
				this.notifyStateChanged();
				this.scheduleRun(this.getNextDelay());
			}
			return;
		}
		this.metadata.clear();
		this.discoveryPending = true;
		this.markPending(this.getCurrentPeriod(), MONTHLY_URGENT_PRIORITY);
		await this.persistCheckpoint();
		await this.discoverHistoricalPeriods(false);
	}

	async handleCatalogSettled(): Promise<void> {
		if (!this.discoveryPending) return;
		await this.discoverHistoricalPeriods(true);
	}

	async listPeriods(): Promise<string[]> {
		const ownedPeriods = await this.options.inputBuilder.listOwnedMonthlyPeriods();
		if (this.options.listCatalogPeriods === undefined) {
			return [...new Set([
				...await this.options.inputBuilder.listDailyPeriods(),
				...ownedPeriods,
			])].sort();
		}
		try {
			const catalogPeriods = await this.options.listCatalogPeriods();
			return [...new Set([...catalogPeriods, ...ownedPeriods])].sort();
		} catch {
			return [...new Set([
				...await this.options.inputBuilder.listDailyPeriods(),
				...ownedPeriods,
			])].sort();
		}
	}

	async invalidatePeriods(
		periods: readonly string[],
		priority = MONTHLY_URGENT_PRIORITY,
	): Promise<void> {
		for (const period of [...new Set(periods)].sort()) {
			if (/^\d{4}-(?:0[1-9]|1[0-2])$/u.test(period)) this.markPending(period, priority);
		}
		if (this.pendingPeriods.size > 0) {
			await this.persistCheckpoint();
			this.notifyStateChanged();
			this.scheduleRun(this.getNextDelay());
		}
	}

	invalidateChangedPeriods(periods: readonly string[]): Promise<void> {
		return this.invalidatePeriods(periods, MONTHLY_URGENT_PRIORITY);
	}

	async rebuildPeriod(period: string): Promise<{ projected: number; failed: number }> {
		if (!/^\d{4}-(?:0[1-9]|1[0-2])$/u.test(period)) throw new Error(`Invalid Monthly period: ${period}`);
		await this.invalidatePeriods([period], MONTHLY_URGENT_PRIORITY);
		return this.run(true);
	}

	run(ignoreCooldown = false): Promise<{ projected: number; failed: number }> {
		if (this.stopped) return Promise.resolve({ projected: 0, failed: 0 });
		if (!this.isProjectionAllowed()) {
			this.notifyStateChanged();
			return Promise.resolve({ projected: 0, failed: 0 });
		}
		if (this.running !== null) return this.running;
		this.running = this.runOnce(ignoreCooldown).then((result) => {
			if (this.pendingPeriods.size > 0) {
				this.scheduleRun(result.failed > 0 ? this.retryDelayMs : this.getNextDelay());
			}
			return result;
		}).finally(() => {
			this.running = null;
			this.notifyStateChanged();
		});
		return this.running;
	}

	getProjectionState(): MonthlyProjectionState {
		if (this.failedPeriods.size > 0) return "failed";
		if (!this.isProjectionAllowed()) return "stale";
		if (this.pendingPeriods.size > 0 || this.running !== null) return "stale";
		return "ready";
	}

	getProjectionMetadata(period: string): MonthlyProjectionMetadata | null {
		return this.metadata.get(period) ?? null;
	}

	getFailedPeriods(): string[] {
		return [...this.failedPeriods].sort();
	}

	private async runOnce(ignoreCooldown: boolean): Promise<{ projected: number; failed: number }> {
		let projected = 0;
		let failed = 0;
		for (const period of this.getPendingPeriodsInPriorityOrder()) {
			const invalidationVersion = this.invalidationVersions.get(period) ?? 0;
			const priority = this.periodPriorities.get(period) ?? MONTHLY_NORMAL_PRIORITY;
			const lastProjected = this.lastProjectedAt.get(period);
			if (!ignoreCooldown && lastProjected !== undefined && this.now() - lastProjected < this.cooldownMs) continue;
			try {
				await this.runLowPriorityTask(period, () => this.project(period));
				let completed = false;
				if ((this.invalidationVersions.get(period) ?? 0) === invalidationVersion) {
					this.pendingPeriods.delete(period);
					this.periodPriorities.delete(period);
					completed = true;
				}
				try {
					await this.persistCheckpoint();
				} catch (error) {
					if (completed && (this.invalidationVersions.get(period) ?? 0) === invalidationVersion) {
						this.pendingPeriods.add(period);
						this.periodPriorities.set(period, priority);
					}
					throw error;
				}
				this.failedPeriods.delete(period);
				this.lastProjectedAt.set(period, this.now());
				projected += 1;
			} catch (error) {
				if (error instanceof MonthlyProjectionStoppedError) break;
				this.failedPeriods.add(period);
				failed += 1;
			} finally {
				await this.yieldControl();
			}
		}
		return { projected, failed };
	}

	private async project(period: string): Promise<void> {
		const targetPath = this.options.inputBuilder.getTargetPath(period);
		await this.enqueuePath(targetPath, async () => {
			this.assertRunning();
			const existing = this.app.vault.getAbstractFileByPath(targetPath);
			if (existing !== null && !(existing instanceof TFile)) {
				throw new Error(`Monthly projection target is not a file: ${targetPath}`);
			}
			let existingContent: string | null = null;
			if (existing instanceof TFile) {
				existingContent = await this.app.vault.read(existing);
				if (!hasKnomoMonthlyArchiveMarker(existingContent)) {
					this.metadata.delete(period);
					return;
				}
			}
			const built = await this.options.inputBuilder.build(period);
			if (existing === null && built.observations.length === 0) {
				this.metadata.delete(period);
				return;
			}
			const preservedMarker = existingContent === null
				? undefined
				: extractLegacyMonthlyArchiveMarker(existingContent) ?? undefined;
			const projection = await buildMonthlyProjection({
				period,
				settings: built.settings,
				observations: built.observations,
				sourceDigest: built.sourceDigest,
				preservedMarker,
			});
			if (projection.path !== targetPath) throw new Error("Monthly projection settings changed during build.");
			if (existing instanceof TFile) {
				const currentHash = await sha256Bytes(new Uint8Array(await this.app.vault.readBinary(existing)));
				if (currentHash === projection.outputHash) {
					this.metadata.set(period, toMetadata(projection));
					return;
				}
			}
			this.assertRunning();
			const opId = `monthly-projection:${period}:${projection.outputHash}`;
			this.options.selfWriteTracker.mark(targetPath, {
				opId,
				path: targetPath,
				reason: "monthly_projection",
				writtenAt: this.now(),
				expiresAt: this.now() + 10_000,
				expectedHash: projection.outputHash,
			});
			try {
				let file: TFile;
				if (existing instanceof TFile) {
					let skippedUnmarked = false;
					let changedMarker = false;
					await this.app.vault.process(existing, (currentContent) => {
						if (!hasKnomoMonthlyArchiveMarker(currentContent)) {
							skippedUnmarked = true;
							return currentContent;
						}
						if ((extractLegacyMonthlyArchiveMarker(currentContent) ?? undefined) !== preservedMarker) {
							changedMarker = true;
							return currentContent;
						}
						return currentContent === projection.content ? currentContent : projection.content;
					});
					if (skippedUnmarked) {
						this.options.selfWriteTracker.discard(targetPath, opId);
						this.metadata.delete(period);
						return;
					}
					if (changedMarker) throw new Error("Monthly projection marker changed during commit.");
					file = existing;
				} else {
					const parentFolder = getParentFolderPath(targetPath);
					if (parentFolder !== null) await ensureFolder(this.app, parentFolder);
					this.assertRunning();
					file = await this.app.vault.create(targetPath, projection.content);
				}
				const outputHash = await sha256Bytes(new Uint8Array(await this.app.vault.readBinary(file)));
				if (outputHash !== projection.outputHash) throw new Error("Monthly projection output verification failed.");
				this.metadata.set(period, toMetadata(projection));
			} catch (error) {
				this.options.selfWriteTracker.discard(targetPath, opId);
				const racedFile = this.app.vault.getAbstractFileByPath(targetPath);
				if (existing === null && racedFile instanceof TFile) {
					const racedContent = await this.app.vault.read(racedFile);
					if (!hasKnomoMonthlyArchiveMarker(racedContent)) {
						this.metadata.delete(period);
						return;
					}
				}
				throw error;
			}
		});
	}

	private async handleMonthlyFileChanged(file: unknown): Promise<void> {
		if (!(file instanceof TFile)) return;
		const period = this.options.inputBuilder.getMonthlyPeriod(file.path);
		if (period === null) return;
		try {
			const hash = await sha256Bytes(new Uint8Array(await this.app.vault.readBinary(file)));
			if (this.options.selfWriteTracker.consumeByExpectedHash(file.path, hash) !== null) return;
		} catch {
			// 无法读取的 Monthly 仍视为 stale，由下一次 projection 恢复。
		}
		await this.invalidatePeriods([period]);
	}

	private async handleFileChanged(file: unknown): Promise<void> {
		if (!(file instanceof TFile)) return;
		if (this.options.inputBuilder.getMonthlyPeriod(file.path) !== null) {
			await this.handleMonthlyFileChanged(file);
			return;
		}
		await this.invalidateChangedPeriods(await this.options.inputBuilder.updateDailyFile(file));
	}

	private async handleFileDeleted(file: unknown): Promise<void> {
		if (!(file instanceof TFile)) return;
		const monthlyPeriod = this.options.inputBuilder.getMonthlyPeriod(file.path);
		const dailyPeriods = await this.options.inputBuilder.removeDailyPath(file.path);
		await this.invalidateChangedPeriods([
			...(monthlyPeriod === null ? [] : [monthlyPeriod]),
			...dailyPeriods,
		]);
	}

	private async handleFileRenamed(file: unknown, oldPath: string): Promise<void> {
		const oldMonthlyPeriod = this.options.inputBuilder.getMonthlyPeriod(oldPath);
		const oldDailyPeriods = await this.options.inputBuilder.removeDailyPath(oldPath);
		await this.invalidateChangedPeriods([
			...(oldMonthlyPeriod === null ? [] : [oldMonthlyPeriod]),
			...oldDailyPeriods,
		]);
		await this.handleFileChanged(file);
	}

	private handleMonthlyFileDeleted(file: unknown): void {
		if (!(file instanceof TFile)) return;
		const period = this.options.inputBuilder.getMonthlyPeriod(file.path);
		if (period !== null) void this.invalidatePeriods([period]);
	}

	private handleMonthlyFileRenamed(file: unknown, oldPath: string): void {
		const oldPeriod = this.options.inputBuilder.getMonthlyPeriod(oldPath);
		if (oldPeriod !== null) void this.invalidatePeriods([oldPeriod]);
		if (file instanceof TFile) void this.handleMonthlyFileChanged(file);
	}

	private enqueuePath(path: string, action: () => Promise<void>): Promise<void> {
		const previous = this.pathQueues.get(path) ?? Promise.resolve();
		const current = previous.catch(() => undefined).then(action).finally(() => {
			if (this.pathQueues.get(path) === current) this.pathQueues.delete(path);
		});
		this.pathQueues.set(path, current);
		return current;
	}

	private markPending(period: string, priority: number): void {
		this.pendingPeriods.add(period);
		this.periodPriorities.set(period, Math.min(priority, this.periodPriorities.get(period) ?? priority));
		this.invalidationVersions.set(period, (this.invalidationVersions.get(period) ?? 0) + 1);
	}

	private async discoverHistoricalPeriods(fallbackToDaily: boolean): Promise<void> {
		let ownedPeriods: string[];
		try {
			ownedPeriods = await this.options.inputBuilder.listOwnedMonthlyPeriods();
		} catch {
			await this.persistCheckpoint();
			return;
		}
		let sourcePeriods: string[];
		if (this.options.listCatalogPeriods === undefined) {
			sourcePeriods = await this.options.inputBuilder.listDailyPeriods();
		} else {
			try {
				sourcePeriods = await this.options.listCatalogPeriods();
			} catch {
				if (!fallbackToDaily) {
					await this.invalidatePeriods(ownedPeriods, MONTHLY_NORMAL_PRIORITY);
					await this.persistCheckpoint();
					return;
				}
				sourcePeriods = await this.options.inputBuilder.listDailyPeriods();
			}
		}
		this.discoveryPending = false;
		await this.invalidatePeriods([...sourcePeriods, ...ownedPeriods], MONTHLY_NORMAL_PRIORITY);
		await this.persistCheckpoint();
	}

	private async loadCheckpoint(): Promise<MonthlyProjectionCheckpoint | null> {
		const checkpoint = await this.options.checkpointStore?.getMeta<unknown>(MONTHLY_PROJECTION_CHECKPOINT_META_KEY) ?? null;
		return isMonthlyProjectionCheckpoint(checkpoint) ? checkpoint : null;
	}

	private restoreCheckpoint(checkpoint: MonthlyProjectionCheckpoint): void {
		this.pendingPeriods.clear();
		this.invalidationVersions.clear();
		this.periodPriorities.clear();
		this.metadata.clear();
		for (const item of checkpoint.pending) {
			this.pendingPeriods.add(item.period);
			this.periodPriorities.set(item.period, item.priority);
			this.invalidationVersions.set(item.period, item.invalidationVersion);
		}
		for (const [period, value] of Object.entries(checkpoint.metadata)) {
			this.metadata.set(period, value);
		}
		this.discoveryPending = checkpoint.discoveryPending;
	}

	private persistCheckpoint(): Promise<void> {
		if (this.options.checkpointStore === undefined || this.configuration === null) return Promise.resolve();
		const write = this.checkpointQueue.catch(() => undefined).then(async () => {
			if (this.configuration === null) return;
			const checkpoint: MonthlyProjectionCheckpoint = {
				dailyScopeKey: this.configuration.dailyScopeKey,
				renderFingerprint: this.configuration.renderFingerprint,
				discoveryPending: this.discoveryPending,
				pending: this.getPendingPeriodsInPriorityOrder().map((period) => ({
					period,
					priority: this.periodPriorities.get(period) ?? MONTHLY_NORMAL_PRIORITY,
					invalidationVersion: this.invalidationVersions.get(period) ?? 0,
				})),
				metadata: Object.fromEntries([...this.metadata.entries()].sort(([left], [right]) => left.localeCompare(right))),
			};
			await this.options.checkpointStore?.setMeta(MONTHLY_PROJECTION_CHECKPOINT_META_KEY, checkpoint);
		});
		this.checkpointQueue = write;
		return write;
	}

	private assertRunning(): void {
		if (this.stopped) throw new MonthlyProjectionStoppedError();
	}

	private getPendingPeriodsInPriorityOrder(): string[] {
		const currentPeriod = this.getCurrentPeriod();
		return [...this.pendingPeriods].sort((left, right) => {
			const priorityDifference = (this.periodPriorities.get(left) ?? MONTHLY_NORMAL_PRIORITY)
				- (this.periodPriorities.get(right) ?? MONTHLY_NORMAL_PRIORITY);
			if (priorityDifference !== 0) return priorityDifference;
			if (left === currentPeriod) return -1;
			if (right === currentPeriod) return 1;
			return right.localeCompare(left);
		});
	}

	private runLowPriorityTask<T>(period: string, action: () => Promise<T>): Promise<T> {
		const priority = (this.periodPriorities.get(period) ?? MONTHLY_NORMAL_PRIORITY) === MONTHLY_URGENT_PRIORITY
			? MONTHLY_CHANGED_WORK_PRIORITY
			: MONTHLY_HISTORY_WORK_PRIORITY;
		return this.options.workQueue?.run(priority, action) ?? action();
	}

	private yieldControl(): Promise<void> {
		if (this.options.yieldControl !== undefined) return this.options.yieldControl();
		if (this.stopped) return Promise.resolve();
		return new Promise<void>((resolve) => {
			this.app.workspace.containerEl.win.setTimeout(resolve, 0);
		});
	}

	private getCurrentPeriod(): string {
		if (this.options.currentPeriod !== undefined) return this.options.currentPeriod();
		const today = new Date();
		return `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}`;
	}

	private scheduleRun(delay = this.debounceMs): void {
		if (this.stopped || !this.isProjectionAllowed()) return;
		const win = this.app.workspace.containerEl.win;
		if (this.timer !== null) win.clearTimeout(this.timer);
		this.timer = win.setTimeout(() => {
			this.timer = null;
			void this.run();
		}, delay);
	}

	private isProjectionAllowed(): boolean {
		return this.options.isProjectionAllowed?.() ?? true;
	}

	private getNextDelay(): number {
		let delay = this.debounceMs;
		for (const period of this.pendingPeriods) {
			const lastProjected = this.lastProjectedAt.get(period);
			if (lastProjected === undefined) continue;
			delay = Math.max(delay, this.cooldownMs - Math.max(0, this.now() - lastProjected));
		}
		return delay;
	}

	private notifyStateChanged(): void {
		try {
			this.options.onStateChanged?.();
		} catch {
			// 状态提示刷新失败不影响 Monthly projection 主流程。
		}
	}

	private stop(): void {
		this.stopped = true;
		if (this.timer !== null) this.app.workspace.containerEl.win.clearTimeout(this.timer);
		this.timer = null;
		this.pathQueues.clear();
	}
}

function toMetadata(projection: Awaited<ReturnType<typeof buildMonthlyProjection>>): MonthlyProjectionMetadata {
	return {
		sourceDigest: projection.sourceDigest,
		outputHash: projection.outputHash,
	};
}

function isMonthlyProjectionCheckpoint(value: unknown): value is MonthlyProjectionCheckpoint {
	if (typeof value !== "object" || value === null) return false;
	const checkpoint = value as Partial<MonthlyProjectionCheckpoint>;
	return typeof checkpoint.dailyScopeKey === "string"
		&& typeof checkpoint.renderFingerprint === "string"
		&& typeof checkpoint.discoveryPending === "boolean"
		&& Array.isArray(checkpoint.pending)
		&& checkpoint.pending.every((item) => typeof item === "object"
			&& item !== null
			&& typeof (item as { period?: unknown }).period === "string"
			&& /^\d{4}-(?:0[1-9]|1[0-2])$/u.test((item as { period: string }).period)
			&& typeof (item as { priority?: unknown }).priority === "number"
			&& typeof (item as { invalidationVersion?: unknown }).invalidationVersion === "number")
		&& typeof checkpoint.metadata === "object"
		&& checkpoint.metadata !== null;
}

class MonthlyProjectionStoppedError extends Error {}

export function getMonthlyProjectionTargetPath(settings: KnomoSettings, period: string): string {
	return getMonthlyArchivePath(settings, period);
}
