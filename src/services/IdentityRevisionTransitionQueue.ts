import { normalizePath } from "obsidian";

import type { IdentityLedgerReconcileResult } from "../types/identityLedger";
import type { CatalogRevisionTransition } from "./CatalogIndexCoordinator";
import type { MemoCatalogStore } from "./MemoCatalogStore";

export const IDENTITY_REVISION_TRANSITION_QUEUE_META_KEY = "identityRevisionTransitions";

interface IdentityRevisionTransitionQueueOptions {
	store: Pick<MemoCatalogStore, "getMeta" | "setMeta" | "deleteMeta">;
	getCurrentSourceRevision: (sourcePath: string) => Promise<string | null>;
}

/** 保存受影响文件的本机增量身份工作；它不是共享协议状态。 */
export class IdentityRevisionTransitionQueue {
	private readonly pendingByPath = new Map<string, CatalogRevisionTransition[]>();
	private initialized = false;

	constructor(private readonly options: IdentityRevisionTransitionQueueOptions) {}

	async enqueue(transition: CatalogRevisionTransition): Promise<void> {
		await this.initialize();
		const sourcePath = normalizePath(transition.sourcePath);
		const pending = this.pendingByPath.get(sourcePath) ?? [];
		const latest = pending[pending.length - 1];
		if (latest?.after.sourceRevision === transition.after.sourceRevision) {
			const preferred = preferTransition(latest, transition);
			if (preferred === latest) return;
			pending[pending.length - 1] = preferred;
		} else {
			pending.push(cloneTransition(transition));
		}
		this.pendingByPath.set(sourcePath, pending);
		await this.persist();
	}

	async drain(
		reconcile: (transition: CatalogRevisionTransition) => Promise<IdentityLedgerReconcileResult>,
	): Promise<void> {
		await this.initialize();
		for (const sourcePath of [...this.pendingByPath.keys()].sort()) {
			const pending = this.pendingByPath.get(sourcePath);
			if (pending === undefined || pending.length === 0) continue;
			const latest = pending[pending.length - 1];
			const currentRevision = await this.options.getCurrentSourceRevision(sourcePath);
			if (latest === undefined || currentRevision !== latest.after.sourceRevision) {
				this.pendingByPath.delete(sourcePath);
				await this.persist();
				continue;
			}
			while (pending.length > 0) {
				const transition = pending[0];
				if (transition === undefined) break;
				const result = await reconcile(cloneTransition(transition));
				if (result.deferredObservationCount > 0) return;
				pending.shift();
				if (pending.length === 0) this.pendingByPath.delete(sourcePath);
				await this.persist();
			}
		}
	}

	private async initialize(): Promise<void> {
		if (this.initialized) return;
		const stored = await this.options.store.getMeta<CatalogRevisionTransition[]>(
			IDENTITY_REVISION_TRANSITION_QUEUE_META_KEY,
		);
		if (Array.isArray(stored)) {
			for (const transition of stored) {
				const sourcePath = normalizePath(transition.sourcePath);
				const pending = this.pendingByPath.get(sourcePath) ?? [];
				pending.push(cloneTransition(transition));
				this.pendingByPath.set(sourcePath, pending);
			}
		}
		this.initialized = true;
	}

	private async persist(): Promise<void> {
		const transitions = [...this.pendingByPath.entries()]
			.sort(([left], [right]) => left.localeCompare(right))
			.flatMap(([, pending]) => pending.map(cloneTransition));
		if (transitions.length === 0) {
			await this.options.store.deleteMeta(IDENTITY_REVISION_TRANSITION_QUEUE_META_KEY);
			return;
		}
		await this.options.store.setMeta(IDENTITY_REVISION_TRANSITION_QUEUE_META_KEY, transitions);
	}
}

function preferTransition(
	current: CatalogRevisionTransition,
	incoming: CatalogRevisionTransition,
): CatalogRevisionTransition {
	if (current.insertedObservation === null && incoming.insertedObservation !== null) {
		return cloneTransition(incoming);
	}
	if (current.insertedObservation !== null) return current;
	if (!current.allowIdentityAdoption && incoming.allowIdentityAdoption) {
		return cloneTransition(incoming);
	}
	return current;
}

function cloneTransition(transition: CatalogRevisionTransition): CatalogRevisionTransition {
	return {
		sourcePath: transition.sourcePath,
		before: transition.before === null ? null : {
			sourceRevision: transition.before.sourceRevision,
			observations: transition.before.observations.map(cloneObservation),
		},
		after: {
			sourceRevision: transition.after.sourceRevision,
			observations: transition.after.observations.map(cloneObservation),
		},
		insertedObservation: transition.insertedObservation === null
			? null
			: cloneObservation(transition.insertedObservation),
		allowIdentityAdoption: transition.allowIdentityAdoption,
	};
}

function cloneObservation<T extends CatalogRevisionTransition["after"]["observations"][number]>(observation: T): T {
	return structuredClone(observation);
}
