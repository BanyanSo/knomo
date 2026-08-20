import assert from "node:assert/strict";
import test from "node:test";

import { CatalogV2ImmutableStateWriter } from "../src/services/CatalogV2ImmutableStateWriter";
import { buildMigrationCommit } from "../src/services/CatalogV2Migration";
import { canonicalJsonFileBytes, sha256Bytes } from "../src/services/CatalogV2Protocol";
import {
	CatalogV2SharedMutationStore,
	deriveObservationMemoId,
} from "../src/services/CatalogV2SharedMutationStore";
import { CatalogV2VaultProtocol } from "../src/services/CatalogV2VaultProtocol";
import type { IdentityEvidence, StateOperation } from "../src/types/catalogV2";
import type { CatalogV2MutationPrepareArtifact, CatalogV2VaultContract } from "../src/types/catalogV2Protocol";
import { CatalogV2ReplicaVault } from "./helpers/CatalogV2ReplicaVault";
import {
	makeMigrationResult,
	TEST_MIGRATION_VERIFICATION,
} from "./helpers/CatalogV2MigrationFixture";

const WRITER_A = "w_00000000000000000000000000000001";
const WRITER_B = "w_00000000000000000000000000000002";
const VAULT_ID = "v_00000000000000000000000000000001";

test("state writer commits immutable segments, heads and a verified generation", async () => {
	const replica = new CatalogV2ReplicaVault();
	const protocol = new CatalogV2VaultProtocol(replica.app);
	const context = await protocol.initializeVault({
		catalogDataRoot: "Memos/_knomo-data",
		contract: makeContract(),
		initialWriterId: WRITER_A,
		createdAt: time(0),
		vaultInstanceId: VAULT_ID,
	});
	const writer = new CatalogV2ImmutableStateWriter(protocol, () => context);
	await writer.append(makeReview(WRITER_A, 1));
	await writer.append(makeReview(WRITER_A, 2));
	await writer.append(makeReview(WRITER_A, 3));

	const selected = await protocol.selectGeneration(context);
	assert.equal(selected.kind, "verified", JSON.stringify(selected));
	assert.deepEqual(selected.kind === "verified" ? selected.value.operations.map((operation) => operation.sequence) : [], [1, 2, 3]);
	assert.equal(replica.paths().filter((path) => path.includes("/segments/")).length, 3);
	assert.equal(replica.paths().some((path) => path.endsWith(".jsonl")), false);
});

test("two replicas merge different writer generations after arbitrary delivery", async () => {
	const replicaA = new CatalogV2ReplicaVault();
	const protocolA = new CatalogV2VaultProtocol(replicaA.app);
	const contextA = await protocolA.initializeVault({
		catalogDataRoot: "Memos/_knomo-data",
		contract: makeContract(),
		initialWriterId: WRITER_A,
		createdAt: time(0),
		vaultInstanceId: VAULT_ID,
	});
	const replicaB = new CatalogV2ReplicaVault(replicaA.snapshot());
	const protocolB = new CatalogV2VaultProtocol(replicaB.app);
	const loadedB = await protocolB.loadVaultContext();
	assert.equal(loadedB.kind, "ready");
	if (loadedB.kind !== "ready") throw new Error("missing test context");

	await new CatalogV2ImmutableStateWriter(protocolA, () => contextA).append(makeReview(WRITER_A, 1));
	await new CatalogV2ImmutableStateWriter(protocolB, () => loadedB.context).append(makeReview(WRITER_B, 1));
	replicaA.deliverFrom(replicaB);
	replicaB.deliverFrom(replicaA);
	assert.equal((await protocolA.selectGeneration(contextA)).kind, "forked");

	const merger = new CatalogV2ImmutableStateWriter(protocolA, () => contextA, () => time(3));
	await merger.reconcile(WRITER_A);
	replicaB.deliverFrom(replicaA);
	const selectedA = await protocolA.selectGeneration(contextA);
	const selectedB = await protocolB.selectGeneration(loadedB.context);
	assert.equal(selectedA.kind, "verified", JSON.stringify(selectedA));
	assert.equal(selectedB.kind, "verified", JSON.stringify(selectedB));
	assert.deepEqual(
		selectedA.kind === "verified" ? selectedA.value.operations.map((operation) => operation.writerId).sort() : [],
		[WRITER_A, WRITER_B],
	);
	assert.equal(
		selectedA.kind === "verified" && selectedB.kind === "verified"
			? selectedA.value.generationRef.sha256 === selectedB.value.generationRef.sha256
			: false,
		true,
	);
});

test("only the control authority can finalize an equivalent migration generation", async () => {
	const replicaA = new CatalogV2ReplicaVault();
	const protocolA = new CatalogV2VaultProtocol(replicaA.app);
	const contextA = await protocolA.initializeVault({
		catalogDataRoot: "Memos/_knomo-data",
		contract: makeContract(),
		initialWriterId: WRITER_A,
		createdAt: time(0),
		vaultInstanceId: VAULT_ID,
	});
	const replicaB = new CatalogV2ReplicaVault(replicaA.snapshot());
	const protocolB = new CatalogV2VaultProtocol(replicaB.app);
	const loadedB = await protocolB.loadVaultContext();
	if (loadedB.kind !== "ready") throw new Error("missing test context");
	const result = await makeMigrationResult();
	if (result.kind !== "imported") throw new Error("invalid migration fixture");
	const commitA = await buildMigrationCommit({
		writerId: WRITER_A,
		committedAt: time(1),
		results: [result],
		verification: TEST_MIGRATION_VERIFICATION,
	});
	const commitB = await buildMigrationCommit({
		writerId: WRITER_B,
		committedAt: time(2),
		results: [result],
		verification: TEST_MIGRATION_VERIFICATION,
	});
	assert.equal(commitA.commit.generationDigest, commitB.commit.generationDigest);
	await protocolA.writeImmutable(`Memos/_knomo-data/${result.packagePath}`, result.packageBytes);
	await protocolB.writeImmutable(`Memos/_knomo-data/${result.packagePath}`, result.packageBytes);
	const commitRefA = await protocolA.writeImmutable(`Memos/_knomo-data/${commitA.path}`, commitA.bytes);
	const commitRefB = await protocolB.writeImmutable(`Memos/_knomo-data/${commitB.path}`, commitB.bytes);
	await new CatalogV2ImmutableStateWriter(protocolA, () => contextA).commitMigration(
		WRITER_A,
		commitRefA,
		commitA.commit.generationDigest,
		["legacy-memo-1"],
	);
	await assert.rejects(new CatalogV2ImmutableStateWriter(protocolB, () => loadedB.context).commitMigration(
		WRITER_B,
		commitRefB,
		commitB.commit.generationDigest,
		["legacy-memo-1"],
	), /control authority/u);
	replicaB.deliverFrom(replicaA);
	replicaA.deliverFrom(replicaB);
	replicaB.deliverFrom(replicaA);
	assert.equal((await protocolA.selectGeneration(contextA)).kind, "verified");
	const selectedA = await protocolA.selectGeneration(contextA);
	const selectedB = await protocolB.selectGeneration(loadedB.context);
	assert.equal(selectedA.kind, "verified", JSON.stringify(selectedA));
	assert.equal(selectedB.kind, "verified", JSON.stringify(selectedB));
	assert.equal(selectedA.kind === "verified" && selectedB.kind === "verified"
		? selectedA.value.generationRef.sha256 === selectedB.value.generationRef.sha256
		: false, true);
});

test("explicit authority transfer advances the epoch and fences the former writer", async () => {
	const replica = new CatalogV2ReplicaVault();
	const protocol = new CatalogV2VaultProtocol(replica.app);
	const context = await protocol.initializeVault({
		catalogDataRoot: "Memos/_knomo-data",
		contract: makeContract(),
		initialWriterId: WRITER_A,
		createdAt: time(0),
		vaultInstanceId: VAULT_ID,
	});
	await new CatalogV2ImmutableStateWriter(protocol, () => context).reconcile(WRITER_A);
	const request = await protocol.requestAuthorityTransfer(
		context,
		WRITER_B,
		time(1),
		"o_90000000000000000000000000000001",
	);
	const transferred = await protocol.transferAuthority(
		context,
		WRITER_A,
		request,
		time(2),
		"o_90000000000000000000000000000002",
	);

	assert.equal(transferred.generation.authorityWriterId, WRITER_B);
	assert.equal(transferred.generation.authorityEpoch, 2);
	assert.deepEqual(transferred.generation.writerFrontier.map((item) => item.writerId), [WRITER_A, WRITER_B]);
	const refreshed = await protocol.loadVaultContext();
	assert.equal(refreshed.kind, "ready");
	if (refreshed.kind !== "ready") throw new Error("missing transferred context");
	await assert.rejects(protocol.authorizeControlAction(refreshed.context, WRITER_A, {
		actionId: "o_90000000000000000000000000000003",
		kind: "identity_adoption",
		inputDigest: "a".repeat(64),
		memoIds: ["memo-old-authority"],
	}), /not the current Catalog control authority/u);
});

test("a higher authority epoch wins over a stale same-parent control branch", async () => {
	const replicaA = new CatalogV2ReplicaVault();
	const protocolA = new CatalogV2VaultProtocol(replicaA.app);
	const contextA = await protocolA.initializeVault({
		catalogDataRoot: "Memos/_knomo-data",
		contract: makeContract(),
		initialWriterId: WRITER_A,
		createdAt: time(0),
		vaultInstanceId: VAULT_ID,
	});
	await new CatalogV2ImmutableStateWriter(protocolA, () => contextA).reconcile(WRITER_A);
	const replicaB = new CatalogV2ReplicaVault(replicaA.snapshot());
	const protocolB = new CatalogV2VaultProtocol(replicaB.app);
	const loadedB = await protocolB.loadVaultContext();
	if (loadedB.kind !== "ready") throw new Error("missing replica B context");

	await protocolA.authorizeControlAction(contextA, WRITER_A, {
		actionId: "o_91000000000000000000000000000001",
		kind: "identity_adoption",
		inputDigest: "1".repeat(64),
		memoIds: ["memo-stale-branch"],
	});
	const request = await protocolB.requestAuthorityTransfer(
		loadedB.context,
		WRITER_B,
		time(1),
		"o_91000000000000000000000000000002",
	);
	await protocolB.transferAuthority(
		loadedB.context,
		WRITER_A,
		request,
		time(2),
		"o_91000000000000000000000000000003",
	);
	replicaA.deliverFrom(replicaB);
	replicaB.deliverFrom(replicaA);

	const selectedA = await protocolA.loadVaultContext();
	const selectedB = await protocolB.loadVaultContext();
	assert.equal(selectedA.kind, "ready", JSON.stringify(selectedA));
	assert.equal(selectedB.kind, "ready", JSON.stringify(selectedB));
	assert.equal(selectedA.kind === "ready" ? selectedA.context.control.generation.authorityWriterId : null, WRITER_B);
	assert.equal(selectedB.kind === "ready" ? selectedB.context.control.generation.authorityEpoch : null, 2);
});

test("an ordinary mutation created before a later control commit remains mergeable", async () => {
	const replicaA = new CatalogV2ReplicaVault();
	const protocolA = new CatalogV2VaultProtocol(replicaA.app);
	const contextA = await protocolA.initializeVault({
		catalogDataRoot: "Memos/_knomo-data",
		contract: makeContract(),
		initialWriterId: WRITER_A,
		createdAt: time(0),
		vaultInstanceId: VAULT_ID,
	});
	await new CatalogV2ImmutableStateWriter(protocolA, () => contextA).reconcile(WRITER_A);
	const replicaB = new CatalogV2ReplicaVault(replicaA.snapshot());
	const protocolB = new CatalogV2VaultProtocol(replicaB.app);
	const loadedB = await protocolB.loadVaultContext();
	if (loadedB.kind !== "ready") throw new Error("missing replica B context");
	const contextB = loadedB.context;

	const storeB = new CatalogV2SharedMutationStore(replicaB.app, protocolB, () => contextB);
	const evidence = makeEvidence("2".repeat(64));
	const memoId = await deriveObservationMemoId(VAULT_ID, contextB.contractSha256, evidence);
	const prepare = { ...makeCreatePrepare(memoId, evidence), preparedByWriterId: WRITER_B };
	const prepareRef = await storeB.prepare(prepare);
	const commitRef = await storeB.commit({
		kind: "knomo.catalog-v2.mutation-commit",
		schemaVersion: 2,
		vaultInstanceId: VAULT_ID,
		mutationId: prepare.mutationId,
		prepare: prepareRef,
		control: null,
	});
	await new CatalogV2ImmutableStateWriter(protocolB, () => contextB).commitSharedMutation(WRITER_B, commitRef, [memoId]);

	await protocolA.authorizeControlAction(contextA, WRITER_A, {
		actionId: "o_92000000000000000000000000000001",
		kind: "identity_adoption",
		inputDigest: "9".repeat(64),
		memoIds: ["memo-authorized-elsewhere"],
	});
	replicaA.deliverFrom(replicaB);
	replicaB.deliverFrom(replicaA);
	const refreshedA = await protocolA.loadVaultContext();
	if (refreshedA.kind !== "ready") throw new Error("missing refreshed replica A context");
	const selected = await protocolA.selectGeneration(refreshedA.context);
	assert.equal(selected.kind, "verified", JSON.stringify(selected));
	assert.equal(selected.kind === "verified"
		? selected.value.operations.some((operation) => operation.memoId === memoId)
		: false, true);
});

test("a contract control commit preserves its anchored state and fences later stale-contract writes", async () => {
	const replicaA = new CatalogV2ReplicaVault();
	const protocolA = new CatalogV2VaultProtocol(replicaA.app);
	const contextA = await protocolA.initializeVault({
		catalogDataRoot: "Memos/_knomo-data",
		contract: makeContract(),
		initialWriterId: WRITER_A,
		createdAt: time(0),
		vaultInstanceId: VAULT_ID,
	});
	await new CatalogV2ImmutableStateWriter(protocolA, () => contextA).append(makeReview(WRITER_A, 1));
	const replicaB = new CatalogV2ReplicaVault(replicaA.snapshot());
	const protocolB = new CatalogV2VaultProtocol(replicaB.app);
	const loadedB = await protocolB.loadVaultContext();
	if (loadedB.kind !== "ready") throw new Error("missing replica B context");

	const nextContract = {
		...makeContract(),
		daily: { ...makeContract().daily, folder: "Journal" },
	};
	const updatedControl = await protocolA.updateContract(
		contextA,
		WRITER_A,
		nextContract,
		time(2),
		"o_93000000000000000000000000000001",
	);
	await new CatalogV2ImmutableStateWriter(protocolB, () => loadedB.context).append(makeReview(WRITER_A, 2));
	replicaA.deliverFrom(replicaB);

	const refreshedA = await protocolA.loadVaultContext();
	if (refreshedA.kind !== "ready") throw new Error("missing refreshed replica A context");
	const anchored = await protocolA.selectGeneration(refreshedA.context);
	assert.equal(anchored.kind, "verified", JSON.stringify(anchored));
	assert.deepEqual(anchored.kind === "verified"
		? anchored.value.operations.map((operation) => operation.sequence)
		: [], [1]);

	const bridged = await new CatalogV2ImmutableStateWriter(protocolA, () => refreshedA.context).reconcile(WRITER_A);
	assert.notEqual(bridged, null);
	const selected = await protocolA.selectGeneration(refreshedA.context);
	assert.equal(selected.kind, "verified", JSON.stringify(selected));
	assert.deepEqual(selected.kind === "verified"
		? selected.value.operations.map((operation) => operation.sequence)
		: [], [1]);
	assert.equal(selected.kind === "verified"
		? selected.value.generation.contract.sha256
		: null, updatedControl.generation.contract.sha256);
});

test("a shared mutation can only be published by the current authority", async () => {
	const replica = new CatalogV2ReplicaVault();
	const protocol = new CatalogV2VaultProtocol(replica.app);
	const context = await protocol.initializeVault({
		catalogDataRoot: "Memos/_knomo-data",
		contract: makeContract(),
		initialWriterId: WRITER_A,
		createdAt: time(0),
		vaultInstanceId: VAULT_ID,
	});
	const writer = new CatalogV2ImmutableStateWriter(protocol, () => context);
	await writer.reconcile(WRITER_A);
	await assert.rejects(writer.commitSharedMutation(WRITER_B, {
		path: "Memos/_knomo-data/mutations/o_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/commit-a.json",
		sha256: "a".repeat(64),
		byteLength: 1,
	}, ["memo-b"], true), /current control authority/u);
});

test("a non-authority writer can publish an ordinary shared mutation", async () => {
	const replica = new CatalogV2ReplicaVault();
	const protocol = new CatalogV2VaultProtocol(replica.app);
	const context = await protocol.initializeVault({
		catalogDataRoot: "Memos/_knomo-data",
		contract: makeContract(),
		initialWriterId: WRITER_A,
		createdAt: time(0),
		vaultInstanceId: VAULT_ID,
	});
	const writer = new CatalogV2ImmutableStateWriter(protocol, () => context);
	await writer.reconcile(WRITER_A);
	const store = new CatalogV2SharedMutationStore(replica.app, protocol, () => context);
	const evidence = makeEvidence("2".repeat(64));
	const memoId = await deriveObservationMemoId(VAULT_ID, context.contractSha256, evidence);
	const prepare = { ...makeCreatePrepare(memoId, evidence), preparedByWriterId: WRITER_B };
	const prepareRef = await store.prepare(prepare);
	const commitRef = await store.commit({
		kind: "knomo.catalog-v2.mutation-commit",
		schemaVersion: 2,
		vaultInstanceId: VAULT_ID,
		mutationId: prepare.mutationId,
		prepare: prepareRef,
		control: null,
	});

	await writer.commitSharedMutation(WRITER_B, commitRef, [memoId]);
	assert.equal((await protocol.selectGeneration(context)).kind, "verified");
});

test("a prepared create is recoverable on another replica without any local IndexedDB state", async () => {
	const replicaA = new CatalogV2ReplicaVault();
	const protocolA = new CatalogV2VaultProtocol(replicaA.app);
	let contextA = await protocolA.initializeVault({
		catalogDataRoot: "Memos/_knomo-data",
		contract: makeContract(),
		initialWriterId: WRITER_A,
		createdAt: time(0),
		vaultInstanceId: VAULT_ID,
	});
	await new CatalogV2ImmutableStateWriter(protocolA, () => contextA).reconcile(WRITER_A);
	const storeA = new CatalogV2SharedMutationStore(replicaA.app, protocolA, () => contextA);
	const evidence = makeEvidence("2".repeat(64));
	const memoId = await deriveObservationMemoId(VAULT_ID, contextA.contractSha256, evidence);
	const prepare = makeCreatePrepare(memoId, evidence);
	const prepareRef = await storeA.prepare(prepare);

	const replicaB = new CatalogV2ReplicaVault(replicaA.snapshot());
	const protocolB = new CatalogV2VaultProtocol(replicaB.app);
	let loadedB = await protocolB.loadVaultContext();
	if (loadedB.kind !== "ready") throw new Error("missing replica B context");
	let contextB = loadedB.context;
	const storeB = new CatalogV2SharedMutationStore(replicaB.app, protocolB, () => contextB);
	const inspection = await storeB.inspect();
	assert.equal(inspection.records.length, 1);
	assert.equal(inspection.records[0]?.prepare.memoId, memoId);
	assert.deepEqual(inspection.missingCommitMutationIds, [prepare.mutationId]);
	const commitRef = await storeB.commit({
		kind: "knomo.catalog-v2.mutation-commit",
		schemaVersion: 2,
		vaultInstanceId: VAULT_ID,
		mutationId: prepare.mutationId,
		prepare: prepareRef,
		control: null,
	});
	await new CatalogV2ImmutableStateWriter(protocolB, () => contextB).commitSharedMutation(
		WRITER_A,
		commitRef,
		[memoId],
	);
	loadedB = await protocolB.loadVaultContext();
	if (loadedB.kind !== "ready") throw new Error("missing refreshed replica B context");
	contextB = loadedB.context;
	const selected = await protocolB.selectGeneration(contextB);
	assert.equal(selected.kind, "verified", JSON.stringify(selected));
	assert.deepEqual(selected.kind === "verified"
		? selected.value.operations.map((operation) => operation.type)
		: [], ["lifecycle.create_intent", "identity.claim"]);
});

test("shared mutation inspection isolates malformed, orphaned, duplicate, and digest-mismatched artifacts", async () => {
	const replica = new CatalogV2ReplicaVault();
	const protocol = new CatalogV2VaultProtocol(replica.app);
	const context = await protocol.initializeVault({
		catalogDataRoot: "Memos/_knomo-data",
		contract: makeContract(),
		initialWriterId: WRITER_A,
		createdAt: time(0),
		vaultInstanceId: VAULT_ID,
	});
	const store = new CatalogV2SharedMutationStore(replica.app, protocol, () => context);
	const valid = makeCreatePrepare("memo-valid", makeEvidence("2".repeat(64)));
	const validRef = await store.prepare(valid);
	const mutationRoot = validRef.path.slice(0, validRef.path.lastIndexOf(`/${valid.mutationId}/`));

	const duplicate = {
		...valid,
		preparedAt: time(2),
	};
	const duplicateBytes = canonicalJsonFileBytes(duplicate);
	const duplicateDigest = await sha256Bytes(duplicateBytes);
	await protocol.writeImmutable(
		`${mutationRoot}/${valid.mutationId}/prepare-${duplicateDigest}.json`,
		duplicateBytes,
	);

	const orphanMutationId = "o_98000000000000000000000000000009";
	const orphanCommit = {
		kind: "knomo.catalog-v2.mutation-commit",
		schemaVersion: 2,
		vaultInstanceId: VAULT_ID,
		mutationId: orphanMutationId,
		prepare: {
			path: `${mutationRoot}/${orphanMutationId}/prepare-${"1".repeat(64)}.json`,
			sha256: "1".repeat(64),
			byteLength: 1,
		},
		control: null,
	} as const;
	const orphanBytes = canonicalJsonFileBytes(orphanCommit);
	const orphanDigest = await sha256Bytes(orphanBytes);
	await protocol.writeImmutable(
		`${mutationRoot}/${orphanMutationId}/commit-${orphanDigest}.json`,
		orphanBytes,
	);

	const badMutationId = "o_98000000000000000000000000000008";
	await protocol.writeImmutable(
		`${mutationRoot}/${badMutationId}/prepare-${"f".repeat(64)}.json`,
		new TextEncoder().encode("{}\n"),
	);

	const inspection = await store.inspect();
	assert.deepEqual(inspection.records, []);
	assert.deepEqual(inspection.missingPrepareMutationIds, [orphanMutationId]);
	assert.deepEqual(inspection.missingCommitMutationIds, []);
	assert.equal(inspection.issues.some((issue) => issue.kind === "duplicate_artifact"
		&& issue.mutationId === valid.mutationId), true);
	assert.equal(inspection.issues.some((issue) => issue.kind === "digest_mismatch"
		&& issue.mutationId === badMutationId), true);
	assert.equal(inspection.affectedMemoIds.includes("memo-valid"), true);
	assert.equal(inspection.affectedPaths.some((path) => path.includes(valid.mutationId)), true);
});

test("a generation stays awaiting until its referenced mutation prepare arrives", async () => {
	const replicaA = new CatalogV2ReplicaVault();
	const protocolA = new CatalogV2VaultProtocol(replicaA.app);
	let contextA = await protocolA.initializeVault({
		catalogDataRoot: "Memos/_knomo-data",
		contract: makeContract(),
		initialWriterId: WRITER_A,
		createdAt: time(0),
		vaultInstanceId: VAULT_ID,
	});
	await new CatalogV2ImmutableStateWriter(protocolA, () => contextA).reconcile(WRITER_A);
	const storeA = new CatalogV2SharedMutationStore(replicaA.app, protocolA, () => contextA);
	const evidence = makeEvidence("2".repeat(64));
	const memoId = await deriveObservationMemoId(VAULT_ID, contextA.contractSha256, evidence);
	const prepare = makeCreatePrepare(memoId, evidence);
	const prepareRef = await storeA.prepare(prepare);
	const commitRef = await storeA.commit({
		kind: "knomo.catalog-v2.mutation-commit",
		schemaVersion: 2,
		vaultInstanceId: VAULT_ID,
		mutationId: prepare.mutationId,
		prepare: prepareRef,
		control: null,
	});
	await new CatalogV2ImmutableStateWriter(protocolA, () => contextA).commitSharedMutation(WRITER_A, commitRef, [memoId]);
	const replicaB = new CatalogV2ReplicaVault();
	replicaB.deliverFrom(replicaA, replicaA.paths().filter((path) => path !== prepareRef.path));
	const protocolB = new CatalogV2VaultProtocol(replicaB.app);
	const loadedB = await protocolB.loadVaultContext();
	if (loadedB.kind !== "ready") throw new Error("missing replica B context");
	const awaiting = await protocolB.selectGeneration(loadedB.context);
	assert.equal(awaiting.kind, "awaiting_data", JSON.stringify(awaiting));
	assert.equal(awaiting.kind === "awaiting_data" ? awaiting.missingPaths.includes(prepareRef.path) : false, true);
	replicaB.deliverFrom(replicaA, [prepareRef.path]);
	assert.equal((await protocolB.selectGeneration(loadedB.context)).kind, "verified");
});

test("commit and abandon are mutually exclusive and cannot both become trusted state", async () => {
	const replica = new CatalogV2ReplicaVault();
	const protocol = new CatalogV2VaultProtocol(replica.app);
	const context = await protocol.initializeVault({
		catalogDataRoot: "Memos/_knomo-data",
		contract: makeContract(),
		initialWriterId: WRITER_A,
		createdAt: time(0),
		vaultInstanceId: VAULT_ID,
	});
	const store = new CatalogV2SharedMutationStore(replica.app, protocol, () => context);
	const evidence = makeEvidence("2".repeat(64));
	const memoId = await deriveObservationMemoId(VAULT_ID, context.contractSha256, evidence);
	const prepare = makeCreatePrepare(memoId, evidence);
	const prepareRef = await store.prepare(prepare);
	await store.abandon({
		kind: "knomo.catalog-v2.mutation-abandon",
		schemaVersion: 2,
		vaultInstanceId: VAULT_ID,
		mutationId: prepare.mutationId,
		prepare: prepareRef,
		reason: "user_cancelled",
	});
	await assert.rejects(store.commit({
		kind: "knomo.catalog-v2.mutation-commit",
		schemaVersion: 2,
		vaultInstanceId: VAULT_ID,
		mutationId: prepare.mutationId,
		prepare: prepareRef,
		control: null,
	}), /Abandoned mutation/u);
});

test("a late abandon invalidates a generation that already references the same mutation commit", async () => {
	const replica = new CatalogV2ReplicaVault();
	const protocol = new CatalogV2VaultProtocol(replica.app);
	const context = await protocol.initializeVault({
		catalogDataRoot: "Memos/_knomo-data",
		contract: makeContract(),
		initialWriterId: WRITER_A,
		createdAt: time(0),
		vaultInstanceId: VAULT_ID,
	});
	await new CatalogV2ImmutableStateWriter(protocol, () => context).reconcile(WRITER_A);
	const store = new CatalogV2SharedMutationStore(replica.app, protocol, () => context);
	const evidence = makeEvidence("2".repeat(64));
	const memoId = await deriveObservationMemoId(VAULT_ID, context.contractSha256, evidence);
	const prepare = makeCreatePrepare(memoId, evidence);
	const prepareRef = await store.prepare(prepare);
	const commitRef = await store.commit({
		kind: "knomo.catalog-v2.mutation-commit",
		schemaVersion: 2,
		vaultInstanceId: VAULT_ID,
		mutationId: prepare.mutationId,
		prepare: prepareRef,
		control: null,
	});
	await new CatalogV2ImmutableStateWriter(protocol, () => context).commitSharedMutation(WRITER_A, commitRef, [memoId]);
	const { canonicalJsonFileBytes, sha256Bytes } = await import("../src/services/CatalogV2Protocol");
	const abandonBytes = canonicalJsonFileBytes({
		kind: "knomo.catalog-v2.mutation-abandon",
		schemaVersion: 2,
		vaultInstanceId: VAULT_ID,
		mutationId: prepare.mutationId,
		prepare: prepareRef,
		reason: "user_cancelled",
	});
	const abandonDigest = await sha256Bytes(abandonBytes);
	const mutationRoot = prepareRef.path.slice(0, prepareRef.path.lastIndexOf("/"));
	await protocol.writeImmutable(
		`${mutationRoot}/abandon-${abandonDigest}.json`,
		abandonBytes,
	);

	const selected = await protocol.selectGeneration(context);
	assert.equal(selected.kind, "invalid", JSON.stringify(selected));
	assert.equal(selected.kind === "invalid"
		? selected.reasons.some((reason) => reason.includes("mutation_commit_abandon_conflict"))
		: false, true);
});

test("direct manual identity operations are rejected before any shared segment is written", async () => {
	const replica = new CatalogV2ReplicaVault();
	const protocol = new CatalogV2VaultProtocol(replica.app);
	const context = await protocol.initializeVault({
		catalogDataRoot: "Memos/_knomo-data",
		contract: makeContract(),
		initialWriterId: WRITER_A,
		createdAt: time(0),
		vaultInstanceId: VAULT_ID,
	});
	const before = replica.paths();
	await assert.rejects(new CatalogV2ImmutableStateWriter(protocol, () => context).append({
		schemaVersion: 1,
		writerId: WRITER_A,
		sequence: 1,
		opId: "o_99000000000000000000000000000001",
		memoId: "memo-manual",
		occurredAt: time(1),
		type: "identity.claim",
		baseEvidence: null,
		payload: {
			evidence: makeEvidence("1".repeat(64)),
			origin: "manual_adoption",
			createIntentOpId: null,
		},
	}), /shared mutation/u);
	assert.deepEqual(replica.paths(), before);
});

test("state writer refuses shared mutations without a verified bootstrap", async () => {
	const replica = new CatalogV2ReplicaVault();
	const writer = new CatalogV2ImmutableStateWriter(new CatalogV2VaultProtocol(replica.app), () => null);
	await assert.rejects(writer.append(makeReview(WRITER_A, 1)), /bootstrap is not verified/u);
	assert.deepEqual(replica.paths(), []);
});

function makeReview(writerId: string, sequence: number): StateOperation {
	return {
		schemaVersion: 1,
		writerId,
		sequence,
		opId: `o_${writerId === WRITER_A ? "1" : "2"}${sequence.toString(16).padStart(31, "0")}`,
		memoId: `memo-${writerId}`,
		occurredAt: time(sequence),
		type: "review.record",
		baseEvidence: null,
		payload: { reviewedAt: time(sequence) },
	};
}

function makeEvidence(sourceRevision: string): IdentityEvidence {
	return {
		sourcePath: "Daily/2026-08-11.md",
		sourceRevision,
		logicalDate: "2026-08-11",
		section: "## Memos",
		startLine: 2,
		endLine: 2,
		time: "00:00",
		contentHash: "fnv1a-1234abcd",
		existingBlockId: null,
	};
}

function makeCreatePrepare(memoId: string, evidence: IdentityEvidence): CatalogV2MutationPrepareArtifact {
	const mutationId = "o_98000000000000000000000000000001";
	const intentId = "o_98000000000000000000000000000002";
	return {
		kind: "knomo.catalog-v2.mutation-prepare",
		schemaVersion: 2,
		vaultInstanceId: VAULT_ID,
		mutationId,
		mutationKind: "create",
		memoId,
		changes: [{
			transition: {
				sourcePath: evidence.sourcePath,
				logicalDate: evidence.logicalDate,
				headings: ["## Memos"],
				beforeRevision: "1".repeat(64),
				afterRevision: evidence.sourceRevision,
				beforeEvidence: null,
				afterEvidence: evidence,
				baseBindingId: null,
				baseEvidence: null,
				preservedEvidence: [],
			},
			replay: { kind: "insert", rawBlock: "00:00 created", section: "## Memos" },
		}],
		effectDrafts: [{
			opId: intentId,
			memoId,
			occurredAt: time(1),
			type: "lifecycle.create_intent",
			baseEvidence: null,
			payload: {
				evidence,
				targetPath: evidence.sourcePath,
				logicalDate: evidence.logicalDate,
				time: evidence.time,
				contentHash: evidence.contentHash,
				sourceMemoId: null,
			},
		}, {
			opId: mutationId,
			memoId,
			occurredAt: time(1),
			type: "identity.claim",
			baseEvidence: null,
			payload: {
				evidence,
				origin: "plugin_create",
				createIntentOpId: intentId,
			},
		}],
		preparedByWriterId: WRITER_A,
		preparedAt: time(1),
	};
}

function time(offset: number): string {
	return `2026-08-11T00:00:0${offset}.000Z`;
}

function makeContract(): CatalogV2VaultContract {
	return {
		kind: "knomo.catalog-v2.vault-contract",
		schemaVersion: 2,
		parserVersion: 1,
		daily: { folder: "Daily", dateFormat: "YYYY-MM-DD", headings: ["## Memos"], allowRootMemos: true },
		monthly: {
			folder: "Memos",
			fileFormat: "Memos-YYYY-MM.md",
			dateHeadingFormat: "## [[YYYY-MM-DD]]",
			dateOrder: "asc",
			rendererVersion: 1,
			newline: "lf",
		},
	};
}
