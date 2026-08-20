import test from "node:test";
import assert from "node:assert/strict";

import { CatalogV2StateReducer } from "../src/services/CatalogV2StateReducer";
import { canonicalJson, sha256Text } from "../src/services/CatalogV2Protocol";
import type { StateOperation, StateOperationEnvelope } from "../src/types/catalogV2";

const BASE_BINDING_ID = "o_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

test("state reducer is permutation-stable for review and source relations", async () => {
	const operations = [
		makeOperation(1, "review.record", { reviewedAt: "2026-08-01T00:00:00.000Z" }),
		makeOperation(2, "review.record", { reviewedAt: "2026-08-03T00:00:00.000Z" }),
		makeOperation(3, "relation.set_source", { sourceMemoId: "source-a", supersedesRelationIds: [] }),
	];
	const envelopes = await Promise.all(operations.map(toEnvelope));
	const reducer = new CatalogV2StateReducer();
	const forward = await reducer.reduce(envelopes);
	const reverse = await reducer.reduce([...envelopes].reverse());
	assert.deepEqual(forward, reverse);
	assert.equal(forward.memos["legacy-memo-1"]?.reviewCount, 2);
	assert.equal(forward.memos["legacy-memo-1"]?.lastReviewedAt, "2026-08-03T00:00:00.000Z");
	assert.deepEqual(forward.memos["legacy-memo-1"]?.sourceMemoIds, ["source-a"]);
});

test("阶段 6 两端在线、离线重放与 100 组到达乱序收敛到同一状态", async () => {
	const operations = [
		makeOperation(1, "review.record", { reviewedAt: "2026-08-01T00:00:00.000Z" }),
		makeOperation(2, "relation.set_source", { sourceMemoId: "source-a", supersedesRelationIds: [] }),
		makeOperation(3, "review.record", { reviewedAt: "2026-08-02T00:00:00.000Z" }),
		makeOperation(4, "relation.set_source", { sourceMemoId: "source-b", supersedesRelationIds: ["o_00000000000000000000000000000002"] }),
		makeOperation(5, "review.record", { reviewedAt: "2026-08-03T00:00:00.000Z" }),
	];
	const envelopes = await Promise.all(operations.map(toEnvelope));
	const reducer = new CatalogV2StateReducer();
	const expected = await reducer.reduce(envelopes);
	for (let seed = 1; seed <= 100; seed += 1) {
		const online = deterministicShuffle(envelopes, seed);
		const deviceA = online.filter((_item, index) => index % 2 === 0);
		const deviceB = online.filter((_item, index) => index % 2 !== 0);
		const replayed = deterministicShuffle([...deviceA, ...deviceB, ...deviceA], seed * 17);
		assert.deepEqual(await reducer.reduce(replayed), expected, `seed ${seed}`);
	}
});

test("same opId with different content and writer forks are quarantined", async () => {
	const first = makeOperation(1, "review.record", { reviewedAt: "2026-08-01T00:00:00.000Z" });
	const opCollision = { ...first, payload: { reviewedAt: "2026-08-02T00:00:00.000Z" } } as StateOperation;
	const sequenceFork = { ...makeOperation(1, "review.record", { reviewedAt: "2026-08-03T00:00:00.000Z" }), opId: "o_ffffffffffffffffffffffffffffffff" };
	const reduced = await new CatalogV2StateReducer().reduce(await Promise.all([first, opCollision, sequenceFork].map(toEnvelope)));
	assert.equal(reduced.quarantine.some((item) => item.code === "op_id_collision"), true);
	assert.equal(reduced.quarantine.some((item) => item.code === "writer_sequence_fork"), true);
	assert.deepEqual(reduced.forkedWriterIds, [first.writerId]);
});

test("sequence gaps mark only the affected writer awaiting data", async () => {
	const reduced = await new CatalogV2StateReducer().reduce(await Promise.all([
		makeOperation(1, "review.record", { reviewedAt: "2026-08-01T00:00:00.000Z" }),
		makeOperation(3, "review.record", { reviewedAt: "2026-08-03T00:00:00.000Z" }),
	].map(toEnvelope)));
	assert.deepEqual(reduced.awaitingWriterIds, ["w_00000000000000000000000000000001"]);
});

test("redirect cycles are quarantined without choosing a winner", async () => {
	const operations: StateOperation[] = [
		{
			schemaVersion: 1,
			writerId: "w_00000000000000000000000000000001",
			sequence: 1,
			opId: "o_00000000000000000000000000000001",
			memoId: "memo-a",
			occurredAt: "2026-08-09T00:00:00.000Z",
			type: "identity.redirect",
			baseEvidence: null,
			payload: { toMemoId: "memo-b", reason: "manual_resolution" },
		},
		{
			schemaVersion: 1,
			writerId: "w_00000000000000000000000000000001",
			sequence: 2,
			opId: "o_00000000000000000000000000000002",
			memoId: "memo-b",
			occurredAt: "2026-08-09T00:00:00.000Z",
			type: "identity.redirect",
			baseEvidence: null,
			payload: { toMemoId: "memo-a", reason: "manual_resolution" },
		},
	];
	const reduced = await new CatalogV2StateReducer().reduce(await Promise.all(operations.map(toEnvelope)));
	assert.equal(reduced.quarantine.some((item) => item.code === "redirect_conflict" && item.key.startsWith("cycle:")), true);
});

test("delete/edit and divergent restore races remain explicit lifecycle conflicts", async () => {
	const baseEvidence = makeEvidence("a", 1);
	const firstRestore = makeEvidence("b", 2);
	const secondRestore = makeEvidence("c", 3);
	const operations: StateOperation[] = [
		{
			schemaVersion: 1,
			writerId: "w_00000000000000000000000000000001",
			sequence: 1,
			opId: "o_00000000000000000000000000000001",
			memoId: "memo-life",
			occurredAt: "2026-08-09T00:00:00.000Z",
			type: "lifecycle.delete",
			baseEvidence,
			payload: {
				baseBindingId: BASE_BINDING_ID,
				deleteOpId: "o_00000000000000000000000000000001",
				deletedPayload: { path: "state/deleted/memo-life/delete.json", sha256: "d".repeat(64), byteLength: 1 },
			},
		},
		{
			schemaVersion: 1,
			writerId: "w_00000000000000000000000000000001",
			sequence: 2,
			opId: "o_00000000000000000000000000000002",
			memoId: "memo-life",
			occurredAt: "2026-08-09T00:00:00.000Z",
			type: "identity.rebind",
			baseEvidence,
			payload: { baseBindingId: BASE_BINDING_ID, evidence: firstRestore, reason: "edit" },
		},
		...([firstRestore, secondRestore].map((evidence, index): StateOperation => ({
			schemaVersion: 1,
			writerId: "w_00000000000000000000000000000001",
			sequence: index + 3,
			opId: `o_${(index + 3).toString(16).padStart(32, "0")}`,
			memoId: "memo-life",
			occurredAt: "2026-08-09T00:00:00.000Z",
			type: "lifecycle.restore",
			baseEvidence: null,
			payload: { baseBindingId: BASE_BINDING_ID, deleteOpId: "o_00000000000000000000000000000001", evidence },
		}))),
	];
	const reduced = await new CatalogV2StateReducer().reduce(await Promise.all(operations.map(toEnvelope)));

	assert.equal(reduced.quarantine.some((item) => item.code === "lifecycle_conflict"), true);
	assert.equal(reduced.quarantine.some((item) => item.code === "restore_conflict"), true);
	assert.deepEqual(reduced.memos["memo-life"]?.identityBindings.map((item) => item.entryId), [
		"o_00000000000000000000000000000002",
		"o_00000000000000000000000000000003",
		"o_00000000000000000000000000000004",
	]);
});

test("restore waits for its referenced delete instead of binding an unknown payload version", async () => {
	const restore: StateOperation = {
		schemaVersion: 1,
		writerId: "w_00000000000000000000000000000001",
		sequence: 1,
		opId: "o_00000000000000000000000000000001",
		memoId: "memo-waiting-restore",
		occurredAt: "2026-08-09T00:00:00.000Z",
		type: "lifecycle.restore",
		baseEvidence: null,
		payload: {
			baseBindingId: null,
			deleteOpId: "o_99999999999999999999999999999999",
			evidence: makeEvidence("e", 4),
		},
	};
	const reduced = await new CatalogV2StateReducer().reduce([await toEnvelope(restore)]);

	assert.equal(reduced.quarantine.some((item) => item.code === "restore_missing_delete"), true);
	assert.deepEqual(reduced.memos[restore.memoId]?.restoredDeleteOperationIds, []);
	assert.deepEqual(reduced.memos[restore.memoId]?.identityBindings, []);
});

test("restore creates one successor binding without a duplicate rebind", async () => {
	const baseEvidence = makeEvidence("a", 1);
	const restoredEvidence = makeEvidence("b", 2);
	const operations: StateOperation[] = [
		{
			schemaVersion: 1,
			writerId: "w_00000000000000000000000000000001",
			sequence: 1,
			opId: "o_00000000000000000000000000000001",
			memoId: "memo-restored",
			occurredAt: "2026-08-09T00:00:00.000Z",
			type: "identity.claim",
			baseEvidence: null,
			payload: { evidence: baseEvidence, origin: "manual_adoption", createIntentOpId: null },
		},
		{
			schemaVersion: 1,
			writerId: "w_00000000000000000000000000000001",
			sequence: 2,
			opId: "o_00000000000000000000000000000002",
			memoId: "memo-restored",
			occurredAt: "2026-08-09T00:00:00.000Z",
			type: "lifecycle.delete",
			baseEvidence,
			payload: {
				baseBindingId: "o_00000000000000000000000000000001",
				deleteOpId: "o_00000000000000000000000000000002",
				deletedPayload: { path: "state/deleted/memo-restored/delete.json", sha256: "d".repeat(64), byteLength: 1 },
			},
		},
		{
			schemaVersion: 1,
			writerId: "w_00000000000000000000000000000001",
			sequence: 3,
			opId: "o_00000000000000000000000000000003",
			memoId: "memo-restored",
			occurredAt: "2026-08-09T00:00:00.000Z",
			type: "lifecycle.restore",
			baseEvidence: null,
			payload: {
				baseBindingId: "o_00000000000000000000000000000001",
				deleteOpId: "o_00000000000000000000000000000002",
				evidence: restoredEvidence,
			},
		},
	];
	const reduced = await new CatalogV2StateReducer().reduce(await Promise.all(operations.map(toEnvelope)));

	assert.equal(reduced.quarantine.some((item) => item.code === "lifecycle_conflict"), false);
	assert.deepEqual(reduced.memos["memo-restored"]?.restoredDeleteOperationIds, [operations[1]?.opId]);
	assert.deepEqual(reduced.memos["memo-restored"]?.activeBindingHeads.map((binding) => binding.entryId), [operations[2]?.opId]);
});

async function toEnvelope(operation: StateOperation): Promise<StateOperationEnvelope> {
	return {
		operation,
		digest: await sha256Text(canonicalJson(operation)),
		sourcePath: `state/devices/${operation.writerId}/segment-000001.jsonl`,
	};
}

function makeOperation(
	sequence: number,
	type: "review.record" | "relation.set_source",
	payload: { reviewedAt: string } | { sourceMemoId: string | null; supersedesRelationIds: string[] },
): StateOperation {
	const base = {
		schemaVersion: 1 as const,
		writerId: "w_00000000000000000000000000000001",
		sequence,
		opId: `o_${sequence.toString(16).padStart(32, "0")}`,
		memoId: "legacy-memo-1",
		occurredAt: "2026-08-09T00:00:00.000Z",
		baseEvidence: null,
	};
	return type === "review.record"
		? { ...base, type, payload: payload as { reviewedAt: string } }
		: { ...base, type, payload: payload as { sourceMemoId: string | null; supersedesRelationIds: string[] } };
}

function makeEvidence(revisionChar: string, startLine: number) {
	return {
		sourcePath: "Daily/2026-08-09.md",
		sourceRevision: revisionChar.repeat(64),
		logicalDate: "2026-08-09",
		section: "## Memos",
		startLine,
		endLine: startLine,
		time: "09:00",
		contentHash: "fnv1a-12345678",
		existingBlockId: null,
	};
}

function deterministicShuffle<T>(values: readonly T[], seed: number): T[] {
	const result = [...values];
	let state = seed >>> 0;
	for (let index = result.length - 1; index > 0; index -= 1) {
		state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
		const target = state % (index + 1);
		[result[index], result[target]] = [result[target] as T, result[index] as T];
	}
	return result;
}
