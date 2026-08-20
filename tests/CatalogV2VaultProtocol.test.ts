import assert from "node:assert/strict";
import test from "node:test";
import { TFile, TFolder } from "obsidian";
import type { App, TAbstractFile } from "obsidian";

import {
	assertControlGeneration,
	assertStateGeneration,
	assertVaultBootstrap,
	CatalogV2VaultProtocol,
	type CatalogV2InitializeVaultInput,
} from "../src/services/CatalogV2VaultProtocol";
import { buildMigrationCommit } from "../src/services/CatalogV2Migration";
import { canonicalJson, canonicalJsonFileBytes, sha256Bytes, sha256Text } from "../src/services/CatalogV2Protocol";
import type { ArtifactRef, StateOperation } from "../src/types/catalogV2";
import type {
	CatalogV2ImmutableStateSegment,
	CatalogV2StateGeneration,
	CatalogV2VaultContract,
	CatalogV2WriterHead,
} from "../src/types/catalogV2Protocol";
import {
	getCatalogBootstrapPath,
	getCatalogWriterHeadPath,
	getCatalogWriterSegmentPath,
} from "../src/utils/path";
import {
	makeMigrationResult,
	TEST_MIGRATION_VERIFICATION,
} from "./helpers/CatalogV2MigrationFixture";

const WRITER_A = "w_00000000000000000000000000000001";
const WRITER_B = "w_00000000000000000000000000000002";
const CREATED_AT = "2026-08-11T00:00:00.000Z";

test("Vault bootstrap uses one fixed locator and does not infer a fresh Vault from absence", async () => {
	const harness = createVaultHarness();
	const protocol = new CatalogV2VaultProtocol(harness.app);

	assert.deepEqual(await protocol.loadVaultContext(), { kind: "missing" });
	assert.deepEqual(harness.listPaths(), []);

	const context = await protocol.initializeVault(makeInitializeInput());
	assert.equal(context.bootstrap.catalogDataRoot, "Memos/_knomo-data");
	assert.equal(context.bootstrap.vaultInstanceId, "v_00000000000000000000000000000001");
	assert.equal(harness.hasFile(getCatalogBootstrapPath()), true);
	assert.equal((await protocol.loadVaultContext()).kind, "ready");
});

test("冻结 schema 拒绝开发期 Monthly authority/control 字段", async () => {
	const protocol = new CatalogV2VaultProtocol(createVaultHarness().app);
	const context = await protocol.initializeVault(makeInitializeInput());
	assert.throws(() => assertVaultBootstrap({
		...context.bootstrap,
		projectionAuthorityWriterId: WRITER_A,
	}), /Invalid Catalog v2 Vault bootstrap/u);
	assert.throws(() => assertControlGeneration({
		...context.control.generation,
		action: { ...context.control.generation.action, period: null },
	}), /Invalid Catalog v2 control generation/u);
	assert.throws(() => assertStateGeneration({
		...makeGeneration(context, [{
			writerId: WRITER_A,
			registration: context.control.generation.writerFrontier[0]?.registration,
			head: null,
			affectedMemoIds: [],
		}]),
		projectionAuthorityWriterId: WRITER_A,
	}), /Invalid Catalog v2 state generation/u);
});

test("unsupported parser and renderer contract versions are rejected", async () => {
	const parserProtocol = new CatalogV2VaultProtocol(createVaultHarness().app);
	await assert.rejects(parserProtocol.initializeVault({
		...makeInitializeInput(),
		contract: { ...makeContract(), parserVersion: 2 },
	}), /Invalid Catalog v2 Vault contract/u);
	const rendererProtocol = new CatalogV2VaultProtocol(createVaultHarness().app);
	const contract = makeContract();
	await assert.rejects(rendererProtocol.initializeVault({
		...makeInitializeInput(),
		contract: { ...contract, monthly: { ...contract.monthly, rendererVersion: 2 } },
	}), /Invalid Catalog v2 Vault contract/u);
});

test("a second bootstrap candidate is attention instead of silently choosing a Vault identity", async () => {
	const harness = createVaultHarness();
	const protocol = new CatalogV2VaultProtocol(harness.app);
	const context = await protocol.initializeVault(makeInitializeInput());
	const conflicting = {
		...context.bootstrap,
		vaultInstanceId: "v_00000000000000000000000000000002",
	};
	harness.addFile("_knomo-data/manifest conflict.json", new TextDecoder().decode(canonicalJsonFileBytes(conflicting)));

	const result = await protocol.loadVaultContext();
	assert.equal(result.kind, "attention");
	assert.equal(result.kind === "attention" && result.reasons.includes("multiple_bootstrap_candidates"), true);
});

test("a canonical bootstrap with a missing contract waits for sync", async () => {
	const harness = createVaultHarness();
	const protocol = new CatalogV2VaultProtocol(harness.app);
	const bootstrap = {
		kind: "knomo.catalog-v2.vault-bootstrap",
		schemaVersion: 2,
		protocolVersion: 2,
		initializationMode: "native",
		vaultInstanceId: "v_00000000000000000000000000000001",
		catalogDataRoot: "Memos/_knomo-data",
		contract: { path: "Memos/_knomo-data/contracts/contract-missing.json", sha256: "a".repeat(64), byteLength: 1 },
		controlGenesis: { path: "Memos/_knomo-data/protocol/control/generations/control-missing.json", sha256: "b".repeat(64), byteLength: 1 },
		initialWriterId: WRITER_A,
		createdAt: CREATED_AT,
	};
	harness.addFile(getCatalogBootstrapPath(), new TextDecoder().decode(canonicalJsonFileBytes(bootstrap)));

	const result = await protocol.loadVaultContext();
	assert.deepEqual(result, { kind: "awaiting_data", missingPaths: [bootstrap.contract.path] });
});

test("a conflict-named bootstrap without the canonical locator is attention", async () => {
	const harness = createVaultHarness();
	const protocol = new CatalogV2VaultProtocol(harness.app);
	const context = await protocol.initializeVault(makeInitializeInput());
	const canonical = getCatalogBootstrapPath();
	const conflict = "_knomo-data/manifest conflict.json";
	const content = harness.readFile(canonical);
	if (content === null) throw new Error("Expected canonical bootstrap.");
	harness.deleteFile(canonical);
	harness.addFile(conflict, content);

	assert.deepEqual(await protocol.loadVaultContext(), { kind: "attention", reasons: ["canonical_bootstrap_missing"] });
	assert.equal(context.bootstrap.vaultInstanceId.length > 0, true);
});

test("verified generation materializes only immutable writer chains", async () => {
	const harness = createVaultHarness();
	const protocol = new CatalogV2VaultProtocol(harness.app);
	const context = await protocol.initializeVault(makeInitializeInput());
	const registration = await protocol.ensureWriterRegistration(context, WRITER_A, CREATED_AT);
	const operation = makeOperation(WRITER_A, 1);
	const segment = await writeSegment(protocol, context.bootstrap.vaultInstanceId, operation, null);
	const head = await writeHead(protocol, context.bootstrap.vaultInstanceId, operation, segment, null);
	const generation = makeGeneration(context, [{
		writerId: WRITER_A,
		registration,
		head,
		affectedMemoIds: [operation.memoId],
	}]);
	const generationRef = await protocol.writeGeneration(context, generation);

	const selected = await protocol.selectGeneration(context);
	assert.equal(selected.kind, "verified", JSON.stringify(selected));
	assert.equal(selected.kind === "verified" ? selected.value.generationRef.sha256 : null, generationRef.sha256);
	assert.deepEqual(selected.kind === "verified" ? selected.value.operations : [], [operation]);
});

test("a generation that names an entirely missing writer remains awaiting data", async () => {
	const harness = createVaultHarness();
	const protocol = new CatalogV2VaultProtocol(harness.app);
	const context = await protocol.initializeVault(makeInitializeInput());
	const registration = await protocol.ensureWriterRegistration(context, WRITER_A, CREATED_AT);
	const missingRegistration: ArtifactRef = {
		path: "Memos/_knomo-data/state/writers/w_00000000000000000000000000000002/registration-missing.json",
		sha256: "f".repeat(64),
		byteLength: 1,
	};
	const missingHead: ArtifactRef = {
		path: "Memos/_knomo-data/state/writers/w_00000000000000000000000000000002/heads/head-000001-missing.json",
		sha256: "e".repeat(64),
		byteLength: 1,
	};
	const generation = makeGeneration(context, [
		{ writerId: WRITER_A, registration, head: null, affectedMemoIds: [] },
		{ writerId: WRITER_B, registration: missingRegistration, head: missingHead, affectedMemoIds: ["memo-missing"] },
	]);
	await protocol.writeGeneration(context, generation);

	const selected = await protocol.selectGeneration(context);
	assert.equal(selected.kind, "awaiting_data");
	assert.deepEqual(selected.kind === "awaiting_data" ? selected.missingPaths : [], [missingRegistration.path]);
	assert.deepEqual(selected.kind === "awaiting_data" ? selected.affectedMemoIds : null, ["memo-missing"]);
});

test("a migration generation stays scoped awaiting until every committed artifact arrives", async () => {
	const harness = createVaultHarness();
	const protocol = new CatalogV2VaultProtocol(harness.app);
	const context = await protocol.initializeVault(makeInitializeInput());
	const registration = await protocol.ensureWriterRegistration(context, WRITER_A, CREATED_AT);
	const result = await makeMigrationResult();
	if (result.kind !== "imported") throw new Error("invalid migration fixture");
	const built = await buildMigrationCommit({
		writerId: WRITER_A,
		committedAt: CREATED_AT,
		results: [result],
		verification: TEST_MIGRATION_VERIFICATION,
	});
	const commitRef = await protocol.writeImmutable(
		`${context.bootstrap.catalogDataRoot}/${built.path}`,
		built.bytes,
	);
	const generation = makeGeneration(context, [{
		writerId: WRITER_A,
		registration,
		head: null,
		affectedMemoIds: [],
	}]);
	generation.migrationCommit = commitRef;
	generation.migrationGenerationDigest = built.commit.generationDigest;
	generation.migrationMemoIds = ["legacy-memo-1"];
	await protocol.writeGeneration(context, generation);

	const awaiting = await protocol.selectGeneration(context);
	assert.equal(awaiting.kind, "awaiting_data", JSON.stringify(awaiting));
	assert.deepEqual(awaiting.kind === "awaiting_data" ? awaiting.missingPaths : [], [
		`${context.bootstrap.catalogDataRoot}/${result.packagePath}`,
	]);
	assert.deepEqual(awaiting.kind === "awaiting_data" ? awaiting.affectedMemoIds : null, ["legacy-memo-1"]);

	await protocol.writeImmutable(`${context.bootstrap.catalogDataRoot}/${result.packagePath}`, result.packageBytes);
	assert.equal((await protocol.selectGeneration(context)).kind, "verified");
});

test("a digest-valid migration package with malformed nested evidence is invalid", async () => {
	const harness = createVaultHarness();
	const protocol = new CatalogV2VaultProtocol(harness.app);
	const context = await protocol.initializeVault(makeInitializeInput());
	const registration = await protocol.ensureWriterRegistration(context, WRITER_A, CREATED_AT);
	const result = await makeMigrationResult();
	if (result.kind !== "imported") throw new Error("invalid migration fixture");
	const packageValue = {
		...result.package,
		identityClaims: result.package.identityClaims.map((claim) => ({
			...claim,
			evidence: { ...claim.evidence, contentHash: "invalid" },
		})),
	};
	const packageBytes = canonicalJsonFileBytes(packageValue);
	const packageSha256 = await sha256Bytes(packageBytes);
	const built = await buildMigrationCommit({
		writerId: WRITER_A,
		committedAt: CREATED_AT,
		results: [{
			...result,
			package: packageValue,
			packageBytes,
			packageSha256,
			receipt: {
				...result.receipt,
				requiredArtifact: { path: result.packagePath, sha256: packageSha256, byteLength: packageBytes.byteLength },
			},
		}],
		verification: TEST_MIGRATION_VERIFICATION,
	});
	const commitRef = await protocol.writeImmutable(`${context.bootstrap.catalogDataRoot}/${built.path}`, built.bytes);
	await protocol.writeImmutable(`${context.bootstrap.catalogDataRoot}/${result.packagePath}`, packageBytes);
	const generation = makeGeneration(context, [{ writerId: WRITER_A, registration, head: null, affectedMemoIds: [] }]);
	generation.migrationCommit = commitRef;
	generation.migrationGenerationDigest = built.commit.generationDigest;
	generation.migrationMemoIds = ["legacy-memo-1"];
	await protocol.writeGeneration(context, generation);

	const selected = await protocol.selectGeneration(context);
	assert.equal(selected.kind, "invalid", JSON.stringify(selected));
	assert.equal(selected.kind === "invalid"
		&& selected.reasons.some((reason) => reason.includes("Invalid migration identity claim")), true);
});

test("a migration commit cannot assert domain counts that its packages do not reproduce", async () => {
	const harness = createVaultHarness();
	const protocol = new CatalogV2VaultProtocol(harness.app);
	const context = await protocol.initializeVault(makeInitializeInput());
	const registration = await protocol.ensureWriterRegistration(context, WRITER_A, CREATED_AT);
	const result = await makeMigrationResult();
	if (result.kind !== "imported") throw new Error("invalid migration fixture");
	const built = await buildMigrationCommit({
		writerId: WRITER_A,
		committedAt: CREATED_AT,
		results: [result],
		verification: TEST_MIGRATION_VERIFICATION,
	});
	const commit = {
		...built.commit,
		domainCounts: { ...built.commit.domainCounts, identityClaims: 0 },
	};
	commit.generationDigest = await sha256Text(canonicalJson({
		schemaVersion: commit.schemaVersion,
		importerVersion: commit.importerVersion,
		legacySources: commit.legacySources.map((source) => ({
			artifactDigest: source.artifactDigest,
			artifactKind: source.artifactKind,
			disposition: source.disposition,
			receiptSha256: source.receipt.sha256,
		})),
		requiredArtifacts: commit.requiredArtifacts,
		domainCounts: commit.domainCounts,
	}));
	const commitBytes = canonicalJsonFileBytes(commit);
	const commitRef = await protocol.writeImmutable(
		`${context.bootstrap.catalogDataRoot}/upgrade/checkpoints/commit-invalid-counts.json`,
		commitBytes,
	);
	await protocol.writeImmutable(`${context.bootstrap.catalogDataRoot}/${result.packagePath}`, result.packageBytes);
	const generation = makeGeneration(context, [{ writerId: WRITER_A, registration, head: null, affectedMemoIds: [] }]);
	generation.migrationCommit = commitRef;
	generation.migrationGenerationDigest = commit.generationDigest;
	generation.migrationMemoIds = ["legacy-memo-1"];
	await protocol.writeGeneration(context, generation);

	const selected = await protocol.selectGeneration(context);
	assert.equal(selected.kind, "invalid", JSON.stringify(selected));
	assert.equal(selected.kind === "invalid" && selected.reasons.includes("migration_domain_counts_mismatch"), true);
});

test("a generation is not verified before its complete parent chain arrives", async () => {
	const harness = createVaultHarness();
	const protocol = new CatalogV2VaultProtocol(harness.app);
	const context = await protocol.initializeVault(makeInitializeInput());
	const registration = await protocol.ensureWriterRegistration(context, WRITER_A, CREATED_AT);
	const parent = makeGeneration(context, [{ writerId: WRITER_A, registration, head: null, affectedMemoIds: [] }]);
	const parentBytes = canonicalJsonFileBytes(parent);
	const parentDigest = await sha256Bytes(parentBytes);
	const parentRef: ArtifactRef = {
		path: `Memos/_knomo-data/state/generations/generation-${parentDigest}.json`,
		sha256: parentDigest,
		byteLength: parentBytes.byteLength,
	};
	await protocol.writeGeneration(context, {
		...parent,
		parents: [parentRef],
		createdAt: "2026-08-11T00:01:00.000Z",
	});

	const awaiting = await protocol.selectGeneration(context);
	assert.equal(awaiting.kind, "awaiting_data", JSON.stringify(awaiting));
	assert.deepEqual(awaiting.kind === "awaiting_data" ? awaiting.missingPaths : [], [parentRef.path]);
	await protocol.writeImmutable(parentRef.path, parentBytes);
	assert.equal((await protocol.selectGeneration(context)).kind, "verified");
});

test("a child generation cannot remove a writer declared by its parent", async () => {
	const harness = createVaultHarness();
	const protocol = new CatalogV2VaultProtocol(harness.app);
	const context = await protocol.initializeVault(makeInitializeInput());
	const registrationA = await protocol.ensureWriterRegistration(context, WRITER_A, CREATED_AT);
	const registrationB = await protocol.ensureWriterRegistration(context, WRITER_B, CREATED_AT);
	const parent = makeGeneration(context, [
		{ writerId: WRITER_A, registration: registrationA, head: null, affectedMemoIds: [] },
		{ writerId: WRITER_B, registration: registrationB, head: null, affectedMemoIds: [] },
	]);
	const parentRef = await protocol.writeGeneration(context, parent);
	await protocol.writeGeneration(context, {
		...parent,
		parents: [parentRef],
		writers: [{ writerId: WRITER_A, registration: registrationA, head: null, affectedMemoIds: [] }],
		createdAt: "2026-08-11T00:01:00.000Z",
	});

	const selected = await protocol.selectGeneration(context);
	assert.equal(selected.kind, "invalid", JSON.stringify(selected));
	assert.equal(selected.kind === "invalid"
		&& selected.reasons.some((reason) => reason.includes(`generation_writer_removed:${WRITER_B}`)), true);
});

function makeInitializeInput(): CatalogV2InitializeVaultInput {
	return {
		catalogDataRoot: "Memos/_knomo-data",
		contract: makeContract(),
		initialWriterId: WRITER_A,
		createdAt: CREATED_AT,
		vaultInstanceId: "v_00000000000000000000000000000001",
	};
}

function makeContract(): CatalogV2VaultContract {
	return {
		kind: "knomo.catalog-v2.vault-contract",
		schemaVersion: 2,
		parserVersion: 1,
		daily: {
			folder: "Daily",
			dateFormat: "YYYY-MM-DD",
			headings: ["## Memos"],
			allowRootMemos: true,
		},
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

async function writeSegment(
	protocol: CatalogV2VaultProtocol,
	vaultInstanceId: string,
	operation: StateOperation,
	previousHead: ArtifactRef | null,
): Promise<ArtifactRef> {
	const segment: CatalogV2ImmutableStateSegment = {
		kind: "knomo.catalog-v2.state-segment",
		schemaVersion: 2,
		vaultInstanceId,
		writerId: operation.writerId,
		firstSequence: operation.sequence,
		lastSequence: operation.sequence,
		previousHeadSha256: previousHead?.sha256 ?? null,
		operations: [operation],
	};
	const bytes = canonicalJsonFileBytes(segment);
	const digest = await sha256Bytes(bytes);
	return protocol.writeImmutable(
		getCatalogWriterSegmentPath("Memos/_knomo-data", operation.writerId, operation.sequence, operation.sequence, digest),
		bytes,
	);
}

async function writeHead(
	protocol: CatalogV2VaultProtocol,
	vaultInstanceId: string,
	operation: StateOperation,
	segment: ArtifactRef,
	previousHead: ArtifactRef | null,
): Promise<ArtifactRef> {
	const head: CatalogV2WriterHead = {
		kind: "knomo.catalog-v2.writer-head",
		schemaVersion: 2,
		vaultInstanceId,
		writerId: operation.writerId,
		firstSequence: operation.sequence,
		lastSequence: operation.sequence,
		previousHead,
		segment,
		affectedMemoIds: [operation.memoId],
		committedAt: operation.occurredAt,
	};
	const bytes = canonicalJsonFileBytes(head);
	const digest = await sha256Bytes(bytes);
	return protocol.writeImmutable(
		getCatalogWriterHeadPath("Memos/_knomo-data", operation.writerId, operation.sequence, digest),
		bytes,
	);
}

function makeGeneration(
	context: Awaited<ReturnType<CatalogV2VaultProtocol["initializeVault"]>>,
	writers: CatalogV2StateGeneration["writers"],
): CatalogV2StateGeneration {
	return {
		kind: "knomo.catalog-v2.state-generation",
		schemaVersion: 2,
		vaultInstanceId: context.bootstrap.vaultInstanceId,
		contract: context.bootstrap.contract,
		controlGeneration: context.control.generationRef,
		parents: [],
		writers,
		migrationCommit: null,
		migrationGenerationDigest: null,
		migrationMemoIds: [],
		retiredWriterIds: [],
		createdByWriterId: WRITER_A,
		createdAt: CREATED_AT,
	};
}

function makeOperation(writerId: string, sequence: number): StateOperation {
	return {
		schemaVersion: 1,
		writerId,
		sequence,
		opId: `o_${sequence.toString(16).padStart(32, "0")}`,
		memoId: "memo-1",
		occurredAt: CREATED_AT,
		type: "review.record",
		baseEvidence: null,
		payload: { reviewedAt: CREATED_AT },
	};
}

function createVaultHarness(): {
	app: App;
	addFile: (path: string, content: string) => void;
	readFile: (path: string) => string | null;
	deleteFile: (path: string) => void;
	hasFile: (path: string) => boolean;
	listPaths: () => string[];
} {
	const files = new Map<string, TAbstractFile>();
	const contents = new Map<string, string>();
	const addFile = (path: string, content: string): void => {
		const name = path.split("/").at(-1) ?? path;
		const file = Object.assign(new TFile(), {
			path,
			name,
			basename: name.replace(/\.[^.]+$/u, ""),
			extension: name.includes(".") ? name.split(".").at(-1) ?? "" : "",
			stat: { ctime: 1, mtime: 1, size: new TextEncoder().encode(content).byteLength },
		});
		files.set(path, file);
		contents.set(path, content);
		addToParent(files, path, file);
	};
	const vault = {
		getFiles: () => [...files.values()].filter((file): file is TFile => file instanceof TFile),
		getAbstractFileByPath: (path: string) => files.get(path) ?? null,
		createFolder: async (path: string) => {
			const folder = Object.assign(new TFolder(), { path, name: path.split("/").at(-1) ?? path, children: [] });
			files.set(path, folder);
			addToParent(files, path, folder);
		},
		create: async (path: string, content: string) => {
			if (files.has(path)) throw new Error(`exists:${path}`);
			addFile(path, content);
			return files.get(path) as TFile;
		},
		readBinary: async (file: TFile) => new TextEncoder().encode(contents.get(file.path) ?? "").buffer,
	} as unknown as App["vault"];
	return {
		app: { vault } as App,
		addFile,
		readFile: (path) => contents.get(path) ?? null,
		deleteFile: (path) => {
			files.delete(path);
			contents.delete(path);
		},
		hasFile: (path) => files.get(path) instanceof TFile,
		listPaths: () => [...files.keys()].sort(),
	};
}

function addToParent(files: Map<string, TAbstractFile>, path: string, child: TAbstractFile): void {
	const separator = path.lastIndexOf("/");
	if (separator < 0) return;
	const parent = files.get(path.slice(0, separator));
	if (parent instanceof TFolder && !parent.children.includes(child)) parent.children.push(child);
}
