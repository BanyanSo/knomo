import { normalizePath, TFile } from "obsidian";
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
import { CATALOG_PARSER_VERSION, DiaryMemoParser } from "./DiaryMemoParser";
import type { DailyNotesConfig } from "./DailyNoteService";
import type { MemoCatalogService } from "./MemoCatalogService";
import type { MarkdownCatalogCommitInput } from "./MarkdownMutationService";

export const CATALOG_SCANNER_ENABLED = true;
export const CATALOG_CHECKPOINT_META_KEY = "catalogCheckpoint";
export const CATALOG_LAST_FULL_AUDIT_META_KEY = "catalogLastFullAuditAt";
export const CATALOG_FAILED_PATHS_META_KEY = "catalogFailedPaths";

const DEFAULT_FULL_AUDIT_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_SLICE_BUDGET_MS = 12;
const DEFAULT_RECONCILE_DEBOUNCE_MS = 250;

interface CatalogFailure {
	sourcePath: string;
	message: string;
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
	reconcileDebounceMs?: number;
	now?: () => number;
	onProgress?: (coverage: CatalogCoverage) => void | Promise<void>;
	onCatalogSettled?: () => void | Promise<void>;
	onRevisionTransition?: (transition: CatalogRevisionTransition) => void | Promise<void>;
	isConfigurationComplete?: () => boolean;
}

export class CatalogIndexCoordinator {
	private readonly enabled: boolean;
	private readonly fullAuditIntervalMs: number;
	private readonly sliceBudgetMs: number;
	private readonly reconcileDebounceMs: number;
	private readonly now: () => number;
	private readonly onProgress: ((coverage: CatalogCoverage) => void | Promise<void>) | null;
	private readonly onCatalogSettled: (() => void | Promise<void>) | null;
	private readonly onRevisionTransition: ((transition: CatalogRevisionTransition) => void | Promise<void>) | null;
	private readonly isConfigurationComplete: () => boolean;
	private readonly inventoryByPath = new Map<string, CatalogInventoryEntry>();
	private readonly coveredPaths = new Set<string>();
	private readonly forcedPaths = new Set<string>();
	private readonly pendingDeletedPaths = new Set<string>();
	private readonly failedPaths = new Map<string, CatalogFailure>();
	private readonly idleResolvers: Array<() => void> = [];
	private readonly pathResolvers = new Map<string, Array<() => void>>();
	private queue: string[] = [];
	private headings: string[] = [];
	private dailyConfig: DailyNotesConfig | null = null;
	private settingsFingerprint = "";
	private checkpointStartedAt = 0;
	private fullAuditScheduled = false;
	private startupAuditScheduled = false;
	private opened = false;
	private stopped = false;
	private paused = false;
	private processing = false;
	private reconciling = false;
	private reconcileAgain = false;
	private closeWhenIdle = false;
	private rebuilding = false;
	private drainTimer: number | null = null;
	private reconcileTimer: number | null = null;
	private auditTimer: number | null = null;

	constructor(
		private readonly app: App,
		private readonly catalogService: MemoCatalogService,
		private readonly parser: DiaryMemoParser,
		private readonly getDailyConfig: () => Promise<DailyNotesConfig>,
		private readonly getHeadings: () => readonly string[],
		options: CatalogIndexCoordinatorOptions = {},
	) {
		this.enabled = options.enabled ?? CATALOG_SCANNER_ENABLED;
		this.fullAuditIntervalMs = options.fullAuditIntervalMs ?? DEFAULT_FULL_AUDIT_INTERVAL_MS;
		this.sliceBudgetMs = options.sliceBudgetMs ?? DEFAULT_SLICE_BUDGET_MS;
		this.reconcileDebounceMs = options.reconcileDebounceMs ?? DEFAULT_RECONCILE_DEBOUNCE_MS;
		this.now = options.now ?? Date.now;
		this.onProgress = options.onProgress ?? null;
		this.onCatalogSettled = options.onCatalogSettled ?? null;
		this.onRevisionTransition = options.onRevisionTransition ?? null;
		this.isConfigurationComplete = options.isConfigurationComplete ?? (() => true);
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
		if (!this.enabled || this.stopped || this.opened) {
			return;
		}
		await this.catalogService.open();
		if (this.stopped) {
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
		if (!this.opened || this.stopped) throw new Error("Memo Catalog is not available.");
		const normalizedPaths = [...new Set(paths.map((path) => normalizePath(path)))];
		const refreshed = normalizedPaths.map((path) => new Promise<void>((resolve) => {
			const resolvers = this.pathResolvers.get(path) ?? [];
			resolvers.push(resolve);
			this.pathResolvers.set(path, resolvers);
		}));
		for (const path of normalizedPaths) {
			this.forcedPaths.add(path);
			const queueIndex = this.queue.indexOf(path);
			if (queueIndex !== -1) this.queue.splice(queueIndex, 1);
			if (this.inventoryByPath.has(path)) this.queue.unshift(path);
		}
		this.scheduleReconcile(0);
		this.scheduleDrain();
		await Promise.all(refreshed);
	}

	async replaceCommittedFile(input: MarkdownCatalogCommitInput): Promise<void> {
		if (!this.opened || this.stopped) throw new Error("Memo Catalog is not available.");
		const sourcePath = normalizePath(input.file.path);
		const inventory: CatalogInventoryEntry = {
			sourcePath,
			logicalDate: input.logicalDate,
			mtime: input.file.stat.mtime,
			size: new TextEncoder().encode(input.content).byteLength,
		};
		await this.reconcileRevisionTransition(sourcePath, input.parsed.sourceRevision, input.parsed.observations);
		if (this.stopped) throw new Error("Memo Catalog is not available.");
		await this.catalogService.replaceFile({
			inventory,
			sourceRevision: input.parsed.sourceRevision,
			observations: input.parsed.observations,
			parserVersion: CATALOG_PARSER_VERSION,
			settingsFingerprint: this.settingsFingerprint,
			auditedAt: this.now(),
		});
		if (this.stopped) return;
		this.inventoryByPath.set(sourcePath, inventory);
		this.coveredPaths.add(sourcePath);
		this.failedPaths.delete(sourcePath);
		const coverage = this.buildCoverage();
		await this.catalogService.getStore().setCoverage(coverage);
		this.notifyProgress(coverage);
	}

	async rebuildLocalCatalog(): Promise<void> {
		if (!this.opened || this.stopped) throw new Error("Memo Catalog is not available.");
		await this.waitForIdle();
		if (this.stopped) throw new Error("Memo Catalog is not available.");
		this.rebuilding = true;
		try {
			await this.catalogService.getStore().clear();
			if (this.stopped) return;
			this.inventoryByPath.clear();
			this.coveredPaths.clear();
			this.forcedPaths.clear();
			this.pendingDeletedPaths.clear();
			this.failedPaths.clear();
			this.queue = [];
			this.fullAuditScheduled = false;
			await this.reconcileInventory();
			if (this.stopped) return;
			await this.waitForIdle();
		} finally {
			if (this.rebuilding) {
				this.rebuilding = false;
				if (!this.stopped) {
					const coverage = this.buildCoverage();
					await this.catalogService.getStore().setCoverage(coverage).catch(() => undefined);
					this.notifyProgress(coverage);
				}
			}
		}
	}

	async refreshLocalCatalog(): Promise<CatalogRefreshResult> {
		if (!this.opened || this.stopped) throw new Error("Memo Catalog is not available.");
		const before = await this.catalogService.listFiles();
		if (this.stopped) throw new Error("Memo Catalog is not available.");
		await this.reconcileInventory();
		await this.waitForIdle();
		if (this.stopped) throw new Error("Memo Catalog is not available.");
		const after = await this.catalogService.listFiles();
		return buildRefreshResult(before, after, [...this.failedPaths.values()]);
	}

	private handleFileChanged(file: unknown): void {
		if (!(file instanceof TFile) || file.extension !== "md") {
			return;
		}
		this.forcedPaths.add(normalizePath(file.path));
		this.scheduleReconcile();
	}

	private handleFileRenamed(file: unknown, oldPath: string): void {
		if (!(file instanceof TFile) || file.extension !== "md") {
			return;
		}
		this.pendingDeletedPaths.add(normalizePath(oldPath));
		this.forcedPaths.add(normalizePath(file.path));
		this.scheduleReconcile();
	}

	private handleFileDeleted(file: unknown): void {
		if (!(file instanceof TFile) || file.extension !== "md") {
			return;
		}
		this.pendingDeletedPaths.add(normalizePath(file.path));
		this.scheduleReconcile();
	}

	private handleVisibilityChange(): void {
		this.paused = this.app.workspace.containerEl.doc.visibilityState === "hidden";
		if (!this.paused) {
			this.scheduleReconcile(0);
			this.scheduleDrain();
		}
	}

	private scheduleReconcile(delay = this.reconcileDebounceMs): void {
		if (!this.enabled || this.stopped || !this.opened) {
			return;
		}
		const win = this.app.workspace.containerEl.win;
		if (this.reconcileTimer !== null) {
			win.clearTimeout(this.reconcileTimer);
		}
		this.reconcileTimer = win.setTimeout(() => {
			this.reconcileTimer = null;
			void this.reconcileInventory();
		}, delay);
	}

	private async reconcileInventory(): Promise<void> {
		if (!this.opened || this.stopped) {
			return;
		}
		if (this.reconciling) {
			this.reconcileAgain = true;
			return;
		}
		this.reconciling = true;
		try {
			this.dailyConfig = await this.getDailyConfig();
			if (this.stopped) return;
			this.headings = [...new Set(this.getHeadings().map((heading) => heading.trim()).filter(Boolean))].sort();
			this.settingsFingerprint = buildSettingsFingerprint(this.dailyConfig, this.headings);
			const inventory = collectDailyInventory(this.app, this.dailyConfig);
			this.inventoryByPath.clear();
			for (const entry of inventory) {
				this.inventoryByPath.set(entry.sourcePath, entry);
			}

			const store = this.catalogService.getStore();
			const storedFiles = await store.listFiles();
			if (this.stopped) return;
			if (storedFiles.length === 0 && inventory.length > 0) this.rebuilding = true;
			const storedByPath = new Map(storedFiles.map((file) => [file.sourcePath, file]));
			for (const storedFile of storedFiles) {
				if (this.stopped) return;
				if (!this.inventoryByPath.has(storedFile.sourcePath)) {
					await this.catalogService.deleteFile(storedFile.sourcePath);
				}
			}
			for (const deletedPath of this.pendingDeletedPaths) {
				if (this.stopped) return;
				await this.catalogService.deleteFile(deletedPath);
				storedByPath.delete(deletedPath);
			}
			this.pendingDeletedPaths.clear();

			const checkpoint = await store.getMeta<CatalogCheckpoint>(CATALOG_CHECKPOINT_META_KEY);
			if (this.stopped) return;
			const checkpointCompatible = checkpoint !== null
				&& checkpoint.settingsFingerprint === this.settingsFingerprint
				&& checkpoint.parserVersion === CATALOG_PARSER_VERSION;
			const lastFullAuditAt = await store.getMeta<number>(CATALOG_LAST_FULL_AUDIT_META_KEY);
			if (this.stopped) return;
			const resumingFullAudit = checkpointCompatible && checkpoint.fullAudit;
			const startingFullAudit = !resumingFullAudit && (
				!this.startupAuditScheduled
				|| lastFullAuditAt === null
				|| this.now() - lastFullAuditAt >= this.fullAuditIntervalMs
			);
			if (startingFullAudit) this.startupAuditScheduled = true;
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
			}
			if (checkpointCompatible) {
				for (const path of checkpoint.pendingPaths) {
					if (this.inventoryByPath.has(path)) {
						pending.add(path);
					}
				}
			}
			for (const path of this.forcedPaths) {
				if (this.inventoryByPath.has(path)) {
					pending.add(path);
				} else {
					this.resolvePath(path);
				}
			}
			this.forcedPaths.clear();
			if (startingFullAudit) {
				for (const entry of inventory) {
					pending.add(entry.sourcePath);
				}
			}
			for (const path of pending) {
				this.coveredPaths.delete(path);
			}

			this.queue = sortPathsNewestFirst([...pending], this.inventoryByPath);
			this.fullAuditScheduled = resumingFullAudit || startingFullAudit;
			this.checkpointStartedAt = checkpointCompatible ? checkpoint.startedAt : this.now();
			this.failedPaths.clear();
			await this.saveProgress();
			if (this.stopped) return;
			if (this.queue.length === 0) {
				await this.finishScan();
			} else {
				this.scheduleDrain();
			}
		} catch (error) {
			if (this.stopped) return;
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
		if (this.stopped || this.paused || this.processing || this.drainTimer !== null || this.queue.length === 0) {
			return;
		}
		this.drainTimer = this.app.workspace.containerEl.win.setTimeout(() => {
			this.drainTimer = null;
			void this.drainSlice();
		}, 0);
	}

	private async drainSlice(): Promise<void> {
		if (this.processing || this.paused || this.stopped) {
			return;
		}
		this.processing = true;
		const sliceStartedAt = this.now();
		try {
			do {
				const sourcePath = this.queue.shift();
				if (sourcePath === undefined) {
					break;
				}
				await this.processPath(sourcePath);
				if (this.stopped) break;
				await this.saveProgress();
			} while (!this.paused && this.queue.length > 0 && this.now() - sliceStartedAt < this.sliceBudgetMs);
			if (!this.stopped && this.queue.length === 0) {
				await this.finishScan();
			}
		} finally {
			this.processing = false;
			this.closeStoreWhenSafe();
			if (!this.closeWhenIdle) {
				this.scheduleDrain();
			}
			this.resolveIdleIfNeeded();
		}
	}

	private async processPath(sourcePath: string): Promise<void> {
		if (this.stopped) return;
		const inventory = this.inventoryByPath.get(sourcePath);
		const abstractFile = this.app.vault.getAbstractFileByPath(sourcePath);
		if (inventory === undefined || !(abstractFile instanceof TFile)) {
			await this.catalogService.deleteFile(sourcePath);
			this.coveredPaths.delete(sourcePath);
			this.resolvePath(sourcePath);
			return;
		}
		try {
			const raw = await this.app.vault.readBinary(abstractFile);
			if (this.stopped) return;
			const bytes = new Uint8Array(raw);
			const parsed = await this.parser.parse({
				sourcePath,
				logicalDate: inventory.logicalDate,
				headings: this.headings,
				bytes,
			});
			if (this.stopped) return;
			const stored = await this.catalogService.getStore().getFile(sourcePath);
			if (this.stopped) return;
			if (stored?.sourceRevision !== parsed.sourceRevision
				|| stored.parserVersion !== CATALOG_PARSER_VERSION
				|| stored.settingsFingerprint !== this.settingsFingerprint
				|| stored.mtime !== abstractFile.stat.mtime
				|| stored.size !== abstractFile.stat.size) {
				await this.reconcileRevisionTransition(sourcePath, parsed.sourceRevision, parsed.observations);
				if (this.stopped) return;
				await this.catalogService.replaceFile({
					inventory: {
						...inventory,
						mtime: abstractFile.stat.mtime,
						size: abstractFile.stat.size,
					},
					sourceRevision: parsed.sourceRevision,
					observations: parsed.observations,
					parserVersion: CATALOG_PARSER_VERSION,
					settingsFingerprint: this.settingsFingerprint,
					auditedAt: this.now(),
				});
			}
			this.coveredPaths.add(sourcePath);
			this.failedPaths.delete(sourcePath);
		} catch (error) {
			this.coveredPaths.delete(sourcePath);
			this.failedPaths.set(sourcePath, { sourcePath, message: getErrorMessage(error) });
		} finally {
			this.resolvePath(sourcePath);
		}
	}

	private async reconcileRevisionTransition(
		sourcePath: string,
		sourceRevision: string,
		observations: readonly MemoObservation[],
	): Promise<void> {
		if (this.onRevisionTransition === null) return;
		try {
			const before = await this.catalogService.getFileRevisionBatch(sourcePath);
			if (this.stopped || before === null || before.file.sourceRevision === sourceRevision) return;
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
		if (this.stopped || this.onCatalogSettled === null) return;
		void Promise.resolve(this.onCatalogSettled()).catch(() => undefined);
	}

	private async saveProgress(): Promise<void> {
		if (this.stopped) return;
		const store = this.catalogService.getStore();
		const coverage = this.buildCoverage();
		await store.setCoverage(coverage);
		if (this.stopped) return;
		this.notifyProgress(coverage);
		const checkpoint: CatalogCheckpoint = {
			settingsFingerprint: this.settingsFingerprint,
			parserVersion: CATALOG_PARSER_VERSION,
			pendingPaths: [...this.queue],
			fullAudit: this.fullAuditScheduled,
			completedFileCount: coverage.coveredFileCount,
			totalFileCount: coverage.totalFileCount,
			startedAt: this.checkpointStartedAt,
			updatedAt: this.now(),
		};
		await store.setMeta(CATALOG_CHECKPOINT_META_KEY, checkpoint);
		if (this.stopped) return;
		await store.setMeta(CATALOG_FAILED_PATHS_META_KEY, [...this.failedPaths.values()]);
	}

	private notifyProgress(coverage: CatalogCoverage): void {
		if (this.stopped || this.onProgress === null) return;
		void Promise.resolve(this.onProgress({ ...coverage })).catch(() => undefined);
	}

	private async finishScan(): Promise<void> {
		if (this.stopped) return;
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
			if (this.stopped) return;
			await store.setCoverage(coverage);
			if (this.stopped) return;
			this.fullAuditScheduled = false;
			this.scheduleFailedPathRetry();
			this.notifyCatalogSettled();
			return;
		}
		if (this.fullAuditScheduled) {
			await store.setMeta(CATALOG_LAST_FULL_AUDIT_META_KEY, this.now());
			if (this.stopped) return;
			this.scheduleAuditWake(this.now(), false);
		}
		this.rebuilding = false;
		await store.deleteMeta(CATALOG_CHECKPOINT_META_KEY);
		if (this.stopped) return;
		await store.setCoverage(this.buildCoverage());
		if (this.stopped) return;
		this.fullAuditScheduled = false;
		this.notifyCatalogSettled();
	}

	private scheduleFailedPathRetry(): void {
		if (this.stopped) return;
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
		const entries = [...this.inventoryByPath.values()];
		const coveredFileCount = entries.filter((entry) => this.coveredPaths.has(entry.sourcePath)).length;
		const sharedConfigurationComplete = this.isConfigurationComplete();
		const dates = [...new Set(entries.map((entry) => entry.logicalDate))].sort((left, right) => right.localeCompare(left));
		let coveredFromDate: string | null = null;
		for (const date of dates) {
			const dateEntries = entries.filter((entry) => entry.logicalDate === date);
			if (!dateEntries.every((entry) => this.coveredPaths.has(entry.sourcePath))) {
				break;
			}
			coveredFromDate = date;
		}
		const pendingFileCount = entries.length - coveredFileCount;
		return {
			kind: this.rebuilding
				? "rebuilding"
				: pendingFileCount === 0 && this.failedPaths.size === 0
					? "complete"
					: "partial",
			sharedConfigurationComplete,
			coveredFromDate,
			pendingFileCount,
			coveredFileCount,
			totalFileCount: entries.length,
		};
	}

	private scheduleAuditWake(lastFullAuditAt: number | null, fullAuditDue: boolean): void {
		const win = this.app.workspace.containerEl.win;
		if (this.auditTimer !== null) {
			win.clearTimeout(this.auditTimer);
			this.auditTimer = null;
		}
		if (fullAuditDue || lastFullAuditAt === null || this.stopped) {
			return;
		}
		const delay = Math.max(0, lastFullAuditAt + this.fullAuditIntervalMs - this.now());
		this.auditTimer = win.setTimeout(() => {
			this.auditTimer = null;
			this.scheduleReconcile(0);
		}, delay);
	}

	private stop(): void {
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
		for (const path of this.queue) this.resolvePath(path);
		this.queue = [];
		this.forcedPaths.clear();
		this.pendingDeletedPaths.clear();
		for (const path of this.pathResolvers.keys()) this.resolvePath(path);
		if (this.processing || this.reconciling) {
			this.closeWhenIdle = true;
		} else if (this.opened) {
			this.catalogService.close();
			this.opened = false;
		}
		this.resolveIdleIfNeeded();
	}

	private isIdle(): boolean {
		return this.queue.length === 0 && !this.processing && !this.reconciling
			&& this.drainTimer === null && this.reconcileTimer === null;
	}

	private closeStoreWhenSafe(): void {
		if (!this.closeWhenIdle || this.processing || this.reconciling) {
			return;
		}
		this.catalogService.close();
		this.opened = false;
		this.closeWhenIdle = false;
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

function collectDailyInventory(app: App, config: DailyNotesConfig): CatalogInventoryEntry[] {
	const entries: CatalogInventoryEntry[] = [];
	for (const file of app.vault.getMarkdownFiles()) {
		const sourcePath = normalizePath(file.path);
		const date = parseDailyNoteDateFromPath(sourcePath, config);
		if (date === null) {
			continue;
		}
		entries.push({
			sourcePath,
			logicalDate: formatDatePart(date),
			mtime: file.stat.mtime,
			size: file.stat.size,
		});
	}
	return entries.sort((left, right) =>
		right.logicalDate.localeCompare(left.logicalDate) || left.sourcePath.localeCompare(right.sourcePath));
}

function buildSettingsFingerprint(config: DailyNotesConfig, headings: readonly string[]): string {
	return hashText(JSON.stringify({
		folder: normalizePath(config.folder ?? ""),
		format: config.format,
		headings,
		parserVersion: CATALOG_PARSER_VERSION,
		rootMemos: true,
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

function sortPathsNewestFirst(paths: string[], inventoryByPath: ReadonlyMap<string, CatalogInventoryEntry>): string[] {
	return paths.sort((left, right) => {
		const leftDate = inventoryByPath.get(left)?.logicalDate ?? "";
		const rightDate = inventoryByPath.get(right)?.logicalDate ?? "";
		return rightDate.localeCompare(leftDate) || left.localeCompare(right);
	});
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


function getErrorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
