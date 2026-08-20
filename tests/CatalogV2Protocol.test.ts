import test from "node:test";
import assert from "node:assert/strict";

import {
	buildStateSnapshot,
	assertStateOperation,
	canonicalJson,
	createCatalogV2Id,
	parseDeletedMemoPayload,
	parseStateSegment,
	planStateSegmentAppend,
	serializeStateSegment,
	serializeDeletedMemoPayload,
} from "../src/services/CatalogV2Protocol";
import type { DeletedMemoPayload, StateOperation } from "../src/types/catalogV2";

test("canonical JSON recursively sorts keys and uses stable compact bytes", () => {
	assert.equal(canonicalJson({ z: 1, a: { y: 2, b: 3 }, list: [{ d: 4, c: 5 }] }),
		'{"a":{"b":3,"y":2},"list":[{"c":5,"d":4}],"z":1}');
});

test("v2 IDs use exactly 128 bits supplied by the random source", () => {
	const bytes = Uint8Array.from({ length: 16 }, (_, index) => index);
	assert.equal(createCatalogV2Id("w", (target) => target.set(bytes)), "w_000102030405060708090a0b0c0d0e0f");
	assert.equal(createCatalogV2Id("o", (target) => target.fill(0xff)), "o_ffffffffffffffffffffffffffffffff");
});

test("state segment is canonical JSONL and detects writer/sequence violations", async () => {
	const operations = [makeOperation(1), makeOperation(2)];
	const content = serializeStateSegment(operations);
	assert.equal(content.endsWith("\n"), true);
	assert.equal(content.split("\n").length, 3);
	const parsed = await parseStateSegment("state/devices/w_00000000000000000000000000000001/segment-000001.jsonl", content);
	assert.deepEqual(parsed.operations.map((item) => item.operation.sequence), [1, 2]);
	assert.equal(parsed.operations.every((item) => item.digest.length === 64), true);

	assert.throws(() => serializeStateSegment([makeOperation(2), makeOperation(1)]), /sequence/i);
	assert.throws(() => serializeStateSegment([makeOperation(1), {
		...makeOperation(2),
		writerId: "w_00000000000000000000000000000002",
	}]), /writer/i);
});

test("segment append rotates at 384 KiB and refuses an operation above 512 KiB", () => {
	const operation = makeOperation(2);
	assert.equal(planStateSegmentAppend("x".repeat(384 * 1024), operation).action, "rotate");
	const tooLarge = {
		...operation,
		type: "identity.redirect",
		payload: { toMemoId: "x".repeat(513 * 1024), reason: "manual_resolution" },
	} as StateOperation;
	assert.throws(() => planStateSegmentAppend("", tooLarge), /512 KiB/);
});

test("snapshot bytes are deterministic for the same covered input", async () => {
	const first = await buildStateSnapshot({
		sourceWriterId: "w_00000000000000000000000000000001",
		coveredSegments: [
			{ path: "state/devices/w_00000000000000000000000000000001/segment-000002.jsonl", sha256: "b".repeat(64), byteLength: 20 },
			{ path: "state/devices/w_00000000000000000000000000000001/segment-000001.jsonl", sha256: "a".repeat(64), byteLength: 10 },
		],
		operations: [makeOperation(2), makeOperation(1)],
	});
	const second = await buildStateSnapshot({
		sourceWriterId: "w_00000000000000000000000000000001",
		coveredSegments: [...first.snapshot.coveredSegments].reverse(),
		operations: [makeOperation(1), makeOperation(2)],
	});
	assert.equal(first.digest, second.digest);
	assert.equal(new TextDecoder().decode(first.bytes), new TextDecoder().decode(second.bytes));
	assert.deepEqual(first.snapshot.operations.map((item) => item.sequence), [1, 2]);
});

test("deleted payload uses immutable canonical bytes and legacy state entry references remain valid", () => {
	const payload: DeletedMemoPayload = {
		kind: "knomo.catalog-v2.deleted-payload",
		schemaVersion: 1,
		memoId: "memo-1",
		deleteOpId: "o_11111111111111111111111111111111",
		deletedAt: "2026-08-09T00:00:00.000Z",
		sourcePath: "Daily/2026-08-09.md",
		logicalDate: "2026-08-09",
		section: "## Memos",
		rawBlock: "- 09:00 deleted",
		contentHash: "fnv1a-12345678",
		sourceMemoId: null,
	};
	const bytes = serializeDeletedMemoPayload(payload);
	assert.deepEqual(parseDeletedMemoPayload("deleted.json", bytes), payload);
	assert.throws(() => parseDeletedMemoPayload("deleted.json", `${new TextDecoder().decode(bytes)}\n`), /canonical|JSON/u);

	const relation: StateOperation = {
		...makeOperation(1),
		type: "relation.set_source",
		baseEvidence: null,
		payload: { sourceMemoId: null, supersedesRelationIds: ["l_" + "a".repeat(64)] },
	};
	assert.doesNotThrow(() => assertStateOperation(relation));
});

test("a normal delete operation cannot point at another deleteOpId", () => {
	const evidence = {
		sourcePath: "Daily/2026-08-09.md",
		sourceRevision: "a".repeat(64),
		logicalDate: "2026-08-09",
		section: null,
		startLine: 0,
		endLine: 0,
		time: "09:00",
		contentHash: "fnv1a-12345678",
		existingBlockId: null,
	};
	const operation: StateOperation = {
		...makeOperation(1),
		type: "lifecycle.delete",
		baseEvidence: evidence,
		payload: {
			baseBindingId: "o_11111111111111111111111111111111",
			deleteOpId: "o_22222222222222222222222222222222",
			deletedPayload: { path: "state/deleted/memo-1/delete.json", sha256: "a".repeat(64), byteLength: 1 },
		},
	};
	assert.throws(() => assertStateOperation(operation), /lifecycle\.delete/u);
});

function makeOperation(sequence: number): StateOperation {
	return {
		schemaVersion: 1,
		writerId: "w_00000000000000000000000000000001",
		sequence,
		opId: `o_${sequence.toString(16).padStart(32, "0")}`,
		memoId: "legacy-memo-1",
		occurredAt: "2026-08-09T00:00:00.000Z",
		type: "review.record",
		baseEvidence: null,
		payload: { reviewedAt: "2026-08-09T00:00:00.000Z" },
	};
}
