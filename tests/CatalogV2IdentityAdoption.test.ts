import assert from "node:assert/strict";
import test from "node:test";
import { IDBFactory, IDBKeyRange } from "fake-indexeddb";

import { CatalogV2IdentityAdoption } from "../src/services/CatalogV2IdentityAdoption";
import {
	CatalogV2IdentityResolver,
	createResolvedMemoHandle,
	observationToIdentityEvidence,
} from "../src/services/CatalogV2IdentityResolver";
import { CatalogV2OperationWriter } from "../src/services/CatalogV2OperationWriter";
import { IndexedDbCatalogV2TransactionStore } from "../src/services/IndexedDbCatalogV2TransactionStore";
import type { CatalogFileRevisionBatch, MemoObservation } from "../src/types/catalog";
import type { ArtifactRef, StateOperation } from "../src/types/catalogV2";
import type { CatalogV2AdoptionPermit } from "../src/types/catalogV2Protocol";
import { canonicalJson, sha256Text } from "../src/services/CatalogV2Protocol";

test("eligible observed memo adopts through a durable manual claim before retry", async () => {
	const store = new IndexedDbCatalogV2TransactionStore("phase3-adoption", {
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
	const observation = makeObservation();
	const [observed] = new CatalogV2IdentityResolver().resolveFile({
		batch: makeBatch(observation),
		state: {
			schemaVersion: 1,
			memos: {},
			quarantine: [],
			awaitingWriterIds: [],
			forkedWriterIds: [],
			processedOperationCount: 0,
		},
		stateRevision: "state-1",
		localIntents: [],
		settlement: { stateComplete: true, migrationComplete: true, revisionStable: true, historical: false },
	});
	assert.ok(observed !== undefined);
	assert.equal(createResolvedMemoHandle(observed), null);

	const adopted = await new CatalogV2IdentityAdoption(
		writer,
		async (memo) => memo,
		(prefix) => prefix === "m" ? "m_11111111111111111111111111111111" : "o_11111111111111111111111111111111",
		() => "2026-08-09T00:00:00.000Z",
	).adopt(observed, await makePermit(observation));

	assert.equal(adopted.memoId, "m_11111111111111111111111111111111");
	assert.equal(adopted.operation.type, "identity.claim");
	assert.equal(adopted.operation.type === "identity.claim" ? adopted.operation.payload.origin : null, "manual_adoption");
	assert.deepEqual(appender.appended, [adopted.operation]);
	assert.deepEqual(await store.listStateOperationOutbox(), []);
});

test("a settling observation cannot be adopted", async () => {
	const store = new IndexedDbCatalogV2TransactionStore("phase3-adoption-blocked", {
		factory: new IDBFactory(),
		keyRange: IDBKeyRange,
	});
	await store.open();
	const writer = new CatalogV2OperationWriter(
		{ getOrCreateWriterId: async () => "w_11111111111111111111111111111111" },
		store,
		new MemoryAppender(),
	);
	const observation = makeObservation();
	const [settling] = new CatalogV2IdentityResolver().resolveFile({
		batch: makeBatch(observation),
		state: {
			schemaVersion: 1,
			memos: {},
			quarantine: [],
			awaitingWriterIds: [],
			forkedWriterIds: [],
			processedOperationCount: 0,
		},
		stateRevision: "state-2",
		localIntents: [],
		settlement: { stateComplete: false, migrationComplete: true, revisionStable: true, historical: false },
	});
	assert.ok(settling !== undefined);
	const permit = await makePermit(observation);
	await assert.rejects(() => new CatalogV2IdentityAdoption(writer, async (memo) => memo)
		.adopt(settling, permit), /freshly settled/u);
});

test("readiness 在 refresh 后变化时不会写入 identity claim", async () => {
	const store = new IndexedDbCatalogV2TransactionStore("phase3-adoption-readiness-changed", {
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
	const observation = makeObservation();
	const [observed] = new CatalogV2IdentityResolver().resolveFile({
		batch: makeBatch(observation),
		state: {
			schemaVersion: 1,
			memos: {},
			quarantine: [],
			awaitingWriterIds: [],
			forkedWriterIds: [],
			processedOperationCount: 0,
		},
		stateRevision: "state-3",
		localIntents: [],
		settlement: { stateComplete: true, migrationComplete: true, revisionStable: true, historical: false },
	});
	assert.ok(observed);
	const permit = await makePermit(observation);
	await assert.rejects(() => new CatalogV2IdentityAdoption(
		writer,
		async (memo) => memo,
		undefined,
		undefined,
		async () => false,
	).adopt(observed, permit), /settlement changed/u);
	assert.deepEqual(appender.appended, []);
});

function makeObservation(): MemoObservation {
	return {
		sourcePath: "Daily/2026-08-09.md",
		sourceRevision: "a".repeat(64),
		rawBlockHash: "fnv1a-rawblock",
		logicalDate: "2026-08-09",
		section: "## Memos",
		startLine: 1,
		endLine: 1,
		time: "09:00",
		content: "manual",
		contentHash: "fnv1a-12345678",
		existingBlockId: null,
		tags: [],
		links: [],
		images: [],
		tasks: [],
		timeBuoyDates: [],
	};
}

async function makePermit(observation: MemoObservation): Promise<CatalogV2AdoptionPermit> {
	return {
		kind: "catalog-v2-adoption-permit",
		vaultInstanceId: "v_11111111111111111111111111111111",
		memoId: "m_11111111111111111111111111111111",
		generationId: "b".repeat(64),
		contractDigest: "c".repeat(64),
		sourceRevision: observation.sourceRevision,
		observationDigest: await sha256Text(canonicalJson(observationToIdentityEvidence(observation))),
		control: {
			kind: "catalog-v2-control-permit",
			vaultInstanceId: "v_11111111111111111111111111111111",
			controlGeneration: { path: "control.json", sha256: "d".repeat(64), byteLength: 1 },
			controlSequence: 2,
			authorityEpoch: 1,
			authorityWriterId: "w_11111111111111111111111111111111",
			actionId: "o_22222222222222222222222222222222",
			actionKind: "identity_adoption",
			inputDigest: await sha256Text(canonicalJson(observationToIdentityEvidence(observation))),
			authorizedAt: "2026-08-09T00:00:00.000Z",
			stateGenerationId: "b".repeat(64),
			contractDigest: "c".repeat(64),
		},
	};
}

function makeBatch(observation: MemoObservation): CatalogFileRevisionBatch<MemoObservation> {
	return {
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
}

class MemoryAppender {
	readonly appended: StateOperation[] = [];

	async getLastSequence(): Promise<number> {
		return this.appended.length;
	}

	async append(operation: StateOperation): Promise<ArtifactRef> {
		this.appended.push(operation);
		return { path: "state.jsonl", sha256: "a".repeat(64), byteLength: 1 };
	}
}
