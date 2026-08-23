import { normalizePath, TFile } from "obsidian";
import type { App } from "obsidian";

import type { CatalogCoverage, CatalogFileRevisionBatch, ResolvedMemo } from "../types/catalog";
import type {
	ArtifactRef,
	CatalogV2MaterializedState,
	CatalogV2InstallMode,
	CatalogV2LegacyV2Receipt,
	CatalogV2IdentityReadinessReason,
	CatalogV2UpgradeStatus,
	LegacyArtifactReceipt,
	LegacyImportResult,
	MigrationCommit,
	MigrationCommitVerification,
	MigrationPackage,
} from "../types/catalogV2";
import type { IndexedDbCatalogV2TransactionStore } from "./IndexedDbCatalogV2TransactionStore";
import type { MemoCatalogService } from "./MemoCatalogService";
import { CatalogV2ColdStartVerifier } from "./CatalogV2ColdStartVerifier";
import { CatalogV2IdentityResolver } from "./CatalogV2IdentityResolver";
import {
	buildMigrationCommit,
	CatalogV2MigrationReducer,
	evaluateMigrationCommit,
	selectMigrationCommit,
} from "./CatalogV2Migration";
import type { CatalogV2MigrationArtifactStore, StoredMigrationPackage } from "./CatalogV2MigrationArtifactStore";
import { canonicalJson, sha256Bytes } from "./CatalogV2Protocol";
import type { CatalogV2StateShadowCoordinator } from "./CatalogV2StateShadowCoordinator";
import type { IndexedDbCatalogV2StateStore } from "./IndexedDbCatalogV2StateStore";

export interface CatalogV2UpgradeCoordinatorOptions {
	sessionId: string;
	installMode: CatalogV2InstallMode;
	getInstallMode?: () => CatalogV2InstallMode;
	legacyReadsDisabled: () => boolean;
	legacyWriterRemoved: () => boolean;
	canWriteSharedUpgrade?: () => boolean;
	settlementMs?: number;
	now?: () => number;
	onLegacyRootRetired?: () => void | Promise<void>;
	onLegacyRootBlocked?: () => void;
	commitMigration?: (
		commit: ArtifactRef,
		generationDigest: string,
		memoIds: readonly string[],
		supersedes: ArtifactRef | null,
	) => Promise<void>;
}

interface CatalogV2SettlementEvaluation {
	ready: boolean;
	reason: CatalogV2IdentityReadinessReason;
	stateRevision: string | null;
	localQueuesDrained: boolean;
}

export class CatalogV2UpgradeCoordinator {
	private readonly now: () => number;
	private readonly settlementMs: number;
	private readonly coldStartVerifier: CatalogV2ColdStartVerifier;
	private initialized = false;
	private running: Promise<CatalogV2UpgradeStatus | null> | null = null;

	constructor(
		private readonly app: App,
		private readonly catalogDataRoot: string | (() => string),
		private readonly legacySystemRoot: string,
		private readonly catalog: MemoCatalogService,
		private readonly stateStore: IndexedDbCatalogV2StateStore,
		private readonly stateCoordinator: CatalogV2StateShadowCoordinator,
		private readonly transactionStore: IndexedDbCatalogV2TransactionStore,
		private readonly artifactStore: CatalogV2MigrationArtifactStore,
		private readonly options: CatalogV2UpgradeCoordinatorOptions,
	) {
		this.now = options.now ?? Date.now;
		this.settlementMs = options.settlementMs ?? 0;
		this.coldStartVerifier = new CatalogV2ColdStartVerifier(stateStore);
	}

	async initialize(): Promise<CatalogV2UpgradeStatus | null> {
		this.initialized = true;
		return this.run();
	}

	run(): Promise<CatalogV2UpgradeStatus | null> {
		if (!this.initialized) return Promise.resolve(null);
		if (this.running !== null) return this.running;
		this.running = this.runOnce().catch(async (error: unknown) => {
			const status = await this.loadStatus();
			status.attention = uniqueSorted([...status.attention, errorMessage(error)]);
			status.identityAdoptionReadiness = {
				kind: "blocked",
				epoch: this.stateCoordinator.getMigrationInputEpoch(),
				reason: "artifact_attention",
			};
			await this.stateStore.saveUpgradeStatus(status);
			return status;
		}).finally(() => {
			this.running = null;
		});
		return this.running;
	}

	private async runOnce(): Promise<CatalogV2UpgradeStatus> {
		const runEpoch = this.stateCoordinator.getMigrationInputEpoch();
		let status = await this.loadStatus();
		if (!this.stateStore.isAuthoritative() || !this.transactionStore.isAuthoritative()) {
			status.attention = uniqueSorted([...status.attention, "storage_unavailable"]);
			status.identityAdoptionReadiness = {
				kind: "blocked",
				epoch: runEpoch,
				reason: "artifact_attention",
			};
			await this.stateStore.saveUpgradeStatus(status);
			return status;
		}
		const currentInstallMode = this.options.getInstallMode?.() ?? this.options.installMode;
		if (currentInstallMode === "legacy_upgrade") {
			status.installMode = "legacy_upgrade";
		} else if ((status.installMode === "uninitialized" || status.installMode === "nonempty_unconfigured" || status.installMode === "joining")
			&& currentInstallMode === "existing_v2") {
			status.installMode = "existing_v2";
		}
		status.identityAdoptionReadiness = { kind: "blocked", epoch: runEpoch, reason: "collecting" };
		await this.stateStore.saveUpgradeStatus(status);
		const preview = await this.stateStore.loadShadowPreview();
		const currentReceipts = preview?.legacyReceipts ?? [];
		const currentLegacyV2Receipts = [...this.stateCoordinator.getLatestLegacyV2Receipts()];
		const currentInventorySignature = combinedInventorySignature(currentReceipts, currentLegacyV2Receipts);
		if (hasInventoryAddition(status.legacyInventorySignature, currentInventorySignature)) {
			status.legacyChangedAt = this.now();
			status.phase = currentReceipts.length > 0 ? "importing" : "verifying";
			status.attention = [];
			status.pendingNoLegacyStartupSessionId = null;
			status.verifiedNoLegacyStartupSessionId = null;
		}
		status.legacyInventorySignature = currentInventorySignature;
		status.legacyReceipts = mergeReceipts(status.legacyReceipts, currentReceipts);
		status.legacyV2Receipts = mergeLegacyV2Receipts(status.legacyV2Receipts, currentLegacyV2Receipts);
		const layoutSignature = legacyV2ReceiptSignature(status.legacyV2Receipts);
		if (layoutSignature.length > 0 && status.pendingLayoutStartupSignature !== layoutSignature) {
			status.pendingLayoutStartupSignature = layoutSignature;
			status.pendingLayoutStartupSessionId = this.options.sessionId;
			status.verifiedLayoutStartupSignature = null;
		}
		if (layoutSignature.length > 0 && status.pendingLayoutStartupSessionId !== this.options.sessionId
			&& status.verifiedLayoutStartupSignature !== layoutSignature
			&& await this.verifyLegacyV2Targets(status.legacyV2Receipts)) {
			status.verifiedLayoutStartupSignature = layoutSignature;
		}
		await this.stateStore.saveUpgradeStatus(status);

		const artifacts = await this.artifactStore.listAvailableArtifacts();
		const storedPackages = await this.artifactStore.listPackages();
		let storedCommits = await this.artifactStore.listCommits();
		let selection = await selectMigrationCommit(storedCommits.map((item) => item.value), artifacts);
		const latestResults = [...this.stateCoordinator.getLatestImportResults()];
		if (currentReceipts.length > 0 || currentLegacyV2Receipts.length > 0
			|| latestResults.length > 0 || storedCommits.length > 0) {
			status.installMode = "legacy_upgrade";
		}
		const selectedBeforeBuild = selection.status === "selected" ? selection.commit : null;
		if (needsNewCommit(selectedBeforeBuild, latestResults) && this.canWriteSharedUpgrade()) {
			status.phase = "verifying";
			const built = await this.buildVerifiedCommit(selectedBeforeBuild, latestResults, storedPackages, artifacts);
			if (built !== null) {
				await this.artifactStore.persistCommit(built);
				await this.publishMigrationGeneration(built.commit, {
					path: `${this.resolveCatalogDataRoot()}/${built.path}`,
					sha256: built.sha256,
					byteLength: built.bytes.byteLength,
				}, allMemoIdsFromPackages(packagesForCommit(built.commit, [
					...storedPackages,
					...latestResults.flatMap((result) => result.kind === "imported" ? [{
						path: result.packagePath,
						bytes: result.packageBytes,
						value: result.package,
					}] : []),
				])));
				status.phase = "committed";
				status.selectedGenerationDigest = built.commit.generationDigest;
				status.pendingStartupGenerationDigest = built.commit.generationDigest;
				status.pendingStartupSessionId = this.options.sessionId;
				status.verifiedStartupGenerationDigest = null;
				await this.stateStore.saveUpgradeStatus(status);
				storedCommits = await this.artifactStore.listCommits();
				selection = await selectMigrationCommit(storedCommits.map((item) => item.value), artifacts);
			}
		}

		if (selection.status !== "selected") {
			if (storedCommits.length > 0) status.attention = uniqueSorted([...status.attention, `migration_${selection.status}`]);
			const noSemanticLegacyInputs = storedCommits.length === 0 && latestResults.length === 0
				&& currentReceipts.length === 0;
			const hasLayoutMigration = status.legacyV2Receipts.length > 0;
			const noLegacyInputs = noSemanticLegacyInputs && !hasLayoutMigration;
			if (noLegacyInputs && status.installMode === "legacy_upgrade") {
				if (status.pendingNoLegacyStartupSessionId === null) {
					status.pendingNoLegacyStartupSessionId = this.options.sessionId;
					status.verifiedNoLegacyStartupSessionId = null;
				} else if (status.pendingNoLegacyStartupSessionId !== this.options.sessionId) {
					status.verifiedNoLegacyStartupSessionId = this.options.sessionId;
				}
			}
			const noLegacyColdStartVerified = noLegacyInputs && status.verifiedNoLegacyStartupSessionId !== null;
			const nativeInstallReady = noLegacyInputs && status.installMode === "existing_v2";
			const semanticMigrationVerified = noSemanticLegacyInputs
				&& (hasLayoutMigration || noLegacyColdStartVerified || nativeInstallReady);
			const semanticReason: CatalogV2IdentityReadinessReason = noSemanticLegacyInputs
				? "cold_start_pending"
				: selection.status === "awaiting_data" ? "awaiting_data" : "artifact_attention";
			const evaluation = await this.evaluateSettlement(
				status,
				semanticMigrationVerified,
				semanticReason,
				currentReceipts,
			);
			if (noSemanticLegacyInputs && status.installMode === "legacy_upgrade") {
				status = await this.tryRetireLegacy(status, null, evaluation, currentReceipts, currentLegacyV2Receipts);
			}
			return this.finalizeIdentityReadiness(
				status,
				evaluation,
				runEpoch,
				null,
				currentInventorySignature,
			);
		}

		const selected = selection.commit;
		status.attention = status.attention.filter((item) => !item.startsWith("migration_"));
		status.selectedGenerationDigest = selected.generationDigest;
		if (status.pendingStartupGenerationDigest !== selected.generationDigest) {
			status.pendingStartupGenerationDigest = selected.generationDigest;
			status.pendingStartupSessionId = this.options.sessionId;
			status.verifiedStartupGenerationDigest = null;
			status.phase = "committed";
		}
		if (status.pendingStartupSessionId !== this.options.sessionId
			&& status.verifiedStartupGenerationDigest !== selected.generationDigest) {
			const verified = await this.verifySelectedColdStart(selected, storedPackages);
			if (verified) {
				status.verifiedStartupGenerationDigest = selected.generationDigest;
				status.phase = "settlement";
			}
		}

		const selectedAvailability = await evaluateMigrationCommit(selected, artifacts);
		const semanticMigrationVerified = status.verifiedStartupGenerationDigest === selected.generationDigest
			&& selectedAvailability.status === "complete";
		const selectedPackages = packagesForCommit(selected, storedPackages);
		const selectedMemoIds = allMemoIdsFromPackages(selectedPackages);
		const storedCommit = storedCommits.find((item) => item.value.generationDigest === selected.generationDigest
			&& item.value.writerId === selected.writerId);
		const selectedCommitRef: ArtifactRef | null = storedCommit === undefined ? null : {
			path: `${this.resolveCatalogDataRoot()}/${storedCommit.path}`,
			sha256: await sha256Bytes(storedCommit.bytes),
			byteLength: storedCommit.bytes.byteLength,
		};
		if (semanticMigrationVerified && selectedCommitRef !== null && this.canWriteSharedUpgrade()) {
			await this.publishMigrationGeneration(selected, selectedCommitRef, selectedMemoIds);
		}
		const migrationGenerationBound = selectedCommitRef !== null
			&& this.isMigrationGenerationBound(selectedCommitRef, selected.generationDigest, selectedMemoIds);
		const semanticReason: CatalogV2IdentityReadinessReason = selectedAvailability.status === "awaiting_data"
			? "awaiting_data"
			: selectedAvailability.status === "quarantined" ? "artifact_attention"
				: semanticMigrationVerified && !migrationGenerationBound ? "awaiting_data" : "cold_start_pending";
		const currentIdentityState = (await this.stateStore.loadMaterializedSnapshot())?.state ?? null;
		const currentCatalogParityVerified = semanticMigrationVerified && migrationGenerationBound
			&& currentIdentityState !== null
			&& await this.buildVerificationInput(activeMemoIdsFromPackages(
				selectedPackages,
			), currentIdentityState) !== null;
		const evaluation = await this.evaluateSettlement(
			status,
			semanticMigrationVerified && migrationGenerationBound && currentCatalogParityVerified,
			semanticMigrationVerified && !migrationGenerationBound ? "awaiting_data"
				: semanticMigrationVerified && !currentCatalogParityVerified ? "state_mismatch" : semanticReason,
			currentReceipts,
		);
		status = await this.tryRetireLegacy(
			status,
			selected,
			evaluation,
			currentReceipts,
			currentLegacyV2Receipts,
		);
		return this.finalizeIdentityReadiness(
			status,
			evaluation,
			runEpoch,
			selected.generationDigest,
			currentInventorySignature,
		);
	}

	private async publishMigrationGeneration(
		commitValue: MigrationCommit,
		commit: ArtifactRef,
		memoIds: readonly string[],
	): Promise<void> {
		if (this.options.commitMigration === undefined) return;
		const current = this.stateCoordinator.getVerifiedGeneration()?.generation.migrationCommit ?? null;
		if (current !== null && !sameArtifactRef(current, commit)) {
			const currentStored = (await this.artifactStore.listCommits()).find((item) =>
				`${this.resolveCatalogDataRoot()}/${item.path}` === current.path);
			if (currentStored === undefined
				|| currentStored.bytes.byteLength !== current.byteLength
				|| await sha256Bytes(currentStored.bytes) !== current.sha256
				|| !migrationCommitSupersedes(commitValue, currentStored.value)) {
				throw new Error("Migration generation fork requires manual attention.");
			}
		}
		await this.options.commitMigration(commit, commitValue.generationDigest, memoIds, current);
	}

	private canWriteSharedUpgrade(): boolean {
		return this.options.canWriteSharedUpgrade?.() === true;
	}

	private isMigrationGenerationBound(
		commit: ArtifactRef,
		generationDigest: string,
		memoIds: readonly string[],
	): boolean {
		const verified = this.stateCoordinator.getVerifiedGeneration();
		if (verified === null || verified.generation.migrationCommit === null) return false;
		const migrationRef = verified.generation.migrationCommit;
		return migrationRef.path === commit.path && migrationRef.sha256 === commit.sha256
			&& migrationRef.byteLength === commit.byteLength
			&& verified.generation.migrationGenerationDigest === generationDigest
			&& verified.generation.migrationMemoIds.join("\u0000") === memoIds.join("\u0000");
	}

	private async tryRetireLegacy(
		status: CatalogV2UpgradeStatus,
		_commit: MigrationCommit | null,
		evaluation: CatalogV2SettlementEvaluation,
		_currentReceipts: readonly LegacyArtifactReceipt[],
		_currentLegacyV2Receipts: readonly CatalogV2LegacyV2Receipt[],
	): Promise<CatalogV2UpgradeStatus> {
		// protocol-v2 第一版只做逻辑接管；没有多设备确认前绝不自动删除共享 legacy 文件。
		if (evaluation.ready) status.phase = "settlement";
		return status;
	}

	private async evaluateSettlement(
		status: CatalogV2UpgradeStatus,
		semanticMigrationVerified: boolean,
		semanticReason: CatalogV2IdentityReadinessReason,
		currentReceipts: readonly LegacyArtifactReceipt[],
	): Promise<CatalogV2SettlementEvaluation> {
		const localQueuesDrained = await this.localQueuesDrained();
		const stateSnapshot = await this.stateStore.loadMaterializedSnapshot();
		const stateClean = stateSnapshot !== null && stateSnapshot.state.awaitingWriterIds.length === 0
			&& stateSnapshot.state.forkedWriterIds.length === 0 && stateSnapshot.state.quarantine.length === 0;
		const layoutSignature = legacyV2ReceiptSignature(status.legacyV2Receipts);
		const layoutVerified = layoutSignature.length === 0 || status.verifiedLayoutStartupSignature === layoutSignature;
		const semanticInputsResolved = currentReceipts.every((receipt) => receipt.disposition === "imported");
		const coverage = await this.catalog.getStore().getCoverage();
		const failedPaths = await this.catalog.getStore().getMeta<Array<{ sourcePath: string }>>("catalogFailedPaths") ?? [];
		const catalogComplete = coverage.kind === "complete" && failedPaths.length === 0;

		let reason: CatalogV2IdentityReadinessReason = "state_mismatch";
		if (!semanticMigrationVerified) reason = semanticReason;
		else if (!layoutVerified) reason = "cold_start_pending";
		else if (!semanticInputsResolved || hasUnresolvedAttention(status.attention)) reason = "artifact_attention";
		const legacyRuntimeReady = status.installMode !== "legacy_upgrade" || this.options.legacyReadsDisabled();
		const ready = semanticMigrationVerified && layoutVerified && localQueuesDrained
			&& stateClean && semanticInputsResolved && !hasUnresolvedAttention(status.attention) && catalogComplete
			&& legacyRuntimeReady && this.options.legacyWriterRemoved();
		return {
			ready,
			reason,
			stateRevision: stateSnapshot?.revision ?? null,
			localQueuesDrained,
		};
	}

	private async finalizeIdentityReadiness(
		status: CatalogV2UpgradeStatus,
		evaluation: CatalogV2SettlementEvaluation,
		runEpoch: number,
		generationDigest: string | null,
		inventorySignature: string,
	): Promise<CatalogV2UpgradeStatus> {
		const currentEpoch = this.stateCoordinator.getMigrationInputEpoch();
		if (evaluation.ready && evaluation.stateRevision !== null && currentEpoch === runEpoch) {
			if (status.installMode !== "legacy_upgrade") status.phase = "v2_ready";
			status.identityAdoptionReadiness = {
				kind: "ready",
				epoch: runEpoch,
				generationDigest,
				inventorySignature,
				stateRevision: evaluation.stateRevision,
				verifiedSessionId: this.options.sessionId,
				settledAt: this.now(),
			};
		} else {
			status.identityAdoptionReadiness = {
				kind: "blocked",
				epoch: currentEpoch,
				reason: currentEpoch === runEpoch ? evaluation.reason : "collecting",
			};
		}
		await this.stateStore.saveUpgradeStatus(status);
		if (status.identityAdoptionReadiness.kind !== "ready") return status;
		if (this.stateCoordinator.confirmMigrationReadiness(runEpoch)) return status;
		status.identityAdoptionReadiness = {
			kind: "blocked",
			epoch: this.stateCoordinator.getMigrationInputEpoch(),
			reason: "collecting",
		};
		await this.stateStore.saveUpgradeStatus(status);
		return status;
	}

	private async verifyLegacyV2Targets(receipts: readonly CatalogV2LegacyV2Receipt[]): Promise<boolean> {
		const root = `${this.resolveCatalogDataRoot()}/`;
		for (const receipt of receipts) {
			if (!receipt.target.path.startsWith(root)) return false;
			const file = this.app.vault.getAbstractFileByPath(receipt.target.path);
			if (!(file instanceof TFile)) return false;
			const bytes = new Uint8Array(await this.app.vault.readBinary(file));
			if (bytes.byteLength !== receipt.target.byteLength
				|| await sha256Bytes(bytes) !== receipt.target.sha256) return false;
		}
		return true;
	}

	private async buildVerifiedCommit(
		baseCommit: MigrationCommit | null,
		results: LegacyImportResult[],
		storedPackages: StoredMigrationPackage[],
		artifacts: Awaited<ReturnType<CatalogV2MigrationArtifactStore["listAvailableArtifacts"]>>,
	) {
		const basePackages = baseCommit === null ? [] : packagesForCommit(baseCommit, storedPackages);
		const packages = mergePackages(basePackages, results.flatMap((result) => result.kind === "imported" ? [result.package] : []));
		const requiredMemoIds = activeMemoIdsFromPackages(packages);
		const eventState = await this.stateCoordinator.buildFreshEventState();
		const currentExpectedState = await new CatalogV2MigrationReducer().reduce(basePackages, eventState);
		const expectedState = await new CatalogV2MigrationReducer().reduce(packages, eventState);
		const currentSnapshot = await this.stateStore.loadMaterializedSnapshot();
		if (currentSnapshot === null || canonicalJson(currentSnapshot.state) !== canonicalJson(currentExpectedState)
			|| !Object.keys(eventState.memos).every((memoId) => expectedState.memos[memoId] !== undefined)) return null;
		const verificationInput = await this.buildVerificationInput(requiredMemoIds, expectedState);
		if (verificationInput === null) return null;
		const verification: MigrationCommitVerification = {
			structure: {
				requiredArtifactsVerified: true,
				existingMemoIdsPreserved: true,
				domainCountsVerified: true,
				deletedPayloadsVerified: true,
				dailyHashesUnchanged: true,
			},
			runtime: {
				v2ColdStartPassed: true,
				outboxDrained: true,
				legacyReadsDisabled: true,
				legacyWriterRemoved: true,
			},
			catalog: verificationInput,
		};
		const built = await buildMigrationCommit({
			writerId: await this.stateStore.getOrCreateWriterId(),
			committedAt: new Date(this.now()).toISOString(),
			results,
			verification,
			baseCommits: baseCommit === null ? [] : [baseCommit],
			basePackages,
		});
		const availability = await evaluateMigrationCommit(built.commit, artifacts);
		if (availability.status !== "complete") return null;
		const beforeDaily = await this.dailyRevisionSignature();
		const coldStartPassed = await this.coldStartVerifier.verify({
			generationDigest: built.commit.generationDigest,
			packages,
			eventState,
			expectedState,
		});
		return coldStartPassed && beforeDaily === await this.dailyRevisionSignature() ? built : null;
	}

	private async verifySelectedColdStart(
		commit: MigrationCommit,
		storedPackages: StoredMigrationPackage[],
	): Promise<boolean> {
		const packages = packagesForCommit(commit, storedPackages);
		const eventState = await this.stateCoordinator.buildFreshEventState();
		const expectedState = await new CatalogV2MigrationReducer().reduce(packages, eventState);
		const beforeDaily = await this.dailyRevisionSignature();
		const passed = await this.coldStartVerifier.verify({
			generationDigest: commit.generationDigest,
			packages,
			eventState,
			expectedState,
		});
		return passed && beforeDaily === await this.dailyRevisionSignature();
	}

	private async buildVerificationInput(
		requiredMemoIds: readonly string[],
		identityState: CatalogV2MaterializedState,
	): Promise<MigrationCommitVerification["catalog"] | null> {
		if (!this.options.legacyReadsDisabled() || !this.options.legacyWriterRemoved() || !await this.localQueuesDrained()) return null;
		const store = this.catalog.getStore();
		const coverage = await store.getCoverage();
		if (coverage.kind !== "complete") return null;
		const failed = await store.getMeta<Array<{ sourcePath: string }>>("catalogFailedPaths") ?? [];
		if (failed.length > 0) return null;
		const batches = await this.loadAllCatalogFileBatches();
		if (batches === null) return null;
		const resolver = new CatalogV2IdentityResolver();
		const resolved = batches.flatMap((batch) => resolver.resolveFile({
			batch,
			state: identityState,
			stateRevision: "migration-staging",
			localIntents: [],
			settlement: { stateComplete: true, migrationComplete: true, revisionStable: true, historical: true },
		}));
		const terminalMemoIds = Object.values(identityState.memos)
			.filter(isTerminalLifecycleMemo)
			.map((memo) => memo.memoId);
		if (!hasUniqueCatalogIdentityParity(requiredMemoIds, resolved, terminalMemoIds)) return null;
		return summarizeCatalogVerification(coverage, resolved, failed.map((item) => item.sourcePath));
	}

	private async loadAllCatalogFileBatches(): Promise<CatalogFileRevisionBatch[] | null> {
		const store = this.catalog.getStore();
		const expectedRevision = await store.getMeta<number>("catalogRevision") ?? 0;
		const files = await store.listFiles();
		const batches: CatalogFileRevisionBatch[] = [];
		for (const file of files) {
			const batch = await store.getFileRevisionBatch(file.sourcePath);
			if (batch === null || batch.catalogRevision !== expectedRevision
				|| batch.file.sourceRevision !== file.sourceRevision) return null;
			batches.push(batch);
		}
		const finalRevision = await store.getMeta<number>("catalogRevision") ?? 0;
		return finalRevision === expectedRevision ? batches : null;
	}

	private async localQueuesDrained(): Promise<boolean> {
		return (await this.transactionStore.listPending()).length === 0
			&& (await this.transactionStore.listOutbox()).length === 0;
	}

	private async dailyRevisionSignature(): Promise<string> {
		return canonicalJson((await this.catalog.getStore().listFiles()).map((file) => ({
			path: file.sourcePath,
			revision: file.sourceRevision,
			logicalDate: file.logicalDate,
		})).sort((left, right) => left.path.localeCompare(right.path)));
	}

	private resolveCatalogDataRoot(): string {
		return normalizePath((typeof this.catalogDataRoot === "function"
			? this.catalogDataRoot()
			: this.catalogDataRoot).replace(/\/$/u, ""));
	}

	private async loadStatus(): Promise<CatalogV2UpgradeStatus> {
		const defaults: CatalogV2UpgradeStatus = {
			schemaVersion: 1,
			installMode: this.options.installMode,
			phase: "v2_ready",
			selectedGenerationDigest: null,
			pendingStartupGenerationDigest: null,
			pendingStartupSessionId: null,
			verifiedStartupGenerationDigest: null,
			pendingNoLegacyStartupSessionId: null,
			verifiedNoLegacyStartupSessionId: null,
			pendingLayoutStartupSignature: null,
			pendingLayoutStartupSessionId: null,
			verifiedLayoutStartupSignature: null,
			legacyInventorySignature: "",
			legacyChangedAt: this.now(),
			legacyReceipts: [],
			legacyV2Receipts: [],
			retiredReceipts: [],
			attention: [],
			identityAdoptionReadiness: {
				kind: "blocked",
				epoch: this.stateCoordinator.getMigrationInputEpoch(),
				reason: "collecting",
			},
		};
		const stored = await this.stateStore.loadUpgradeStatus();
		return stored === null ? defaults : {
			...defaults,
			...stored,
			legacyReceipts: stored.legacyReceipts ?? [],
			legacyV2Receipts: stored.legacyV2Receipts ?? [],
			retiredReceipts: stored.retiredReceipts ?? [],
			attention: stored.attention ?? [],
			identityAdoptionReadiness: stored.identityAdoptionReadiness ?? defaults.identityAdoptionReadiness,
		};
	}
}

function summarizeCatalogVerification(
	coverage: CatalogCoverage,
	resolved: readonly ResolvedMemo[],
	failedPaths: readonly string[],
): MigrationCommitVerification["catalog"] {
	return {
		coverage: "complete",
		observationCount: resolved.length,
		identifiedCount: resolved.filter((item) => item.kind === "identified").length,
		observedCount: resolved.filter((item) => item.kind === "observed").length,
		ambiguousCount: resolved.filter((item) => item.kind === "ambiguous").length,
		failedPaths: [...new Set(failedPaths)].sort(),
	};
}

export function hasCatalogIdentityParity(
	requiredMemoIds: readonly string[],
	accountedMemoIds: readonly string[],
): boolean {
	const accounted = new Set(accountedMemoIds);
	return [...new Set(requiredMemoIds)].every((memoId) => accounted.has(memoId));
}

function hasUniqueCatalogIdentityParity(
	requiredMemoIds: readonly string[],
	resolved: readonly ResolvedMemo[],
	terminalMemoIds: readonly string[],
): boolean {
	const counts = new Map<string, number>();
	for (const memo of resolved) {
		const memoIds = memo.kind === "identified"
			? [memo.identityHandle.memoId]
			: memo.kind === "ambiguous" ? [...new Set(memo.candidates.map((candidate) => candidate.memoId))] : [];
		if (memoIds.length !== 1) continue;
		const memoId = memoIds[0] as string;
		counts.set(memoId, (counts.get(memoId) ?? 0) + 1);
	}
	const terminal = new Set(terminalMemoIds);
	return [...new Set(requiredMemoIds)].every((memoId) => terminal.has(memoId) || counts.get(memoId) === 1);
}

function isTerminalLifecycleMemo(memo: CatalogV2MaterializedState["memos"][string]): boolean {
	if (memo.purgedDeleteOperationIds.length > 0) return true;
	return memo.deleteOperationIds.some((deleteOpId) =>
		!memo.restoredDeleteOperationIds.includes(deleteOpId)
		&& !memo.purgedDeleteOperationIds.includes(deleteOpId));
}

function needsNewCommit(commit: MigrationCommit | null, results: readonly LegacyImportResult[]): boolean {
	if (results.length === 0) return false;
	const covered = new Set(commit?.legacySources.map((source) => `${source.artifactKind}\u0000${source.artifactDigest}`) ?? []);
	return results.some((result) => {
		const kind = result.kind === "imported" ? result.receipt.artifactKind : result.receipt.artifactKind;
		const digest = result.kind === "imported" ? result.receipt.sha256 : result.receipt.artifactDigest;
		return !covered.has(`${kind}\u0000${digest}`);
	});
}

function packagesForCommit(commit: MigrationCommit, packages: readonly StoredMigrationPackage[]): MigrationPackage[] {
	const requiredPaths = new Set(commit.requiredArtifacts
		.filter((artifact) => artifact.artifactKind === "migration_package")
		.map((artifact) => artifact.path));
	return packages.filter((item) => requiredPaths.has(item.path)).map((item) => item.value);
}

function mergePackages(left: readonly MigrationPackage[], right: readonly MigrationPackage[]): MigrationPackage[] {
	return [...new Map([...left, ...right].map((item) => [
		`${item.source.artifactKind}\u0000${item.source.artifactDigest}`,
		item,
	])).values()];
}

function activeMemoIdsFromPackages(packages: readonly MigrationPackage[]): string[] {
	return [...new Set(packages.flatMap((packageValue) => packageValue.identityClaims
		.filter((claim) => claim.legacyStatus === "active")
		.map((claim) => claim.memoId)))].sort();
}

function allMemoIdsFromPackages(packages: readonly MigrationPackage[]): string[] {
	return [...new Set(packages.flatMap((packageValue) => [
		...packageValue.identityClaims.map((item) => item.memoId),
		...packageValue.deletedRecords.map((item) => item.memoId),
		...packageValue.relations.map((item) => item.memoId),
		...packageValue.reviews.map((item) => item.memoId),
		...packageValue.pendingCreates.map((item) => item.memoId),
	]))].sort();
}

function combinedInventorySignature(
	receipts: readonly LegacyArtifactReceipt[],
	legacyV2Receipts: readonly CatalogV2LegacyV2Receipt[],
): string {
	return [
		...receipts.map((receipt) => `legacy\u0000${receipt.path}\u0000${receipt.artifactKind}\u0000${receipt.sha256}`),
		...legacyV2Receipts.map((receipt) => `layout\u0000${receipt.sourcePath}\u0000${receipt.sourceSha256}`),
	].sort().join("\u0001");
}

function hasInventoryAddition(previous: string, current: string): boolean {
	const previousItems = new Set(previous.length === 0 ? [] : previous.split("\u0001"));
	return (current.length === 0 ? [] : current.split("\u0001")).some((item) => !previousItems.has(item));
}

function mergeReceipts(left: readonly LegacyArtifactReceipt[], right: readonly LegacyArtifactReceipt[]): LegacyArtifactReceipt[] {
	return [...new Map([...left, ...right].map((receipt) => [
		`${receipt.path}\u0000${receipt.artifactKind}\u0000${receipt.sha256}`,
		receipt,
	])).values()].sort((a, b) => a.path.localeCompare(b.path) || a.sha256.localeCompare(b.sha256));
}

function mergeLegacyV2Receipts(
	left: readonly CatalogV2LegacyV2Receipt[],
	right: readonly CatalogV2LegacyV2Receipt[],
): CatalogV2LegacyV2Receipt[] {
	return [...new Map([...left, ...right].map((receipt) => [
		`${receipt.sourcePath}\u0000${receipt.sourceSha256}`,
		receipt,
	])).values()].sort((a, b) => a.sourcePath.localeCompare(b.sourcePath) || a.sourceSha256.localeCompare(b.sourceSha256));
}

function legacyV2ReceiptSignature(receipts: readonly CatalogV2LegacyV2Receipt[]): string {
	return receipts.map((receipt) => `${receipt.sourcePath}\u0000${receipt.sourceSha256}\u0000${receipt.target.sha256}`)
		.sort().join("\u0001");
}

function hasUnresolvedAttention(attention: readonly string[]): boolean {
	return attention.some((item) => item !== "legacy_root_not_empty" && !item.startsWith("cleanup_failed:"));
}

function migrationCommitSupersedes(next: MigrationCommit, previous: MigrationCommit): boolean {
	if (next.generationDigest === previous.generationDigest) return true;
	const nextSources = new Map(next.legacySources.map((source) => [
		`${source.artifactKind}\u0000${source.artifactDigest}`,
		canonicalJson(source),
	]));
	if (previous.legacySources.some((source) =>
		nextSources.get(`${source.artifactKind}\u0000${source.artifactDigest}`) !== canonicalJson(source))) return false;
	const nextArtifacts = new Map(next.requiredArtifacts.map((artifact) => [
		`${artifact.artifactKind}\u0000${artifact.path}`,
		canonicalJson(artifact),
	]));
	return previous.requiredArtifacts.every((artifact) =>
		nextArtifacts.get(`${artifact.artifactKind}\u0000${artifact.path}`) === canonicalJson(artifact));
}

function sameArtifactRef(left: ArtifactRef, right: ArtifactRef): boolean {
	return left.path === right.path && left.sha256 === right.sha256 && left.byteLength === right.byteLength;
}

function uniqueSorted(values: readonly string[]): string[] {
	return [...new Set(values)].sort();
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
