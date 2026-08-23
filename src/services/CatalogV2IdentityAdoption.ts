import type { ResolvedMemo } from "../types/catalog";
import type { StateOperation } from "../types/catalogV2";
import type { CatalogV2AdoptionPermit } from "../types/catalogV2Protocol";
import { observationToIdentityEvidence } from "./CatalogV2IdentityResolver";
import type { CatalogV2OperationWriter } from "./CatalogV2OperationWriter";
import { canonicalJson, createCatalogV2Id, sha256Text } from "./CatalogV2Protocol";

export type CatalogV2IdentityIdFactory = (prefix: "m" | "o") => string;

export interface CatalogV2IdentityAdoptionResult {
	memoId: string;
	operation: StateOperation;
}

export class CatalogV2IdentityAdoption {
	private adoptionQueue: Promise<void> = Promise.resolve();

	constructor(
		private readonly operationWriter: CatalogV2OperationWriter,
		private readonly refresh: (memo: ResolvedMemo) => Promise<ResolvedMemo>,
		private readonly createId: CatalogV2IdentityIdFactory | null = null,
		private readonly now: () => string = () => new Date().toISOString(),
		private readonly isReadinessCurrent: (
			permit: CatalogV2AdoptionPermit,
			stateRevision: string,
		) => boolean | Promise<boolean> = () => true,
	) {}

	async adopt(memo: ResolvedMemo, permit: CatalogV2AdoptionPermit): Promise<CatalogV2IdentityAdoptionResult> {
		return this.runExclusive(() => this.adoptFresh(memo, permit, null));
	}

	async adoptPreservingMemoId(
		memo: ResolvedMemo,
		memoId: string,
		permit: CatalogV2AdoptionPermit,
	): Promise<CatalogV2IdentityAdoptionResult> {
		return this.runExclusive(() => this.adoptFresh(memo, permit, memoId));
	}

	private async adoptFresh(
		memo: ResolvedMemo,
		permit: CatalogV2AdoptionPermit,
		preservedMemoId: string | null,
	): Promise<CatalogV2IdentityAdoptionResult> {
		const refreshed = await this.refresh(memo);
		if (refreshed.kind !== "observed" || refreshed.adoption !== "eligible"
			|| refreshed.capabilities.identity.crossDeviceIdentity !== "absent"
			|| refreshed.observation.sourcePath !== memo.observation.sourcePath
			|| refreshed.observation.sourceRevision !== memo.observation.sourceRevision
			|| refreshed.observation.startLine !== memo.observation.startLine
			|| refreshed.observation.contentHash !== memo.observation.contentHash) {
			throw new Error("Only a freshly settled, unique observation can be adopted.");
		}
		if (!await this.isReadinessCurrent(permit, refreshed.stateRevision)) {
			throw new Error("Memo identity settlement changed before adoption.");
		}
		const evidence = observationToIdentityEvidence(refreshed.observation);
		const observationDigest = await sha256Text(canonicalJson(evidence));
		if (permit.kind !== "catalog-v2-adoption-permit"
			|| permit.sourceRevision !== evidence.sourceRevision
			|| permit.observationDigest !== observationDigest
			|| !/^[a-f0-9]{64}$/u.test(permit.generationId)
			|| !/^[a-f0-9]{64}$/u.test(permit.contractDigest)
			|| !/^v_[a-f0-9]{32}$/u.test(permit.vaultInstanceId)) {
			throw new Error("Identity adoption permit does not match the current Daily revision.");
		}
		const memoId = preservedMemoId ?? this.createId?.("m") ?? `m_${(await sha256Text(canonicalJson({
			vaultInstanceId: permit.vaultInstanceId,
			contractDigest: permit.contractDigest,
			observationDigest,
		}))).slice(0, 32)}`;
		if (permit.memoId !== memoId || permit.control === undefined
			|| permit.control.actionKind !== "identity_adoption"
			|| !permit.control.actionId.startsWith("o_")) {
			throw new Error("Identity adoption permit does not authorize this memo identity.");
		}
		const operation = await this.operationWriter.queue({
			opId: this.createId?.("o") ?? createCatalogV2Id("o"),
			memoId,
			occurredAt: this.now(),
			type: "identity.claim",
			baseEvidence: null,
			payload: {
				evidence,
				origin: "manual_adoption",
				createIntentOpId: null,
				control: permit.control,
			},
		});
		const flushed = await this.operationWriter.flush();
		if (flushed.failed > 0) {
			throw new Error("Identity adoption is queued but not durable yet.");
		}
		return { memoId, operation };
	}

	private async runExclusive<T>(operation: () => Promise<T>): Promise<T> {
		const previous = this.adoptionQueue;
		let release: () => void = () => undefined;
		this.adoptionQueue = new Promise<void>((resolve) => {
			release = resolve;
		});
		await previous;
		try {
			return await operation();
		} finally {
			release();
		}
	}
}
