import type { IndependentTrashService } from "./IndependentTrashService";
import { t } from "../i18n";
import { TFile } from "obsidian";
import type { App } from "obsidian";
import { KnomoMutationBarrier } from "./KnomoMutationBarrier";

import type { CatalogRefreshResult, ResolvedMemo } from "../types/catalog";
import type {
	DailyMutationResult,
	CatalogFeatureQuery,
	CatalogMemoItem,
	CatalogOperationalState,
	CatalogReadState,
	MemoSaveOperation,
	MemoSaveResult,
	MonthlyProjectionState,
	MutationFollowUpState,
	TrashMemoItem,
} from "../types/catalogView";
import type {
	MarkdownMutationResult,
	MarkdownMutationService as MarkdownMutationContract,
} from "../types/memoOperations";
import type { KnomoCurrentConfigStatus } from "../types/knomoConfig";
import type { KnomoSettingsLoadStatus } from "../types/settings";
import type { KnomoStartupBootstrapSnapshot } from "./KnomoStartupBootstrapService";
import { formatDatePart } from "../utils/date";
import { withCreatedAtAlias } from "../utils/references";
import { extractTimeBuoyDates } from "../utils/timeBuoyParser";
import { CatalogReadService } from "./CatalogReadService";
import type { MemoCatalogService } from "./MemoCatalogService";
import { LocalMemoReviewStore } from "./LocalMemoReviewStore";
import { CatalogReferenceService } from "./CatalogReferenceService";

export interface MemoCommandServiceOptions {
	getTrashService?: () => IndependentTrashService;
	getDailyPathForDate?: (logicalDate: string) => Promise<string>;
	refreshCatalogPaths: (paths: readonly string[]) => Promise<void>;
	refreshLocalCatalog: () => Promise<CatalogRefreshResult>;
	getProjectionState?: () => MonthlyProjectionState;
	getMemoTimeFormat: () => "HH:mm" | "HH:mm:ss";
	rebuildLocalCatalog: () => Promise<void>;
	getLegacyImportStatus?: () => import("../types/legacyMigration").LegacyMigrationStatus;
	getSharedConfigurationStatus?: () => KnomoCurrentConfigStatus;
	getSettingsStatus?: () => KnomoSettingsLoadStatus;
	getStartupBootstrapSnapshot?: () => KnomoStartupBootstrapSnapshot;
	now?: () => Date;
	random?: () => number;
}

export interface MemoReferenceResult extends MutationFollowUpState {
	text: string;
}

export class MemoCommandService {
	private readonly mutationBarrier = new KnomoMutationBarrier();
	private readonly now: () => Date;
	private readonly readService: CatalogReadService;

	constructor(
		private readonly app: App,
		catalog: MemoCatalogService,
		private readonly options: MemoCommandServiceOptions,
		private readonly markdownMutations: MarkdownMutationContract,
	) {
		this.now = options.now ?? (() => new Date());
		this.createInternal = this.mutationBarrier.wrap(this.createInternal.bind(this));
		this.copy = this.mutationBarrier.wrap(this.copy.bind(this));
		this.move = this.mutationBarrier.wrap(this.move.bind(this));
		this.editInternal = this.mutationBarrier.wrap(this.editInternal.bind(this));
		this.toggleTask = this.mutationBarrier.wrap(this.toggleTask.bind(this));
		this.delete = this.mutationBarrier.wrap(this.delete.bind(this));
		this.restore = this.mutationBarrier.wrap(this.restore.bind(this));
		this.purge = this.mutationBarrier.wrap(this.purge.bind(this));
		this.createReferenceText = this.mutationBarrier.wrap(this.createReferenceText.bind(this));
		this.recordReview = this.mutationBarrier.wrap(this.recordReview.bind(this));
		this.readService = new CatalogReadService({
			references: new CatalogReferenceService(app, catalog),
			reviews: new LocalMemoReviewStore(app),
			catalog,
			getTrashService: options.getTrashService,
			requestObservationScan: async () => { await options.refreshLocalCatalog(); },
			getProjectionState: options.getProjectionState,
			getLegacyImportStatus: options.getLegacyImportStatus,
			getSharedConfigurationStatus: options.getSharedConfigurationStatus,
			getSettingsStatus: options.getSettingsStatus,
			getStartupBootstrapSnapshot: options.getStartupBootstrapSnapshot,
			now: options.now,
			random: options.random,
		});
	}

	getReadService(): CatalogReadService {
		return this.readService;
	}

	runWithMutationsPaused<T>(action: () => Promise<T>): Promise<T> {
		return this.mutationBarrier.runPaused(action);
	}

	async rebuildLocalCatalog(): Promise<void> {
		await this.options.rebuildLocalCatalog();
	}

	async refreshLocalCatalog(): Promise<CatalogRefreshResult> {
		return this.options.refreshLocalCatalog();
	}

	getOperationalState(readState: CatalogReadState = this.readService.getLastReadState() ?? "history_building"): CatalogOperationalState {
		return {
			readState,
			capabilities: {
				createNew: true,
			},
		};
	}

	startCreate(contentInput: string): MemoSaveOperation {
		return this.startSaveOperation((onDailyCommitted) => this.createInternal(
			contentInput,
			onDailyCommitted,
		));
	}

	async create(contentInput: string): Promise<MemoSaveResult> {
		return this.createInternal(contentInput);
	}

	private async createInternal(
		contentInput: string,
		onDailyCommitted?: () => void,
	): Promise<MemoSaveResult> {
		const content = normalizeMemoInput(contentInput);
		if (content.trim().length === 0) throw new Error("Memo content is empty.");
		const createdAt = this.now();
		const logicalDate = formatDatePart(createdAt);
		const result = await this.markdownMutations.create({
			content,
			targetLogicalDate: logicalDate,
			createdAt,
			onDailyCommitted,
		});
		return this.finishMarkdownSavedMemo(result, result.observation?.timeBuoyDates ?? []);
	}

	async copy(item: CatalogMemoItem, logicalDate = formatDatePart(this.now())): Promise<MemoSaveResult> {
		const createdAt = this.now();
		const result = await this.markdownMutations.copy({
			observation: item.observationHandle,
			targetLogicalDate: logicalDate,
			createdAt,
		});
		return this.finishMarkdownSavedMemo(result, result.observation?.timeBuoyDates ?? item.timeBuoyDates);
	}

	async move(item: CatalogMemoItem, targetLogicalDate: string): Promise<MemoSaveResult> {
		const result = await this.markdownMutations.move({
			observation: item.observationHandle,
			targetLogicalDate,
		});
		return this.finishMarkdownSavedMemo(result, result.observation?.timeBuoyDates ?? item.timeBuoyDates);
	}

	startEdit(item: CatalogMemoItem, contentInput: string): MemoSaveOperation {
		return this.startSaveOperation((onDailyCommitted) => this.editInternal(item, contentInput, onDailyCommitted));
	}

	async edit(item: CatalogMemoItem, contentInput: string): Promise<MemoSaveResult> {
		return this.editInternal(item, contentInput);
	}

	private async editInternal(
		item: CatalogMemoItem,
		contentInput: string,
		onDailyCommitted?: () => void,
	): Promise<MemoSaveResult> {
		const content = normalizeMemoInput(contentInput);
		if (content.trim().length === 0) throw new Error("Memo content is empty.");
		const result = await this.markdownMutations.edit({
			observation: item.observationHandle,
			content,
			onDailyCommitted,
		});
		return this.finishMarkdownSavedMemo(result, extractTimeBuoyDates(content));
	}

	async toggleTask(item: CatalogMemoItem, taskIndex: number, checked: boolean): Promise<MemoSaveResult> {
		const result = await this.markdownMutations.toggleTask({
			observation: item.observationHandle,
			taskIndex,
			checked,
		});
		return this.finishMarkdownSavedMemo(result, result.observation?.timeBuoyDates ?? item.timeBuoyDates);
	}

	async delete(item: CatalogMemoItem): Promise<DailyMutationResult> {
		const result = await this.requireTrashService().delete(item.observationHandle);
		return { status: "saved", followUpPending: false, localRefreshPending: result.catalogUpdatePending };
	}

	async restore(item: TrashMemoItem): Promise<MemoSaveResult> {
		const result = await this.requireTrashService().restore(item.snapshotId);
		if (result.state === "restored_cleanup_pending") throw new Error(result.message ?? t("trash.restoredCleanupPending"));
		const memo = result.observation === null ? null : await this.findMemoByObservation(result.observation).catch(() => null);
		return { status: "saved", memo, timeBuoyDates: memo?.timeBuoyDates ?? [], followUpPending: false,
			localRefreshPending: result.catalogUpdatePending || memo === null };
	}

	async purge(item: TrashMemoItem): Promise<void> {
		return this.requireTrashService().purge(item.snapshotId);
	}

	private requireTrashService(): IndependentTrashService {
		if (!this.options.getTrashService) throw new Error("Trash unavailable.");
		return this.options.getTrashService();
	}

	async createReferenceText(item: CatalogMemoItem, sourcePath = ""): Promise<MemoReferenceResult> {
		const file = this.getFile(item.sourcePath);
		const anchored = await this.markdownMutations.createBlockReference({
			observation: item.observationHandle,
			sourcePath,
		});
		const saved = await this.finishMarkdownSavedMemo(
			anchored,
			anchored.observation?.timeBuoyDates ?? item.timeBuoyDates,
		);
		const link = this.app.fileManager.generateMarkdownLink(file, sourcePath, `#^${anchored.blockId}`);
		return {
			text: withCreatedAtAlias(link, `${item.observation.logicalDate}T${item.observation.time}`),
			followUpPending: saved.followUpPending,
			localRefreshPending: saved.localRefreshPending,
		};
	}

	async recordReview(item: CatalogMemoItem): Promise<void> {
		await this.readService.recordReview(item);
	}

	private async finishMarkdownSavedMemo(
		input: MarkdownMutationResult,
		timeBuoyDates: readonly string[],
	): Promise<MemoSaveResult> {
		let localRefreshPending = input.catalogUpdatePending;
		let memo: CatalogMemoItem | null = null;
		if (!localRefreshPending && input.observation !== null) {
			try {
				memo = await this.findMemoByObservation(input.observation);
			} catch {
				localRefreshPending = true;
			}
		}
		if (input.observation !== null && memo === null) localRefreshPending = true;
		return {
			status: input.status === "committed_content_pending" ? "content_pending" : "saved",
			memo,
			timeBuoyDates: [...(memo?.timeBuoyDates ?? timeBuoyDates)],
			followUpPending: input.status === "committed_content_pending",
			localRefreshPending,
		};
	}

	private startSaveOperation(
		action: (onDailyCommitted: () => void) => Promise<MemoSaveResult>,
	): MemoSaveOperation {
		let committed = false;
		let resolveCommitted: () => void = () => undefined;
		let rejectCommitted: (error: unknown) => void = () => undefined;
		const dailyCommitted = new Promise<void>((resolve, reject) => {
			resolveCommitted = resolve;
			rejectCommitted = reject;
		});
		const markCommitted = (): void => {
			if (committed) return;
			committed = true;
			resolveCommitted();
		};
		const settled = Promise.resolve()
			.then(() => action(markCommitted))
			.then((result) => {
				// 兼容只实现最终结果的测试替身；真实链路会在 Daily 提交点先触发。
				markCommitted();
				return result;
			})
			.catch((error: unknown) => {
				if (!committed) rejectCommitted(error);
				throw error;
			});
		// 阶段 Promise 允许调用方只观察其中一个，不产生未处理拒绝。
		void dailyCommitted.catch(() => undefined);
		void settled.catch(() => undefined);
		return { dailyCommitted, settled };
	}

	private async findMemoByObservation(observation: ResolvedMemo["observation"]): Promise<CatalogMemoItem | null> {
		let cursor: CatalogFeatureQuery["cursor"] = null;
		do {
			const page = await this.readService.query({ sourcePaths: [observation.sourcePath], limit: 150, cursor });
			const found = page.items.find((item) => item.observation.sourceRevision === observation.sourceRevision
				&& item.observation.startLine === observation.startLine
				&& item.observation.endLine === observation.endLine
				&& item.observation.rawBlockHash === observation.rawBlockHash);
			if (found !== undefined) return found;
			if (page.invalidated) return null;
			cursor = page.nextCursor;
		} while (cursor !== null);
		return null;
	}

	private getFile(path: string): TFile {
		const file = this.app.vault.getAbstractFileByPath(path);
		if (!(file instanceof TFile)) throw new Error(`Daily file is unavailable: ${path}`);
		return file;
	}
}

function normalizeMemoInput(input: string): string {
	return input.replace(/\r\n/gu, "\n").replace(/\r/gu, "\n");
}
