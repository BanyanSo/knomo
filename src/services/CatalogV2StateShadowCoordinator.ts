import { normalizePath, TFile } from "obsidian";
import type { App, Component } from "obsidian";

import type {
	CatalogV2ShadowPreview,
	CatalogV2LegacyV2Receipt,
	CatalogV2MaterializedState,
	LegacyArtifactInput,
	LegacyArtifactReceipt,
	LegacyImportResult,
	MigrationPackage,
} from "../types/catalogV2";
import type {
	CatalogV2FileRevisionTransition,
	CatalogV2GenerationSelection,
	CatalogV2VerifiedStateGeneration,
	CatalogV2VerifiedVaultContext,
} from "../types/catalogV2Protocol";
import { hashText } from "../utils/hash";
import { isRecord } from "../utils/object";
import { getCatalogBootstrapPath, getCatalogDataRootPath, getLegacySystemRootPath } from "../utils/path";
import { CatalogV2LegacyImporter } from "./CatalogV2LegacyImporter";
import { CatalogV2MigrationReducer } from "./CatalogV2Migration";
import type { CatalogV2MigrationArtifactStore } from "./CatalogV2MigrationArtifactStore";
import { canonicalJson, canonicalJsonFileBytes, sha256Bytes, sha256Text } from "./CatalogV2Protocol";
import { CatalogV2StateReducer } from "./CatalogV2StateReducer";
import { CatalogV2StateCompactionService } from "./CatalogV2StateCompactionService";
import { CatalogV2StateTransport } from "./CatalogV2StateTransport";
import type { CatalogV2VaultProtocol } from "./CatalogV2VaultProtocol";
import type { CatalogV2StateSnapshot } from "./IndexedDbCatalogV2StateStore";
import { IndexedDbCatalogV2StateStore } from "./IndexedDbCatalogV2StateStore";
import { classifyLegacyArtifactPath } from "./LegacyArtifactInventory";
import { isLegacyV2Path } from "./CatalogV2LayoutMigrationService";
import type { CatalogV2IdentitySettlement } from "./CatalogV2IdentityResolver";

export const CATALOG_V2_STATE_RUNTIME_ENABLED = true;

const DEFAULT_RECONCILE_DELAY_MS = 500;
const DEFAULT_SHA_AUDIT_DELAY_MS = 60_000;
const DEFAULT_COMPACTION_DELAY_MS = 60_000;

export interface CatalogV2StateShadowCoordinatorOptions {
	enabled?: boolean;
	getCatalogDataRoot?: () => string | Promise<string>;
	getLegacySystemRoot?: () => string | Promise<string>;
	migrateLegacyLayout?: () => Promise<{ receipts: CatalogV2LegacyV2Receipt[] }>;
	reconcileDelayMs?: number;
	shaAuditDelayMs?: number;
	now?: () => number;
	migrationArtifactStore?: CatalogV2MigrationArtifactStore;
	canPersistMigrationArtifacts?: () => boolean;
	onCaptured?: () => void | Promise<void>;
	protocol?: CatalogV2VaultProtocol;
	getVaultContext?: () => CatalogV2VerifiedVaultContext | null | Promise<CatalogV2VerifiedVaultContext | null>;
}

export class CatalogV2StateShadowCoordinator {
	private readonly enabled: boolean;
	private readonly reconcileDelayMs: number;
	private readonly shaAuditDelayMs: number;
	private readonly now: () => number;
	private readonly getCatalogDataRoot: (() => string | Promise<string>) | null;
	private readonly getLegacySystemRoot: (() => string | Promise<string>) | null;
	private readonly migrateLegacyLayout: (() => Promise<{ receipts: CatalogV2LegacyV2Receipt[] }>) | null;
	private readonly migrationArtifactStore: CatalogV2MigrationArtifactStore | null;
	private readonly canPersistMigrationArtifacts: () => boolean;
	private readonly onCaptured: (() => void | Promise<void>) | null;
	private readonly protocol: CatalogV2VaultProtocol | null;
	private readonly getVaultContext: (() => CatalogV2VerifiedVaultContext | null | Promise<CatalogV2VerifiedVaultContext | null>) | null;
	private opened = false;
	private stopped = false;
	private running = false;
	private runAgain = false;
	private activeCatalogDataRoot: string | null = null;
	private activeLegacySystemRoot: string | null = null;
	private reconcileTimer: number | null = null;
	private shaAuditTimer: number | null = null;
	private compactionTimer: number | null = null;
	private stateRevisionStable = false;
	private lastObservedStateRevision: string | null = null;
	private lastObservedGenerationId: string | null = null;
	private verifiedGeneration: CatalogV2VerifiedStateGeneration | null = null;
	private generationSelectionKind: CatalogV2GenerationSelection["kind"] | "unavailable" = "unavailable";
	private blockedMemoIds: string[] | null = null;
	private activeContractDigest: string | null = null;
	private migrationInputEpoch = 0;
	private migrationInputDirty = true;
	private pendingLegacyReviewSignature: string | null = null;
	private latestImportResults: LegacyImportResult[] = [];
	private latestLegacyV2Receipts: CatalogV2LegacyV2Receipt[] = [];

	constructor(
		private readonly app: App,
		private readonly store: IndexedDbCatalogV2StateStore,
		private readonly getMonthlyMemoFolder: () => string,
		private readonly pluginId: string,
		private readonly importer = new CatalogV2LegacyImporter(),
		options: CatalogV2StateShadowCoordinatorOptions = {},
	) {
		this.enabled = options.enabled ?? CATALOG_V2_STATE_RUNTIME_ENABLED;
		this.getCatalogDataRoot = options.getCatalogDataRoot ?? null;
		this.getLegacySystemRoot = options.getLegacySystemRoot ?? null;
		this.migrateLegacyLayout = options.migrateLegacyLayout ?? null;
		this.reconcileDelayMs = options.reconcileDelayMs ?? DEFAULT_RECONCILE_DELAY_MS;
		this.shaAuditDelayMs = options.shaAuditDelayMs ?? DEFAULT_SHA_AUDIT_DELAY_MS;
		this.now = options.now ?? Date.now;
		this.migrationArtifactStore = options.migrationArtifactStore ?? null;
		this.canPersistMigrationArtifacts = options.canPersistMigrationArtifacts ?? (() => false);
		this.onCaptured = options.onCaptured ?? null;
		this.protocol = options.protocol ?? null;
		this.getVaultContext = options.getVaultContext ?? null;
	}

	start(owner: Component): void {
		if (!this.enabled) return;
		owner.registerEvent(this.app.vault.on("modify", (file) => this.handleVaultChange(file)));
		owner.registerEvent(this.app.vault.on("create", (file) => this.handleVaultChange(file)));
		owner.registerEvent(this.app.vault.on("rename", (file, oldPath) => this.handleVaultChange(file, oldPath)));
		owner.registerEvent(this.app.vault.on("delete", (file) => this.handleVaultChange(file)));
		owner.registerDomEvent(this.app.workspace.containerEl.doc, "visibilitychange", () => {
			if (this.app.workspace.containerEl.doc.visibilityState !== "hidden") this.scheduleCapture(0);
		});
		owner.register(() => this.stop());
	}

	async initialize(): Promise<void> {
		if (!this.enabled || this.stopped) return;
		if (!this.opened) {
			await this.store.open();
			this.opened = true;
		}
		if (this.store.isFallbackActive()) {
			if (await this.store.loadMaterializedState() === null) {
				await this.store.saveMaterializedState(createUnavailableMaterializedState());
			}
			this.stateRevisionStable = false;
			return;
		}
		await this.capture(false);
		this.scheduleShaAudit();
	}

	async capture(verifyUnchanged: boolean): Promise<void> {
		if (!this.enabled || this.stopped || !this.opened) return;
		if (this.store.isFallbackActive()) return;
		if (this.running) {
			this.runAgain = true;
			return;
		}
		this.running = true;
		try {
			let catalogDataRoot = await this.resolveCatalogDataRoot();
			let legacySystemRoot = await this.resolveLegacySystemRoot();
			this.activeCatalogDataRoot = catalogDataRoot;
			this.activeLegacySystemRoot = legacySystemRoot;
			if (this.protocol !== null && this.getVaultContext !== null) {
				await this.getVaultContext();
				const refreshedCatalogDataRoot = await this.resolveCatalogDataRoot();
				const refreshedLegacySystemRoot = await this.resolveLegacySystemRoot();
				if (refreshedCatalogDataRoot !== catalogDataRoot || refreshedLegacySystemRoot !== legacySystemRoot) {
					catalogDataRoot = refreshedCatalogDataRoot;
					legacySystemRoot = refreshedLegacySystemRoot;
					this.activeCatalogDataRoot = catalogDataRoot;
					this.activeLegacySystemRoot = legacySystemRoot;
				}
			}
			const migrationAuthorized = this.canPersistMigrationArtifacts();
			if (migrationAuthorized && this.migrateLegacyLayout !== null) {
				this.latestLegacyV2Receipts = (await this.migrateLegacyLayout()).receipts;
			}
			const legacyInputs = migrationAuthorized ? await this.collectLegacyInputs(legacySystemRoot) : [];
			const results: LegacyImportResult[] = [];
			for (const input of legacyInputs) results.push(await this.importer.importArtifact(input));
			this.latestImportResults = results;
			const previousPreview = await this.store.loadShadowPreview();
			if (this.protocol !== null && this.getVaultContext !== null) {
				if (this.canPersistMigrationArtifacts() && await this.getVaultContext() !== null) {
					await this.migrationArtifactStore?.persistImportResults(results);
				}
				await this.captureProtocolV2(catalogDataRoot, results, previousPreview);
				if (this.pendingLegacyReviewSignature !== null) {
					await this.store.saveLegacyReviewSignature(this.pendingLegacyReviewSignature);
					this.pendingLegacyReviewSignature = null;
				}
				if (this.onCaptured !== null) await Promise.resolve(this.onCaptured()).catch(() => undefined);
				return;
			}
			if (this.canPersistMigrationArtifacts()) {
				await this.migrationArtifactStore?.persistImportResults(results);
			}

			const transport = new CatalogV2StateTransport(this.app, catalogDataRoot);
			const checkpoints = await this.store.listSegmentCheckpoints();
			const invalidPaths: string[] = [];
			const inputSet = await transport.prepareInputSet((path) => invalidPaths.push(path));
			const currentFiles = inputSet.files;
			const currentPaths = new Set(currentFiles.map((file) => file.path));
			let stateInputsChanged = false;
			for (const checkpoint of checkpoints) {
				if (currentPaths.has(checkpoint.path)) continue;
				await this.store.replaceSegmentEnvelopes(checkpoint.path, []);
				await this.store.deleteSegmentCheckpoint(checkpoint.path);
				stateInputsChanged = true;
			}
			const segments = await transport.readInputSet(inputSet, checkpoints, verifyUnchanged, (path) => invalidPaths.push(path));
			stateInputsChanged = stateInputsChanged || segments.length > 0 || invalidPaths.length > 0;
			for (const path of invalidPaths) {
				await this.store.replaceSegmentEnvelopes(path, []);
				await this.store.deleteSegmentCheckpoint(path);
			}
			const fileByPath = new Map(currentFiles.map((file) => [file.path, file]));
			for (const segment of segments) {
				await this.store.replaceSegmentEnvelopes(segment.path, segment.operations);
				const file = fileByPath.get(segment.path);
				await this.store.setSegmentCheckpoint({
					path: segment.path,
					sha256: segment.sha256,
					byteLength: segment.byteLength,
					mtime: file?.stat.mtime,
					consumedSequence: segment.lastSequence,
				});
			}
			const packages = this.migrationArtifactStore === null
				? results.flatMap((result): MigrationPackage[] => result.kind === "imported" ? [result.package] : [])
				: (await this.migrationArtifactStore.listPackages()).map((item) => item.value);
			stateInputsChanged = stateInputsChanged || migrationInputSignature(results) !== previewInputSignature(previousPreview);
			if (stateInputsChanged) this.invalidateMigrationReadiness();
			let state: CatalogV2MaterializedState | null = stateInputsChanged ? null : await this.store.loadMaterializedState();
			if (state === null) {
				const eventState = await new CatalogV2StateReducer().reduce(await this.store.listOperationEnvelopes());
				state = await new CatalogV2MigrationReducer().reduce(packages, eventState);
				await this.store.saveMaterializedState(state);
			}
			const writerId = await this.store.getOrCreateWriterId();
			if (state.forkedWriterIds.includes(writerId)) await this.store.rotateWriterId();

			const preview = buildPreview(
				this.now(),
				catalogDataRoot,
				results,
				currentFiles.length,
				Object.keys(state.memos).length,
				invalidPaths,
			);
			await this.store.saveShadowPreview(preview);
			this.scheduleCompaction(catalogDataRoot);
			const snapshot = await this.store.loadMaterializedSnapshot();
			this.stateRevisionStable = snapshot !== null && snapshot.revision === this.lastObservedStateRevision;
			this.lastObservedStateRevision = snapshot?.revision ?? null;
			if (this.pendingLegacyReviewSignature !== null) {
				await this.store.saveLegacyReviewSignature(this.pendingLegacyReviewSignature);
				this.pendingLegacyReviewSignature = null;
			}
			if (this.onCaptured !== null) await Promise.resolve(this.onCaptured()).catch(() => undefined);
		} finally {
			this.running = false;
			if (this.runAgain) {
				this.runAgain = false;
				this.scheduleCapture(0);
			}
		}
	}

	async loadLocalStateSnapshot(historical: boolean): Promise<{
		snapshot: CatalogV2StateSnapshot;
		settlement: CatalogV2IdentitySettlement;
	} | null> {
		const context = await this.store.loadIdentityContextSnapshot();
		if (context === null) return null;
		const { snapshot } = context;
		const stateClean = snapshot.state.awaitingWriterIds.length === 0
			&& snapshot.state.forkedWriterIds.length === 0
			&& snapshot.state.quarantine.length === 0;
		return {
			snapshot,
			settlement: {
				stateComplete: !this.store.isFallbackActive() && stateClean
					&& (this.protocol === null || this.generationSelectionKind === "verified"),
				migrationComplete: this.isMigrationReady(context.upgradeStatus, snapshot.revision),
				revisionStable: !this.store.isFallbackActive() && this.stateRevisionStable
					&& (this.protocol === null || this.verifiedGeneration !== null),
				historical,
				migrationRequired: context.upgradeStatus?.installMode === "legacy_upgrade",
				verifiedGenerationId: this.verifiedGeneration?.generationRef.sha256,
				contractDigest: this.activeContractDigest ?? undefined,
				blockedMemoIds: this.blockedMemoIds,
			},
		};
	}

	async loadLocalStateSlice(
		observations: ReadonlyArray<{
			sourcePath: string;
			logicalDate: string;
			time: string;
			contentHash: string;
			existingBlockId: string | null;
		}>,
		historical: boolean,
	): Promise<{
		snapshot: CatalogV2StateSnapshot;
		settlement: CatalogV2IdentitySettlement;
	} | null> {
		const context = await this.store.loadIdentityContextSlice(observations);
		if (context === null) return null;
		const { snapshot } = context;
		const stateClean = snapshot.state.awaitingWriterIds.length === 0
			&& snapshot.state.forkedWriterIds.length === 0
			&& snapshot.state.quarantine.length === 0;
		return {
			snapshot,
			settlement: {
				stateComplete: !this.store.isFallbackActive() && stateClean
					&& (this.protocol === null || this.generationSelectionKind === "verified"),
				migrationComplete: this.isMigrationReady(context.upgradeStatus, snapshot.revision),
				revisionStable: !this.store.isFallbackActive() && this.stateRevisionStable
					&& (this.protocol === null || this.verifiedGeneration !== null),
				historical,
				migrationRequired: context.upgradeStatus?.installMode === "legacy_upgrade",
				verifiedGenerationId: this.verifiedGeneration?.generationRef.sha256,
				contractDigest: this.activeContractDigest ?? undefined,
				blockedMemoIds: this.blockedMemoIds,
			},
		};
	}

	getLatestImportResults(): readonly LegacyImportResult[] {
		return this.latestImportResults;
	}

	getLatestLegacyV2Receipts(): readonly CatalogV2LegacyV2Receipt[] {
		return this.latestLegacyV2Receipts;
	}

	getMigrationInputEpoch(): number {
		return this.migrationInputEpoch;
	}

	getVerifiedGeneration(): CatalogV2VerifiedStateGeneration | null {
		return this.verifiedGeneration;
	}

	getGenerationSelectionKind(): CatalogV2GenerationSelection["kind"] | "unavailable" {
		return this.generationSelectionKind;
	}

	confirmMigrationReadiness(epoch: number): boolean {
		if (epoch !== this.migrationInputEpoch) return false;
		this.migrationInputDirty = false;
		return true;
	}

	async isMigrationReadinessCurrent(stateRevision: string): Promise<boolean> {
		return this.isMigrationReady(await this.store.loadUpgradeStatus(), stateRevision);
	}

	async buildFreshEventState(): Promise<CatalogV2MaterializedState> {
		if (this.protocol !== null && this.getVaultContext !== null) {
			const context = await this.getVaultContext();
			if (context === null) throw new Error("Catalog v2 Vault bootstrap is not verified.");
			const selection = await this.protocol.selectGeneration(context);
			if (selection.kind === "empty") return new CatalogV2StateReducer().reduce([]);
			if (selection.kind !== "verified") throw new Error(`Catalog state generation is ${selection.kind}.`);
			const state = await new CatalogV2StateReducer().reduce(await Promise.all(selection.value.operations.map(async (operation) => ({
				operation,
				digest: await sha256Text(canonicalJson(operation)),
				sourcePath: selection.value.generationRef.path,
			}))));
			state.fileRevisionTransitions = collectFileRevisionTransitions(selection.value);
			return state;
		}
		const catalogDataRoot = await this.resolveCatalogDataRoot();
		const transport = new CatalogV2StateTransport(this.app, catalogDataRoot);
		const inputSet = await transport.prepareInputSet();
		const segments = await transport.readInputSet(inputSet, [], true);
		return new CatalogV2StateReducer().reduce(segments.flatMap((segment) => segment.operations));
	}

	private async captureProtocolV2(
		catalogDataRoot: string,
		results: readonly LegacyImportResult[],
		previousPreview: CatalogV2ShadowPreview | null,
	): Promise<void> {
		const context = await this.getVaultContext?.() ?? null;
		if (context === null) {
			this.activeContractDigest = null;
			this.verifiedGeneration = null;
			this.generationSelectionKind = "unavailable";
			this.blockedMemoIds = null;
			this.stateRevisionStable = false;
			if (await this.store.loadMaterializedState() === null) {
				await this.store.saveMaterializedState(createUnavailableMaterializedState());
			}
			return;
		}
		this.activeContractDigest = context.contractSha256;
		const protocol = this.protocol;
		if (protocol === null) throw new Error("Catalog v2 protocol is unavailable.");
		const selection = await protocol.selectGeneration(context);
		this.generationSelectionKind = selection.kind;
		const watermark = await this.store.loadVerifiedGenerationWatermark();
		if (selection.kind === "awaiting_data" && selection.verifiedBase !== null
			&& watermark?.vaultInstanceId === context.bootstrap.vaultInstanceId) {
			const contractChanged = watermark.contractDigest !== context.contractSha256;
			const generationRegressed = !contractChanged && !await protocol.hasGenerationAncestor(
				context,
				selection.verifiedBase.generationRef,
				watermark.generationRef.sha256,
			);
			if (contractChanged || generationRegressed) {
				this.generationSelectionKind = "invalid";
				this.verifiedGeneration = null;
				this.stateRevisionStable = false;
				this.blockedMemoIds = null;
				await this.store.saveShadowPreview(buildPreview(
					this.now(),
					catalogDataRoot,
					results,
					0,
					Object.keys((await this.store.loadMaterializedState())?.memos ?? {}).length,
					[contractChanged ? "generation_contract_regression" : "generation_watermark_regression"],
				));
				return;
			}
		}
		if (selection.kind !== "verified") {
			const scopedAwaiting = selection.kind === "awaiting_data"
				&& selection.affectedMemoIds !== null
				&& this.verifiedGeneration !== null;
			this.blockedMemoIds = scopedAwaiting ? selection.affectedMemoIds : null;
			if (!scopedAwaiting) {
				this.verifiedGeneration = null;
				this.stateRevisionStable = false;
				this.lastObservedGenerationId = null;
			} else {
				this.stateRevisionStable = false;
			}
			if (scopedAwaiting && selection.kind === "awaiting_data" && selection.verifiedBase !== null) {
				const state = await this.materializeProtocolGeneration(
					catalogDataRoot,
					results,
					previousPreview,
					selection.verifiedBase,
				);
				const generationId = selection.verifiedBase.generationRef.sha256;
				this.stateRevisionStable = this.lastObservedGenerationId === generationId;
				this.lastObservedGenerationId = generationId;
				this.verifiedGeneration = selection.verifiedBase;
				this.lastObservedStateRevision = (await this.store.loadMaterializedSnapshot())?.revision ?? null;
				await this.store.saveShadowPreview(buildPreview(
					this.now(),
					catalogDataRoot,
					results,
					selection.verifiedBase.generation.writers.length,
					Object.keys(state.memos).length,
					generationSelectionErrors(selection),
				));
				return;
			}
			if (await this.store.loadMaterializedState() === null) {
				await this.store.saveMaterializedState(createUnavailableMaterializedState());
			}
			const reasons = generationSelectionErrors(selection);
			await this.store.saveShadowPreview(buildPreview(
				this.now(),
				catalogDataRoot,
				results,
				0,
				Object.keys((await this.store.loadMaterializedState())?.memos ?? {}).length,
				reasons,
			));
			return;
		}

		if (watermark?.vaultInstanceId === context.bootstrap.vaultInstanceId) {
			const contractChanged = watermark.contractDigest !== context.contractSha256;
			const generationRegressed = !contractChanged && !await protocol.hasGenerationAncestor(
				context,
				selection.value.generationRef,
				watermark.generationRef.sha256,
			);
			if (contractChanged || generationRegressed) {
				this.generationSelectionKind = "invalid";
				this.verifiedGeneration = null;
				this.stateRevisionStable = false;
				this.blockedMemoIds = null;
				await this.store.saveShadowPreview(buildPreview(
					this.now(),
					catalogDataRoot,
					results,
					0,
					Object.keys((await this.store.loadMaterializedState())?.memos ?? {}).length,
					[contractChanged ? "generation_contract_regression" : "generation_watermark_regression"],
				));
				return;
			}
		}
		this.verifiedGeneration = null;
		this.stateRevisionStable = false;
		this.blockedMemoIds = null;
		const state = await this.materializeProtocolGeneration(
			catalogDataRoot,
			results,
			previousPreview,
			selection.value,
		);
		const generationId = selection.value.generationRef.sha256;
		this.stateRevisionStable = this.lastObservedGenerationId === generationId;
		this.lastObservedGenerationId = generationId;
		this.verifiedGeneration = selection.value;
		this.blockedMemoIds = [];
		await this.store.saveVerifiedGenerationWatermark({
			vaultInstanceId: context.bootstrap.vaultInstanceId,
			contractDigest: context.contractSha256,
			generationRef: selection.value.generationRef,
		});
		if (!this.stateRevisionStable) this.runAgain = true;
		this.lastObservedStateRevision = (await this.store.loadMaterializedSnapshot())?.revision ?? null;
		await this.store.saveShadowPreview(buildPreview(
			this.now(),
			catalogDataRoot,
			results,
			selection.value.generation.writers.length,
			Object.keys(state.memos).length,
			[],
		));
	}

	private async materializeProtocolGeneration(
		catalogDataRoot: string,
		results: readonly LegacyImportResult[],
		previousPreview: CatalogV2ShadowPreview | null,
		generation: CatalogV2VerifiedStateGeneration,
	): Promise<CatalogV2MaterializedState> {
		const envelopes = await Promise.all(generation.operations.map(async (operation) => ({
			operation,
			digest: await sha256Text(canonicalJson(operation)),
			sourcePath: generation.generationRef.path,
		})));
		const eventState = await new CatalogV2StateReducer().reduce(envelopes);
		eventState.fileRevisionTransitions = collectFileRevisionTransitions(generation);
		let packages: MigrationPackage[] = [];
		if (generation.generation.migrationCommit !== null) {
			if (this.migrationArtifactStore === null) {
				throw new Error("Verified migration generation requires its artifact store.");
			}
			const root = `${catalogDataRoot.replace(/\/$/u, "")}/`;
			const commitPath = generation.generation.migrationCommit.path;
			if (!commitPath.startsWith(root)) throw new Error("Migration commit is outside the active Catalog root.");
			const relativeCommitPath = commitPath.slice(root.length);
			const storedCommit = await this.migrationArtifactStore.readCommit(relativeCommitPath);
			if (storedCommit === null) throw new Error("Verified migration commit is unavailable locally.");
			const requiredPackagePaths = storedCommit.value.requiredArtifacts
				.filter((artifact) => artifact.artifactKind === "migration_package")
				.map((artifact) => artifact.path);
			for (const packagePath of requiredPackagePaths) {
				const storedPackage = await this.migrationArtifactStore.readPackage(packagePath);
				if (storedPackage === null) throw new Error(`Verified migration package is unavailable: ${packagePath}`);
				packages.push(storedPackage.value);
			}
		}
		const state = await new CatalogV2MigrationReducer().reduce(packages, eventState);
		const previousState = await this.store.loadMaterializedState();
		const inputsChanged = migrationInputSignature(results) !== previewInputSignature(previousPreview);
		if (inputsChanged) this.invalidateMigrationReadiness();
		if (previousState === null || canonicalJson(previousState) !== canonicalJson(state)) {
			await this.store.saveMaterializedState(state);
		}
		return state;
	}

	private async collectLegacyInputs(legacySystemRoot: string): Promise<LegacyArtifactInput[]> {
		const inputs: LegacyArtifactInput[] = [];
		for (const file of this.app.vault.getFiles()) {
			const classification = classifyLegacyArtifactPath(legacySystemRoot, file.path);
			if (classification === null) continue;
			inputs.push({
				artifactKind: classification.artifactKind,
				path: file.path,
				bytes: new Uint8Array(await this.app.vault.readBinary(file)),
				mtime: file.stat.mtime,
			});
		}
		const pluginData = await this.readPluginDataInput();
		if (pluginData !== null) inputs.push(pluginData);
		return inputs.sort((left, right) => left.path.localeCompare(right.path));
	}

	private async resolveCatalogDataRoot(): Promise<string> {
		return normalizePath(this.getCatalogDataRoot === null
			? getCatalogDataRootPath(this.getMonthlyMemoFolder())
			: await this.getCatalogDataRoot());
	}

	private async resolveLegacySystemRoot(): Promise<string> {
		return normalizePath(this.getLegacySystemRoot === null
			? getLegacySystemRootPath(this.getMonthlyMemoFolder())
			: await this.getLegacySystemRoot());
	}

	private async readPluginDataInput(): Promise<LegacyArtifactInput | null> {
		const vault = this.app.vault as App["vault"] & { configDir?: string };
		const path = normalizePath(`${vault.configDir ?? ".obsidian"}/plugins/${this.pluginId}/data.json`);
		try {
			if (!await vault.adapter.exists(path)) return null;
			const stat = await vault.adapter.stat(path);
			if (stat?.type !== "file") return null;
			const rawBytes = new Uint8Array(await vault.adapter.readBinary(path));
			let value: unknown;
			try {
				value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(rawBytes));
			} catch {
				this.pendingLegacyReviewSignature = await sha256Bytes(rawBytes);
				return { artifactKind: "plugin_data", path, bytes: rawBytes, mtime: stat.mtime };
			}
			if (!isRecord(value)) return null;
			const hasReviewDomain = Object.prototype.hasOwnProperty.call(value, "randomReunionReviewStates");
			const states = hasReviewDomain ? value.randomReunionReviewStates ?? null : {};
			const projectedBytes = canonicalJsonFileBytes({ randomReunionReviewStates: states });
			const signature = await sha256Bytes(projectedBytes);
			const previousSignature = await this.store.loadLegacyReviewSignature();
			this.pendingLegacyReviewSignature = signature;
			const hasReviewState = isRecord(states) && Object.keys(states).length > 0;
			const invalidReviewDomain = hasReviewDomain && !isRecord(states);
			const reviewDomainChanged = previousSignature !== null && previousSignature !== signature;
			if (!hasReviewState && !invalidReviewDomain && !reviewDomainChanged) return null;
			return {
				artifactKind: "plugin_data",
				path,
				bytes: projectedBytes,
				mtime: stat.mtime,
			};
		} catch {
			return null;
		}
	}

	private handleVaultChange(file: unknown, oldPath: string | null = null): void {
		if (!(file instanceof TFile)) return;
		const catalogDataRoot = this.activeCatalogDataRoot ?? getCatalogDataRootPath(this.getMonthlyMemoFolder());
		const legacySystemRoot = this.activeLegacySystemRoot ?? getLegacySystemRootPath(this.getMonthlyMemoFolder());
		const paths = oldPath === null ? [file.path] : [file.path, oldPath];
		const migrationAuthorized = this.canPersistMigrationArtifacts();
		if (!paths.some((path) => hasKnomoProtocolRoot(path)
			|| (migrationAuthorized && classifyLegacyArtifactPath(legacySystemRoot, path) !== null)
			|| (migrationAuthorized && isLegacyV2Path(legacySystemRoot, path))
			|| path === getCatalogBootstrapPath()
			|| path.startsWith(`${catalogDataRoot}/`))) return;
		this.invalidateMigrationReadiness();
		this.scheduleCapture();
	}

	private invalidateMigrationReadiness(): void {
		this.migrationInputEpoch += 1;
		this.migrationInputDirty = true;
	}

	private isMigrationReady(
		status: Awaited<ReturnType<IndexedDbCatalogV2StateStore["loadUpgradeStatus"]>>,
		stateRevision: string,
	): boolean {
		const readiness = status?.identityAdoptionReadiness;
		return !this.store.isFallbackActive() && !this.migrationInputDirty
			&& readiness?.kind === "ready"
			&& readiness.epoch === this.migrationInputEpoch
			&& readiness.stateRevision === stateRevision;
	}

	private scheduleCapture(delay = this.reconcileDelayMs): void {
		if (!this.opened || this.stopped || this.reconcileTimer !== null) return;
		this.reconcileTimer = this.app.workspace.containerEl.win.setTimeout(() => {
			this.reconcileTimer = null;
			void this.capture(false).catch(() => undefined);
		}, delay);
	}

	private scheduleShaAudit(): void {
		if (this.stopped || this.shaAuditTimer !== null) return;
		this.shaAuditTimer = this.app.workspace.containerEl.win.setTimeout(() => {
			this.shaAuditTimer = null;
			void this.capture(true).catch(() => undefined).finally(() => this.scheduleShaAudit());
		}, this.shaAuditDelayMs);
	}

	private scheduleCompaction(catalogDataRoot: string): void {
		if (this.stopped || this.compactionTimer !== null) return;
		this.compactionTimer = this.app.workspace.containerEl.win.setTimeout(() => {
			this.compactionTimer = null;
			void new CatalogV2StateCompactionService(this.app, catalogDataRoot, this.store).maintain()
				.then((result) => {
					if (result.retiredSegments > 0) this.scheduleCapture(0);
				})
				.catch(() => undefined);
		}, DEFAULT_COMPACTION_DELAY_MS);
	}

	private stop(): void {
		this.stopped = true;
		const win = this.app.workspace.containerEl.win;
		if (this.reconcileTimer !== null) win.clearTimeout(this.reconcileTimer);
		if (this.shaAuditTimer !== null) win.clearTimeout(this.shaAuditTimer);
		if (this.compactionTimer !== null) win.clearTimeout(this.compactionTimer);
		this.reconcileTimer = null;
		this.shaAuditTimer = null;
		this.compactionTimer = null;
		this.store.close();
		this.opened = false;
	}
}

function hasKnomoProtocolRoot(path: string): boolean {
	const normalized = normalizePath(path);
	return normalized.startsWith("_knomo-data/") || normalized.includes("/_knomo-data/")
		|| normalized.startsWith("_knomo-system/") || normalized.includes("/_knomo-system/");
}

function collectFileRevisionTransitions(
	generation: CatalogV2VerifiedStateGeneration,
): CatalogV2FileRevisionTransition[] {
	const transitions = new Map<string, CatalogV2FileRevisionTransition>();
	for (const commitRef of generation.generation.mutationCommits ?? []) {
		const prepare = generation.mutationPrepares?.[commitRef.sha256];
		if (prepare === undefined) continue;
		for (const change of prepare.changes) {
			const transition = change.transition;
			const key = `${transition.sourcePath}\u0000${transition.beforeRevision}\u0000${transition.afterRevision}`;
			transitions.set(key, transition);
		}
	}
	return [...transitions.values()].sort((left, right) =>
		`${left.sourcePath}\u0000${left.beforeRevision}\u0000${left.afterRevision}`
			.localeCompare(`${right.sourcePath}\u0000${right.beforeRevision}\u0000${right.afterRevision}`));
}

function createUnavailableMaterializedState(): CatalogV2MaterializedState {
	return {
		schemaVersion: 1,
		memos: {},
		quarantine: [],
		awaitingWriterIds: [],
		forkedWriterIds: [],
		processedOperationCount: 0,
	};
}

function generationSelectionErrors(selection: Exclude<CatalogV2GenerationSelection, { kind: "verified" }>): string[] {
	switch (selection.kind) {
		case "empty":
			return ["state_generation_empty"];
		case "awaiting_data":
			return selection.missingPaths.map((path) => `state_generation_missing:${path}`);
		case "forked":
			return selection.generationRefs.map((ref) => `state_generation_fork:${ref.sha256}`);
		case "invalid":
			return selection.reasons.map((reason) => `state_generation_invalid:${reason}`);
	}
}

function migrationInputSignature(results: readonly LegacyImportResult[]): string {
	const values: string[] = [];
	for (const result of results) {
		if (result.kind === "imported") {
			values.push(`package\u0000${result.packagePath}\u0000${result.packageSha256}`);
			for (const payload of result.deletedPayloads) values.push(`payload\u0000${payload.path}\u0000${payload.sha256}`);
		} else {
			values.push(`quarantine\u0000${result.path}\u0000${result.receiptSha256}`);
		}
	}
	return values.sort().join("\u0001");
}

function previewInputSignature(preview: CatalogV2ShadowPreview | null): string {
	if (preview === null) return "";
	return [
		...preview.packages.map((item) => `package\u0000${item.path}\u0000${item.sha256}`),
		...preview.deletedPayloads.map((item) => `payload\u0000${item.path}\u0000${item.sha256}`),
		...preview.quarantines.map((item) => `quarantine\u0000${item.path}\u0000${item.sha256}`),
	].sort().join("\u0001");
}

export function createCatalogV2StateDatabaseName(app: App): string {
	const vault = app.vault as App["vault"] & { getName?: () => string; configDir?: string };
	const adapter = vault.adapter as App["vault"]["adapter"] & {
		getBasePath?: () => string;
		getFullPath?: (path: string) => string;
	};
	let key = `${adapter.getName?.() ?? "vault"}\u0000${vault.getName?.() ?? "unknown"}\u0000${vault.configDir ?? ".obsidian"}`;
	try {
		key = adapter.getBasePath?.() ?? adapter.getFullPath?.("") ?? key;
	} catch {
		// 移动端 adapter 没有桌面绝对路径时使用 Vault 元数据组合。
	}
	return `knomo-state-v2-${hashText(key)}`;
}

function buildPreview(
	generatedAt: number,
	catalogDataRoot: string,
	results: readonly LegacyImportResult[],
	stateSegmentCount: number,
	materializedMemoCount: number,
	invalidStatePaths: readonly string[],
): CatalogV2ShadowPreview {
	const receipts: LegacyArtifactReceipt[] = [];
	const packages: CatalogV2ShadowPreview["packages"] = [];
	const quarantines: CatalogV2ShadowPreview["quarantines"] = [];
	const deletedPayloads: CatalogV2ShadowPreview["deletedPayloads"] = [];
	for (const result of results) {
		if (result.kind === "imported") {
			receipts.push(result.receipt);
			packages.push({ path: result.packagePath, sha256: result.packageSha256, byteLength: result.packageBytes.byteLength });
			for (const payload of result.deletedPayloads) deletedPayloads.push({ path: payload.path, sha256: payload.sha256, byteLength: payload.bytes.byteLength });
		} else {
			receipts.push(result.inventory);
			quarantines.push({ path: result.path, sha256: result.receiptSha256, byteLength: result.receiptBytes.byteLength });
		}
	}
	return {
		schemaVersion: 1,
		generatedAt,
		catalogDataRoot,
		legacyReceipts: receipts.sort((left, right) => left.path.localeCompare(right.path)),
		packages: packages.sort((left, right) => left.path.localeCompare(right.path)),
		quarantines: quarantines.sort((left, right) => left.path.localeCompare(right.path)),
		deletedPayloads: deletedPayloads.sort((left, right) => left.path.localeCompare(right.path)),
		stateSegmentCount,
		materializedMemoCount,
		stateErrors: [...new Set(invalidStatePaths)].sort().map((path) => ({ path, errorCode: "invalid_state_segment" })),
	};
}
