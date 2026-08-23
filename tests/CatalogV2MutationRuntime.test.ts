import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import { TFile, TFolder } from "obsidian";
import type { App, TAbstractFile } from "obsidian";

import { CatalogV2DailyWriteGateway } from "../src/services/CatalogV2DailyWriteGateway";
import { CatalogV2DeletedPayloadCleanupRunner } from "../src/services/CatalogV2DeletedPayloadCleanupRunner";
import { CatalogV2DeletedPayloadStore } from "../src/services/CatalogV2DeletedPayloadStore";
import { observationToIdentityEvidence } from "../src/services/CatalogV2IdentityResolver";
import { CatalogV2MonthlyProjectionOutboxRunner } from "../src/services/CatalogV2MonthlyProjectionOutbox";
import {
	CatalogV2MutationRuntime,
	insertRawBlock,
	type CatalogV2RuntimeIdFactory,
} from "../src/services/CatalogV2MutationRuntime";
import { CatalogV2OperationWriter } from "../src/services/CatalogV2OperationWriter";
import { deriveObservationMemoId } from "../src/services/CatalogV2SharedMutationStore";
import type { CatalogV2SharedMutationStore } from "../src/services/CatalogV2SharedMutationStore";
import { DiaryMemoParser } from "../src/services/DiaryMemoParser";
import { IndexedDbCatalogV2TransactionStore } from "../src/services/IndexedDbCatalogV2TransactionStore";
import type { ResolvedMemoHandle } from "../src/types/catalog";
import type { ArtifactRef, CatalogV2MaterializedState, IdentityEvidence, StateOperation } from "../src/types/catalogV2";
import type {
	CatalogV2MutationPrepareArtifact,
	CatalogV2SharedMutationRecord,
	CatalogV2VerifiedVaultContext,
} from "../src/types/catalogV2Protocol";

test("insertRawBlock accepts a detached root time line for list memo content", () => {
	assert.equal(
		insertRawBlock("## Memos\n", "- 09:00\n\t- first\n\t- second", "## Memos"),
		"## Memos\n- 09:00\n\t- first\n\t- second\n",
	);
});

test("insertRawBlock still rejects an invalid or indented root time line", () => {
	assert.throws(
		() => insertRawBlock("## Memos\n", "\t- 09:00\n\t- first", "## Memos"),
		/A Daily memo raw block must start with a valid root-level time line\./u,
	);
});

test("create saves Daily without identity markers or monthly projection outbox", async () => {
	const fixture = await createFixture("create", "## Memos\nexisting text\n## Other\nnot a memo\n");
	const result = await fixture.runtime.create({
		file: fixture.dailyFile,
		logicalDate: "2026-08-09",
		headings: ["## Memos"],
		rawBlock: "- 09:00 created #phase3",
		sourceMemoId: null,
	});

	assert.equal(result.dailySaved, true);
	assert.equal(result.followUpPending, false);
	assert.equal(result.handle, null);
	assert.equal(fixture.vault.readText(fixture.dailyFile), "## Memos\nexisting text\n- 09:00 created #phase3\n## Other\nnot a memo\n");
	assert.equal(fixture.vault.readText(fixture.dailyFile).includes("^"), false);
	assert.deepEqual(await fixture.store.listPending(), []);
	assert.equal(fixture.appender.appended.filter((item) => item.type === "lifecycle.create_intent").length, 1);
	assert.deepEqual((await fixture.store.listOutbox()).map((item) => item.kind).sort(), ["state_operation"]);
	assert.deepEqual(fixture.appender.appended.map((item) => item.type), ["lifecycle.create_intent"]);
});

test("edit and task toggle use the current evidence and never add a block ID", async () => {
	const fixture = await createFixture("edit-task", "## Memos\n- 09:00 before\n  - [ ] task\n");
	const handle = await makeHandle(fixture, "memo-edit");
	const edited = await fixture.runtime.edit({
		file: fixture.dailyFile,
		logicalDate: "2026-08-09",
		headings: ["## Memos"],
		handle,
		rawBlock: "- 09:00 after\n  - [ ] task",
	});
	const toggled = await fixture.runtime.toggleTask({
		file: fixture.dailyFile,
		logicalDate: "2026-08-09",
		headings: ["## Memos"],
		handle: edited.handle,
		taskIndex: 0,
		checked: true,
	});

	assert.equal(toggled.followUpPending, false);
	assert.equal(fixture.vault.readText(fixture.dailyFile), "## Memos\n- 09:00 after\n  - [x] task\n");
	assert.equal(fixture.vault.readText(fixture.dailyFile).includes("^"), false);
	assert.deepEqual(await fixture.store.listPending(), []);
	assert.deepEqual(fixture.appender.appended.map((item) => item.type), ["identity.rebind", "identity.rebind"]);
	assert.deepEqual(await fixture.store.listStateOperationOutbox(), []);
});

test("ordinary edit bypasses shared mutation prepare and persists no Daily body replay", async () => {
	const fixture = await createFixture("edit-no-shared-replay", "## Memos\n- 09:00 before\n");
	const handle = await makeHandle(fixture, "memo-edit-lightweight");
	const context = makeRecoveryContext();
	const shared = new FakeSharedMutationStore(makeRecoveryRecord(makeRecoveryPrepare({
		mutationId: "o_dddddddddddddddddddddddddddddddd",
		mutationKind: "move",
		memoId: handle.memoId,
		changes: [],
	})));
	const runtime = createRecoveryRuntime(fixture, shared, context, null);

	const edited = await runtime.edit({
		file: fixture.dailyFile,
		logicalDate: "2026-08-09",
		headings: ["## Memos"],
		handle,
		rawBlock: "- 09:00 after",
	});

	assert.equal(edited.dailySaved, true);
	assert.equal(edited.followUpPending, false);
	assert.equal(shared.prepareCalls, 0);
	assert.deepEqual(shared.preparedArtifacts, []);
	assert.deepEqual(await fixture.store.listPending(), []);
	assert.equal(fixture.appender.appended.at(-1)?.type, "identity.rebind");
	assert.equal(JSON.stringify(fixture.appender.appended).includes("RawBlock"), false);
});

test("explicit reference creation adds only an Obsidian anchor and keeps memo content pure", async () => {
	const fixture = await createFixture("reference-anchor", "## Memos\n- 09:00 referenced content\n");
	const handle = await makeHandle(fixture, "memo-reference");
	const anchored = await fixture.runtime.ensureReferenceAnchor({
		file: fixture.dailyFile,
		logicalDate: "2026-08-09",
		headings: ["## Memos"],
		handle,
		rawBlock: "",
	}, "ref123");

	assert.equal(anchored.blockId, "ref123");
	assert.equal(fixture.vault.readText(fixture.dailyFile), "## Memos\n- 09:00 referenced content ^ref123\n");
	const parsed = await fixture.parser.parse({
		sourcePath: fixture.dailyFile.path,
		logicalDate: "2026-08-09",
		headings: ["## Memos"],
		bytes: new TextEncoder().encode(fixture.vault.readText(fixture.dailyFile)),
	});
	assert.equal(parsed.observations[0]?.content, "referenced content");
	assert.equal(parsed.observations[0]?.existingBlockId, "ref123");
	assert.equal((await fixture.store.listStateOperationOutbox()).at(-1)?.operation.type, "identity.rebind");
});

test("delete writes and verifies payload before Daily removal, then restore keeps memoId", async () => {
	const fixture = await createFixture("lifecycle", "## Memos\n- 09:00 recover me\n");
	const handle = await makeHandle(fixture, "memo-life");
	const deleted = await fixture.runtime.delete({
		file: fixture.dailyFile,
		logicalDate: "2026-08-09",
		headings: ["## Memos"],
		handle,
		sourceMemoId: null,
	});
	assert.equal(deleted.followUpPending, false);
	assert.equal(fixture.vault.readText(fixture.dailyFile), "## Memos\n");

	const deleteItem = (await fixture.store.listStateOperationOutbox()).find((item) => item.operation.type === "lifecycle.delete");
	assert.ok(deleteItem !== undefined && deleteItem.operation.type === "lifecycle.delete");
	const deletedPayload = deleteItem.operation.payload.deletedPayload;
	assert.equal((await fixture.payloadStore.read(deletedPayload)).rawBlock, "- 09:00 recover me");

	const restored = await fixture.runtime.restore({
		file: fixture.dailyFile,
		logicalDate: "2026-08-09",
		headings: ["## Memos"],
		memoId: handle.memoId,
		deleteVersion: {
			deleteOpId: deleteItem.operation.payload.deleteOpId,
			entryId: deleteItem.operation.opId,
			payload: deletedPayload,
			baseEvidence: handle.evidence,
			baseBindingId: handle.activeBindingId,
		},
	});
	assert.equal(restored.handle.memoId, handle.memoId);
	assert.equal(fixture.vault.readText(fixture.dailyFile), "## Memos\n- 09:00 recover me\n");

	await fixture.runtime.purge({
		memoId: handle.memoId,
		deleteOpId: deleteItem.operation.payload.deleteOpId,
		deletedPayload,
	});
	const waiting = await new CatalogV2DeletedPayloadCleanupRunner(fixture.store, fixture.payloadStore).run();
	assert.deepEqual(waiting, { cleaned: 0, waiting: 0 });
	await fixture.writer.flush();
	const cleaned = await new CatalogV2DeletedPayloadCleanupRunner(fixture.store, fixture.payloadStore).run();
	assert.deepEqual(cleaned, { cleaned: 0, waiting: 0 });
	assert.equal(fixture.vault.hasPath(deletedPayload.path), true);
});

test("V3-OP-008：recoverable delete payload 写入失败时 Daily 逐字节不变", async () => {
	const fixture = await createFixture("delete-payload-failure", "## Memos\n- 09:00 keep me\n");
	const handle = await makeHandle(fixture, "memo-delete-payload-failure");
	fixture.payloadStore.write = async () => { throw new Error("payload write failed"); };

	await assert.rejects(() => fixture.runtime.delete({
		file: fixture.dailyFile,
		logicalDate: "2026-08-09",
		headings: ["## Memos"],
		handle,
		sourceMemoId: null,
	}), /payload write failed/u);

	assert.equal(fixture.vault.readText(fixture.dailyFile), "## Memos\n- 09:00 keep me\n");
});

test("ordinary edit returns saved with follow-up pending when identity evidence flush fails", async () => {
	const fixture = await createFixture("resume", "## Memos\n- 09:00 before\n");
	const handle = await makeHandle(fixture, "memo-resume");
	const originalFlush = fixture.writer.flush.bind(fixture.writer);
	fixture.writer.flush = async () => ({ appended: 0, failed: 1 });

	const edited = await fixture.runtime.edit({
		file: fixture.dailyFile,
		logicalDate: "2026-08-09",
		headings: ["## Memos"],
		handle,
		rawBlock: "- 09:00 after",
	});
	assert.equal(edited.dailySaved, true);
	assert.equal(edited.followUpPending, true);
	assert.equal(fixture.vault.readText(fixture.dailyFile), "## Memos\n- 09:00 after\n");
	assert.deepEqual(await fixture.store.listPending(), []);
	assert.equal((await fixture.store.listStateOperationOutbox()).length, 1);

	fixture.writer.flush = originalFlush;
	assert.deepEqual(await fixture.writer.flush(), { appended: 1, failed: 0 });
	assert.equal(fixture.vault.readText(fixture.dailyFile), "## Memos\n- 09:00 after\n");
	assert.deepEqual(await fixture.store.listStateOperationOutbox(), []);
});

test("move target commit success is returned as pending when source removal must be recovered", async () => {
	const fixture = await createFixture("move-source-pending", "## Memos\n- 09:00 move me\n");
	const targetFile = await fixture.vault.create("Daily/2026-08-10.md", "## Memos\n");
	const handle = await makeHandle(fixture, "memo-move-pending");
	const context = makeRecoveryContext();
	const shared = new FakeSharedMutationStore(makeRecoveryRecord(makeRecoveryPrepare({
		mutationId: "o_dddddddddddddddddddddddddddddddd",
		mutationKind: "move",
		memoId: handle.memoId,
		changes: [],
	})));
	const runtime = createRecoveryRuntime(fixture, shared, context, null);
	const originalProcess = fixture.vault.process.bind(fixture.vault);
	let processCalls = 0;
	fixture.vault.process = async (file, update) => {
		processCalls += 1;
		if (processCalls === 2) throw new Error("source Daily removal failed");
		return originalProcess(file, update);
	};

	const moved = await runtime.move({
		file: fixture.dailyFile,
		logicalDate: "2026-08-09",
		headings: ["## Memos"],
		handle,
		targetFile,
		targetLogicalDate: "2026-08-10",
		targetHeadings: ["## Memos"],
	});

	assert.equal(moved.dailySaved, true);
	assert.equal(moved.followUpPending, true);
	assert.equal(fixture.vault.readText(targetFile), "## Memos\n- 09:00 move me\n");
	assert.equal(fixture.vault.readText(fixture.dailyFile), "## Memos\n- 09:00 move me\n");
	assert.equal((await fixture.store.listPending()).length, 1);
});

test("create refuses to write Daily when durable transaction storage is unavailable", async () => {
	const fixture = await createFixture("observed-create", "## Memos\n");
	let cleanupCalls = 0;
	fixture.store.putPending = async () => {
		throw new Error("IndexedDB unavailable");
	};
	fixture.store.assignStateOperation = async () => {
		throw new Error("IndexedDB unavailable");
	};
	fixture.store.putOutbox = async () => {
		throw new Error("IndexedDB unavailable");
	};

	await assert.rejects(() => fixture.runtime.create({
		file: fixture.dailyFile,
		logicalDate: "2026-08-09",
		headings: ["## Memos"],
		rawBlock: "- 09:00 observed",
		sourceMemoId: null,
		removeFileOnAbort: async () => { cleanupCalls += 1; },
	}), /IndexedDB unavailable/u);
	assert.equal(fixture.vault.readText(fixture.dailyFile), "## Memos\n");
	assert.equal(cleanupCalls, 1);
});

test("create never saves a provisional Daily memo when shared intent is unavailable", async () => {
	const fixture = await createFixture("provisional-create", "## Memos\n", true);
	fixture.appender.getLastSequence = async () => { throw new Error("shared state awaiting sync"); };

	await assert.rejects(() => fixture.runtime.create({
		file: fixture.dailyFile,
		logicalDate: "2026-08-09",
		headings: ["## Memos"],
		rawBlock: "- 09:00 provisional",
		sourceMemoId: null,
	}), /intent is not durable/u);

	assert.equal(fixture.vault.readText(fixture.dailyFile), "## Memos\n");
	assert.equal((await fixture.store.listPending()).length, 0);
	assert.equal(fixture.appender.appended.length, 0);
});

test("failed shared intent removes an empty Daily file created only for the aborted memo", async () => {
	const fixture = await createFixture("aborted-new-daily", "", true);
	fixture.appender.getLastSequence = async () => { throw new Error("shared state awaiting sync"); };

	await assert.rejects(() => fixture.runtime.create({
		file: fixture.dailyFile,
		logicalDate: "2026-08-09",
		headings: ["## Memos"],
		rawBlock: "- 09:00 provisional",
		sourceMemoId: null,
		removeFileOnAbort: async () => fixture.vault.trash(fixture.dailyFile),
	}), /intent is not durable/u);

	assert.equal(fixture.vault.hasPath(fixture.dailyFile.path), false);
});

test("create refuses a provisional Daily write when transaction durability is lost after prepare", async () => {
	const fixture = await createFixture("provisional-race", "## Memos\n", true);
	const originalPutPending = fixture.store.putPending.bind(fixture.store);
	fixture.store.putPending = async (pending) => {
		await originalPutPending(pending);
		fixture.store.isAuthoritative = () => false;
	};
	fixture.appender.getLastSequence = async () => { throw new Error("shared state awaiting sync"); };

	await assert.rejects(() => fixture.runtime.create({
		file: fixture.dailyFile,
		logicalDate: "2026-08-09",
		headings: ["## Memos"],
		rawBlock: "- 09:00 unsafe provisional",
		sourceMemoId: null,
	}), /create intent is not durable/u);
	assert.equal(fixture.vault.readText(fixture.dailyFile), "## Memos\n");
});

test("a failed Daily commit durably abandons the already committed create intent", async () => {
	const fixture = await createFixture("create-daily-failure", "## Memos\n");
	fixture.vault.failNextProcess();

	await assert.rejects(() => fixture.runtime.create({
		file: fixture.dailyFile,
		logicalDate: "2026-08-09",
		headings: ["## Memos"],
		rawBlock: "- 09:00 failed Daily write",
		sourceMemoId: null,
	}), /Daily process failed/u);

	assert.equal(fixture.vault.readText(fixture.dailyFile), "## Memos\n");
	assert.deepEqual(fixture.appender.appended.map((item) => item.type), [
		"lifecycle.create_intent",
		"lifecycle.create_abandon",
	]);
	assert.deepEqual(await fixture.store.listPending(), []);
});

test("recovery never replays a create whose shared intent durability was not recorded", async () => {
	const fixture = await createFixture("unsafe-create-recovery", "## Memos\n");
	await fixture.store.putPending({
		transactionId: "tx:unsafe-create",
		kind: "create",
		memoId: "m_99999999999999999999999999999999",
		sourcePath: fixture.dailyFile.path,
		logicalDate: "2026-08-09",
		beforeRevision: await parseRevision(fixture),
		afterRevision: "f".repeat(64),
		operationDrafts: [],
		createdAt: "2026-08-09T00:00:00.000Z",
		headings: ["## Memos"],
		afterRawBlock: "- 09:00 must not replay",
		section: "## Memos",
		createIntentOpId: "o_99999999999999999999999999999999",
	});

	const inspection = await fixture.runtime.inspectPending();
	assert.equal(inspection.items[0]?.status, "attention");
	assert.equal(fixture.vault.readText(fixture.dailyFile), "## Memos\n");
});

test("recovery never trusts a local create marker without a verified shared intent", async () => {
	const fixture = await createFixture("missing-shared-create-intent", "## Memos\n");
	await fixture.store.putPending({
		transactionId: "tx:missing-shared-intent",
		kind: "create",
		memoId: "m_88888888888888888888888888888888",
		sourcePath: fixture.dailyFile.path,
		logicalDate: "2026-08-09",
		beforeRevision: await parseRevision(fixture),
		afterRevision: "e".repeat(64),
		operationDrafts: [],
		createdAt: "2026-08-09T00:00:00.000Z",
		headings: ["## Memos"],
		afterRawBlock: "- 09:00 must not replay",
		section: "## Memos",
		createIntentOpId: "o_88888888888888888888888888888888",
		createIntentDurable: true,
	});

	const inspection = await fixture.runtime.inspectPending();
	assert.equal(inspection.items[0]?.status, "attention");
	assert.equal(fixture.vault.readText(fixture.dailyFile), "## Memos\n");
});

test("explicit create recovery refuses to change Daily while verified state is unavailable", async () => {
	const fixture = await createFixture("recovery-state-unavailable", "## Memos\n");
	const context = makeRecoveryContext();
	const before = await parseContent(fixture.parser, fixture.dailyFile.path, "2026-08-09", "## Memos\n");
	const afterContent = "## Memos\n- 09:00 pending create\n";
	const after = await parseContent(fixture.parser, fixture.dailyFile.path, "2026-08-09", afterContent);
	const afterObservation = after.observations[0];
	assert.ok(afterObservation !== undefined);
	const afterEvidence = observationToIdentityEvidence(afterObservation);
	const memoId = await deriveObservationMemoId(
		context.bootstrap.vaultInstanceId,
		context.contractSha256,
		afterEvidence,
	);
	const prepare = makeRecoveryPrepare({
		mutationId: "o_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
		mutationKind: "create",
		memoId,
		changes: [{
			transition: {
				sourcePath: fixture.dailyFile.path,
				logicalDate: "2026-08-09",
				headings: ["## Memos"],
				beforeRevision: before.sourceRevision,
				afterRevision: after.sourceRevision,
				beforeEvidence: null,
				afterEvidence,
				baseBindingId: null,
				baseEvidence: null,
				preservedEvidence: [],
			},
			replay: { kind: "insert", rawBlock: "- 09:00 pending create", section: "## Memos" },
		}],
	});
	const shared = new FakeSharedMutationStore(makeRecoveryRecord(prepare));
	const runtime = createRecoveryRuntime(fixture, shared, context, null);

	assert.equal(await runtime.recoverExplicit(prepare.mutationId, "continue"), false);
	assert.equal(fixture.vault.readText(fixture.dailyFile), "## Memos\n");
	assert.equal(shared.commitCalls, 0);
});

test("a partially applied move can only continue its exact remaining Daily transition", async () => {
	const fixture = await createFixture("recovery-partial-move", "## Memos\n- 09:00 move me\n");
	const targetFile = await fixture.vault.create("Daily/2026-08-10.md", "## Memos\n- 09:00 move me\n");
	const context = makeRecoveryContext();
	const move = await makePartialMovePrepare(fixture, targetFile, context);
	const shared = new FakeSharedMutationStore(makeRecoveryRecord(move.prepare));
	const runtime = createRecoveryRuntime(fixture, shared, context, move.state);

	const inspection = await runtime.inspectPending();
	assert.equal(inspection.items[0]?.status, "attention");
	assert.deepEqual(inspection.items[0]?.reasons, ["daily_partial"]);
	assert.equal(await runtime.recoverExplicit(move.prepare.mutationId, "continue"), true);
	assert.equal(fixture.vault.readText(fixture.dailyFile), "## Memos\n");
	assert.equal(fixture.vault.readText(targetFile), "## Memos\n- 09:00 move me\n");
	assert.equal(shared.commitCalls, 1);
});

test("a partially applied move cannot be abandoned", async () => {
	const fixture = await createFixture("recovery-partial-abandon", "## Memos\n- 09:00 move me\n");
	const targetFile = await fixture.vault.create("Daily/2026-08-10.md", "## Memos\n- 09:00 move me\n");
	const context = makeRecoveryContext();
	const move = await makePartialMovePrepare(fixture, targetFile, context);
	const shared = new FakeSharedMutationStore(makeRecoveryRecord(move.prepare));
	const runtime = createRecoveryRuntime(fixture, shared, context, move.state);

	assert.equal(await runtime.recoverExplicit(move.prepare.mutationId, "abandon"), false);
	assert.equal(shared.abandonCalls, 0);
	assert.equal(fixture.vault.readText(fixture.dailyFile), "## Memos\n- 09:00 move me\n");
	assert.equal(fixture.vault.readText(targetFile), "## Memos\n- 09:00 move me\n");
});

test("relation, review, and monthly test sink remain external to Daily", async () => {
	const fixture = await createFixture("external-state", "## Memos\n- 09:00 unchanged\n");
	const handle = await makeHandle(fixture, "memo-external");
	await fixture.runtime.setSource(handle, "source-1", ["l_" + "a".repeat(64)]);
	await fixture.runtime.recordReview(handle, "2026-08-09T01:00:00.000Z");
	await fixture.store.putOutbox({
		id: "monthly:memo-external:2026-08-09",
		kind: "monthly_projection",
		memoId: "memo-external",
		logicalDate: "2026-08-09",
		sourceRevision: "a".repeat(64),
		createdAt: "2026-08-09T01:00:00.000Z",
	});
	const received: string[] = [];
	const result = await new CatalogV2MonthlyProjectionOutboxRunner(fixture.store, {
		project: async (item) => {
			received.push(item.id);
		},
	}).run();

	assert.deepEqual(result, { projected: 1, failed: 0 });
	assert.deepEqual(received, ["monthly:memo-external:2026-08-09"]);
	assert.equal(fixture.vault.readText(fixture.dailyFile), "## Memos\n- 09:00 unchanged\n");
});

async function createFixture(name: string, dailyContent: string, _allowProvisionalCreate = false) {
	const vault = new MemoryVault();
	const dailyFile = await vault.create("Daily/2026-08-09.md", dailyContent);
	const app = {
		vault,
		workspace: { getActiveViewOfType: () => null },
		fileManager: {
			trashFile: async (file: TFile) => vault.trash(file),
		},
	} as unknown as App;
	const store = new IndexedDbCatalogV2TransactionStore(`phase3-${name}`, {
		factory: new IDBFactory(),
		keyRange: IDBKeyRange,
	});
	await store.open();
	const appender = new MemoryAppender();
	const writer = new CatalogV2OperationWriter(
		{ getOrCreateWriterId: async () => "w_11111111111111111111111111111111" },
		store,
		appender,
	);
	const parser = new DiaryMemoParser(async (bytes) => createHash("sha256").update(bytes).digest("hex"));
	const gateway = new CatalogV2DailyWriteGateway(app, parser);
	const payloadStore = new CatalogV2DeletedPayloadStore(app, "Memos/_knomo-data");
	const ids = new DeterministicIds();
	const runtime = new CatalogV2MutationRuntime(
		gateway,
		store,
		writer,
		payloadStore,
		(path) => vault.getAbstractFileByPath(path) as TFile | null,
		ids,
		() => "2026-08-09T00:00:00.000Z",
		async (memoId, createIntentOpId) => fixtureHasCreateIntent(appender, memoId, createIntentOpId),
	);
	return { app, vault, dailyFile, store, appender, writer, parser, gateway, payloadStore, ids, runtime };
}

function createRecoveryRuntime(
	fixture: Awaited<ReturnType<typeof createFixture>>,
	shared: FakeSharedMutationStore,
	context: CatalogV2VerifiedVaultContext,
	state: CatalogV2MaterializedState | null,
): CatalogV2MutationRuntime {
	return new CatalogV2MutationRuntime(
		fixture.gateway,
		fixture.store,
		fixture.writer,
		fixture.payloadStore,
		(path) => fixture.vault.getAbstractFileByPath(path) as TFile | null,
		fixture.ids,
		() => "2026-08-09T00:00:00.000Z",
		async () => true,
		shared as unknown as CatalogV2SharedMutationStore,
		() => context,
		async () => "w_11111111111111111111111111111111",
		async () => undefined,
		async () => state === null ? null : ({
			state,
			vaultInstanceId: context.bootstrap.vaultInstanceId,
			contractDigest: context.contractSha256,
			verifiedGenerationId: "f".repeat(64),
		}),
	);
}

async function makePartialMovePrepare(
	fixture: Awaited<ReturnType<typeof createFixture>>,
	targetFile: TFile,
	context: CatalogV2VerifiedVaultContext,
): Promise<{ prepare: CatalogV2MutationPrepareArtifact; state: CatalogV2MaterializedState }> {
	const rawBlock = "- 09:00 move me";
	const sourceBefore = await parseContent(
		fixture.parser,
		fixture.dailyFile.path,
		"2026-08-09",
		"## Memos\n- 09:00 move me\n",
	);
	const sourceAfter = await parseContent(fixture.parser, fixture.dailyFile.path, "2026-08-09", "## Memos\n");
	const targetBefore = await parseContent(fixture.parser, targetFile.path, "2026-08-10", "## Memos\n");
	const targetAfter = await parseContent(
		fixture.parser,
		targetFile.path,
		"2026-08-10",
		"## Memos\n- 09:00 move me\n",
	);
	const sourceObservation = sourceBefore.observations[0];
	const targetObservation = targetAfter.observations[0];
	assert.ok(sourceObservation !== undefined);
	assert.ok(targetObservation !== undefined);
	const sourceEvidence = observationToIdentityEvidence(sourceObservation);
	const targetEvidence = observationToIdentityEvidence(targetObservation);
	const memoId = "m_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
	const bindingId = "o_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
	return {
		prepare: makeRecoveryPrepare({
			mutationId: "o_cccccccccccccccccccccccccccccccc",
			mutationKind: "move",
			memoId,
			changes: [{
				transition: {
					sourcePath: targetFile.path,
					logicalDate: "2026-08-10",
					headings: ["## Memos"],
					beforeRevision: targetBefore.sourceRevision,
					afterRevision: targetAfter.sourceRevision,
					beforeEvidence: null,
					afterEvidence: targetEvidence,
					baseBindingId: null,
					baseEvidence: null,
					preservedEvidence: [],
				},
				replay: { kind: "insert", rawBlock, section: "## Memos" },
			}, {
				transition: {
					sourcePath: fixture.dailyFile.path,
					logicalDate: "2026-08-09",
					headings: ["## Memos"],
					beforeRevision: sourceBefore.sourceRevision,
					afterRevision: sourceAfter.sourceRevision,
					beforeEvidence: sourceEvidence,
					afterEvidence: null,
					baseBindingId: bindingId,
					baseEvidence: sourceEvidence,
					preservedEvidence: [],
				},
				replay: { kind: "remove", beforeRawBlock: rawBlock },
			}],
		}),
		state: makeRecoveryState(memoId, bindingId, sourceEvidence),
	};
}

function makeRecoveryPrepare(input: Pick<CatalogV2MutationPrepareArtifact,
	"mutationId" | "mutationKind" | "memoId" | "changes">): CatalogV2MutationPrepareArtifact {
	return {
		kind: "knomo.catalog-v2.mutation-prepare",
		schemaVersion: 2,
		vaultInstanceId: "v_11111111111111111111111111111111",
		...input,
		effectDrafts: [],
		preparedByWriterId: "w_11111111111111111111111111111111",
		preparedAt: "2026-08-09T00:00:00.000Z",
	};
}

function makeRecoveryRecord(prepare: CatalogV2MutationPrepareArtifact): CatalogV2SharedMutationRecord {
	return {
		mutationId: prepare.mutationId,
		prepare,
		prepareRef: { path: `prepare-${prepare.mutationId}.json`, sha256: "d".repeat(64), byteLength: 1 },
		commit: null,
		commitRef: null,
		abandon: null,
		abandonRef: null,
	};
}

function makeRecoveryContext(): CatalogV2VerifiedVaultContext {
	return {
		bootstrap: { vaultInstanceId: "v_11111111111111111111111111111111" },
		contractSha256: "e".repeat(64),
	} as unknown as CatalogV2VerifiedVaultContext;
}

function makeRecoveryState(
	memoId: string,
	bindingId: string,
	evidence: IdentityEvidence,
): CatalogV2MaterializedState {
	const binding = { entryId: bindingId, source: "state" as const, evidence, baseBindingId: null };
	return {
		schemaVersion: 1,
		memos: {
			[memoId]: {
				memoId,
				identityOperationIds: [bindingId],
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
			},
		},
		quarantine: [],
		awaitingWriterIds: [],
		forkedWriterIds: [],
		processedOperationCount: 1,
	};
}

function parseContent(
	parser: DiaryMemoParser,
	sourcePath: string,
	logicalDate: string,
	content: string,
) {
	return parser.parse({
		sourcePath,
		logicalDate,
		headings: ["## Memos"],
		bytes: new TextEncoder().encode(content),
	});
}

class FakeSharedMutationStore {
	abandonCalls = 0;
	commitCalls = 0;
	prepareCalls = 0;
	readonly preparedArtifacts: CatalogV2MutationPrepareArtifact[] = [];
	private readonly record: CatalogV2SharedMutationRecord;

	constructor(record: CatalogV2SharedMutationRecord) {
		this.record = record;
	}

	async inspect() {
		return {
			records: [this.record],
			missingPrepareMutationIds: [],
			missingCommitMutationIds: [this.record.mutationId],
			issues: [],
			affectedPaths: [],
			affectedMemoIds: [],
		};
	}

	async abandon(): Promise<ArtifactRef> {
		this.abandonCalls += 1;
		return { path: "abandon.json", sha256: "a".repeat(64), byteLength: 1 };
	}

	async prepare(artifact: CatalogV2MutationPrepareArtifact): Promise<ArtifactRef> {
		this.prepareCalls += 1;
		this.preparedArtifacts.push(artifact);
		return { path: "prepare.json", sha256: "b".repeat(64), byteLength: 1 };
	}

	async commit(): Promise<ArtifactRef> {
		this.commitCalls += 1;
		return { path: "commit.json", sha256: "c".repeat(64), byteLength: 1 };
	}

	async findControlPermit(): Promise<null> {
		return null;
	}
}

function fixtureHasCreateIntent(appender: MemoryAppender, memoId: string, createIntentOpId: string): boolean {
	return appender.appended.some((operation) => operation.memoId === memoId
		&& operation.opId === createIntentOpId && operation.type === "lifecycle.create_intent");
}

async function makeHandle(
	fixture: Awaited<ReturnType<typeof createFixture>>,
	memoId: string,
): Promise<ResolvedMemoHandle> {
	const content = fixture.vault.readText(fixture.dailyFile);
	const parsed = await fixture.parser.parse({
		sourcePath: fixture.dailyFile.path,
		logicalDate: "2026-08-09",
		headings: ["## Memos"],
		bytes: new TextEncoder().encode(content),
	});
	const observation = parsed.observations[0];
	assert.ok(observation !== undefined);
	const evidence = observationToIdentityEvidence(observation);
	return {
		memoId,
		activeBindingId: "o_ffffffffffffffffffffffffffffffff",
		evidence,
		bindingEvidence: evidence,
		stateRevision: evidence.sourceRevision,
	};
}

async function parseRevision(fixture: Awaited<ReturnType<typeof createFixture>>): Promise<string> {
	return (await fixture.parser.parse({
		sourcePath: fixture.dailyFile.path,
		logicalDate: "2026-08-09",
		headings: ["## Memos"],
		bytes: new TextEncoder().encode(fixture.vault.readText(fixture.dailyFile)),
	})).sourceRevision;
}

class DeterministicIds implements CatalogV2RuntimeIdFactory {
	private operationSequence = 0;
	private memoSequence = 0;

	createMemoId(): string {
		this.memoSequence += 1;
		return `m_${this.memoSequence.toString(16).padStart(32, "0")}`;
	}

	createOperationId(): string {
		this.operationSequence += 1;
		return `o_${this.operationSequence.toString(16).padStart(32, "0")}`;
	}
}

class MemoryAppender {
	readonly appended: StateOperation[] = [];
	private lastSequence = 0;

	async getLastSequence(): Promise<number> {
		return this.lastSequence;
	}

	async append(operation: StateOperation): Promise<ArtifactRef> {
		this.appended.push(operation);
		this.lastSequence = operation.sequence;
		return { path: "state.jsonl", sha256: "a".repeat(64), byteLength: 1 };
	}
}

class MemoryVault {
	private readonly files = new Map<string, TAbstractFile>();
	private readonly contents = new Map<string, string>();
	private processShouldFail = false;

	getAbstractFileByPath(path: string): TAbstractFile | null {
		return this.files.get(path) ?? null;
	}

	async createFolder(path: string): Promise<TFolder> {
		const folder = Object.assign(new TFolder(), { path, name: path.split("/").pop() ?? "", children: [] });
		this.files.set(path, folder);
		this.addToParent(path, folder);
		return folder;
	}

	async create(path: string, content: string): Promise<TFile> {
		const name = path.split("/").pop() ?? "";
		const file = Object.assign(new TFile(), {
			path,
			name,
			basename: name.replace(/\.[^.]+$/u, ""),
			extension: name.includes(".") ? name.split(".").pop() ?? "" : "",
			stat: { ctime: 1, mtime: 1, size: new TextEncoder().encode(content).byteLength },
		});
		this.files.set(path, file);
		this.contents.set(path, content);
		this.addToParent(path, file);
		return file;
	}

	async cachedRead(file: TFile): Promise<string> {
		return this.readText(file);
	}

	async process(file: TFile, update: (content: string) => string): Promise<string> {
		if (this.processShouldFail) {
			this.processShouldFail = false;
			throw new Error("Daily process failed");
		}
		const content = update(this.readText(file));
		this.contents.set(file.path, content);
		file.stat = { ...file.stat, mtime: file.stat.mtime + 1, size: new TextEncoder().encode(content).byteLength };
		return content;
	}

	failNextProcess(): void {
		this.processShouldFail = true;
	}

	async readBinary(file: TFile): Promise<ArrayBuffer> {
		const bytes = new TextEncoder().encode(this.readText(file));
		return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
	}

	readText(file: TFile): string {
		return this.contents.get(file.path) ?? "";
	}

	hasPath(path: string): boolean {
		return this.files.has(path);
	}

	trash(file: TFile): void {
		this.files.delete(file.path);
		this.contents.delete(file.path);
	}

	private addToParent(path: string, child: TAbstractFile): void {
		const separator = path.lastIndexOf("/");
		if (separator < 0) return;
		const parent = this.files.get(path.slice(0, separator));
		if (parent instanceof TFolder) parent.children.push(child);
	}
}
