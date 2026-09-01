import assert from "node:assert/strict";
import test from "node:test";

import type { MemoObservation } from "../src/types/catalog";
import type { IdentityLedgerReconcileResult } from "../src/types/identityLedger";
import type { CatalogRevisionTransition } from "../src/services/CatalogIndexCoordinator";
import {
	IDENTITY_REVISION_TRANSITION_QUEUE_META_KEY,
	IdentityRevisionTransitionQueue,
} from "../src/services/IdentityRevisionTransitionQueue";
import { InMemoryMemoCatalogStore } from "../src/services/MemoCatalogStore";

test("deferred transition 持久保留，重启后的恢复成功才出队", async () => {
	const store = new InMemoryMemoCatalogStore();
	await store.open();
	const transition = makeTransition(true);
	const first = new IdentityRevisionTransitionQueue({
		store,
		getCurrentSourceRevision: async () => transition.after.sourceRevision,
	});
	await first.enqueue(transition);

	await first.drain(async () => reconcileResult(1));
	assert.notEqual(await store.getMeta(IDENTITY_REVISION_TRANSITION_QUEUE_META_KEY), null);

	let replayCount = 0;
	const restarted = new IdentityRevisionTransitionQueue({
		store,
		getCurrentSourceRevision: async () => transition.after.sourceRevision,
	});
	await restarted.drain(async (replayed) => {
		replayCount += 1;
		assert.equal(replayed.allowIdentityAdoption, true);
		return reconcileResult(0);
	});

	assert.equal(replayCount, 1);
	assert.equal(await store.getMeta(IDENTITY_REVISION_TRANSITION_QUEUE_META_KEY), null);
});

test("当前 Catalog revision 已越过或删除时丢弃陈旧 transition，不采用旧 observation", async () => {
	const store = new InMemoryMemoCatalogStore();
	await store.open();
	const transition = makeTransition(true);
	const queue = new IdentityRevisionTransitionQueue({
		store,
		getCurrentSourceRevision: async () => null,
	});
	await queue.enqueue(transition);
	let reconcileCount = 0;

	await queue.drain(async () => {
		reconcileCount += 1;
		return reconcileResult(0);
	});

	assert.equal(reconcileCount, 0);
	assert.equal(await store.getMeta(IDENTITY_REVISION_TRANSITION_QUEUE_META_KEY), null);
});

test("同一 revision 的 Knomo 已知插入优先于 editor marker，避免重复 adoption", async () => {
	const store = new InMemoryMemoCatalogStore();
	await store.open();
	const local = makeTransition(true);
	const inserted = {
		...makeTransition(false),
		insertedObservation: makeTransition(false).after.observations[1] ?? null,
	};
	const queue = new IdentityRevisionTransitionQueue({
		store,
		getCurrentSourceRevision: async () => local.after.sourceRevision,
	});
	await queue.enqueue(local);
	await queue.enqueue(inserted);
	let reconciled: CatalogRevisionTransition | null = null;

	await queue.drain(async (transition) => {
		reconciled = transition;
		return reconcileResult(0);
	});

	assert.notEqual(reconciled, null);
	assert.notEqual((reconciled as CatalogRevisionTransition | null)?.insertedObservation, null);
	assert.equal((reconciled as CatalogRevisionTransition | null)?.allowIdentityAdoption, false);
});

function reconcileResult(deferredObservationCount: number): IdentityLedgerReconcileResult {
	return { appendedEventCount: 0, conflictedMemoIds: [], deferredObservationCount };
}

function makeTransition(allowIdentityAdoption: boolean): CatalogRevisionTransition {
	const before = makeObservation("a".repeat(64), 1, "已有正文");
	const existing = makeObservation("b".repeat(64), 1, "已有正文");
	const added = makeObservation("b".repeat(64), 2, "本机新增");
	return {
		sourcePath: before.sourcePath,
		before: { sourceRevision: before.sourceRevision, observations: [before] },
		after: { sourceRevision: existing.sourceRevision, observations: [existing, added] },
		insertedObservation: null,
		allowIdentityAdoption,
	};
}

function makeObservation(sourceRevision: string, startLine: number, content: string): MemoObservation {
	return {
		sourcePath: "Daily/2026-08-22.md",
		sourceRevision,
		rawBlockHash: `raw-${startLine}`,
		logicalDate: "2026-08-22",
		section: "Memos",
		startLine,
		endLine: startLine,
		time: "09:00",
		content,
		contentHash: `content-${startLine}`,
		existingBlockId: null,
		tags: [],
		links: [],
		images: [],
		tasks: [],
		timeBuoyDates: [],
	};
}
