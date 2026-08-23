import assert from "node:assert/strict";
import test from "node:test";

import {
	CatalogV2IdentityResolver,
	createResolvedMemoHandle,
} from "../src/services/CatalogV2IdentityResolver";
import type { CatalogFileRevisionBatch, MemoObservation } from "../src/types/catalog";
import type {
	CatalogV2MaterializedMemo,
	CatalogV2MaterializedState,
	IdentityEvidence,
} from "../src/types/catalogV2";

test("resolver performs a file-wide one-to-one assignment", () => {
	const first = makeObservation(2, "same");
	const second = makeObservation(5, "same");
	const state = makeState([
		makeMemo("memo-a", toEvidence(first)),
		makeMemo("memo-b", toEvidence(first)),
	]);

	const resolved = new CatalogV2IdentityResolver().resolveFile({
		batch: makeBatch([first, second]),
		state,
		stateRevision: "state-1",
		localIntents: [],
		settlement: completeSettlement(),
	});

	assert.deepEqual(resolved.map((item) => item.kind), ["ambiguous", "ambiguous"]);
	assert.equal(createResolvedMemoHandle(resolved[0]), null);
	assert.equal(createResolvedMemoHandle(resolved[1]), null);
});

test("resolver refuses a truncated file revision batch", () => {
	const first = makeObservation(2, "same");
	const second = makeObservation(5, "same");
	const complete = makeBatch([first, second]);
	assert.throws(() => new CatalogV2IdentityResolver().resolveFile({
		batch: { ...complete, observations: [first] },
		state: makeState([]),
		stateRevision: "state-truncated",
		localIntents: [],
		settlement: completeSettlement(),
	}), /requires every observation/u);
});

test("local create intent is only a non-writable candidate until its claim is durable", () => {
	const observation = makeObservation(2, "created");
	const state = makeState([
		makeMemo("late-legacy", {
			...toEvidence(observation),
			sourceRevision: "a".repeat(64),
		}),
	]);

	const [resolved] = new CatalogV2IdentityResolver().resolveFile({
		batch: makeBatch([observation]),
		state,
		stateRevision: "state-2",
		localIntents: [{
			memoId: "m_11111111111111111111111111111111",
			createIntentOpId: "o_11111111111111111111111111111111",
			targetPath: observation.sourcePath,
			logicalDate: observation.logicalDate,
			time: observation.time,
			contentHash: observation.contentHash,
		}],
		settlement: completeSettlement(),
	});

	assert.equal(resolved?.kind, "ambiguous");
	assert.equal(resolved?.kind === "ambiguous" ? resolved.candidates[0]?.memoId : null, "m_11111111111111111111111111111111");
	assert.equal(createResolvedMemoHandle(resolved ?? null), null, "identity is not writable until its claim is durable");
});

test("a same-content cross-file move remains unresolved until a durable rebind is committed", () => {
	const oldObservation = makeObservation(2, "moved", "Daily/2026-08-08.md");
	const movedObservation = makeObservation(8, "moved", "Journal/2026-08-08.md");
	const state = makeState([makeMemo("legacy-memo", toEvidence(oldObservation))]);

	const [resolved] = new CatalogV2IdentityResolver().resolveFile({
		batch: makeBatch([movedObservation]),
		state,
		stateRevision: "state-3",
		localIntents: [],
		settlement: completeSettlement(),
	});

	assert.equal(resolved?.kind, "observed");
	assert.equal(createResolvedMemoHandle(resolved ?? null), null);
});

test("the same tuple in another file cannot reuse a memo identity", () => {
	const original = makeObservation(2, "same-tuple", "Daily/2026-08-08.md");
	const duplicate = makeObservation(2, "same-tuple", "Archive/2026-08-08.md");
	const state = makeState([makeMemo("memo-original", toEvidence(original))]);

	const [resolved] = new CatalogV2IdentityResolver().resolveFile({
		batch: makeBatch([duplicate]),
		state,
		stateRevision: "state-cross-file-tuple",
		localIntents: [],
		settlement: completeSettlement(),
	});

	assert.equal(resolved?.kind, "observed");
	assert.equal(createResolvedMemoHandle(resolved ?? null), null);
});

test("the same Obsidian block ID in another file cannot reuse a memo identity", () => {
	const original = { ...makeObservation(2, "original", "Daily/2026-08-08.md"), existingBlockId: "same-block" };
	const duplicate = { ...makeObservation(2, "different", "Archive/2026-08-08.md"), existingBlockId: "same-block" };
	const state = makeState([makeMemo("memo-original", toEvidence(original))]);

	const [resolved] = new CatalogV2IdentityResolver().resolveFile({
		batch: makeBatch([duplicate]),
		state,
		stateRevision: "state-cross-file-block",
		localIntents: [],
		settlement: completeSettlement(),
	});

	assert.equal(resolved?.kind, "observed");
	assert.equal(createResolvedMemoHandle(resolved ?? null), null);
});

test("resolver performs one-to-one assignment across the complete Vault", () => {
	const first = makeObservation(2, "shared", "Daily/2026-08-08.md");
	const second = makeObservation(2, "shared", "Daily/2026-08-09.md");
	const state = makeState([makeMemo("memo-only-first", toEvidence(first))]);
	const resolved = new CatalogV2IdentityResolver().resolveVault({
		batches: [makeBatch([first]), makeBatch([second])],
		state,
		stateRevision: "state-vault",
		localIntents: [],
		settlement: completeSettlement(),
	});

	assert.equal(resolved.get(`${first.sourcePath}\0${first.startLine.toString().padStart(10, "0")}`)?.kind, "identified");
	assert.equal(resolved.get(`${second.sourcePath}\0${second.startLine.toString().padStart(10, "0")}`)?.kind, "observed");
});

test("state R2 with Daily R1 is waiting for sync and never becomes writable", () => {
	const r1 = makeObservation(2, "before");
	const r2 = { ...makeObservation(2, "after"), sourceRevision: "2".repeat(64) };
	const state = makeState([makeMemo("memo-sync", toEvidence(r2))]);
	state.fileRevisionTransitions = [{
		sourcePath: r1.sourcePath,
		logicalDate: r1.logicalDate,
		headings: ["# Memos"],
		beforeRevision: r1.sourceRevision,
		afterRevision: r2.sourceRevision,
		beforeEvidence: toEvidence(r1),
		afterEvidence: toEvidence(r2),
		baseBindingId: "identity:memo-sync",
		baseEvidence: toEvidence(r1),
		preservedEvidence: [],
	}];
	const [resolved] = new CatalogV2IdentityResolver().resolveFile({
		batch: makeBatch([r1]),
		state,
		stateRevision: "state-r2-daily-r1",
		localIntents: [],
		settlement: completeSettlement(),
	});

	assert.equal(resolved?.kind, "ambiguous");
	assert.equal(resolved?.kind === "ambiguous" ? resolved.reason : null, "known_predecessor");
	assert.equal(resolved?.capabilities.markdown.edit, true);
	assert.equal(resolved?.capabilities.identity.crossDeviceIdentity, "syncing");
	assert.equal(createResolvedMemoHandle(resolved ?? null), null);
});

test("state R2 rebind evidence with Daily R1 never grants a reverse writable handle", () => {
	const r1 = makeObservation(2, "before");
	const r2 = { ...makeObservation(2, "after"), sourceRevision: "2".repeat(64) };
	const memo = makeMemo("memo-sync-rebind", toEvidence(r1));
	const rebound = {
		entryId: "identity:memo-sync-rebind:r2",
		source: "state" as const,
		evidence: toEvidence(r2),
		baseBindingId: memo.activeBindingHeads[0]?.entryId ?? null,
		baseEvidence: toEvidence(r1),
	};
	memo.identityOperationIds.push(rebound.entryId);
	memo.identityBindings.push(rebound);
	memo.activeBindingHeads = [rebound];
	const [resolved] = new CatalogV2IdentityResolver().resolveFile({
		batch: makeBatch([r1]),
		state: makeState([memo]),
		stateRevision: "state-r2-rebind-daily-r1",
		localIntents: [],
		settlement: completeSettlement(),
	});

	assert.equal(resolved?.kind, "ambiguous");
	assert.equal(resolved?.kind === "ambiguous" ? resolved.reason : null, "known_predecessor");
	assert.equal(createResolvedMemoHandle(resolved ?? null), null);
});

test("manual edits without verified lineage remain ambiguous successor candidates", () => {
	const previous = makeObservation(2, "before");
	const current = { ...makeObservation(2, "after"), sourceRevision: "b".repeat(64) };
	const state = makeState([makeMemo("memo-edit", toEvidence(previous))]);

	const [resolved] = new CatalogV2IdentityResolver().resolveFile({
		batch: makeBatch([current]),
		state,
		stateRevision: "state-4",
		localIntents: [],
		settlement: completeSettlement(),
	});

	assert.equal(resolved?.kind, "ambiguous");
	assert.equal(resolved?.kind === "ambiguous" ? resolved.reason : null, "manual_successor");
	assert.equal(resolved?.kind === "ambiguous" ? resolved.candidates[0]?.memoId : null, "memo-edit");
	assert.equal(createResolvedMemoHandle(resolved ?? null), null);
});

test("unbound observations require complete settlement before adoption", () => {
	const observation = makeObservation(2, "manual");
	const resolver = new CatalogV2IdentityResolver();
	const settling = resolver.resolveFile({
		batch: makeBatch([observation]),
		state: makeState([]),
		stateRevision: "state-5",
		localIntents: [],
		settlement: { ...completeSettlement(), stateComplete: false },
	})[0];
	const eligible = resolver.resolveFile({
		batch: makeBatch([observation]),
		state: makeState([]),
		stateRevision: "state-6",
		localIntents: [],
		settlement: completeSettlement(),
	})[0];

	assert.equal(settling?.kind, "observed");
	assert.equal(settling?.kind === "observed" ? settling.adoption : null, "settling");
	assert.equal(eligible?.kind, "observed");
	assert.equal(eligible?.kind === "observed" ? eligible.adoption : null, "eligible");
	assert.equal(createResolvedMemoHandle(eligible ?? null), null);
});

test("durable identities remain writable while legacy adoption is still settling", () => {
	const observation = makeObservation(2, "identified");
	const [identified] = new CatalogV2IdentityResolver().resolveFile({
		batch: makeBatch([observation]),
		state: makeState([makeMemo("memo-identified", toEvidence(observation))]),
		stateRevision: "state-settling-migration",
		localIntents: [],
		settlement: { ...completeSettlement(), migrationComplete: false },
	});
	const [observed] = new CatalogV2IdentityResolver().resolveFile({
		batch: makeBatch([observation]),
		state: makeState([]),
		stateRevision: "state-settling-observation",
		localIntents: [],
		settlement: { ...completeSettlement(), migrationComplete: false },
	});

	assert.equal(createResolvedMemoHandle(identified ?? null)?.memoId, "memo-identified");
	assert.equal(observed?.kind === "observed" ? observed.adoption : null, "settling");
});

test("verified file revision lineage keeps an unchanged memo writable after another block changes", () => {
	const previous = makeObservation(2, "unchanged");
	const current = { ...previous, sourceRevision: "2".repeat(64), startLine: 6, endLine: 6 };
	const state = makeState([makeMemo("memo-lineage", toEvidence(previous))]);
	state.fileRevisionTransitions = [{
		sourcePath: previous.sourcePath,
		logicalDate: previous.logicalDate,
		headings: ["# Memos"],
		beforeRevision: previous.sourceRevision,
		afterRevision: current.sourceRevision,
		beforeEvidence: null,
		afterEvidence: {
			...toEvidence(current),
			startLine: 9,
			endLine: 9,
			contentHash: "fnv1a-edited00",
		},
		baseBindingId: null,
		baseEvidence: null,
		preservedEvidence: [{ before: toEvidence(previous), after: toEvidence(current) }],
	}];

	const [resolved] = new CatalogV2IdentityResolver().resolveFile({
		batch: makeBatch([current]),
		state,
		stateRevision: "state-lineage",
		localIntents: [],
		settlement: completeSettlement(),
	});

	assert.equal(resolved?.kind, "identified");
	const handle = createResolvedMemoHandle(resolved ?? null);
	assert.equal(handle?.memoId, "memo-lineage");
	assert.equal(handle?.evidence.sourceRevision, current.sourceRevision);
	assert.equal(handle?.bindingEvidence.sourceRevision, previous.sourceRevision);
});

test("unique unchanged state tuple remains writable across a file revision without shared transition state", () => {
	const previous = makeObservation(2, "unchanged");
	const current = { ...previous, sourceRevision: "2".repeat(64), startLine: 6, endLine: 6 };
	const editedPrevious = makeObservation(4, "before-edit");
	const editedCurrent = {
		...makeObservation(9, "after-edit"),
		sourceRevision: current.sourceRevision,
		contentHash: "fnv1a-87654321",
	};
	const editedMemo = makeMemo("memo-lineage-edited-neighbor", toEvidence(editedPrevious));
	const rebound = {
		entryId: "identity:memo-lineage-edited-neighbor:r2",
		source: "state" as const,
		evidence: toEvidence(editedCurrent),
		baseBindingId: editedMemo.activeBindingHeads[0]?.entryId ?? null,
		baseEvidence: toEvidence(editedPrevious),
	};
	editedMemo.identityOperationIds.push(rebound.entryId);
	editedMemo.identityBindings.push(rebound);
	editedMemo.activeBindingHeads = [rebound];
	const state = makeState([
		makeMemo("memo-lineage-unmapped", toEvidence(previous)),
		editedMemo,
	]);

	const [resolved] = new CatalogV2IdentityResolver().resolveFile({
		batch: makeBatch([current, editedCurrent]),
		state,
		stateRevision: "state-lineage-unmapped",
		localIntents: [],
		settlement: completeSettlement(),
	});

	assert.equal(resolved?.kind, "identified");
	assert.equal(createResolvedMemoHandle(resolved ?? null)?.memoId, "memo-lineage-unmapped");
});

test("revision lineage keeps a uniquely edited memo identified after its content hash changes", () => {
	const previous = makeObservation(2, "before-edit");
	const current = {
		...makeObservation(2, "after-edit"),
		sourceRevision: "2".repeat(64),
		contentHash: "fnv1a-87654321",
	};
	const previousEvidence = toEvidence(previous);
	const currentEvidence = toEvidence(current);
	const state = makeState([makeMemo("memo-lineage-edited", previousEvidence)]);
	state.fileRevisionTransitions = [{
		sourcePath: previous.sourcePath,
		logicalDate: previous.logicalDate,
		headings: ["# Memos"],
		beforeRevision: previous.sourceRevision,
		afterRevision: current.sourceRevision,
		beforeEvidence: previousEvidence,
		afterEvidence: currentEvidence,
		baseBindingId: "identity:memo-lineage-edited",
		baseEvidence: previousEvidence,
		preservedEvidence: [],
	}];

	const [resolved] = new CatalogV2IdentityResolver().resolveFile({
		batch: makeBatch([current]),
		state,
		stateRevision: "state-lineage-edited",
		localIntents: [],
		settlement: completeSettlement(),
	});

	assert.equal(resolved?.kind, "identified");
	assert.equal(createResolvedMemoHandle(resolved ?? null)?.memoId, "memo-lineage-edited");
});

test("forked file revision lineage never grants a writable identity", () => {
	const previous = makeObservation(2, "unchanged");
	const current = { ...previous, sourceRevision: "2".repeat(64) };
	const state = makeState([makeMemo("memo-lineage-fork", toEvidence(previous))]);
	state.fileRevisionTransitions = ["2", "3"].map((revision) => ({
		sourcePath: previous.sourcePath,
		logicalDate: previous.logicalDate,
		headings: ["# Memos"],
		beforeRevision: previous.sourceRevision,
		afterRevision: revision.repeat(64),
		beforeEvidence: null,
		afterEvidence: {
			...toEvidence(current),
			sourceRevision: revision.repeat(64),
			startLine: 9,
			endLine: 9,
			contentHash: `fnv1a-${revision.repeat(8)}`,
		},
		baseBindingId: null,
		baseEvidence: null,
		preservedEvidence: [{
			before: toEvidence(previous),
			after: { ...toEvidence(current), sourceRevision: revision.repeat(64) },
		}],
	}));

	const [resolved] = new CatalogV2IdentityResolver().resolveFile({
		batch: makeBatch([current]),
		state,
		stateRevision: "state-lineage-fork",
		localIntents: [],
		settlement: completeSettlement(),
	});

	assert.equal(resolved?.kind, "ambiguous");
	assert.equal(createResolvedMemoHandle(resolved ?? null), null);
});

test("purging a delete payload does not turn a late Daily block back into a writable memo", () => {
	const observation = makeObservation(2, "late");
	const memo = makeMemo("memo-purged", toEvidence(observation));
	memo.deleteOperationIds = ["o_11111111111111111111111111111111"];
	memo.purgedDeleteOperationIds = ["o_11111111111111111111111111111111"];
	const [resolved] = new CatalogV2IdentityResolver().resolveFile({
		batch: makeBatch([observation]),
		state: makeState([memo]),
		stateRevision: "state-7",
		localIntents: [],
		settlement: completeSettlement(),
	});

	assert.equal(resolved?.kind, "ambiguous");
	assert.equal(createResolvedMemoHandle(resolved ?? null), null);
});

function makeObservation(startLine: number, content: string, sourcePath = "Daily/2026-08-08.md"): MemoObservation {
	return {
		sourcePath,
		sourceRevision: "1".repeat(64),
		rawBlockHash: `fnv1a-raw-${content}`,
		logicalDate: "2026-08-08",
		section: "# Memos",
		startLine,
		endLine: startLine,
		time: "08:00",
		content,
		contentHash: `fnv1a-${content.padEnd(8, "0").slice(0, 8)}`,
		existingBlockId: null,
		tags: [],
		links: [],
		images: [],
		tasks: [],
		timeBuoyDates: [],
	};
}

function makeBatch(observations: readonly MemoObservation[]): CatalogFileRevisionBatch<MemoObservation> {
	const first = observations[0];
	if (first === undefined) throw new Error("Test file batch requires an observation.");
	return {
		file: {
			sourcePath: first.sourcePath,
			sourceRevision: first.sourceRevision,
			logicalDate: first.logicalDate,
			mtime: 1,
			size: 1,
			parserVersion: 1,
			settingsFingerprint: "settings-v1",
			observationCount: observations.length,
			auditedAt: 1,
		},
		observations,
		catalogRevision: 1,
	};
}

function toEvidence(observation: MemoObservation): IdentityEvidence {
	return {
		sourcePath: observation.sourcePath,
		sourceRevision: observation.sourceRevision,
		logicalDate: observation.logicalDate,
		section: observation.section,
		startLine: observation.startLine,
		endLine: observation.endLine,
		time: observation.time,
		contentHash: observation.contentHash,
		existingBlockId: observation.existingBlockId,
	};
}

function makeMemo(memoId: string, evidence: IdentityEvidence): CatalogV2MaterializedMemo {
	const binding = {
		entryId: `identity:${memoId}`,
		source: "state" as const,
		evidence,
		baseBindingId: null,
	};
	return {
		memoId,
		identityOperationIds: [`identity:${memoId}`],
		activeBindingHeads: [binding],
		identityBindings: [binding],
		deleteOperationIds: [],
		deleteVersions: [],
		restoreVersions: [],
		restoredDeleteOperationIds: [],
		purgedDeleteOperationIds: [],
		relationEntries: [],
		supersededRelationIds: [],
		sourceMemoIds: [],
		reviewOperationIds: [],
		reviewCount: 0,
		lastReviewedAt: null,
		pendingCreateIds: [],
		pendingCreateIntents: [],
	};
}

function makeState(memos: CatalogV2MaterializedMemo[]): CatalogV2MaterializedState {
	return {
		schemaVersion: 1,
		memos: Object.fromEntries(memos.map((memo) => [memo.memoId, memo])),
		quarantine: [],
		awaitingWriterIds: [],
		forkedWriterIds: [],
		processedOperationCount: 0,
	};
}

function completeSettlement() {
	return {
		stateComplete: true,
		migrationComplete: true,
		revisionStable: true,
		historical: false,
	};
}
