import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { CatalogV2IdentityResolver } from "../src/services/CatalogV2IdentityResolver";
import { createCatalogCapabilities, createResolvedMemoCapabilities } from "../src/services/MemoCapabilityModel";
import type {
	CatalogFileRevisionBatch,
	IdentityHandle,
	MemoObservation,
	ObservationHandle,
} from "../src/types/catalog";
import type { CatalogV2MaterializedMemo, CatalogV2MaterializedState, IdentityEvidence } from "../src/types/catalogV2";
import type { CatalogV2MemoItem } from "../src/types/catalogV2View";
import type {
	IdentityMergeInput,
	IdentityRelationInput,
	IdentityRepairInput,
	IdentityRestoreInput,
	IdentityReviewInput,
	IdentityTrashInput,
	MarkdownBlockReferenceInput,
	MarkdownCopyInput,
	MarkdownCreateInput,
	MarkdownEditInput,
	MarkdownMoveInput,
	MarkdownRemoveInput,
	MarkdownTaskInput,
} from "../src/types/memoOperations";

type AssertNever<T extends never> = T;
type MarkdownInputs = MarkdownCreateInput
	| MarkdownEditInput
	| MarkdownTaskInput
	| MarkdownCopyInput
	| MarkdownMoveInput
	| MarkdownRemoveInput
	| MarkdownBlockReferenceInput;
type IdentityInputs = IdentityRelationInput
	| IdentityReviewInput
	| IdentityTrashInput
	| IdentityRestoreInput
	| IdentityMergeInput
	| IdentityRepairInput;
type MarkdownForbiddenKeys = MarkdownInputs extends infer T
	? T extends unknown ? Extract<keyof T, "memoId" | "identity" | "identityHandle" | "observationKey"> : never
	: never;
type IdentityObservationKey = IdentityInputs extends infer T
	? T extends unknown ? Extract<keyof T, "observationKey"> : never
	: never;
type MarkdownInputsUseNoIdentity = AssertNever<MarkdownForbiddenKeys>;
type IdentityInputsUseNoObservationKey = AssertNever<IdentityObservationKey>;
type AssertTrue<T extends true> = T;
type MemoViewRequiresObservation = AssertTrue<undefined extends CatalogV2MemoItem["observation"] ? false : true>;
type MemoViewAllowsMissingIdentity = AssertTrue<null extends CatalogV2MemoItem["memoId"] ? true : false>;

void (null as MarkdownInputsUseNoIdentity
	| IdentityInputsUseNoObservationKey
	| MemoViewRequiresObservation
	| MemoViewAllowsMissingIdentity
	| null);

test("V3-GUARD-002：ObservationHandle 与 IdentityHandle 互不替代，视图允许 identity 后到", () => {
	const observation: ObservationHandle = {
		sourcePath: "Daily/2026-08-21.md",
		sourceRevision: "a".repeat(64),
		startLine: 2,
		endLine: 4,
		rawBlockHash: "fnv1a-12345678",
	};
	const identity: IdentityHandle = {
		memoId: "m_11111111111111111111111111111111",
		activeBindingId: "o_11111111111111111111111111111111",
		identityRevision: "identity-1",
	};

	assert.deepEqual(Object.keys(observation).sort(), ["endLine", "rawBlockHash", "sourcePath", "sourceRevision", "startLine"]);
	assert.deepEqual(Object.keys(identity).sort(), ["activeBindingId", "identityRevision", "memoId"]);
});

test("V3-FAIL-004/V3-FAIL-014：Markdown、Catalog 与 Identity capability 独立变化", () => {
	const absent = createResolvedMemoCapabilities("absent");
	const ready = createResolvedMemoCapabilities("ready");
	const conflicted = createResolvedMemoCapabilities("conflicted");

	assert.deepEqual(absent.markdown, ready.markdown);
	assert.deepEqual(ready.markdown, conflicted.markdown);
	assert.equal(absent.markdown.edit, true);
	assert.equal(conflicted.markdown.copy, true);
	assert.equal(conflicted.markdown.openDaily, true);
	assert.equal(absent.identity.relation, "absent");
	assert.equal(ready.identity.review, "ready");
	assert.equal(conflicted.identity.recoverableDelete, "conflicted");

	assert.equal(createCatalogCapabilities(makeCoverage("complete")).fullHistory, "complete");
	assert.equal(createCatalogCapabilities(makeCoverage("partial")).search, "partial");
});

test("V3-OP-001/V3-FAIL-013：三种身份状态保留相同 observation 与 Markdown 能力", () => {
	const observation = makeObservation();
	const resolver = new CatalogV2IdentityResolver();
	const observed = resolver.resolveFile(makeResolverInput(observation, makeState([]), "identity-observed"))[0];
	const identified = resolver.resolveFile(makeResolverInput(
		observation,
		makeState([makeMemo("m_11111111111111111111111111111111", observation)]),
		"identity-ready",
	))[0];
	const ambiguous = resolver.resolveFile(makeResolverInput(
		observation,
		makeState([
			makeMemo("m_11111111111111111111111111111111", observation),
			makeMemo("m_22222222222222222222222222222222", observation),
		]),
		"identity-conflicted",
	))[0];

	assert.equal(observed?.kind, "observed");
	assert.equal(identified?.kind, "identified");
	assert.equal(ambiguous?.kind, "ambiguous");
	for (const resolved of [observed, identified, ambiguous]) {
		assert.equal(resolved?.observation.content, observation.content);
		assert.equal(resolved?.observation.rawBlockHash, observation.rawBlockHash);
		assert.equal(resolved?.capabilities.markdown.view, true);
		assert.equal(resolved?.capabilities.markdown.copy, true);
		assert.equal(resolved?.capabilities.markdown.openDaily, true);
		assert.equal(resolved?.capabilities.markdown.edit, true);
	}
	assert.equal(observed?.identityHandle, null);
	assert.equal(identified?.identityHandle?.memoId, "m_11111111111111111111111111111111");
	assert.equal(identified?.identityHandle?.identityRevision, "identity-ready");
	assert.equal(ambiguous?.identityHandle, null);
	assert.equal(ambiguous?.capabilities.identity.relation, "conflicted");
});

test("V3-GUARD-001：公共正文契约不依赖 identity，身份契约不接受 observationKey", () => {
	const source = fs.readFileSync(path.resolve("src/types/memoOperations.ts"), "utf8");
	const markdownStart = source.indexOf("export interface MarkdownCreateInput");
	const identityStart = source.indexOf("export interface IdentityRelationInput");
	assert.notEqual(markdownStart, -1);
	assert.notEqual(identityStart, -1);
	assert.doesNotMatch(source.slice(markdownStart, identityStart), /\bmemoId\b|\bIdentityHandle\b|\bidentityHandle\b|\bobservationKey\b/u);
	assert.doesNotMatch(source.slice(identityStart), /\bobservationKey\b/u);
});

function makeObservation(): MemoObservation {
	return {
		sourcePath: "Daily/2026-08-21.md",
		sourceRevision: "a".repeat(64),
		startLine: 2,
		endLine: 2,
		rawBlockHash: "fnv1a-rawblock",
		logicalDate: "2026-08-21",
		section: "## Memos",
		time: "09:00",
		content: "正文不随身份状态变化",
		contentHash: "fnv1a-content0",
		existingBlockId: null,
		tags: [],
		links: [],
		images: [],
		tasks: [],
		timeBuoyDates: [],
	};
}

function makeResolverInput(observation: MemoObservation, state: CatalogV2MaterializedState, stateRevision: string) {
	const batch: CatalogFileRevisionBatch<MemoObservation> = {
		file: {
			sourcePath: observation.sourcePath,
			sourceRevision: observation.sourceRevision,
			logicalDate: observation.logicalDate,
			mtime: 1,
			size: 1,
			parserVersion: 1,
			settingsFingerprint: "settings-v1",
			observationCount: 1,
			auditedAt: 1,
		},
		observations: [observation],
		catalogRevision: 1,
	};
	return {
		batch,
		state,
		stateRevision,
		localIntents: [],
		settlement: { stateComplete: true, migrationComplete: true, revisionStable: true, historical: false },
	};
}

function makeMemo(memoId: string, observation: MemoObservation): CatalogV2MaterializedMemo {
	const evidence: IdentityEvidence = {
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
	const binding = { entryId: `binding:${memoId}`, source: "state" as const, evidence, baseBindingId: null };
	return {
		memoId,
		identityOperationIds: [binding.entryId],
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

function makeState(memos: readonly CatalogV2MaterializedMemo[]): CatalogV2MaterializedState {
	return {
		schemaVersion: 1,
		memos: Object.fromEntries(memos.map((memo) => [memo.memoId, memo])),
		quarantine: [],
		awaitingWriterIds: [],
		forkedWriterIds: [],
		processedOperationCount: 0,
	};
}

function makeCoverage(kind: "complete" | "partial") {
	return {
		kind,
		coveredFromDate: kind === "complete" ? "2026-08-21" : null,
		pendingFileCount: kind === "complete" ? 0 : 1,
		coveredFileCount: 1,
		totalFileCount: kind === "complete" ? 1 : 2,
	};
}
