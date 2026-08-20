import assert from "node:assert/strict";
import test from "node:test";
import { TFile, TFolder } from "obsidian";
import type { App, TAbstractFile } from "obsidian";

import { CatalogV2LayoutMigrationService } from "../src/services/CatalogV2LayoutMigrationService";
import { parseCanonicalMigrationCommit, parseCanonicalMigrationPackage } from "../src/services/CatalogV2MigrationArtifactStore";
import {
	buildStateCompactionCommit,
	buildStateSnapshot,
	canonicalJsonFileBytes,
	parseStateCompactionCommit,
	parseStateSegment,
	parseStateSnapshot,
	serializeDeletedMemoPayload,
	serializeStateSegment,
	sha256Bytes,
} from "../src/services/CatalogV2Protocol";
import type {
	DeletedMemoPayload,
	MigrationCommit,
	MigrationPackage,
	StateOperation,
} from "../src/types/catalogV2";

const LEGACY_ROOT = "Memos/_knomo-system";
const CATALOG_ROOT = "Memos/_knomo-data";
const WRITER_ID = "w_11111111111111111111111111111111";
const OP_ID = "o_22222222222222222222222222222222";
const MEMO_ID = "memo-layout";

test("legacy v2 artifacts migrate by dependency order with rewritten references and stable Markdown bytes", async () => {
	const fixture = createMemoryApp();
	const seeded = await seedLegacyLayout(fixture);
	const beforeDaily = fixture.read("Daily/2026-08-11.md");
	const service = new CatalogV2LayoutMigrationService(fixture.app, CATALOG_ROOT, LEGACY_ROOT);

	const report = await service.migrate({ allowMutableSegmentReplace: true });

	assert.equal(report.receipts.length, 6);
	assert.equal(fixture.read("Daily/2026-08-11.md"), beforeDaily);
	assert.equal(fixture.paths().some((path) => path.startsWith(`${CATALOG_ROOT}/v2/`)), false);
	assert.equal(fixture.has(`${CATALOG_ROOT}/manifest.json`), false);
	assert.equal(fixture.has(seeded.oldSegmentPath), true);

	const segmentPath = `${CATALOG_ROOT}/state/devices/${WRITER_ID}/segment-000001.jsonl`;
	const segment = await parseStateSegment(segmentPath, fixture.read(segmentPath));
	const operation = segment.operations[0]?.operation;
	assert.equal(operation?.type, "lifecycle.delete");
	if (operation?.type === "lifecycle.delete") {
		assert.equal(operation.payload.deletedPayload.path, `state/deleted/${MEMO_ID}/${OP_ID}.json`);
	}

	const snapshotReceipt = report.receipts.find((receipt) => receipt.artifactKind === "state_snapshot");
	assert.notEqual(snapshotReceipt, undefined);
	const snapshot = await parseStateSnapshot(snapshotReceipt?.target.path ?? "", fixture.read(snapshotReceipt?.target.path ?? ""));
	assert.equal(snapshot.coveredSegments[0]?.path, `state/devices/${WRITER_ID}/segment-000001.jsonl`);
	const snapshotDelete = snapshot.operations[0];
	assert.equal(snapshotDelete?.type, "lifecycle.delete");
	if (snapshotDelete?.type === "lifecycle.delete") {
		assert.equal(snapshotDelete.payload.deletedPayload.path, `state/deleted/${MEMO_ID}/${OP_ID}.json`);
	}

	const stateCommitReceipt = report.receipts.find((receipt) => receipt.artifactKind === "state_checkpoint");
	const stateCommit = parseStateCompactionCommit(stateCommitReceipt?.target.path ?? "", fixture.read(stateCommitReceipt?.target.path ?? ""));
	assert.equal(stateCommit.snapshot.path, snapshotReceipt?.target.path.slice(`${CATALOG_ROOT}/`.length));
	assert.equal(stateCommit.snapshot.sha256, snapshotReceipt?.target.sha256);

	const packageReceipt = report.receipts.find((receipt) => receipt.artifactKind === "upgrade_package");
	const packageValue = parseCanonicalMigrationPackage(packageReceipt?.target.path ?? "", bytes(fixture.read(packageReceipt?.target.path ?? "")));
	assert.equal(packageValue.deletedRecords[0]?.payload.path, `state/deleted/${MEMO_ID}/${OP_ID}.json`);

	const upgradeCommitReceipt = report.receipts.find((receipt) => receipt.artifactKind === "upgrade_checkpoint");
	const upgradeCommit = parseCanonicalMigrationCommit(upgradeCommitReceipt?.target.path ?? "", bytes(fixture.read(upgradeCommitReceipt?.target.path ?? "")));
	assert.equal(upgradeCommit.requiredArtifacts.every((artifact) => !artifact.path.startsWith("v2/")), true);
	assert.equal(upgradeCommit.legacySources[0]?.receipt.sha256, packageReceipt?.target.sha256);

	const firstTargetBytes = new Map(report.receipts.map((receipt) => [receipt.target.path, fixture.read(receipt.target.path)]));
	const repeated = await service.migrate({ allowMutableSegmentReplace: true });
	assert.deepEqual(repeated.receipts.map((receipt) => receipt.target), report.receipts.map((receipt) => receipt.target));
	for (const [path, content] of firstTargetBytes) assert.equal(fixture.read(path), content);
});

test("interrupted layout migration resumes without marking or rewriting Markdown", async () => {
	const fixture = createMemoryApp();
	await seedLegacyLayout(fixture);
	const beforeDaily = fixture.read("Daily/2026-08-11.md");
	fixture.failNextCreate(3);
	const service = new CatalogV2LayoutMigrationService(fixture.app, CATALOG_ROOT, LEGACY_ROOT);

	await assert.rejects(() => service.migrate({ allowMutableSegmentReplace: true }), /interrupted/u);
	fixture.failNextCreate(null);
	const report = await service.migrate({ allowMutableSegmentReplace: true });

	assert.equal(report.receipts.length, 6);
	assert.equal(fixture.read("Daily/2026-08-11.md"), beforeDaily);
});

async function seedLegacyLayout(fixture: ReturnType<typeof createMemoryApp>): Promise<{ oldSegmentPath: string }> {
	fixture.add("Daily/2026-08-11.md", "## Knomo\n\n- 09:00 deleted memo\n");
	const deletedPayload: DeletedMemoPayload = {
		kind: "knomo.catalog-v2.deleted-payload",
		schemaVersion: 1,
		memoId: MEMO_ID,
		deleteOpId: OP_ID,
		deletedAt: "2026-08-11T01:00:00.000Z",
		sourcePath: "Daily/2026-08-11.md",
		logicalDate: "2026-08-11",
		section: "## Knomo",
		rawBlock: "- 09:00 deleted memo",
		contentHash: "fnv1a-12345678",
		sourceMemoId: null,
	};
	const deletedBytes = serializeDeletedMemoPayload(deletedPayload);
	const oldDeletedRelative = `v2/state/deleted/${MEMO_ID}/${OP_ID}.json`;
	fixture.add(`${LEGACY_ROOT}/${oldDeletedRelative}`, text(deletedBytes));
	const operation: StateOperation = {
		schemaVersion: 1,
		writerId: WRITER_ID,
		sequence: 1,
		opId: OP_ID,
		memoId: MEMO_ID,
		occurredAt: "2026-08-11T01:00:00.000Z",
		type: "lifecycle.delete",
		baseEvidence: {
			sourcePath: "Daily/2026-08-11.md",
			sourceRevision: "a".repeat(64),
			logicalDate: "2026-08-11",
			section: "## Knomo",
			startLine: 2,
			endLine: 2,
			time: "09:00",
			contentHash: "fnv1a-12345678",
			existingBlockId: null,
		},
		payload: {
			baseBindingId: "o_ffffffffffffffffffffffffffffffff",
			deleteOpId: OP_ID,
			deletedPayload: {
				path: oldDeletedRelative,
				sha256: await sha256Bytes(deletedBytes),
				byteLength: deletedBytes.byteLength,
			},
		},
	};
	const deletedPayloadRef = operation.payload.deletedPayload;
	const segmentBytes = bytes(serializeStateSegment([operation]));
	const oldSegmentRelative = `v2/state/writers/${WRITER_ID}/segment-000001.jsonl`;
	const oldSegmentPath = `${LEGACY_ROOT}/${oldSegmentRelative}`;
	fixture.add(oldSegmentPath, text(segmentBytes));
	const snapshot = await buildStateSnapshot({
		sourceWriterId: WRITER_ID,
		coveredSegments: [{
			path: oldSegmentRelative,
			sha256: await sha256Bytes(segmentBytes),
			byteLength: segmentBytes.byteLength,
		}],
		operations: [operation],
	});
	const oldSnapshotRelative = `v2/${snapshot.path}`;
	fixture.add(`${LEGACY_ROOT}/${oldSnapshotRelative}`, text(snapshot.bytes));
	const stateCommit = await buildStateCompactionCommit({
		snapshot: { path: oldSnapshotRelative, sha256: snapshot.digest, byteLength: snapshot.bytes.byteLength },
		snapshotValue: snapshot.snapshot,
		committingWriterId: WRITER_ID,
		committedAt: "2026-08-11T02:00:00.000Z",
	});
	fixture.add(`${LEGACY_ROOT}/v2/state/compactions/commit-${snapshot.digest}-${WRITER_ID}.json`, text(stateCommit.bytes));

	const sourceDigest = "b".repeat(64);
	const packageValue: MigrationPackage = {
		kind: "knomo.catalog-v2.migration-package",
		schemaVersion: 1,
		importerVersion: 1,
		source: { artifactDigest: sourceDigest, artifactKind: "memo_index", byteLength: 10, legacySchemaVersion: 3, period: "2026-08", recordCount: 1 },
		identityClaims: [],
		deletedRecords: [{ memoId: MEMO_ID, deleteOpId: OP_ID, deletedAt: deletedPayload.deletedAt, deleteSource: "user", legacyRecordDigest: "c".repeat(64), payload: deletedPayloadRef }],
		relations: [],
		reviews: [],
		pendingCreates: [],
		diagnostics: [],
		counts: { identityClaims: 0, deletedRecords: 1, relations: 0, reviewOrdinals: 0, pendingCreates: 0, diagnostics: 0 },
	};
	const packageBytes = canonicalJsonFileBytes(packageValue);
	const oldPackageRelative = `v2/migrations/imports/memo_index-${sourceDigest}.json`;
	fixture.add(`${LEGACY_ROOT}/${oldPackageRelative}`, text(packageBytes));
	const oldPackageRef = { path: oldPackageRelative, sha256: await sha256Bytes(packageBytes), byteLength: packageBytes.byteLength };
	const migrationCommit: MigrationCommit = {
		kind: "knomo.catalog-v2.migration-commit",
		schemaVersion: 1,
		importerVersion: 1,
		generationDigest: "d".repeat(64),
		writerId: WRITER_ID,
		committedAt: "2026-08-11T03:00:00.000Z",
		legacySources: [{ artifactDigest: sourceDigest, artifactKind: "memo_index", disposition: "imported", receipt: oldPackageRef }],
		requiredArtifacts: [
			{ artifactKind: "migration_package", ...oldPackageRef },
			{ artifactKind: "deleted_payload", ...deletedPayloadRef },
		],
		domainCounts: { ...packageValue.counts, quarantinedArtifacts: 0 },
		verification: {
			structure: { requiredArtifactsVerified: true, existingMemoIdsPreserved: true, domainCountsVerified: true, deletedPayloadsVerified: true, dailyHashesUnchanged: true },
			runtime: { v2ColdStartPassed: true, outboxDrained: true, legacyReadsDisabled: true, legacyWriterRemoved: true },
			catalog: { coverage: "complete", observationCount: 0, identifiedCount: 0, observedCount: 0, ambiguousCount: 0, failedPaths: [] },
		},
	};
	fixture.add(`${LEGACY_ROOT}/v2/migrations/commits/commit-${migrationCommit.generationDigest}-${WRITER_ID}.json`, text(canonicalJsonFileBytes(migrationCommit)));
	return { oldSegmentPath };
}

function createMemoryApp(): {
	app: App;
	add: (path: string, content: string) => void;
	read: (path: string) => string;
	has: (path: string) => boolean;
	paths: () => string[];
	failNextCreate: (call: number | null) => void;
} {
	const files = new Map<string, TAbstractFile>();
	const contents = new Map<string, string>();
	let createCalls = 0;
	let failCreateCall: number | null = null;
	const ensureFolder = (path: string): TFolder => {
		const existing = files.get(path);
		if (existing instanceof TFolder) return existing;
		const folder = Object.assign(new TFolder(), { path, name: path.split("/").pop() ?? "", children: [] as TAbstractFile[] });
		files.set(path, folder);
		addToParent(files, path, folder);
		return folder;
	};
	const add = (path: string, content: string): void => {
		const parts = path.split("/");
		for (let index = 1; index < parts.length; index += 1) ensureFolder(parts.slice(0, index).join("/"));
		const name = parts.at(-1) ?? "";
		const file = Object.assign(new TFile(), {
			path,
			name,
			basename: name.replace(/\.[^.]+$/u, ""),
			extension: name.includes(".") ? name.split(".").at(-1) ?? "" : "",
			stat: { ctime: 1, mtime: 1, size: bytes(content).byteLength },
		});
		files.set(path, file);
		contents.set(path, content);
		addToParent(files, path, file);
	};
	const vault = {
		getAbstractFileByPath: (path: string) => files.get(path) ?? null,
		getFiles: () => [...files.values()].filter((file): file is TFile => file instanceof TFile),
		getMarkdownFiles: () => [...files.values()].filter((file): file is TFile => file instanceof TFile && file.extension === "md"),
		createFolder: async (path: string) => { ensureFolder(path); },
		create: async (path: string, content: string) => {
			createCalls += 1;
			if (failCreateCall === createCalls) throw new Error("interrupted create");
			add(path, content);
			return files.get(path) as TFile;
		},
		process: async (file: TFile, update: (content: string) => string) => {
			const content = update(contents.get(file.path) ?? "");
			contents.set(file.path, content);
			file.stat = { ...file.stat, mtime: file.stat.mtime + 1, size: bytes(content).byteLength };
			return content;
		},
		readBinary: async (file: TFile) => {
			const value = bytes(contents.get(file.path) ?? "");
			return value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength);
		},
	} as unknown as App["vault"];
	return {
		app: { vault } as App,
		add,
		read: (path) => contents.get(path) ?? "",
		has: (path) => files.has(path),
		paths: () => [...files.keys()].sort(),
		failNextCreate: (call) => {
			createCalls = 0;
			failCreateCall = call;
		},
	};
}

function addToParent(files: Map<string, TAbstractFile>, path: string, child: TAbstractFile): void {
	const separator = path.lastIndexOf("/");
	if (separator < 0) return;
	const parent = files.get(path.slice(0, separator));
	if (parent instanceof TFolder && !parent.children.includes(child)) parent.children.push(child);
}

function bytes(value: string): Uint8Array {
	return new TextEncoder().encode(value);
}

function text(value: Uint8Array): string {
	return new TextDecoder("utf-8", { fatal: true }).decode(value);
}
