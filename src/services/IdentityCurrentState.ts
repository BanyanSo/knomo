import type { IdentityLedgerEvent, IdentityLedgerEventEnvelope, IdentityLedgerSnapshot } from "../types/identityLedger";
import { assertIdentityLedgerEvent, canonicalIdentityLedgerJson, sha256IdentityLedgerText } from "./IdentityLedgerProtocol";
import { isRecord } from "../utils/object";

export interface IdentityCurrentState {
	bindings: IdentityLedgerEvent[];
	reviews: Record<string, { count: number; last: string | null; createdAt: string | null }>;
}

/** 保存当前绑定、当前关系及唯一有效删除副本；事件形状只用于复用身份求值器，不保存操作日志。 */
export function compactIdentityState(snapshot: IdentityLedgerSnapshot, envelopes: readonly IdentityLedgerEventEnvelope[]): IdentityCurrentState {
	const byId = new Map(envelopes.map(({ event }) => [event.eventId, event]));
	const bindings: IdentityLedgerEvent[] = [...snapshot.pendingIntents];
	const reviews: IdentityCurrentState["reviews"] = {};
	for (const memo of Object.values(snapshot.memos)) {
		const deletes = [...(memo.pendingDeletes ?? []), ...(memo.activeDeletes ?? [])]
			.sort((a, b) => b.evidence.deletedAt.localeCompare(a.evidence.deletedAt) || b.deleteEventId.localeCompare(a.deleteEventId));
		const deleted = deletes[0];
		if (memo.bindings.length === 0 && deleted === undefined) continue;
		reviews[memo.memoId] = { count: memo.reviewCount, last: memo.lastReviewedAt, createdAt: memo.createdAt };
		const ids = new Set(memo.bindings.map((binding) => binding.bindingId));
		if (deleted !== undefined) ids.add(deleted.baseBindingId);
		if (memo.conflictBaseBindingId !== null) ids.add(memo.conflictBaseBindingId);
		for (const id of ids) {
			const event = byId.get(id);
			if (event === undefined || !("observation" in event.evidence)) throw new Error("Current Identity binding evidence is missing.");
			if (memo.conflictBaseBindingId !== null && id !== memo.conflictBaseBindingId) {
				bindings.push({ ...event, type: "rebind", baseBindingId: memo.conflictBaseBindingId,
					evidence: { observation: event.evidence.observation, reason: "manual_resolution" } });
			} else {
				bindings.push({ ...event, type: "claim", baseBindingId: null,
					evidence: { observation: event.evidence.observation,
						createIntentEventId: event.type === "claim" ? event.evidence.createIntentEventId : null } });
			}
		}
		for (const sourceMemoId of memo.sourceMemoIds) {
			const relation = envelopes.find(({ event }) => event.memoId === memo.memoId && event.type === "relation" && event.evidence.sourceMemoId === sourceMemoId);
			if (relation !== undefined) bindings.push(relation.event);
		}
		if (deleted !== undefined) {
			const payload = byId.get(deleted.deleteEventId);
			const commit = deleted.deleteCommitEventId === null ? undefined : byId.get(deleted.deleteCommitEventId);
			if (payload === undefined) throw new Error("Current deleted memo payload is missing.");
			bindings.push(payload);
			if (commit !== undefined) bindings.push(commit);
		}
	}
	return { bindings: bindings.sort((a, b) => a.eventId.localeCompare(b.eventId)), reviews };
}

export function assertIdentityCurrentState(value: unknown): asserts value is IdentityCurrentState {
	if (!isRecord(value) || !Array.isArray(value.bindings) || !isRecord(value.reviews)) throw new Error("Invalid current Identity state.");
	for (const event of value.bindings) assertIdentityLedgerEvent(event);
	for (const review of Object.values(value.reviews)) {
		if (!isRecord(review) || !Number.isSafeInteger(review.count) || Number(review.count) < 0
			|| (review.last !== null && typeof review.last !== "string")
			|| (review.createdAt !== null && typeof review.createdAt !== "string")) throw new Error("Invalid current review state.");
	}
}

export async function currentIdentityEnvelopes(events: readonly IdentityLedgerEvent[], sourcePath: string): Promise<IdentityLedgerEventEnvelope[]> {
	return Promise.all(events.map(async (event) => ({ event, sourcePath, digest: await sha256IdentityLedgerText(canonicalIdentityLedgerJson(event)) })));
}

/** 版本只表示当前可观察状态，不随着清除已完成操作而改变。 */
export async function normalizeCurrentIdentitySnapshot(snapshot: IdentityLedgerSnapshot, reviews: IdentityCurrentState["reviews"]): Promise<IdentityLedgerSnapshot> {
	for (const [memoId, memo] of Object.entries(snapshot.memos)) {
		const base = reviews[memoId];
		if (base !== undefined) {
			memo.reviewCount += base.count;
			memo.lastReviewedAt = [memo.lastReviewedAt, base.last].filter((value): value is string => value !== null).sort().pop() ?? null;
			memo.createdAt = base.createdAt;
		}
		const latest = [...(memo.pendingDeletes ?? []), ...(memo.activeDeletes ?? [])]
			.sort((a, b) => b.evidence.deletedAt.localeCompare(a.evidence.deletedAt) || b.deleteEventId.localeCompare(a.deleteEventId))[0];
		memo.pendingDeletes = latest?.deleteCommitEventId === null ? [latest] : [];
		memo.activeDeletes = latest !== undefined && latest.deleteCommitEventId !== null ? [latest] : [];
		memo.purgedDeleteEventIds = [];
		if (memo.bindings.length === 0 && latest === undefined) delete snapshot.memos[memoId];
		for (const binding of memo.bindings) binding.identityRevision = "";
	}
	snapshot.revision = await sha256IdentityLedgerText(canonicalIdentityLedgerJson({ memos: snapshot.memos, pendingIntents: snapshot.pendingIntents, quarantinedEventIds: snapshot.quarantinedEventIds }));
	for (const memo of Object.values(snapshot.memos)) for (const binding of memo.bindings) binding.identityRevision = snapshot.revision;
	return snapshot;
}
