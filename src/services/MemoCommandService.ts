import { TFile } from "obsidian";
import type { App } from "obsidian";

import type { ResolvedMemo } from "../types/catalog";
import type {
	CatalogFeatureQuery,
	CatalogMemoItem,
	CatalogOperationalState,
	CatalogReadState,
	DailyMutationResult,
	MemoSaveResult,
	MonthlyProjectionState,
	MutationFollowUpState,
	TrashMemoItem,
} from "../types/catalogView";
import type {
	IdentityLedgerCreatePlan,
	IdentityLedgerMutationService,
	IdentityLedgerRebindReason,
} from "../types/identityLedger";
import type {
	MarkdownMutationResult,
	MarkdownMutationService as MarkdownMutationContract,
} from "../types/memoOperations";
import { formatDatePart, formatTimePart } from "../utils/date";
import { hashMemoContent } from "../utils/hash";
import { withCreatedAtAlias } from "../utils/references";
import { extractTimeBuoyDates } from "../utils/timeBuoyParser";
import { CatalogReadService } from "./CatalogReadService";
import type { MemoCatalogService } from "./MemoCatalogService";

export interface MemoCommandServiceOptions {
	getDailyPathForDate?: (logicalDate: string) => Promise<string>;
	refreshCatalogPaths: (paths: readonly string[]) => Promise<void>;
	refreshLocalCatalog: () => Promise<void>;
	getProjectionState?: () => MonthlyProjectionState;
	getMemoTimeFormat: () => "HH:mm" | "HH:mm:ss";
	rebuildLocalCatalog: () => Promise<void>;
	getLegacyImportStatus?: () => import("../types/legacyMigration").LegacyIdentityImportStatus;
	now?: () => Date;
	random?: () => number;
}

export interface MemoReferenceResult extends MutationFollowUpState {
	text: string;
	memoId: string | null;
}

export class MemoCommandService {
	private readonly now: () => Date;
	private readonly readService: CatalogReadService;

	constructor(
		private readonly app: App,
		catalog: MemoCatalogService,
		private readonly options: MemoCommandServiceOptions,
		private readonly markdownMutations: MarkdownMutationContract,
		private readonly identityLedger: IdentityLedgerMutationService,
	) {
		this.now = options.now ?? (() => new Date());
		this.readService = new CatalogReadService({
			catalog,
			identityLedger,
			requestObservationScan: options.refreshLocalCatalog,
			getProjectionState: options.getProjectionState,
			getLegacyImportStatus: options.getLegacyImportStatus,
			now: options.now,
			random: options.random,
		});
	}

	getReadService(): CatalogReadService {
		return this.readService;
	}

	async rebuildLocalCatalog(): Promise<void> {
		await this.options.rebuildLocalCatalog();
		await this.readService.materializeResolutionSnapshot();
	}

	async refreshLocalCatalog(): Promise<void> {
		await this.options.refreshLocalCatalog();
		await this.readService.materializeResolutionSnapshot();
	}

	getOperationalState(readState: CatalogReadState = this.readService.getLastReadState() ?? "history_building"): CatalogOperationalState {
		return {
			readState,
			capabilities: {
				createNew: true,
			},
		};
	}

	async adoptMemo(item: CatalogMemoItem): Promise<string> {
		const status = this.identityLedger.getStatus();
		if (status !== "ready" && status !== "absent") throw new Error("Existing Daily memo adoption is unavailable.");
		const refreshed = await this.refreshResolvedMemo(item.resolved);
		if (refreshed.kind !== "observed"
			|| this.identityLedger.resolveObservationState(refreshed.observation).kind !== "unbound") {
			throw new Error("Only a current historical observation without identity can be adopted.");
		}
		const binding = await this.identityLedger.adoptObservation(refreshed.observation);
		await this.readService.materializeResolutionSnapshot();
		return binding.memoId;
	}

	async create(contentInput: string, sourceMemoId: string | null = null): Promise<MemoSaveResult> {
		const content = normalizeMemoInput(contentInput);
		if (content.trim().length === 0) throw new Error("Memo content is empty.");
		const createdAt = this.now();
		const logicalDate = formatDatePart(createdAt);
		const plan = await this.beginIdentityCreate(content, logicalDate, createdAt, sourceMemoId);
		const result = await this.markdownMutations.create({ content, targetLogicalDate: logicalDate, createdAt });
		const identityPending = await this.finishIdentityCreate(plan, result.observation);
		return this.finishMarkdownSavedMemo(result, result.observation?.timeBuoyDates ?? [], {
			memoId: plan?.memoId ?? null,
			pending: identityPending,
		});
	}

	async copy(item: CatalogMemoItem, logicalDate = formatDatePart(this.now())): Promise<MemoSaveResult> {
		const createdAt = this.now();
		const plan = await this.beginIdentityCreate(item.content, logicalDate, createdAt, item.memoId);
		const result = await this.markdownMutations.copy({
			observation: item.observationHandle,
			targetLogicalDate: logicalDate,
			createdAt,
		});
		const identityPending = await this.finishIdentityCreate(plan, result.observation);
		return this.finishMarkdownSavedMemo(result, result.observation?.timeBuoyDates ?? item.timeBuoyDates, {
			memoId: plan?.memoId ?? null,
			pending: identityPending,
		});
	}

	async move(item: CatalogMemoItem, targetLogicalDate: string): Promise<MemoSaveResult> {
		const result = await this.markdownMutations.move({
			observation: item.observationHandle,
			targetLogicalDate,
		});
		const identity = result.status === "committed_content_pending"
			? { memoId: item.memoId, pending: true }
			: await this.finishIdentityRebind(item, result.observation, "move");
		return this.finishMarkdownSavedMemo(result, result.observation?.timeBuoyDates ?? item.timeBuoyDates, identity);
	}

	async repairIdentity(target: CatalogMemoItem, candidateMemoId: string): Promise<void> {
		const memo = this.identityLedger.getSnapshot().memos[candidateMemoId];
		if (memo?.conflicted !== true) throw new Error("The selected identity conflict is no longer current.");
		const refreshed = await this.refreshResolvedMemo(target.resolved);
		if (refreshed.kind !== "ambiguous"
			|| !refreshed.candidates.some((candidate) => candidate.memoId === candidateMemoId)) {
			throw new Error("The selected identity conflict is no longer current.");
		}
		await this.identityLedger.repairConflict(candidateMemoId, refreshed.observation);
		await this.readService.materializeResolutionSnapshot();
	}

	async edit(item: CatalogMemoItem, contentInput: string): Promise<MemoSaveResult> {
		const content = normalizeMemoInput(contentInput);
		if (content.trim().length === 0) throw new Error("Memo content is empty.");
		const result = await this.markdownMutations.edit({ observation: item.observationHandle, content });
		const identity = await this.finishIdentityRebind(item, result.observation, "edit");
		return this.finishMarkdownSavedMemo(result, extractTimeBuoyDates(content), identity);
	}

	async toggleTask(item: CatalogMemoItem, taskIndex: number, checked: boolean): Promise<MemoSaveResult> {
		const result = await this.markdownMutations.toggleTask({
			observation: item.observationHandle,
			taskIndex,
			checked,
		});
		const identity = await this.finishIdentityRebind(item, result.observation, "edit");
		return this.finishMarkdownSavedMemo(result, result.observation?.timeBuoyDates ?? item.timeBuoyDates, identity);
	}

	async removePermanently(item: CatalogMemoItem): Promise<DailyMutationResult> {
		const refreshed = await this.refreshResolvedMemo(item.resolved);
		if (refreshed.capabilities.identity.recoverableDelete !== "absent") {
			throw new Error("Permanent delete requires a current memo without recoverable identity.");
		}
		const result = await this.markdownMutations.remove({ observation: refreshed.observation });
		const saved = await this.finishMarkdownSavedMemo(result, []);
		return pickDailyMutationResult(saved);
	}

	async delete(item: CatalogMemoItem): Promise<DailyMutationResult> {
		if (this.identityLedger.recordDeletePayload === undefined
			|| this.identityLedger.recordDeleteCommit === undefined
			|| this.markdownMutations.captureObservation === undefined) {
			throw new Error("Recoverable delete requires an available Identity Ledger.");
		}
		const refreshed = await this.refreshResolvedMemo(item.resolved);
		const state = this.identityLedger.resolveObservationState(refreshed.observation);
		if (state.kind !== "identified") throw new Error("Recoverable delete requires one confirmed memo identity.");
		const captured = await this.markdownMutations.captureObservation({ observation: refreshed.observation });
		const deleteRecord = await this.identityLedger.recordDeletePayload(state.binding, {
			deletedAt: this.now().toISOString(),
			sourcePath: captured.observation.sourcePath,
			deletedSourceRevision: captured.deletedSourceRevision,
			logicalDate: captured.observation.logicalDate,
			section: captured.observation.section,
			rawBlock: captured.rawBlock,
			contentHash: captured.observation.contentHash,
			sourceMemoId: item.sourceMemoId,
		});
		const result = await this.markdownMutations.remove({ observation: captured.observation });
		let pending = true;
		try {
			await this.identityLedger.recordDeleteCommit(deleteRecord);
			pending = false;
		} catch {
			pending = true;
		}
		const saved = await this.finishMarkdownSavedMemo(result, [], { memoId: state.binding.memoId, pending });
		return pickDailyMutationResult(saved);
	}

	async restore(item: TrashMemoItem): Promise<MemoSaveResult> {
		if (this.identityLedger.getActiveDeletes === undefined
			|| this.identityLedger.recordRestore === undefined
			|| this.markdownMutations.restore === undefined) {
			throw new Error("Identity Ledger restore is unavailable.");
		}
		const record = this.identityLedger.getActiveDeletes()
			.find((candidate) => candidate.deleteEventId === item.deleteEventId);
		if (record === undefined) throw new Error("Deleted memo payload is no longer active.");
		const result = await this.markdownMutations.restore({
			targetLogicalDate: record.evidence.logicalDate,
			rawBlock: record.evidence.rawBlock,
			section: record.evidence.section,
		});
		let pending = true;
		if (result.observation !== null) {
			try {
				await this.identityLedger.recordRestore(record, result.observation);
				pending = false;
			} catch {
				pending = true;
			}
		}
		return this.finishMarkdownSavedMemo(result, result.observation?.timeBuoyDates ?? [], {
			memoId: item.memoId,
			pending,
		});
	}

	async createReferenceText(item: CatalogMemoItem, sourcePath = ""): Promise<MemoReferenceResult> {
		const file = this.getFile(item.sourcePath);
		const anchored = await this.markdownMutations.createBlockReference({
			observation: item.observationHandle,
			sourcePath,
		});
		const identity = await this.finishIdentityRebind(item, anchored.observation, "edit");
		const saved = await this.finishMarkdownSavedMemo(
			anchored,
			anchored.observation?.timeBuoyDates ?? item.timeBuoyDates,
			identity,
		);
		const link = this.app.fileManager.generateMarkdownLink(file, sourcePath, `#^${anchored.blockId}`);
		return {
			text: withCreatedAtAlias(link, item.createdAt),
			memoId: item.memoId,
			followUpPending: saved.followUpPending,
			localRefreshPending: saved.localRefreshPending,
		};
	}

	async recordReview(item: CatalogMemoItem): Promise<void> {
		const state = this.identityLedger.resolveObservationState(item.observation);
		if (state.kind !== "identified") throw new Error("Review requires one confirmed memo identity.");
		await this.identityLedger.recordReview(state.binding, this.now().toISOString());
		await this.readService.materializeResolutionSnapshot();
	}

	private async refreshResolvedMemo(memo: ResolvedMemo): Promise<ResolvedMemo> {
		await this.options.refreshCatalogPaths([memo.observation.sourcePath]);
		await this.readService.materializeResolutionSnapshot();
		return this.readService.resolveObservationInFile(memo.observation.sourcePath, memo.observation.startLine);
	}

	private async finishMarkdownSavedMemo(
		input: MarkdownMutationResult,
		timeBuoyDates: readonly string[],
		identity?: { memoId: string | null; pending: boolean },
	): Promise<MemoSaveResult> {
		let localRefreshPending = input.catalogUpdatePending;
		let memo: CatalogMemoItem | null = null;
		try {
			await this.readService.materializeResolutionSnapshot();
		} catch {
			localRefreshPending = true;
		}
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
			memoId: memo?.memoId ?? identity?.memoId ?? null,
			memo,
			timeBuoyDates: [...(memo?.timeBuoyDates ?? timeBuoyDates)],
			followUpPending: identity?.pending ?? true,
			localRefreshPending,
		};
	}

	private async beginIdentityCreate(
		content: string,
		logicalDate: string,
		createdAt: Date,
		sourceMemoId: string | null,
	): Promise<IdentityLedgerCreatePlan | null> {
		let targetPath: string | null = null;
		try {
			targetPath = await this.options.getDailyPathForDate?.(logicalDate) ?? null;
		} catch {
			targetPath = null;
		}
		try {
			return await this.identityLedger.beginCreate({
				targetPath,
				logicalDate,
				time: formatTimePart(createdAt, this.options.getMemoTimeFormat()),
				contentHash: hashMemoContent(content),
				sourceMemoId,
			});
		} catch {
			return null;
		}
	}

	private async finishIdentityCreate(
		plan: IdentityLedgerCreatePlan | null,
		observation: ResolvedMemo["observation"] | null,
	): Promise<boolean> {
		if (plan === null || observation === null) return true;
		try {
			await this.identityLedger.finishCreate(plan, observation);
			return false;
		} catch {
			return true;
		}
	}

	private async finishIdentityRebind(
		item: CatalogMemoItem,
		observation: ResolvedMemo["observation"] | null,
		reason: IdentityLedgerRebindReason,
	): Promise<{ memoId: string | null; pending: boolean }> {
		if (observation === null) return { memoId: item.memoId, pending: true };
		try {
			const binding = await this.identityLedger.rebindObservation(item.observation, observation, reason);
			return binding === null
				? { memoId: item.memoId, pending: true }
				: { memoId: binding.memoId, pending: false };
		} catch {
			return { memoId: item.memoId, pending: true };
		}
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

function pickDailyMutationResult(result: MemoSaveResult): DailyMutationResult {
	return {
		status: result.status,
		memoId: result.memoId,
		followUpPending: result.followUpPending,
		localRefreshPending: result.localRefreshPending,
	};
}
