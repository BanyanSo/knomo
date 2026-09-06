import type {
	CatalogCoverage,
	CatalogFileRevisionBatch,
	CatalogStoreLifecycle,
	MemoObservation,
} from "../types/catalog";
import type { IdentityLedgerObservationState, IdentityLedgerSnapshot, IdentityLedgerStatus } from "../types/identityLedger";
import type { LegacyIdentityImportStatus } from "../types/legacyMigration";
import { canonicalIdentityLedgerJson, sha256IdentityLedgerText } from "./IdentityLedgerProtocol";
import type { HistoricalIdentityAdoptionResult } from "./IdentityLedgerService";
import type { LowPriorityWorkRunner } from "./LowPriorityWorkQueue";
import type { MemoCatalogStore } from "./MemoCatalogStore";
import { normalizeVaultPath } from "../utils/path";

export const HISTORICAL_IDENTITY_BOOTSTRAP_META_KEY = "historicalIdentityBootstrap";

const HISTORICAL_IDENTITY_BOOTSTRAP_WORK_PRIORITY = 30;

export type HistoricalIdentityBootstrapStatus = "idle" | "pending" | "running" | "completed" | "failed";

interface HistoricalIdentityBootstrapCheckpoint {
	state: "pending" | "completed";
	reason: "initial_import" | "legacy_source";
	catalogFingerprint: string | null;
	identityRevision: string | null;
	identityEventCount: number | null;
	authorizationRoot?: string | null;
}

interface HistoricalIdentityBootstrapTarget {
	getStatus(): IdentityLedgerStatus;
	getSnapshot(): IdentityLedgerSnapshot;
	resolveObservationState(observation: MemoObservation): IdentityLedgerObservationState;
	adoptHistoricalObservations(
		observations: readonly MemoObservation[],
		runtime?: {
			cancellationSignal?: AbortSignal;
			yieldControl?: () => Promise<void>;
			sliceBudgetMs?: number;
			now?: () => number;
		},
	): Promise<HistoricalIdentityAdoptionResult>;
}

export interface HistoricalIdentityBootstrapServiceOptions {
	getCatalogCoverage: () => Promise<CatalogCoverage>;
	getCatalogLifecycle: () => CatalogStoreLifecycle;
	getObservationBatches: () => Promise<readonly CatalogFileRevisionBatch<MemoObservation>[]>;
	checkpointStore: Pick<MemoCatalogStore, "getMeta" | "setMeta">;
	workQueue?: LowPriorityWorkRunner;
	sliceBudgetMs?: number;
	now?: () => number;
	onStateChanged?: (status: HistoricalIdentityBootstrapStatus) => void | Promise<void>;
}

export class HistoricalIdentityBootstrapService {
	private status: HistoricalIdentityBootstrapStatus = "idle";
	private runQueue: Promise<HistoricalIdentityBootstrapStatus> = Promise.resolve("idle");
	private checkpoint: HistoricalIdentityBootstrapCheckpoint | null = null;

	constructor(
		private readonly target: HistoricalIdentityBootstrapTarget,
		private readonly options: HistoricalIdentityBootstrapServiceOptions,
	) {}

	getStatus(): HistoricalIdentityBootstrapStatus {
		return this.status;
	}

	async authorizeInitialImport(dataRoot: string): Promise<HistoricalIdentityBootstrapStatus> {
		const authorizationRoot = normalizeVaultPath(dataRoot);
		const checkpoint = await this.loadCheckpoint();
		if (checkpoint?.reason === "initial_import" && checkpoint.authorizationRoot === authorizationRoot) {
			this.setStatus(checkpoint.state === "completed" ? "completed" : "pending");
			return this.status;
		}
		await this.persistCheckpoint({
			state: "pending",
			reason: "initial_import",
			catalogFingerprint: null,
			identityRevision: null,
			identityEventCount: null,
			authorizationRoot,
		});
		this.setStatus("pending");
		return this.status;
	}

	async initializeEligibility(): Promise<HistoricalIdentityBootstrapStatus> {
		const checkpoint = await this.loadCheckpoint();
		if (checkpoint !== null) {
			const authorized = checkpoint.reason !== "initial_import"
				|| checkpoint.state === "completed"
				|| typeof checkpoint.authorizationRoot === "string";
			this.setStatus(authorized ? (checkpoint.state === "completed" ? "completed" : "pending") : "idle");
			return this.status;
		}
		const snapshot = this.target.getSnapshot();
		const identityStatus = this.target.getStatus();
		if (identityStatus === "ready") {
			this.setStatus("completed");
			return this.status;
		}
		if (identityStatus !== "absent" || snapshot.eventCount !== 0
			|| snapshot.quarantinedEventIds.length > 0) return this.status;
		return this.status;
	}

	run(legacyStatus: LegacyIdentityImportStatus): Promise<HistoricalIdentityBootstrapStatus> {
		this.runQueue = this.runQueue.then(
			() => this.runLowPriorityTask(() => this.runOnce(legacyStatus)),
			() => this.runLowPriorityTask(() => this.runOnce(legacyStatus)),
		);
		return this.runQueue;
	}

	private runLowPriorityTask<T>(action: () => Promise<T>): Promise<T> {
		return this.options.workQueue?.run(HISTORICAL_IDENTITY_BOOTSTRAP_WORK_PRIORITY, action) ?? action();
	}

	private async runOnce(legacyStatus: LegacyIdentityImportStatus): Promise<HistoricalIdentityBootstrapStatus> {
		try {
			if (this.status === "idle" || this.status === "failed") await this.initializeEligibility();
			if (this.status === "completed") {
				return this.status;
			}
			if (this.status !== "pending") return this.status;
			this.assertRunning();
			if (legacyStatus === "ready" || legacyStatus === "partial" || legacyStatus === "attention") {
				await this.persistCheckpoint({
					state: "completed",
					reason: "legacy_source",
					catalogFingerprint: null,
					identityRevision: this.target.getSnapshot().revision,
					identityEventCount: this.target.getSnapshot().eventCount,
					authorizationRoot: null,
				});
				this.setStatus("completed");
				return this.status;
			}
			if (legacyStatus !== "not_applicable") return this.status;

			const coverage = await this.options.getCatalogCoverage();
			const lifecycle = this.options.getCatalogLifecycle();
			if (coverage.kind !== "complete" || coverage.sharedConfigurationComplete === false
				|| lifecycle.state !== "ready" || !lifecycle.persistent || !lifecycle.writable) {
				return this.status;
			}
			const snapshot = this.target.getSnapshot();
			if ((this.target.getStatus() !== "ready" && this.target.getStatus() !== "absent")
				|| snapshot.quarantinedEventIds.length > 0
				|| Object.values(snapshot.memos).some((memo) => memo.conflicted)) {
				return this.status;
			}

			const batches = await this.options.getObservationBatches();
			const catalogFingerprint = await fingerprintBatches(batches);
			this.setStatus("running");
			const result = await this.target.adoptHistoricalObservations(
				batches.flatMap((batch) => batch.observations),
				{
					cancellationSignal: this.options.workQueue?.signal,
					yieldControl: () => this.yieldControl(),
					sliceBudgetMs: this.options.sliceBudgetMs,
					now: this.options.now,
				},
			);
			this.assertRunning();
			const currentBatches = await this.options.getObservationBatches();
			if (await fingerprintBatches(currentBatches) !== catalogFingerprint) {
				await this.persistCheckpoint({
					state: "pending",
					reason: "initial_import",
					catalogFingerprint: null,
					identityRevision: result.identityRevision,
					identityEventCount: null,
					authorizationRoot: this.checkpoint?.authorizationRoot ?? null,
				});
				this.setStatus("pending");
				return this.status;
			}
			await this.persistCheckpoint({
				state: "completed",
				reason: "initial_import",
				catalogFingerprint,
				identityRevision: result.identityRevision,
				identityEventCount: this.target.getSnapshot().eventCount,
				authorizationRoot: this.checkpoint?.authorizationRoot ?? null,
			});
			this.setStatus("completed");
			return this.status;
		} catch (error) {
			if (this.options.workQueue?.signal.aborted === true) throw error;
			this.setStatus("failed");
			return this.status;
		}
	}

	private async loadCheckpoint(): Promise<HistoricalIdentityBootstrapCheckpoint | null> {
		const value = await this.options.checkpointStore.getMeta<unknown>(HISTORICAL_IDENTITY_BOOTSTRAP_META_KEY);
		this.checkpoint = isHistoricalIdentityBootstrapCheckpoint(value) ? value : null;
		return this.checkpoint;
	}

	private persistCheckpoint(checkpoint: HistoricalIdentityBootstrapCheckpoint): Promise<void> {
		this.checkpoint = checkpoint;
		return this.options.checkpointStore.setMeta(HISTORICAL_IDENTITY_BOOTSTRAP_META_KEY, checkpoint);
	}

	private async yieldControl(): Promise<void> {
		this.assertRunning();
		await new Promise<void>((resolve) => setTimeout(resolve, 0));
		this.assertRunning();
	}

	private assertRunning(): void {
		if (this.options.workQueue?.signal.aborted === true) {
			throw new Error("Historical Identity bootstrap is stopped.");
		}
	}

	private setStatus(status: HistoricalIdentityBootstrapStatus): void {
		if (this.status === status) return;
		this.status = status;
		void Promise.resolve(this.options.onStateChanged?.(status)).catch(() => undefined);
	}
}

async function fingerprintBatches(batches: readonly CatalogFileRevisionBatch<MemoObservation>[]): Promise<string> {
	return sha256IdentityLedgerText(canonicalIdentityLedgerJson(batches
		.map((batch) => ({
			sourcePath: batch.file.sourcePath,
			sourceRevision: batch.file.sourceRevision,
			observationCount: batch.observations.length,
		}))
		.sort((left, right) => left.sourcePath.localeCompare(right.sourcePath))));
}

function isHistoricalIdentityBootstrapCheckpoint(value: unknown): value is HistoricalIdentityBootstrapCheckpoint {
	if (typeof value !== "object" || value === null) return false;
	const checkpoint = value as Partial<HistoricalIdentityBootstrapCheckpoint>;
	const valid = (checkpoint.state === "pending" || checkpoint.state === "completed")
		&& (checkpoint.reason === "initial_import" || checkpoint.reason === "legacy_source")
		&& (checkpoint.catalogFingerprint === null || typeof checkpoint.catalogFingerprint === "string")
		&& (checkpoint.identityRevision === null || typeof checkpoint.identityRevision === "string")
		&& (checkpoint.identityEventCount === undefined || checkpoint.identityEventCount === null
			|| (Number.isInteger(checkpoint.identityEventCount) && checkpoint.identityEventCount >= 0))
		&& (checkpoint.authorizationRoot === undefined || checkpoint.authorizationRoot === null
			|| (typeof checkpoint.authorizationRoot === "string"
				&& normalizeVaultPath(checkpoint.authorizationRoot) === checkpoint.authorizationRoot));
	if (!valid) return false;
	if (checkpoint.identityEventCount === undefined) checkpoint.identityEventCount = null;
	return true;
}
