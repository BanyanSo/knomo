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

test("纯扫描位置变化不持久排队，也不调用身份协调", async () => {
	const store = new InMemoryMemoCatalogStore();
	await store.open();
	const initial = makeTransition(false);
	const shifted = positionTransition(initial);
	const queue = new IdentityRevisionTransitionQueue({ store, getCurrentSourceRevision: async () => shifted.after.sourceRevision });
	await queue.enqueue(shifted);
	assert.equal(await store.getMeta(IDENTITY_REVISION_TRANSITION_QUEUE_META_KEY), null);
	await queue.drain(async () => { throw new Error("position refresh must not reconcile identity"); });
});

test("未完成插入遇到位置刷新只推进目标扫描，重启保留插入证据", async () => {
	const store = new InMemoryMemoCatalogStore();
	await store.open();
	const initial = makeTransition(false);
	initial.insertedObservation = initial.after.observations[1]!;
	const shifted = positionTransition(initial);
	const queue = new IdentityRevisionTransitionQueue({ store, getCurrentSourceRevision: async () => shifted.after.sourceRevision });
	await queue.enqueue(initial);
	await queue.enqueue(shifted);
	const stored = await store.getMeta<CatalogRevisionTransition[]>(IDENTITY_REVISION_TRANSITION_QUEUE_META_KEY);
	assert.equal(stored?.length, 1);
	const restarted = new IdentityRevisionTransitionQueue({ store, getCurrentSourceRevision: async () => shifted.after.sourceRevision });
	await restarted.drain(async (transition, isCurrent) => {
		assert.equal(await isCurrent(), true);
		assert.equal(transition.before?.sourceRevision, initial.before?.sourceRevision);
		assert.equal(transition.after.sourceRevision, shifted.after.sourceRevision);
		assert.deepEqual(transition.insertedObservation, shifted.after.observations[1]);
		return reconcileResult(0);
	});
	assert.equal(await store.getMeta(IDENTITY_REVISION_TRANSITION_QUEUE_META_KEY), null);
});

test("协调等待期间扫描推进后，写入守卫拒绝旧目标", async () => {
	const store = new InMemoryMemoCatalogStore();
	await store.open();
	const transition = makeTransition(true);
	let revision = transition.after.sourceRevision;
	const queue = new IdentityRevisionTransitionQueue({ store, getCurrentSourceRevision: async () => revision });
	await queue.enqueue(transition);
	await queue.drain(async (_transition, isCurrent) => {
		assert.equal(await isCurrent(), true);
		revision = "c".repeat(64);
		assert.equal(await isCurrent(), false);
		return reconcileResult(1);
	});
});

function positionTransition(initial: CatalogRevisionTransition): CatalogRevisionTransition {
	return {
		...initial, before: initial.after, insertedObservation: null,
		after: { sourceRevision: "c".repeat(64), observations: initial.after.observations.map((observation) => ({
			...observation, sourceRevision: "c".repeat(64), startLine: observation.startLine + 4, endLine: observation.endLine + 4,
		})) },
	};
}

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
		occurrenceIndex: 0,
		occurrenceCount: 1,
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
