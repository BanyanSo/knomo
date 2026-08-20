import { TFile } from "obsidian";
import type { App } from "obsidian";

import type {
	ResolvedMemo,
	ResolvedMemoHandle,
} from "../types/catalog";
import type { CatalogV2InstallMode } from "../types/catalogV2";
import type { CatalogV2SharedMutationInspection, CatalogV2VerifiedVaultContext } from "../types/catalogV2Protocol";
import type {
	CatalogV2DeletedMemoItem,
	CatalogV2DailyMutationResult,
	CatalogV2FeatureQuery,
	CatalogV2MemoItem,
	CatalogV2MemoSaveResult,
	CatalogV2MutationFollowUpState,
	CatalogV2OperationalState,
	CatalogV2ReadState,
} from "../types/catalogV2View";
import { formatDatePart, formatTimePart } from "../utils/date";
import { withCreatedAtAlias } from "../utils/references";
import { extractTimeBuoyDates } from "../utils/timeBuoyParser";
import { createResolvedMemoHandle, observationToIdentityEvidence } from "./CatalogV2IdentityResolver";
import type { CatalogV2MutationRuntime } from "./CatalogV2MutationRuntime";
import type { CatalogV2VaultProtocol } from "./CatalogV2VaultProtocol";
import type { CatalogV2StateShadowCoordinator } from "./CatalogV2StateShadowCoordinator";
import type { CatalogV2DeletedPayloadStore } from "./CatalogV2DeletedPayloadStore";
import type { IndexedDbCatalogV2StateStore } from "./IndexedDbCatalogV2StateStore";
import type { IndexedDbCatalogV2TransactionStore } from "./IndexedDbCatalogV2TransactionStore";
import { MarkdownBlockService } from "./MarkdownBlockService";
import type { MemoCatalogService } from "./MemoCatalogService";
import type { CatalogV2PendingMutationInspection } from "../types/catalogV2Runtime";
import { canonicalJson, sha256Text } from "./CatalogV2Protocol";
import { CatalogV2ReadService } from "./CatalogV2ReadService";

export interface CatalogV2FeatureServiceOptions {
	installMode: CatalogV2InstallMode;
	getInstallMode?: () => CatalogV2InstallMode;
	getHeadings: () => readonly string[];
	getOrCreateDailyFile: (date: Date) => Promise<TFile>;
	removeEmptyCreatedDailyFile?: (file: TFile) => Promise<void>;
	getDailyFileForDate: (logicalDate: string) => Promise<TFile>;
	refreshCatalogPaths: (paths: readonly string[]) => Promise<void>;
	refreshLocalCatalog: () => Promise<void>;
	getMemoTimeFormat: () => "HH:mm" | "HH:mm:ss";
	rebuildLocalCatalog: () => Promise<void>;
	getVaultContext?: () => CatalogV2VerifiedVaultContext | null | Promise<CatalogV2VerifiedVaultContext | null>;
	getWriterId?: () => Promise<string>;
	isControlAuthority?: () => boolean;
	vaultProtocol?: CatalogV2VaultProtocol;
	inspectSharedMutations?: () => Promise<CatalogV2SharedMutationInspection>;
	now?: () => Date;
	random?: () => number;
}

function normalizeMemoInput(input: string): string {
	return input.replace(/\r\n/gu, "\n").replace(/\r/gu, "\n");
}

export interface CatalogV2ReferenceResult extends CatalogV2MutationFollowUpState {
	text: string;
	memoId: string;
}

export class CatalogV2FeatureService {
	private readonly markdownBlockService = new MarkdownBlockService();
	private readonly now: () => Date;
	private readonly random: () => number;
	private readonly readService: CatalogV2ReadService;

	constructor(
		private readonly app: App,
		catalog: MemoCatalogService,
		private readonly stateStore: IndexedDbCatalogV2StateStore | null,
		private readonly stateCoordinator: CatalogV2StateShadowCoordinator | null,
		private readonly transactionStore: IndexedDbCatalogV2TransactionStore | null,
		private readonly mutationRuntime: CatalogV2MutationRuntime | null,
		deletedPayloadStore: CatalogV2DeletedPayloadStore | null,
		private readonly options: CatalogV2FeatureServiceOptions,
	) {
		this.now = options.now ?? (() => new Date());
		this.random = options.random ?? Math.random;
		this.readService = new CatalogV2ReadService({
			catalog,
			stateStore,
			stateCoordinator,
			transactionStore,
			deletedPayloadStore,
			installMode: options.installMode,
			getInstallMode: options.getInstallMode,
			getVaultContext: options.getVaultContext,
			inspectSharedMutations: options.inspectSharedMutations,
			now: options.now,
			random: options.random,
		});
	}

	getReadService(): CatalogV2ReadService {
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

	async inspectPendingMutations(): Promise<CatalogV2PendingMutationInspection> {
		if (this.mutationRuntime === null) {
			return { items: [], affectedPaths: [], affectedMemoIds: [] };
		}
		return this.mutationRuntime.inspectPending();
	}

	async recoverPendingMutation(mutationId: string, action: "continue" | "abandon"): Promise<boolean> {
		if (this.mutationRuntime === null) return false;
		const inspection = await this.mutationRuntime.inspectPending();
		const item = inspection.items.find((candidate) => candidate.mutationId === mutationId);
		if (item === undefined) return false;
		const completed = await this.mutationRuntime.recoverExplicit(mutationId, action);
		if (!completed) return false;
		await this.finishMutation(item.paths).catch(() => undefined);
		return true;
	}

	getOperationalState(readState: CatalogV2ReadState = this.getStaticInstallReadState()
		?? this.readService.getLastReadState()
		?? ((this.options.getInstallMode?.() ?? this.options.installMode) === "legacy_upgrade"
			? "legacy_detected" : "state_settling")): CatalogV2OperationalState {
		const installMode = this.options.getInstallMode?.() ?? this.options.installMode;
		return {
			installMode,
			readState,
			capabilities: {
				readKnown: true,
				createNew: (installMode === "existing_v2" || installMode === "legacy_upgrade")
					&& readState === "ready" && this.mutationRuntime !== null
					&& this.stateStore?.isAuthoritative() === true
					&& this.transactionStore?.isAuthoritative() === true,
				adoptExisting: false,
				projectMonthly: false,
				physicalGc: false,
			},
		};
	}

	async adoptMemo(item: CatalogV2MemoItem): Promise<string> {
		void item;
		throw new Error("Existing Daily memo adoption is disabled.");
	}

	private getStaticInstallReadState(): CatalogV2ReadState | null {
		const installMode = this.options.getInstallMode?.() ?? this.options.installMode;
		if (installMode === "uninitialized") return "needs_initialization";
		if (installMode === "joining") return "waiting_for_sync";
		if (installMode === "attention") return "attention";
		return null;
	}

	async create(contentInput: string, sourceMemoId: string | null = null): Promise<CatalogV2MemoSaveResult> {
		if (!this.getOperationalState().capabilities.createNew) {
			throw new Error("Knomo Vault identity is not ready; Daily was not changed.");
		}
		if (this.mutationRuntime === null) throw new Error("Memo identity is still preparing; Daily was not changed.");
		const content = normalizeMemoInput(contentInput);
		if (content.trim().length === 0) throw new Error("Memo content is empty.");
		const createdAt = this.now();
		const existingPaths = new Set(this.app.vault.getFiles().map((item) => item.path));
		const file = await this.options.getOrCreateDailyFile(createdAt);
		const removeFileOnAbort = this.options.removeEmptyCreatedDailyFile === undefined || existingPaths.has(file.path)
			? null
			: () => this.options.removeEmptyCreatedDailyFile?.(file) ?? Promise.resolve();
		const rawBlock = this.markdownBlockService.buildMemoBlock(
			content,
			formatTimePart(createdAt, this.options.getMemoTimeFormat()),
		);
		const result = await this.mutationRuntime.create({
			file,
			logicalDate: formatDatePart(createdAt),
			headings: this.options.getHeadings(),
			rawBlock,
			sourceMemoId,
			removeFileOnAbort,
		}).catch(async (error: unknown) => {
			await removeFileOnAbort?.().catch(() => undefined);
			throw error;
		});
		return this.finishSavedMemo({
			memoId: result.memoId,
			sourcePath: file.path,
			timeBuoyDates: result.observation.timeBuoyDates,
			followUpPending: result.followUpPending,
			provisionalObservation: result.observation,
		});
	}

	async copy(item: CatalogV2MemoItem, logicalDate = formatDatePart(this.now())): Promise<CatalogV2MemoSaveResult> {
		this.assertSharedMutationReady();
		if (item.memoId === null || item.capabilities.copyAsNew !== "ready") {
			throw new Error("Only a memo with stable identity can be copied as a new memo.");
		}
		const file = await this.options.getOrCreateDailyFile(new Date(`${logicalDate}T12:00:00`));
		const result = await this.getMutationRuntime().copy({
			file,
			logicalDate,
			headings: this.options.getHeadings(),
			rawBlock: `- ${formatTimePart(this.now(), this.options.getMemoTimeFormat())} ${item.content}`,
			sourceMemoId: item.memoId,
			removeFileOnAbort: this.options.removeEmptyCreatedDailyFile === undefined
				? null
				: () => this.options.removeEmptyCreatedDailyFile?.(file) ?? Promise.resolve(),
		});
		return this.finishSavedMemo({
			memoId: result.memoId,
			sourcePath: file.path,
			timeBuoyDates: result.observation.timeBuoyDates,
			followUpPending: result.followUpPending,
			provisionalObservation: result.observation,
		});
	}

	async move(item: CatalogV2MemoItem, targetLogicalDate: string): Promise<CatalogV2MemoSaveResult> {
		this.assertSharedMutationReady();
		const handle = await this.getWritableHandle(item, "edit");
		const targetFile = await this.options.getDailyFileForDate(targetLogicalDate);
		const moved = await this.getMutationRuntime().move({
			file: this.getFile(handle.evidence.sourcePath),
			logicalDate: handle.evidence.logicalDate,
			headings: this.options.getHeadings(),
			handle,
			targetFile,
			targetLogicalDate,
			targetHeadings: this.options.getHeadings(),
		});
		return this.finishSavedMemo({
			memoId: moved.handle.memoId,
			sourcePath: targetFile.path,
			additionalPaths: [handle.evidence.sourcePath],
			timeBuoyDates: item.timeBuoyDates,
			followUpPending: moved.followUpPending,
			provisionalObservation: null,
		});
	}

	async repairIdentity(target: CatalogV2MemoItem, candidateMemoId: string): Promise<void> {
		this.assertSharedMutationReady();
		if (this.options.isControlAuthority?.() !== true) {
			throw new Error("Only the current Catalog control authority can repair memo identity.");
		}
		if (target.resolved.kind !== "ambiguous" || target.resolved.reason === "known_predecessor"
			|| !target.resolved.candidates.some((candidate) => candidate.memoId === candidateMemoId)) {
			throw new Error("Manual repair requires an ambiguous target and one of its identity candidates.");
		}
		if (this.options.getVaultContext === undefined || this.options.getWriterId === undefined
			|| this.options.vaultProtocol === undefined || this.stateStore === null) {
			throw new Error("Catalog control authority is unavailable for identity repair.");
		}
		const state = await this.stateStore.loadMaterializedState();
		const memo = state?.memos[candidateMemoId];
		if (memo === undefined || memo.activeBindingHeads.length !== 1) {
			throw new Error("The selected identity no longer has one active binding.");
		}
		const activeBinding = memo.activeBindingHeads[0];
		if (activeBinding === undefined || !("sourceRevision" in activeBinding.evidence)) {
			throw new Error("The selected identity binding cannot be repaired safely.");
		}
		const context = await this.options.getVaultContext();
		if (context === null) throw new Error("Catalog v2 Vault bootstrap is not verified.");
		const writerId = await this.options.getWriterId();
		const baseEvidence = activeBinding.evidence;
		const repairInputDigest = await sha256Text(canonicalJson({
			memoId: candidateMemoId,
			baseBindingId: activeBinding.entryId,
			baseEvidence,
			targetEvidence: observationToIdentityEvidence(target.resolved.observation),
		}));
		const control = await this.options.vaultProtocol.authorizeControlAction(context, writerId, {
			actionId: `o_${repairInputDigest.slice(0, 32)}`,
			kind: "identity_repair",
			inputDigest: repairInputDigest,
			memoIds: [candidateMemoId],
		});
		await this.getMutationRuntime().manualRepair({
			memoId: candidateMemoId,
			baseBindingId: activeBinding.entryId,
			baseEvidence,
			targetEvidence: observationToIdentityEvidence(target.resolved.observation),
			control,
		});
		await this.finishMutation([baseEvidence.sourcePath, target.sourcePath]);
	}

	async edit(item: CatalogV2MemoItem, contentInput: string): Promise<CatalogV2MemoSaveResult> {
		const content = normalizeMemoInput(contentInput);
		if (content.trim().length === 0) throw new Error("Memo content is empty.");
		const handle = await this.getWritableHandle(item, "edit", false);
		const file = this.getFile(handle.evidence.sourcePath);
		const result = await this.getMutationRuntime().edit({
			file,
			logicalDate: handle.evidence.logicalDate,
			headings: this.options.getHeadings(),
			handle,
			rawBlock: this.markdownBlockService.buildMemoBlockWithBlockId(
				content,
				item.observation.time,
				item.observation.existingBlockId,
			),
		});
		return this.finishSavedMemo({
			memoId: handle.memoId,
			sourcePath: file.path,
			timeBuoyDates: extractTimeBuoyDates(content),
			followUpPending: result.followUpPending,
			provisionalObservation: null,
		});
	}

	async toggleTask(item: CatalogV2MemoItem, taskIndex: number, checked: boolean): Promise<CatalogV2MemoSaveResult> {
		const handle = await this.getWritableHandle(item, "toggleTask", false);
		const file = this.getFile(handle.evidence.sourcePath);
		const result = await this.getMutationRuntime().toggleTask({
			file,
			logicalDate: handle.evidence.logicalDate,
			headings: this.options.getHeadings(),
			handle,
			taskIndex,
			checked,
		});
		return this.finishSavedMemo({
			memoId: handle.memoId,
			sourcePath: file.path,
			timeBuoyDates: item.timeBuoyDates,
			followUpPending: result.followUpPending,
			provisionalObservation: null,
		});
	}

	async delete(item: CatalogV2MemoItem): Promise<CatalogV2DailyMutationResult> {
		const handle = await this.getWritableHandle(item, "delete");
		const file = this.getFile(handle.evidence.sourcePath);
		const result = await this.getMutationRuntime().delete({
			file,
			logicalDate: handle.evidence.logicalDate,
			headings: this.options.getHeadings(),
			handle,
			sourceMemoId: item.sourceMemoId,
		});
		return this.finishDailyMutation(handle.memoId, [file.path], result.followUpPending);
	}

	async restore(item: CatalogV2DeletedMemoItem): Promise<CatalogV2MemoSaveResult> {
		this.assertSharedMutationReady();
		if (!item.payloadAvailable) throw new Error("Deleted memo payload is unavailable and cannot be restored.");
		const existing = this.app.vault.getAbstractFileByPath(item.sourcePath);
		const file = existing instanceof TFile ? existing : await this.options.getDailyFileForDate(item.logicalDate);
		const result = await this.getMutationRuntime().restore({
			file,
			logicalDate: item.logicalDate,
			headings: this.options.getHeadings(),
			memoId: item.memoId,
			deleteVersion: item.deleteVersion,
		});
		return this.finishSavedMemo({
			memoId: item.memoId,
			sourcePath: file.path,
			timeBuoyDates: extractTimeBuoyDates(item.content),
			followUpPending: result.followUpPending,
			provisionalObservation: null,
		});
	}

	async purge(item: CatalogV2DeletedMemoItem): Promise<void> {
		this.assertSharedMutationReady();
		await this.getMutationRuntime().purge({
			memoId: item.memoId,
			deleteOpId: item.deleteVersion.deleteOpId,
			deletedPayload: item.deleteVersion.payload,
		});
		await this.finishMutation([]);
	}

	async createReferenceText(item: CatalogV2MemoItem, sourcePath = ""): Promise<CatalogV2ReferenceResult> {
		let handle = await this.getWritableHandle(item, "createReference");
		const file = this.getFile(handle.evidence.sourcePath);
		let blockId = handle.evidence.existingBlockId;
		let followUp: CatalogV2MutationFollowUpState = { followUpPending: false, localRefreshPending: false };
		if (blockId === null) {
			blockId = await this.createUniqueReferenceBlockId(file);
			const anchored = await this.getMutationRuntime().ensureReferenceAnchor({
				file,
				logicalDate: handle.evidence.logicalDate,
				headings: this.options.getHeadings(),
				handle,
				rawBlock: "",
			}, blockId);
			handle = anchored.handle;
			followUp = await this.finishDailyMutation(handle.memoId, [file.path], anchored.followUpPending);
		}
		const link = this.app.fileManager.generateMarkdownLink(file, sourcePath, `#^${blockId}`);
		return { text: withCreatedAtAlias(link, item.createdAt), memoId: handle.memoId, ...followUp };
	}

	async recordReview(item: CatalogV2MemoItem): Promise<void> {
		this.assertSharedMutationReady();
		const handle = await this.getWritableHandle(item, "recordReview");
		await this.getMutationRuntime().recordReview(handle);
		await this.finishMutation([]);
	}

	private async getWritableHandle(
		item: CatalogV2MemoItem,
		capability: "edit" | "toggleTask" | "delete" | "createReference" | "recordReview",
		requireSharedReadiness = true,
	): Promise<ResolvedMemoHandle> {
		if (requireSharedReadiness && !this.getOperationalState().capabilities.createNew) {
			throw new Error("Knomo Vault identity is not ready; Daily was not changed.");
		}
		let resolved = await this.refreshResolvedMemo(item.resolved);
		const handle = createResolvedMemoHandle(resolved);
		if (handle !== null && resolved.capabilities[capability] === "ready") return handle;
		throw new Error(resolved.kind === "ambiguous"
			? "This memo has multiple possible sources and cannot be changed automatically."
			: resolved.kind === "observed" && resolved.adoption === "eligible"
				? "This Daily memo must be explicitly adopted before it can be changed."
				: "This memo is still settling and cannot be changed yet.");
	}

	private async refreshResolvedMemo(memo: ResolvedMemo): Promise<ResolvedMemo> {
		await this.options.refreshCatalogPaths([memo.observation.sourcePath]);
		await this.readService.materializeResolutionSnapshot();
		return this.readService.resolveObservationInFile(memo.observation.sourcePath, memo.observation.startLine);
	}

	private async finishMutation(paths: readonly string[]): Promise<void> {
		if (paths.length > 0) await this.options.refreshCatalogPaths(paths);
		await this.stateCoordinator?.capture(false);
		await this.readService.materializeResolutionSnapshot();
	}

	private async finishSavedMemo(input: {
		memoId: string;
		sourcePath: string;
		additionalPaths?: readonly string[];
		timeBuoyDates: readonly string[];
		followUpPending: boolean;
		provisionalObservation: ResolvedMemo["observation"] | null;
	}): Promise<CatalogV2MemoSaveResult> {
		let memo: CatalogV2MemoItem | null = null;
		const result = await this.finishDailyMutation(
			input.memoId,
			[...(input.additionalPaths ?? []), input.sourcePath],
			input.followUpPending,
		);
		if (!result.localRefreshPending) {
			try {
				memo = await this.findMemoById(input.memoId, input.sourcePath);
				if (memo === null && input.followUpPending && input.provisionalObservation !== null) {
					const page = await this.readService.query({ sourcePaths: [input.sourcePath], limit: 150, cursor: null });
					memo = page.items.find((item) =>
						item.observation.sourceRevision === input.provisionalObservation?.sourceRevision
						&& item.observation.startLine === input.provisionalObservation.startLine
						&& item.observation.contentHash === input.provisionalObservation.contentHash) ?? null;
				}
			} catch {
				result.localRefreshPending = true;
			}
		}
		if (memo === null) result.localRefreshPending = true;
		return {
			...result,
			memo,
			timeBuoyDates: [...(memo?.timeBuoyDates ?? input.timeBuoyDates)],
		};
	}

	private async finishDailyMutation(
		memoId: string,
		paths: readonly string[],
		followUpPending: boolean,
	): Promise<CatalogV2DailyMutationResult> {
		let localRefreshPending = false;
		try {
			await this.finishMutation(paths);
		} catch {
			localRefreshPending = true;
		}
		return { status: "saved", memoId, followUpPending, localRefreshPending };
	}

	private async findMemoById(memoId: string, sourcePath: string): Promise<CatalogV2MemoItem | null> {
		let cursor: CatalogV2FeatureQuery["cursor"] = null;
		do {
			const page = await this.readService.query({ sourcePaths: [sourcePath], limit: 150, cursor });
			const found = page.items.find((item) => item.memoId === memoId);
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

	private getMutationRuntime(): CatalogV2MutationRuntime {
		if (this.mutationRuntime === null) throw new Error("Memo identity is still preparing.");
		return this.mutationRuntime;
	}

	private assertSharedMutationReady(): void {
		if (!this.getOperationalState().capabilities.createNew) {
			throw new Error("Knomo Vault identity is not ready; shared state was not changed.");
		}
	}

	private async createUniqueReferenceBlockId(file: TFile): Promise<string> {
		const content = await this.app.vault.cachedRead(file);
		const ids = new Set<string>();
		const pattern = /(?:^|[^A-Za-z0-9_-])\^([A-Za-z0-9_-]+)/gu;
		let match = pattern.exec(content);
		while (match !== null) {
			ids.add(match[1] ?? "");
			match = pattern.exec(content);
		}
		const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
		for (let attempt = 0; attempt < 1000; attempt += 1) {
			let blockId = "";
			for (let index = 0; index < 6; index += 1) {
				blockId += chars.charAt(Math.min(Math.floor(this.random() * chars.length), chars.length - 1));
			}
			if (!ids.has(blockId)) return blockId;
		}
		throw new Error("Unable to create a unique reference block ID.");
	}
}
