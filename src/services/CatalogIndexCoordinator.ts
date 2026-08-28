import { normalizePath, TFile, TFolder } from "obsidian";
import type { App, Component } from "obsidian";

import type {
	CatalogCheckpoint,
	CatalogCoverage,
	CatalogFileRecord,
	CatalogInventoryEntry,
	CatalogRefreshResult,
	MemoObservation,
} from "../types/catalog";
import { formatDatePart } from "../utils/date";
import { parseDailyNoteDateFromPath } from "../utils/dailyNotes";
import { hashText } from "../utils/hash";
import { buildDailyInventoryScopeKey } from "./DailyInventoryIndex";
import type { DailyInventoryIndex } from "./DailyInventoryIndex";
import { CATALOG_PARSER_VERSION, DiaryMemoParser } from "./DiaryMemoParser";
import type { DailyNotesConfig } from "./DailyNoteService";
import type { LowPriorityWorkRunner } from "./LowPriorityWorkQueue";
import type { MemoCatalogService } from "./MemoCatalogService";
import type { MarkdownCatalogCommitInput } from "./MarkdownMutationService";
import { CooperativeYieldController, stableSortCooperatively } from "./CooperativeTask";
import type { CooperativeTaskRuntime } from "./CooperativeTask";

export const CATALOG_SCANNER_ENABLED = true;
export const CATALOG_CHECKPOINT_META_KEY = "catalogCheckpoint";
export const CATALOG_LAST_FULL_AUDIT_META_KEY = "catalogLastFullAuditAt";
export const CATALOG_FAILED_PATHS_META_KEY = "catalogFailedPaths";

const DEFAULT_FULL_AUDIT_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_SLICE_BUDGET_MS = 12;
const DEFAULT_CHECKPOINT_BATCH_SIZE = 25;
const DEFAULT_CHECKPOINT_INTERVAL_MS = 1_000;
const DEFAULT_PROGRESS_INTERVAL_MS = 250;
const CATALOG_SCAN_WORK_PRIORITY = 20;

interface CatalogFailure {
	sourcePath: string;
	message: string;
}

interface CatalogPathRevision {
	generation: number;
	mtime: number;
	size: number;
}

export interface CatalogRevisionTransitionSide {
	sourceRevision: string;
	observations: readonly MemoObservation[];
}

export interface CatalogRevisionTransition {
	sourcePath: string;
	before: CatalogRevisionTransitionSide | null;
	after: CatalogRevisionTransitionSide;
}

export interface CatalogIndexCoordinatorOptions {
	enabled?: boolean;
	fullAuditIntervalMs?: number;
	sliceBudgetMs?: number;
	checkpointBatchSize?: number;
	checkpointIntervalMs?: number;
	progressIntervalMs?: number;
	now?: () => number;
	onProgress?: (coverage: CatalogCoverage) => void | Promise<void>;
	onCatalogSettled?: () => void | Promise<void>;
	onRevisionTransition?: (transition: CatalogRevisionTransition) => void | Promise<void>;
	onDailyPeriodsChanged?: (periods: readonly string[]) => void | Promise<void>;
	isConfigurationComplete?: () => boolean;
	dailyInventory?: DailyInventoryIndex;
	workQueue?: LowPriorityWorkRunner;
	yieldControl?: () => Promise<void>;
}

export class CatalogIndexCoordinator {
	private readonly enabled: boolean;
	private readonly fullAuditIntervalMs: number;
	private readonly sliceBudgetMs: number;
	private readonly checkpointBatchSize: number;
	private readonly checkpointIntervalMs: number;
	private readonly progressIntervalMs: number;
	private readonly now: () => number;
	private readonly onProgress: ((coverage: CatalogCoverage) => void | Promise<void>) | null;
	private readonly onCatalogSettled: (() => void | Promise<void>) | null;
	private readonly onRevisionTransition: ((transition: CatalogRevisionTransition) => void | Promise<void>) | null;
	private readonly onDailyPeriodsChanged: ((periods: readonly string[]) => void | Promise<void>) | null;
	private readonly isConfigurationComplete: () => boolean;
	private readonly dailyInventory: DailyInventoryIndex | null;
	private readonly workQueue: LowPriorityWorkRunner | null;
	private readonly externalYieldControl: (() => Promise<void>) | null;
	private inventoryByPath = new Map<string, CatalogInventoryEntry>();
	private readonly coveredPaths = new Set<string>();
	private readonly coverageByDate = new Map<string, { total: number; covered: number }>();
	private readonly pendingDeletedPaths = new Set<string>();
	private readonly failedPaths = new Map<string, CatalogFailure>();
	private readonly idleResolvers: Array<() => void> = [];
	private readonly pathResolvers = new Map<string, Array<() => void>>();
	private readonly pathGenerations = new Map<string, number>();
	private readonly pathSerialTails = new Map<string, Promise<void>>();
	private queue: string[] = [];
	private coverageDates: string[] = [];
	private coveredFileCount = 0;
	private activePath: string | null = null;
	private dailyConfig: DailyNotesConfig | null = null;
	private settingsFingerprint = "";
	private checkpointStartedAt = 0;
	private processedSinceCheckpoint = 0;
	private lastCheckpointAt = 0;
	private lastProgressAt = Number.NEGATIVE_INFINITY;
	private fullAuditScheduled = false;
	private opened = false;
	private stopped = false;
	private paused = false;
	private processing = false;
	private reconciling = false;
	private reconcileQueued = false;
	private reconcileAgain = false;
	private closeWhenIdle = false;
	private rebuilding = false;
	private suppressScannedPeriodChanges = true;
	private drainTimer: number | null = null;
	private drainQueued = false;
	private reconcileTimer: number | null = null;
	private auditTimer: number | null = null;
	private readonly yieldTimers = new Map<number, () => void>();

	constructor(
		private readonly app: App,
		private readonly catalogService: MemoCatalogService,
		private readonly parser: DiaryMemoParser,
		private readonly getDailyConfig: () => Promise<DailyNotesConfig>,
		options: CatalogIndexCoordinatorOptions = {},
	) {
		this.enabled = options.enabled ?? CATALOG_SCANNER_ENABLED;
		this.fullAuditIntervalMs = options.fullAuditIntervalMs ?? DEFAULT_FULL_AUDIT_INTERVAL_MS;
		this.sliceBudgetMs = options.sliceBudgetMs ?? DEFAULT_SLICE_BUDGET_MS;
		this.checkpointBatchSize = Math.max(1, options.checkpointBatchSize ?? DEFAULT_CHECKPOINT_BATCH_SIZE);
		this.checkpointIntervalMs = Math.max(1, options.checkpointIntervalMs ?? DEFAULT_CHECKPOINT_INTERVAL_MS);
		this.progressIntervalMs = Math.max(0, options.progressIntervalMs ?? DEFAULT_PROGRESS_INTERVAL_MS);
		this.now = options.now ?? Date.now;
		this.onProgress = options.onProgress ?? null;
		this.onCatalogSettled = options.onCatalogSettled ?? null;
		this.onRevisionTransition = options.onRevisionTransition ?? null;
		this.onDailyPeriodsChanged = options.onDailyPeriodsChanged ?? null;
		this.isConfigurationComplete = options.isConfigurationComplete ?? (() => true);
		this.dailyInventory = options.dailyInventory ?? null;
		this.workQueue = options.workQueue ?? null;
		this.externalYieldControl = options.yieldControl ?? null;
	}

	start(owner: Component): void {
		if (!this.enabled) {
			return;
		}
		owner.registerEvent(this.app.vault.on("modify", (file) => this.handleFileChanged(file)));
		owner.registerEvent(this.app.vault.on("create", (file) => this.handleFileChanged(file)));
		owner.registerEvent(this.app.vault.on("rename", (file, oldPath) => this.handleFileRenamed(file, oldPath)));
		owner.registerEvent(this.app.vault.on("delete", (file) => this.handleFileDeleted(file)));
		owner.registerDomEvent(this.app.workspace.containerEl.doc, "visibilitychange", () => this.handleVisibilityChange());
		owner.register(() => this.stop());
		this.paused = this.app.workspace.containerEl.doc.visibilityState === "hidden";
	}

	async initialize(): Promise<void> {
		if (!this.enabled || this.isStopped() || this.opened) {
			return;
		}
		await this.catalogService.open();
		if (this.isStopped()) {
			this.catalogService.close();
			return;
		}
		this.opened = true;
		await this.reconcileInventory();
	}

	waitForIdle(): Promise<void> {
		if (this.isIdle()) {
			return Promise.resolve();
		}
		return new Promise<void>((resolve) => this.idleResolvers.push(resolve));
	}

	async refreshPaths(paths: readonly string[]): Promise<void> {
		if (!this.opened || this.isStopped()) throw new Error("Memo Catalog is not available.");
		const normalizedPaths = [...new Set(paths.map((path) => normalizePath(path)))];
		const refreshed = normalizedPaths.map((path) => new Promise<void>((resolve) => {
			const resolvers = this.pathResolvers.get(path) ?? [];
			resolvers.push(resolve);
			this.pathResolvers.set(path, resolvers);
		}));
		for (const path of normalizedPaths) {
			const abstractFile = this.app.vault.getAbstractFileByPath(path);
			const entry = abstractFile instanceof TFile ? this.toInventoryEntry(abstractFile) : null;
			if (entry === null) {
				this.enqueueDeletedPath(path);
			} else {
				this.upsertInventoryEntry(entry);
				this.setPathCovered(path, false);
				this.enqueuePath(path, true);
			}
		}
		this.scheduleDrain();
		await Promise.all(refreshed);
	}

	async replaceCommittedFile(input: MarkdownCatalogCommitInput): Promise<void> {
		if (!this.opened || this.isStopped()) throw new Error("Memo Catalog is not available.");
		const sourcePath = normalizePath(input.file.path);
		const inventory: CatalogInventoryEntry = {
			sourcePath,
			logicalDate: input.logicalDate,
			mtime: input.file.stat.mtime,
			size: new TextEncoder().encode(input.content).byteLength,
		};
		this.bumpPathGeneration(sourcePath);
		if (this.reconciling || this.reconcileQueued) this.reconcileAgain = true;
		await this.runPathSerial(sourcePath, async () => {
			if (this.isStopped()) throw new Error("Memo Catalog is not available.");
			await this.reconcileRevisionTransition(sourcePath, input.parsed.sourceRevision, input.parsed.observations);
			if (this.isStopped()) throw new Error("Memo Catalog is not available.");
			await this.catalogService.replaceFile({
				inventory,
				sourceRevision: input.parsed.sourceRevision,
				observations: input.parsed.observations,
				parserVersion: CATALOG_PARSER_VERSION,
				settingsFingerprint: this.settingsFingerprint,
				auditedAt: this.now(),
			});
			if (this.isStopped()) return;
			this.upsertInventoryEntry(inventory);
			this.setPathCovered(sourcePath, true);
			this.failedPaths.delete(sourcePath);
			const coverage = this.buildCoverage();
			await this.catalogService.getStore().setCoverage(coverage);
			this.notifyProgress(coverage);
			this.notifyDailyPeriodsChanged([inventory.logicalDate.slice(0, 7)]);
		});
	}

	async rebuildLocalCatalog(): Promise<void> {
		if (!this.opened || this.isStopped()) throw new Error("Memo Catalog is not available.");
		await this.waitForIdle();
		if (this.isStopped()) throw new Error("Memo Catalog is not available.");
		this.rebuilding = true;
		try {
			await this.catalogService.getStore().clear();
			if (this.isStopped()) return;
			this.inventoryByPath.clear();
			this.coveredPaths.clear();
			this.pendingDeletedPaths.clear();
			this.failedPaths.clear();
			this.queue = [];
			this.fullAuditScheduled = false;
			await this.reconcileInventory();
			if (this.isStopped()) return;
			await this.waitForIdle();
		} finally {
			if (this.rebuilding) {
				this.rebuilding = false;
				if (!this.isStopped()) {
					const coverage = this.buildCoverage();
					await this.catalogService.getStore().setCoverage(coverage).catch(() => undefined);
					this.notifyProgress(coverage);
				}
			}
		}
	}

	async refreshLocalCatalog(): Promise<CatalogRefreshResult> {
		if (!this.opened || this.isStopped()) throw new Error("Memo Catalog is not available.");
		const before = await this.catalogService.listFiles();
		if (this.isStopped()) throw new Error("Memo Catalog is not available.");
		await this.reconcileInventory();
		await this.waitForIdle();
		if (this.isStopped()) throw new Error("Memo Catalog is not available.");
		const after = await this.catalogService.listFiles();
		return buildRefreshResult(before, after, [...this.failedPaths.values()]);
	}

	private handleFileChanged(file: unknown): void {
		if (!(file instanceof TFile) || file.extension !== "md") {
			return;
		}
		const entry = this.toInventoryEntry(file);
		if (entry === null) return;
		if (this.reconciling || this.reconcileQueued) this.reconcileAgain = true;
		this.pendingDeletedPaths.delete(entry.sourcePath);
		this.upsertInventoryEntry(entry);
		this.setPathCovered(entry.sourcePath, false);
		this.enqueuePath(entry.sourcePath);
		this.scheduleDrain();
	}

	private handleFileRenamed(file: unknown, oldPath: string): void {
		const normalizedOldPath = normalizePath(oldPath);
		if (file instanceof TFolder) {
			if (this.reconciling || this.reconcileQueued) this.reconcileAgain = true;
			this.enqueueDeletedFolderPaths(normalizedOldPath);
			this.enqueueDailyFolderFiles(file);
			this.scheduleDrain();
			return;
		}
		const oldPathWasDaily = this.inventoryByPath.has(normalizedOldPath) || this.matchesDailyPath(normalizedOldPath);
		if (oldPathWasDaily) {
			if (this.reconciling || this.reconcileQueued) this.reconcileAgain = true;
			this.enqueueDeletedPath(normalizedOldPath);
		}
		if (!(file instanceof TFile) || file.extension !== "md") {
			this.scheduleDrain();
			return;
		}
		const entry = this.toInventoryEntry(file);
		if (entry !== null && (this.reconciling || this.reconcileQueued)) {
			this.reconcileAgain = true;
		}
		if (entry !== null) {
			this.pendingDeletedPaths.delete(entry.sourcePath);
			this.upsertInventoryEntry(entry);
			this.setPathCovered(entry.sourcePath, false);
			this.enqueuePath(entry.sourcePath);
		}
		this.scheduleDrain();
	}

	private handleFileDeleted(file: unknown): void {
		if (file instanceof TFolder) {
			if (this.reconciling || this.reconcileQueued) this.reconcileAgain = true;
			this.enqueueDeletedFolderPaths(normalizePath(file.path));
			this.scheduleDrain();
			return;
		}
		if (!(file instanceof TFile)) {
			return;
		}
		const sourcePath = normalizePath(file.path);
		if (!this.inventoryByPath.has(sourcePath) && !this.matchesDailyPath(sourcePath)) return;
		if (this.reconciling || this.reconcileQueued) this.reconcileAgain = true;
		this.enqueueDeletedPath(sourcePath);
		this.scheduleDrain();
	}

	private handleVisibilityChange(): void {
		this.paused = this.app.workspace.containerEl.doc.visibilityState === "hidden";
		if (this.paused) {
			if (this.hasCheckpointWork()) void this.saveProgress(true).catch(() => undefined);
		} else {
			this.scheduleReconcile(0);
			this.scheduleDrain();
		}
	}

	private scheduleReconcile(delay = 0): void {
		if (!this.enabled || this.isStopped() || !this.opened) {
			return;
		}
		const win = this.app.workspace.containerEl.win;
		if (this.reconcileTimer !== null) {
			win.clearTimeout(this.reconcileTimer);
		}
		this.reconcileTimer = win.setTimeout(() => {
			this.reconcileTimer = null;
			void this.reconcileInventory().catch(() => undefined);
		}, delay);
	}

	private async reconcileInventory(): Promise<void> {
		if (!this.opened || this.isStopped()) {
			return;
		}
		if (this.processing || this.reconciling || this.reconcileQueued) {
			this.reconcileAgain = true;
			return;
		}
		this.reconcileQueued = true;
		try {
			await this.runLowPriorityTask(() => this.reconcileInventoryNow());
		} catch (error) {
			if (!this.isStopped()) throw error;
		} finally {
			this.reconcileQueued = false;
			this.closeStoreWhenSafe();
			this.resolveIdleIfNeeded();
		}
	}

	private async reconcileInventoryNow(): Promise<void> {
		if (!this.opened || this.isStopped()) return;
		this.reconcileQueued = false;
		this.reconciling = true;
		try {
			this.dailyConfig = await this.getDailyConfig();
			if (this.isStopped()) return;
			this.settingsFingerprint = buildSettingsFingerprint(this.dailyConfig);
			const runtime = this.createCooperativeRuntime();
			const inventory = await collectDailyInventory(this.app, this.dailyConfig, runtime);
			if (this.isStopped()) return;
			const yieldController = new CooperativeYieldController(runtime);
			const nextInventoryByPath = new Map<string, CatalogInventoryEntry>();
			for (const entry of inventory) {
				nextInventoryByPath.set(entry.sourcePath, entry);
				if (yieldController.shouldYield()) {
					await yieldController.yieldNow();
					if (this.isStopped()) return;
				}
			}
			this.inventoryByPath = nextInventoryByPath;
			await this.dailyInventory?.replaceCooperatively(
				inventory,
				buildDailyInventoryScopeKey(this.dailyConfig),
				runtime,
			);
			if (this.isStopped()) return;

			const store = this.catalogService.getStore();
			const storedFiles = await store.listFiles();
			if (this.isStopped()) return;
			const previousCoverage = await store.getCoverage();
			if (this.isStopped()) return;
			this.suppressScannedPeriodChanges = storedFiles.length === 0 && previousCoverage.kind !== "complete";
			if (storedFiles.length === 0 && inventory.length > 0) this.rebuilding = true;
			const storedByPath = new Map<string, CatalogFileRecord>();
			for (const file of storedFiles) {
				storedByPath.set(file.sourcePath, file);
				if (yieldController.shouldYield()) await yieldController.yieldNow();
			}
			const changedPeriods = new Set<string>();
			for (const storedFile of storedFiles) {
				if (this.isStopped()) return;
				if (!this.inventoryByPath.has(storedFile.sourcePath)) {
					await this.deleteCatalogPathIfAbsent(storedFile.sourcePath);
					changedPeriods.add(storedFile.logicalDate.slice(0, 7));
				}
				if (yieldController.shouldYield()) await yieldController.yieldNow();
			}
			for (const deletedPath of this.pendingDeletedPaths) {
				if (this.isStopped()) return;
				const stored = storedByPath.get(deletedPath);
				await this.deleteCatalogPathIfAbsent(deletedPath);
				if (stored !== undefined) changedPeriods.add(stored.logicalDate.slice(0, 7));
				storedByPath.delete(deletedPath);
				if (yieldController.shouldYield()) await yieldController.yieldNow();
			}
			this.pendingDeletedPaths.clear();
			if (!this.suppressScannedPeriodChanges) this.notifyDailyPeriodsChanged([...changedPeriods]);

			const checkpoint = await store.getMeta<CatalogCheckpoint>(CATALOG_CHECKPOINT_META_KEY);
			if (this.isStopped()) return;
			const checkpointCompatible = checkpoint !== null
				&& checkpoint.settingsFingerprint === this.settingsFingerprint
				&& checkpoint.parserVersion === CATALOG_PARSER_VERSION;
			const lastFullAuditAt = await store.getMeta<number>(CATALOG_LAST_FULL_AUDIT_META_KEY);
			if (this.isStopped()) return;
			const resumingFullAudit = checkpointCompatible && checkpoint.fullAudit;
			const fullAuditDue = lastFullAuditAt === null
				|| this.now() - lastFullAuditAt >= this.fullAuditIntervalMs;
			const startingFullAudit = !resumingFullAudit && fullAuditDue;
			this.scheduleAuditWake(lastFullAuditAt, resumingFullAudit || startingFullAudit);
			const pending = new Set<string>();
			this.coveredPaths.clear();
			for (const entry of inventory) {
				const stored = storedByPath.get(entry.sourcePath);
				if (isCurrentFileRecord(stored, entry, this.settingsFingerprint)) {
					this.coveredPaths.add(entry.sourcePath);
				} else {
					pending.add(entry.sourcePath);
				}
				if (yieldController.shouldYield()) await yieldController.yieldNow();
			}
			if (checkpointCompatible) {
				for (const path of checkpoint.pendingPaths) {
					if (this.inventoryByPath.has(path)) {
						pending.add(path);
					}
					if (yieldController.shouldYield()) await yieldController.yieldNow();
				}
			}
			if (startingFullAudit) {
				for (const entry of inventory) {
					pending.add(entry.sourcePath);
					if (yieldController.shouldYield()) await yieldController.yieldNow();
				}
			}
			for (const path of pending) {
				this.coveredPaths.delete(path);
				if (yieldController.shouldYield()) await yieldController.yieldNow();
			}
			await this.rebuildCoverageCounters(runtime);

			this.queue = await sortPathsNewestFirst([...pending], this.inventoryByPath, runtime);
			this.fullAuditScheduled = resumingFullAudit || startingFullAudit;
			this.checkpointStartedAt = checkpointCompatible ? checkpoint.startedAt : this.now();
			this.processedSinceCheckpoint = 0;
			this.lastCheckpointAt = this.now();
			this.failedPaths.clear();
			await this.saveProgress(true, true);
			if (this.isStopped()) return;
			if (this.queue.length === 0) {
				await this.finishScan();
			} else {
				this.scheduleDrain();
			}
		} catch (error) {
			if (this.isStopped()) return;
			this.rebuilding = false;
			const failure = {
				sourcePath: "",
				message: getErrorMessage(error),
			};
			this.failedPaths.set("", failure);
			const store = this.catalogService.getStore();
			await store.setMeta<CatalogFailure[]>(CATALOG_FAILED_PATHS_META_KEY, [failure]);
			await store.setCoverage(this.buildCoverage()).catch(() => undefined);
		} finally {
			this.reconciling = false;
			this.closeStoreWhenSafe();
			if (this.reconcileAgain) {
				this.reconcileAgain = false;
				this.scheduleReconcile(0);
			}
			this.resolveIdleIfNeeded();
		}
	}

	private scheduleDrain(): void {
		if (this.isStopped() || this.paused || this.processing || this.drainQueued || this.drainTimer !== null
			|| (this.queue.length === 0 && this.pendingDeletedPaths.size === 0)) {
			return;
		}
		this.drainTimer = this.app.workspace.containerEl.win.setTimeout(() => {
			this.drainTimer = null;
			this.drainQueued = true;
			void this.runLowPriorityTask(() => this.drainSlice()).catch(() => undefined).finally(() => {
				this.drainQueued = false;
				this.scheduleDrain();
				this.resolveIdleIfNeeded();
			});
		}, 0);
	}

	private async drainSlice(): Promise<void> {
		if (this.processing || this.paused || this.isStopped()) {
			return;
		}
		this.processing = true;
		const sliceStartedAt = monotonicNow();
		try {
			do {
				const deletedPath = this.pendingDeletedPaths.values().next().value as string | undefined;
				if (deletedPath !== undefined) {
					this.pendingDeletedPaths.delete(deletedPath);
					await this.deleteCatalogPathIfAbsent(deletedPath);
					this.failedPaths.delete(deletedPath);
					if (!this.queue.includes(deletedPath)) this.resolvePath(deletedPath);
					this.processedSinceCheckpoint += 1;
					if (this.shouldSaveProgress()) await this.saveProgress();
					continue;
				}
				const sourcePath = this.queue.shift();
				if (sourcePath === undefined) {
					break;
				}
				this.activePath = sourcePath;
				await this.processPath(sourcePath);
				this.activePath = null;
				if (!this.queue.includes(sourcePath) && !this.pendingDeletedPaths.has(sourcePath)) {
					this.resolvePath(sourcePath);
				}
				if (this.isStopped()) break;
				this.processedSinceCheckpoint += 1;
				if (this.shouldSaveProgress()) await this.saveProgress();
			} while (!this.paused
				&& (this.queue.length > 0 || this.pendingDeletedPaths.size > 0)
				&& monotonicNow() - sliceStartedAt < this.sliceBudgetMs);
			if (!this.isStopped()) await this.saveProgress(true);
			if (!this.isStopped() && this.queue.length === 0 && this.pendingDeletedPaths.size === 0) {
				await this.finishScan();
			}
		} finally {
			this.activePath = null;
			this.processing = false;
			this.closeStoreWhenSafe();
			if (this.reconcileAgain && !this.isStopped()) {
				this.reconcileAgain = false;
				this.scheduleReconcile(0);
			} else if (!this.closeWhenIdle) {
				this.scheduleDrain();
			}
			this.resolveIdleIfNeeded();
		}
	}

	private async processPath(sourcePath: string): Promise<void> {
		if (this.isStopped()) return;
		const inventory = this.inventoryByPath.get(sourcePath);
		const abstractFile = this.app.vault.getAbstractFileByPath(sourcePath);
		if (inventory === undefined || !(abstractFile instanceof TFile)) {
			await this.deleteCatalogPathIfAbsent(sourcePath);
			this.removeInventoryEntry(sourcePath);
			return;
		}
		const revision: CatalogPathRevision = {
			generation: this.getPathGeneration(sourcePath),
			mtime: abstractFile.stat.mtime,
			size: abstractFile.stat.size,
		};
		try {
			const raw = await this.app.vault.readBinary(abstractFile);
			if (this.isStopped()) return;
			const bytes = new Uint8Array(raw);
			const parsed = await this.parser.parse({
				sourcePath,
				logicalDate: inventory.logicalDate,
				bytes,
			}, {
				sliceBudgetMs: Math.max(1, Math.min(8, this.sliceBudgetMs)),
				yieldControl: () => this.yieldToEventLoop(),
			});
			if (this.isStopped()) return;
			await this.runPathSerial(sourcePath, async () => {
				if (!this.isPathRevisionCurrent(sourcePath, revision)) {
					this.requeueCurrentPath(sourcePath);
					return;
				}
				const stored = await this.catalogService.getStore().getFile(sourcePath);
				if (this.isStopped()) return;
				if (!this.isPathRevisionCurrent(sourcePath, revision)) {
					this.requeueCurrentPath(sourcePath);
					return;
				}
				if (stored?.sourceRevision !== parsed.sourceRevision
					|| stored.parserVersion !== CATALOG_PARSER_VERSION
					|| stored.settingsFingerprint !== this.settingsFingerprint
					|| stored.mtime !== revision.mtime
					|| stored.size !== revision.size) {
					await this.reconcileRevisionTransition(
						sourcePath,
						parsed.sourceRevision,
						parsed.observations,
						() => this.isPathRevisionCurrent(sourcePath, revision),
					);
					if (this.isStopped()) return;
					if (!this.isPathRevisionCurrent(sourcePath, revision)) {
						this.requeueCurrentPath(sourcePath);
						return;
					}
					if (this.isStopped()) return;
					await this.catalogService.replaceFile({
						inventory: {
							...inventory,
							mtime: revision.mtime,
							size: revision.size,
						},
						sourceRevision: parsed.sourceRevision,
						observations: parsed.observations,
						parserVersion: CATALOG_PARSER_VERSION,
						settingsFingerprint: this.settingsFingerprint,
						auditedAt: this.now(),
					});
					if (!this.suppressScannedPeriodChanges) {
						this.notifyDailyPeriodsChanged([inventory.logicalDate.slice(0, 7)]);
					}
				}
				this.setPathCovered(sourcePath, true);
				this.failedPaths.delete(sourcePath);
			});
		} catch (error) {
			if (this.isStopped()) return;
			this.setPathCovered(sourcePath, false);
			this.failedPaths.set(sourcePath, { sourcePath, message: getErrorMessage(error) });
		}
	}

	private async reconcileRevisionTransition(
		sourcePath: string,
		sourceRevision: string,
		observations: readonly MemoObservation[],
		isCurrent: () => boolean = () => true,
	): Promise<void> {
		if (this.onRevisionTransition === null) return;
		try {
			const before = await this.catalogService.getFileRevisionBatch(sourcePath);
			if (this.isStopped() || !isCurrent() || before === null || before.file.sourceRevision === sourceRevision) return;
			if (this.isStopped()) return;
			await this.onRevisionTransition({
				sourcePath,
				before: {
					sourceRevision: before.file.sourceRevision,
					observations: before.observations,
				},
				after: { sourceRevision, observations },
			});
		} catch {
			// 身份协调属于 Daily 提交后的 follow-up，失败不能阻止 Catalog 采用真实正文。
		}
	}

	private notifyCatalogSettled(): void {
		if (this.isStopped() || this.onCatalogSettled === null) return;
		void Promise.resolve(this.onCatalogSettled()).catch(() => undefined);
	}

	private notifyDailyPeriodsChanged(periods: readonly string[]): void {
		if (this.isStopped() || this.onDailyPeriodsChanged === null || periods.length === 0) return;
		void Promise.resolve(this.onDailyPeriodsChanged([...new Set(periods)])).catch(() => undefined);
	}

	private runLowPriorityTask<T>(action: () => Promise<T>): Promise<T> {
		return this.workQueue?.run(CATALOG_SCAN_WORK_PRIORITY, action) ?? action();
	}

	private createCooperativeRuntime(): CooperativeTaskRuntime {
		return {
			sliceBudgetMs: this.sliceBudgetMs,
			yieldControl: () => this.yieldToEventLoop(),
		};
	}

	private shouldSaveProgress(): boolean {
		return this.processedSinceCheckpoint >= this.checkpointBatchSize
			|| this.now() - this.lastCheckpointAt >= this.checkpointIntervalMs;
	}

	private async saveProgress(
		forceCheckpoint = false,
		forceProgress = false,
	): Promise<void> {
		if (this.isStopped() || (!forceCheckpoint && !this.shouldSaveProgress())) return;
		const store = this.catalogService.getStore();
		const coverage = this.buildCoverage();
		const pendingPaths = [...new Set([
			...(this.activePath === null ? [] : [this.activePath]),
			...this.queue,
		])];
		const checkpoint: CatalogCheckpoint = {
			settingsFingerprint: this.settingsFingerprint,
			parserVersion: CATALOG_PARSER_VERSION,
			pendingPaths,
			fullAudit: this.fullAuditScheduled,
			completedFileCount: coverage.coveredFileCount,
			totalFileCount: coverage.totalFileCount,
			startedAt: this.checkpointStartedAt,
			updatedAt: this.now(),
		};
		const failures = [...this.failedPaths.values()];
		this.processedSinceCheckpoint = 0;
		this.lastCheckpointAt = this.now();
		if (this.isStopped()) return;
		await store.setCoverage(coverage);
		if (this.isStopped()) return;
		this.notifyProgress(coverage, forceProgress);
		await store.setMeta(CATALOG_CHECKPOINT_META_KEY, checkpoint);
		if (this.isStopped()) return;
		await store.setMeta(CATALOG_FAILED_PATHS_META_KEY, failures);
	}

	private notifyProgress(coverage: CatalogCoverage, force = false): void {
		if (this.isStopped() || this.onProgress === null) return;
		const currentTime = monotonicNow();
		if (!force && currentTime - this.lastProgressAt < this.progressIntervalMs) return;
		this.lastProgressAt = currentTime;
		void Promise.resolve(this.onProgress({ ...coverage })).catch(() => undefined);
	}

	private async finishScan(): Promise<void> {
		if (this.isStopped()) return;
		const store = this.catalogService.getStore();
		if (this.failedPaths.size > 0) {
			this.rebuilding = false;
			const coverage = this.buildCoverage();
			await store.setMeta<CatalogCheckpoint>(CATALOG_CHECKPOINT_META_KEY, {
				settingsFingerprint: this.settingsFingerprint,
				parserVersion: CATALOG_PARSER_VERSION,
				pendingPaths: [...this.failedPaths.keys()],
				fullAudit: this.fullAuditScheduled,
				completedFileCount: coverage.coveredFileCount,
				totalFileCount: coverage.totalFileCount,
				startedAt: this.checkpointStartedAt,
				updatedAt: this.now(),
			});
			if (this.isStopped()) return;
			await store.setCoverage(coverage);
			if (this.isStopped()) return;
			this.fullAuditScheduled = false;
			this.scheduleFailedPathRetry();
			this.notifyProgress(coverage, true);
			this.notifyCatalogSettled();
			return;
		}
		if (this.fullAuditScheduled) {
			await store.setMeta(CATALOG_LAST_FULL_AUDIT_META_KEY, this.now());
			if (this.isStopped()) return;
			this.scheduleAuditWake(this.now(), false);
		}
		this.rebuilding = false;
		await store.deleteMeta(CATALOG_CHECKPOINT_META_KEY);
		if (this.isStopped()) return;
		const coverage = this.buildCoverage();
		await store.setCoverage(coverage);
		if (this.isStopped()) return;
		this.fullAuditScheduled = false;
		this.suppressScannedPeriodChanges = false;
		this.notifyProgress(coverage, true);
		this.notifyCatalogSettled();
	}

	private scheduleFailedPathRetry(): void {
		if (this.isStopped()) return;
		const win = this.app.workspace.containerEl.win;
		if (this.auditTimer !== null) {
			win.clearTimeout(this.auditTimer);
		}
		const delay = Math.max(1000, Math.min(60_000, this.fullAuditIntervalMs));
		this.auditTimer = win.setTimeout(() => {
			this.auditTimer = null;
			this.scheduleReconcile(0);
		}, delay);
	}

	private buildCoverage(): CatalogCoverage {
		const sharedConfigurationComplete = this.isConfigurationComplete();
		let coveredFromDate: string | null = null;
		for (const date of this.coverageDates) {
			const counts = this.coverageByDate.get(date);
			if (counts === undefined || counts.covered !== counts.total) break;
			coveredFromDate = date;
		}
		const pendingFileCount = this.inventoryByPath.size - this.coveredFileCount;
		return {
			kind: this.rebuilding
				? "rebuilding"
				: pendingFileCount === 0 && this.failedPaths.size === 0
					? "complete"
					: "partial",
			sharedConfigurationComplete,
			coveredFromDate,
			pendingFileCount,
			coveredFileCount: this.coveredFileCount,
			totalFileCount: this.inventoryByPath.size,
		};
	}

	private async rebuildCoverageCounters(runtime: CooperativeTaskRuntime): Promise<void> {
		const yieldController = new CooperativeYieldController(runtime);
		this.coverageByDate.clear();
		this.coveredFileCount = 0;
		for (const sourcePath of [...this.coveredPaths]) {
			if (!this.inventoryByPath.has(sourcePath)) this.coveredPaths.delete(sourcePath);
			if (yieldController.shouldYield()) await yieldController.yieldNow();
		}
		for (const entry of this.inventoryByPath.values()) {
			const counts = this.coverageByDate.get(entry.logicalDate) ?? { total: 0, covered: 0 };
			counts.total += 1;
			if (this.coveredPaths.has(entry.sourcePath)) {
				counts.covered += 1;
				this.coveredFileCount += 1;
			}
			this.coverageByDate.set(entry.logicalDate, counts);
			if (yieldController.shouldYield()) await yieldController.yieldNow();
		}
		this.coverageDates = await stableSortCooperatively(
			[...this.coverageByDate.keys()],
			(left, right) => right.localeCompare(left),
			runtime,
		);
	}

	private upsertInventoryEntry(entry: CatalogInventoryEntry): void {
		const existing = this.inventoryByPath.get(entry.sourcePath);
		if (existing?.logicalDate === entry.logicalDate) {
			this.inventoryByPath.set(entry.sourcePath, entry);
			this.dailyInventory?.upsert(entry);
			return;
		}
		if (existing !== undefined) this.removeCoverageDateEntry(existing, this.coveredPaths.has(entry.sourcePath));
		this.inventoryByPath.set(entry.sourcePath, entry);
		this.dailyInventory?.upsert(entry);
		const counts = this.coverageByDate.get(entry.logicalDate) ?? { total: 0, covered: 0 };
		counts.total += 1;
		if (this.coveredPaths.has(entry.sourcePath)) counts.covered += 1;
		this.coverageByDate.set(entry.logicalDate, counts);
		this.refreshCoverageDates();
	}

	private removeInventoryEntry(sourcePath: string): void {
		const existing = this.inventoryByPath.get(sourcePath);
		if (existing === undefined) {
			this.coveredPaths.delete(sourcePath);
			this.dailyInventory?.remove(sourcePath);
			return;
		}
		const covered = this.coveredPaths.delete(sourcePath);
		if (covered) this.coveredFileCount -= 1;
		this.removeCoverageDateEntry(existing, covered);
		this.inventoryByPath.delete(sourcePath);
		this.dailyInventory?.remove(sourcePath);
		this.refreshCoverageDates();
	}

	private removeCoverageDateEntry(entry: CatalogInventoryEntry, covered: boolean): void {
		const counts = this.coverageByDate.get(entry.logicalDate);
		if (counts === undefined) return;
		counts.total -= 1;
		if (covered) counts.covered -= 1;
		if (counts.total === 0) this.coverageByDate.delete(entry.logicalDate);
	}

	private setPathCovered(sourcePath: string, covered: boolean): void {
		const entry = this.inventoryByPath.get(sourcePath);
		if (entry === undefined) return;
		const wasCovered = this.coveredPaths.has(sourcePath);
		if (wasCovered === covered) return;
		const counts = this.coverageByDate.get(entry.logicalDate);
		if (covered) {
			this.coveredPaths.add(sourcePath);
			this.coveredFileCount += 1;
			if (counts !== undefined) counts.covered += 1;
		} else {
			this.coveredPaths.delete(sourcePath);
			this.coveredFileCount -= 1;
			if (counts !== undefined) counts.covered -= 1;
		}
	}

	private refreshCoverageDates(): void {
		this.coverageDates = [...this.coverageByDate.keys()].sort((left, right) => right.localeCompare(left));
	}

	private toInventoryEntry(file: TFile): CatalogInventoryEntry | null {
		if (this.dailyConfig === null) return null;
		const sourcePath = normalizePath(file.path);
		const date = parseDailyNoteDateFromPath(sourcePath, this.dailyConfig);
		return date === null ? null : {
			sourcePath,
			logicalDate: formatDatePart(date),
			mtime: file.stat.mtime,
			size: file.stat.size,
		};
	}

	private matchesDailyPath(sourcePath: string): boolean {
		return this.dailyConfig !== null
			&& parseDailyNoteDateFromPath(sourcePath, this.dailyConfig) !== null;
	}

	private enqueuePath(sourcePath: string, prioritize = false): void {
		this.bumpPathGeneration(sourcePath);
		const queueIndex = this.queue.indexOf(sourcePath);
		if (queueIndex !== -1) this.queue.splice(queueIndex, 1);
		if (prioritize) this.queue.unshift(sourcePath);
		else this.queue.push(sourcePath);
	}

	private enqueueDeletedPath(sourcePath: string): void {
		this.bumpPathGeneration(sourcePath);
		const queueIndex = this.queue.indexOf(sourcePath);
		if (queueIndex !== -1) this.queue.splice(queueIndex, 1);
		this.pendingDeletedPaths.add(sourcePath);
		this.removeInventoryEntry(sourcePath);
	}

	private enqueueDeletedFolderPaths(folderPath: string): void {
		const pathPrefix = folderPath.length === 0 ? "" : `${folderPath}/`;
		for (const sourcePath of [...this.inventoryByPath.keys()]) {
			if (pathPrefix.length === 0 || sourcePath.startsWith(pathPrefix)) {
				this.enqueueDeletedPath(sourcePath);
			}
		}
	}

	private enqueueDailyFolderFiles(folder: TFolder): void {
		const pending = [...folder.children];
		while (pending.length > 0) {
			const child = pending.pop();
			if (child instanceof TFolder) {
				pending.push(...child.children);
				continue;
			}
			if (!(child instanceof TFile) || child.extension !== "md") continue;
			const entry = this.toInventoryEntry(child);
			if (entry === null) continue;
			this.pendingDeletedPaths.delete(entry.sourcePath);
			this.upsertInventoryEntry(entry);
			this.setPathCovered(entry.sourcePath, false);
			this.enqueuePath(entry.sourcePath);
		}
	}

	private requeueCurrentPath(sourcePath: string): void {
		const abstractFile = this.app.vault.getAbstractFileByPath(sourcePath);
		const entry = abstractFile instanceof TFile && abstractFile.extension === "md"
			? this.toInventoryEntry(abstractFile)
			: null;
		if (entry === null) {
			this.enqueueDeletedPath(sourcePath);
			return;
		}
		this.pendingDeletedPaths.delete(sourcePath);
		this.upsertInventoryEntry(entry);
		this.setPathCovered(sourcePath, false);
		this.enqueuePath(sourcePath);
	}

	private isPathRevisionCurrent(sourcePath: string, revision: CatalogPathRevision): boolean {
		if (this.getPathGeneration(sourcePath) !== revision.generation) return false;
		const abstractFile = this.app.vault.getAbstractFileByPath(sourcePath);
		return abstractFile instanceof TFile
			&& abstractFile.extension === "md"
			&& abstractFile.stat.mtime === revision.mtime
			&& abstractFile.stat.size === revision.size;
	}

	private getPathGeneration(sourcePath: string): number {
		return this.pathGenerations.get(sourcePath) ?? 0;
	}

	private bumpPathGeneration(sourcePath: string): void {
		this.pathGenerations.set(sourcePath, this.getPathGeneration(sourcePath) + 1);
	}

	private async deleteCatalogPathIfAbsent(sourcePath: string): Promise<void> {
		await this.runPathSerial(sourcePath, async () => {
			if (this.isStopped() || this.inventoryByPath.has(sourcePath)) return;
			await this.catalogService.deleteFile(sourcePath);
		});
	}

	private async runPathSerial<T>(sourcePath: string, action: () => Promise<T>): Promise<T> {
		const previous = this.pathSerialTails.get(sourcePath) ?? Promise.resolve();
		const operation = previous.then(action);
		const tail = operation.then(() => undefined, () => undefined);
		this.pathSerialTails.set(sourcePath, tail);
		try {
			return await operation;
		} finally {
			if (this.pathSerialTails.get(sourcePath) === tail) {
				this.pathSerialTails.delete(sourcePath);
			}
			this.closeStoreWhenSafe();
			this.resolveIdleIfNeeded();
		}
	}

	private async yieldToEventLoop(): Promise<void> {
		if (this.isStopped()) throw new Error("Catalog indexing stopped.");
		if (this.externalYieldControl !== null) {
			await this.externalYieldControl();
			if (this.isStopped()) throw new Error("Catalog indexing stopped.");
			return;
		}
		await new Promise<void>((resolve) => {
			const win = this.app.workspace.containerEl.win;
			let timer = 0;
			const finish = () => {
				this.yieldTimers.delete(timer);
				resolve();
			};
			timer = win.setTimeout(finish, 0);
			this.yieldTimers.set(timer, finish);
		});
		if (this.isStopped()) throw new Error("Catalog indexing stopped.");
	}

	private scheduleAuditWake(lastFullAuditAt: number | null, fullAuditDue: boolean): void {
		const win = this.app.workspace.containerEl.win;
		if (this.auditTimer !== null) {
			win.clearTimeout(this.auditTimer);
			this.auditTimer = null;
		}
		if (fullAuditDue || lastFullAuditAt === null || this.isStopped()) {
			return;
		}
		const delay = Math.max(0, lastFullAuditAt + this.fullAuditIntervalMs - this.now());
		this.auditTimer = win.setTimeout(() => {
			this.auditTimer = null;
			this.scheduleReconcile(0);
		}, delay);
	}

	private stop(): void {
		if (this.stopped) return;
		this.stopped = true;
		const win = this.app.workspace.containerEl.win;
		for (const timer of [this.drainTimer, this.reconcileTimer, this.auditTimer]) {
			if (timer !== null) {
				win.clearTimeout(timer);
			}
		}
		this.drainTimer = null;
		this.reconcileTimer = null;
		this.auditTimer = null;
		for (const [timer, resolve] of this.yieldTimers) {
			win.clearTimeout(timer);
			resolve();
		}
		this.yieldTimers.clear();
		for (const path of this.queue) this.resolvePath(path);
		this.queue = [];
		this.pendingDeletedPaths.clear();
		for (const path of this.pathResolvers.keys()) this.resolvePath(path);
		this.closeWhenIdle = this.opened;
		this.closeStoreWhenSafe();
		this.resolveIdleIfNeeded();
	}

	private hasCheckpointWork(): boolean {
		return this.activePath !== null || this.queue.length > 0;
	}

	private isIdle(): boolean {
		return this.queue.length === 0 && this.pendingDeletedPaths.size === 0
			&& !this.processing && !this.reconciling && !this.reconcileQueued
			&& this.pathSerialTails.size === 0
			&& !this.drainQueued && this.drainTimer === null && this.reconcileTimer === null;
	}

	private closeStoreWhenSafe(): void {
		if (!this.closeWhenIdle || this.processing || this.reconciling || this.reconcileQueued
			|| this.pathSerialTails.size > 0) {
			return;
		}
		this.catalogService.close();
		this.opened = false;
		this.closeWhenIdle = false;
	}

	private isStopped(): boolean {
		return this.stopped || this.workQueue?.signal.aborted === true;
	}

	private resolveIdleIfNeeded(): void {
		if (!this.isIdle()) {
			return;
		}
		for (const resolve of this.idleResolvers.splice(0)) {
			resolve();
		}
	}

	private resolvePath(sourcePath: string): void {
		for (const resolve of this.pathResolvers.get(sourcePath) ?? []) resolve();
		this.pathResolvers.delete(sourcePath);
	}
}

export function createCatalogDatabaseName(app: App): string {
	const vault = app.vault as App["vault"] & {
		adapter?: App["vault"]["adapter"];
		getName?: () => string;
		configDir?: string;
	};
	const adapter = vault.adapter as (App["vault"]["adapter"] & {
		getFullPath?: (path: string) => string;
		getBasePath?: () => string;
	}) | undefined;
	let deviceLocalVaultKey = `${adapter?.getName?.() ?? "vault"}\0${vault.getName?.() ?? "unknown"}\0${vault.configDir ?? ".obsidian"}`;
	try {
		deviceLocalVaultKey = adapter?.getBasePath?.() ?? adapter?.getFullPath?.("") ?? deviceLocalVaultKey;
	} catch {
		// 移动端 adapter 未必提供桌面绝对路径；退回 Vault 元数据组合。
	}
	return `knomo-catalog-${hashText(deviceLocalVaultKey)}`;
}

async function collectDailyInventory(
	app: App,
	config: DailyNotesConfig,
	runtime: CooperativeTaskRuntime,
): Promise<CatalogInventoryEntry[]> {
	const entries: CatalogInventoryEntry[] = [];
	const yieldController = new CooperativeYieldController(runtime);
	for (const file of app.vault.getMarkdownFiles()) {
		const sourcePath = normalizePath(file.path);
		const date = parseDailyNoteDateFromPath(sourcePath, config);
		if (date !== null) {
			entries.push({
				sourcePath,
				logicalDate: formatDatePart(date),
				mtime: file.stat.mtime,
				size: file.stat.size,
			});
		}
		if (yieldController.shouldYield()) await yieldController.yieldNow();
	}
	return stableSortCooperatively(entries, (left, right) =>
		right.logicalDate.localeCompare(left.logicalDate) || left.sourcePath.localeCompare(right.sourcePath), runtime);
}

function buildSettingsFingerprint(config: DailyNotesConfig): string {
	return hashText(JSON.stringify({
		folder: normalizePath(config.folder ?? ""),
		format: config.format,
		parserVersion: CATALOG_PARSER_VERSION,
	}));
}

function isCurrentFileRecord(
	record: CatalogFileRecord | undefined,
	inventory: CatalogInventoryEntry,
	settingsFingerprint: string,
): boolean {
	return record !== undefined
		&& record.mtime === inventory.mtime
		&& record.size === inventory.size
		&& record.parserVersion === CATALOG_PARSER_VERSION
		&& record.settingsFingerprint === settingsFingerprint;
}

function sortPathsNewestFirst(
	paths: string[],
	inventoryByPath: ReadonlyMap<string, CatalogInventoryEntry>,
	runtime: CooperativeTaskRuntime,
): Promise<string[]> {
	return stableSortCooperatively(paths, (left, right) => {
		const leftDate = inventoryByPath.get(left)?.logicalDate ?? "";
		const rightDate = inventoryByPath.get(right)?.logicalDate ?? "";
		return rightDate.localeCompare(leftDate) || left.localeCompare(right);
	}, runtime);
}

function buildRefreshResult(
	before: readonly CatalogFileRecord[],
	after: readonly CatalogFileRecord[],
	failures: readonly CatalogFailure[],
): CatalogRefreshResult {
	const beforeByPath = new Map(before.map((file) => [file.sourcePath, file]));
	const afterByPath = new Map(after.map((file) => [file.sourcePath, file]));
	let created = 0;
	let updated = 0;
	let skipped = 0;
	for (const file of after) {
		const previous = beforeByPath.get(file.sourcePath);
		if (previous === undefined) {
			created += 1;
		} else if (previous.sourceRevision !== file.sourceRevision) {
			updated += 1;
		} else {
			skipped += 1;
		}
	}
	const deleted = before.filter((file) => !afterByPath.has(file.sourcePath)).length;
	const errors = failures
		.map((failure) => failure.sourcePath.length > 0
			? `${failure.sourcePath}: ${failure.message}`
			: failure.message)
		.sort();
	return {
		scannedFiles: created + updated + errors.length,
		created,
		updated,
		deleted,
		skipped,
		failed: errors.length,
		errors,
	};
}

function monotonicNow(): number {
	return typeof performance === "undefined" ? Date.now() : performance.now();
}


function getErrorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
