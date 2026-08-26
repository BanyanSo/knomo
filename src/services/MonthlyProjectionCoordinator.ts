import { TFile } from "obsidian";
import type { App, Component } from "obsidian";

import type { KnomoSettings } from "../types/settings";
import type { MonthlyProjectionState } from "../types/catalogView";
import { ensureTextFile } from "../utils/vault";
import {
	buildMonthlyProjection,
	getMonthlyArchivePath,
} from "./MonthlyProjection";
import type { MonthlyProjectionInputBuilder } from "./MonthlyProjectionInputBuilder";
import { sha256Bytes } from "./CanonicalJson";
import type { SelfWriteTracker } from "./SelfWriteTracker";

const DEFAULT_DEBOUNCE_MS = 250;
const DEFAULT_COOLDOWN_MS = 1_000;
const DEFAULT_RETRY_DELAY_MS = 5_000;

export interface MonthlyProjectionMetadata {
	sourceDigest: string;
	outputHash: string;
}

export interface MonthlyProjectionCoordinatorOptions {
	inputBuilder: MonthlyProjectionInputBuilder;
	selfWriteTracker: SelfWriteTracker;
	debounceMs?: number;
	cooldownMs?: number;
	retryDelayMs?: number;
	now?: () => number;
	onStateChanged?: () => void;
	isProjectionAllowed?: () => boolean;
}

// 职责：合并月份失效并更新可重建的 Monthly view；失败不得进入 Daily、Catalog 或 identity 链路。
export class MonthlyProjectionCoordinator {
	private readonly debounceMs: number;
	private readonly cooldownMs: number;
	private readonly retryDelayMs: number;
	private readonly now: () => number;
	private readonly pendingPeriods = new Set<string>();
	private readonly invalidationVersions = new Map<string, number>();
	private readonly failedPeriods = new Set<string>();
	private readonly lastProjectedAt = new Map<string, number>();
	private readonly metadata = new Map<string, MonthlyProjectionMetadata>();
	private readonly pathQueues = new Map<string, Promise<void>>();
	private running: Promise<{ projected: number; failed: number }> | null = null;
	private timer: number | null = null;
	private stopped = false;

	constructor(
		private readonly app: App,
		private readonly options: MonthlyProjectionCoordinatorOptions,
	) {
		this.debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS;
		this.cooldownMs = options.cooldownMs ?? DEFAULT_COOLDOWN_MS;
		this.retryDelayMs = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
		this.now = options.now ?? Date.now;
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
		await this.invalidatePeriods(await this.options.inputBuilder.listPeriods());
	}

	async handleConfigurationChanged(): Promise<void> {
		await this.invalidatePeriods(await this.options.inputBuilder.listPeriods());
	}

	listPeriods(): Promise<string[]> {
		return this.options.inputBuilder.listPeriods();
	}

	async invalidatePeriods(periods: readonly string[]): Promise<void> {
		for (const period of [...new Set(periods)].sort()) {
			if (/^\d{4}-(?:0[1-9]|1[0-2])$/u.test(period)) this.markPending(period);
		}
		if (this.pendingPeriods.size > 0) {
			this.notifyStateChanged();
			this.scheduleRun(this.getNextDelay());
		}
	}

	rebuildPeriod(period: string): Promise<{ projected: number; failed: number }> {
		if (!/^\d{4}-(?:0[1-9]|1[0-2])$/u.test(period)) throw new Error(`Invalid Monthly period: ${period}`);
		this.markPending(period);
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
		for (const period of [...this.pendingPeriods].sort()) {
			const invalidationVersion = this.invalidationVersions.get(period) ?? 0;
			const lastProjected = this.lastProjectedAt.get(period);
			if (!ignoreCooldown && lastProjected !== undefined && this.now() - lastProjected < this.cooldownMs) continue;
			try {
				await this.project(period);
				if ((this.invalidationVersions.get(period) ?? 0) === invalidationVersion) {
					this.pendingPeriods.delete(period);
				}
				this.failedPeriods.delete(period);
				this.lastProjectedAt.set(period, this.now());
				projected += 1;
			} catch {
				this.failedPeriods.add(period);
				failed += 1;
			}
		}
		return { projected, failed };
	}

	private async project(period: string): Promise<void> {
		const built = await this.options.inputBuilder.build(period);
		const projection = await buildMonthlyProjection({
			period,
			settings: built.settings,
			observations: built.observations,
			sourceDigest: built.sourceDigest,
		});
		await this.enqueuePath(projection.path, async () => {
			const existing = this.app.vault.getAbstractFileByPath(projection.path);
			if (existing !== null && !(existing instanceof TFile)) {
				throw new Error(`Monthly projection target is not a file: ${projection.path}`);
			}
			if (existing instanceof TFile) {
				const currentHash = await sha256Bytes(new Uint8Array(await this.app.vault.readBinary(existing)));
				if (currentHash === projection.outputHash) {
					this.metadata.set(period, toMetadata(projection));
					return;
				}
			}
			const opId = `monthly-projection:${period}:${projection.outputHash}`;
			this.options.selfWriteTracker.mark(projection.path, {
				opId,
				path: projection.path,
				reason: "monthly_projection",
				writtenAt: this.now(),
				expiresAt: this.now() + 10_000,
				expectedHash: projection.outputHash,
			});
			try {
				const file = existing instanceof TFile ? existing : await ensureTextFile(this.app, projection.path);
				await this.app.vault.process(file, (currentContent) =>
					currentContent === projection.content ? currentContent : projection.content);
				const outputHash = await sha256Bytes(new Uint8Array(await this.app.vault.readBinary(file)));
				if (outputHash !== projection.outputHash) throw new Error("Monthly projection output verification failed.");
				this.metadata.set(period, toMetadata(projection));
			} catch (error) {
				this.options.selfWriteTracker.discard(projection.path, opId);
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
		const period = await this.options.inputBuilder.getDailyPeriod(file.path);
		if (period !== null) await this.invalidatePeriods([period]);
	}

	private async handleFileDeleted(file: unknown): Promise<void> {
		if (!(file instanceof TFile)) return;
		const monthlyPeriod = this.options.inputBuilder.getMonthlyPeriod(file.path);
		const dailyPeriod = await this.options.inputBuilder.getDailyPeriod(file.path);
		await this.invalidatePeriods([monthlyPeriod, dailyPeriod].filter((period): period is string => period !== null));
	}

	private async handleFileRenamed(file: unknown, oldPath: string): Promise<void> {
		const oldMonthlyPeriod = this.options.inputBuilder.getMonthlyPeriod(oldPath);
		const oldDailyPeriod = await this.options.inputBuilder.getDailyPeriod(oldPath);
		await this.invalidatePeriods([oldMonthlyPeriod, oldDailyPeriod].filter((period): period is string => period !== null));
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

	private markPending(period: string): void {
		this.pendingPeriods.add(period);
		this.invalidationVersions.set(period, (this.invalidationVersions.get(period) ?? 0) + 1);
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

export function getMonthlyProjectionTargetPath(settings: KnomoSettings, period: string): string {
	return getMonthlyArchivePath(settings, period);
}
