import assert from "node:assert/strict";
import test from "node:test";
import { TFile, TFolder } from "obsidian";
import type { App, TAbstractFile } from "obsidian";

import { CatalogV2LegacyCleanupService, classifyCleanupClass } from "../src/services/CatalogV2LegacyCleanupService";
import { sha256Bytes } from "../src/services/CatalogV2Protocol";
import type { LegacyArtifactReceipt, MigrationCommit, MigrationCommitVerification } from "../src/types/catalogV2";

test("legacy cleanup 只按精确 path、digest、receipt 和 allowlist class 调用 trashFile", async () => {
	const path = "Memos/_knomo-system/indexes/memo-index-2026-08 conflict.json";
	const bytes = new TextEncoder().encode("legacy bytes");
	const digest = await sha256Bytes(bytes);
	const file = Object.assign(new TFile(), {
		path,
		name: path.split("/").pop() ?? "",
		extension: "json",
		stat: { ctime: 1, mtime: 2, size: bytes.byteLength },
	});
	const trashed: string[] = [];
	const app = {
		vault: {
			getAbstractFileByPath: (candidate: string) => candidate === path ? file : null,
			readBinary: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
		},
		fileManager: {
			trashFile: async (target: TFile) => { trashed.push(target.path); },
		},
	} as unknown as App;
	const receipt = makeReceipt(path, digest, bytes.byteLength);
	const result = await new CatalogV2LegacyCleanupService(app, "Memos/_knomo-system", () => new Date("2026-08-11T00:00:00.000Z"))
		.retireFiles({ commit: makeCommit(receipt), receipts: [receipt], legacyV2Receipts: [], allowPendingCreate: true });

	assert.deepEqual(trashed, [path]);
	assert.deepEqual(result.failedPaths, []);
	assert.equal(result.retired[0]?.cleanupClass, "legacy_memo_index");
	assert.equal(classifyCleanupClass("Memos/_knomo-system", ".obsidian/plugins/knomo/data.json"), null);
});

test("legacy cleanup 对 digest 变化和非 allowlist 文件保持原样", async () => {
	const path = "Memos/_knomo-system/indexes/memo-index-2026-08.json";
	const current = new TextEncoder().encode("changed");
	const file = Object.assign(new TFile(), { path, name: "memo-index-2026-08.json", extension: "json" });
	let trashCalls = 0;
	const app = {
		vault: {
			getAbstractFileByPath: () => file,
			readBinary: async () => current.buffer.slice(current.byteOffset, current.byteOffset + current.byteLength),
		},
		fileManager: { trashFile: async () => { trashCalls += 1; } },
	} as unknown as App;
	const receipt = makeReceipt(path, "a".repeat(64), 7);
	const result = await new CatalogV2LegacyCleanupService(app, "Memos/_knomo-system")
		.retireFiles({ commit: makeCommit(receipt), receipts: [receipt], legacyV2Receipts: [], allowPendingCreate: true });
	assert.equal(trashCalls, 0);
	assert.deepEqual(result.skippedPaths, [path]);
});

test("legacy v2 cleanup verifies both source receipt and migrated target before trash", async () => {
	const sourcePath = "Memos/_knomo-system/v2/state/writers/w_00000000000000000000000000000001/segment-000001.jsonl";
	const targetPath = "Memos/_knomo-data/state/devices/w_00000000000000000000000000000001/segment-000001.jsonl";
	const sourceBytes = new TextEncoder().encode("source\n");
	const targetBytes = new TextEncoder().encode("target\n");
	const source = Object.assign(new TFile(), { path: sourcePath, name: "segment-000001.jsonl" });
	const target = Object.assign(new TFile(), { path: targetPath, name: "segment-000001.jsonl" });
	const trashed: string[] = [];
	const app = {
		vault: {
			getAbstractFileByPath: (path: string) => path === sourcePath ? source : path === targetPath ? target : null,
			readBinary: async (file: TFile) => {
				const value = file === source ? sourceBytes : targetBytes;
				return value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength);
			},
		},
		fileManager: { trashFile: async (file: TFile) => { trashed.push(file.path); } },
	} as unknown as App;
	const result = await new CatalogV2LegacyCleanupService(app, "Memos/_knomo-system").retireFiles({
		commit: null,
		receipts: [],
		legacyV2Receipts: [{
			sourcePath,
			sourceSha256: await sha256Bytes(sourceBytes),
			sourceByteLength: sourceBytes.byteLength,
			target: { path: targetPath, sha256: await sha256Bytes(targetBytes), byteLength: targetBytes.byteLength },
			artifactKind: "state_segment",
		}],
		allowPendingCreate: true,
	});
	assert.deepEqual(trashed, [sourcePath]);
	assert.equal(result.retired[0]?.cleanupClass, "legacy_v2_artifact");
});

test("empty directory cleanup is leaf-to-root and retires the empty legacy root", async () => {
	const tree = createFolderTree([
		"Memos/_knomo-system",
		"Memos/_knomo-system/v2",
		"Memos/_knomo-system/v2/state",
		"Memos/_knomo-system/v2/state/writers",
		"Memos/_knomo-system/v2/state/writers/w_00000000000000000000000000000001",
	]);
	const result = await new CatalogV2LegacyCleanupService(tree.app, "Memos/_knomo-system")
		.retireEmptyDirectories({ allowSystemRoot: true });
	assert.deepEqual(tree.trashed, [
		"Memos/_knomo-system/v2/state/writers/w_00000000000000000000000000000001",
		"Memos/_knomo-system/v2/state/writers",
		"Memos/_knomo-system/v2/state",
		"Memos/_knomo-system/v2",
		"Memos/_knomo-system",
	]);
	assert.equal(result.rootRetired, true);
});

test("backups and unknown content keep the legacy root", async () => {
	for (const child of ["backups", "user-copy"]) {
		const tree = createFolderTree(["Memos/_knomo-system", `Memos/_knomo-system/${child}`]);
		const result = await new CatalogV2LegacyCleanupService(tree.app, "Memos/_knomo-system")
			.retireEmptyDirectories({ allowSystemRoot: true });
		assert.equal(result.rootRetired, false);
		assert.equal(tree.has("Memos/_knomo-system"), true);
	}
});

test("a newly arriving file stops root retirement and a failed trash remains retryable", async () => {
	const tree = createFolderTree(["Memos/_knomo-system", "Memos/_knomo-system/v2"]);
	tree.onTrash = (path) => {
		if (path === "Memos/_knomo-system/v2") tree.addFile("Memos/_knomo-system/late-copy.json");
	};
	let result = await new CatalogV2LegacyCleanupService(tree.app, "Memos/_knomo-system")
		.retireEmptyDirectories({ allowSystemRoot: true });
	assert.equal(result.rootRetired, false);
	assert.equal(tree.has("Memos/_knomo-system/late-copy.json"), true);

	const retry = createFolderTree(["Memos/_knomo-system"]);
	retry.failRootOnce = true;
	const service = new CatalogV2LegacyCleanupService(retry.app, "Memos/_knomo-system");
	result = await service.retireEmptyDirectories({ allowSystemRoot: true });
	assert.deepEqual(result.failedPaths, ["Memos/_knomo-system"]);
	assert.equal(retry.has("Memos/_knomo-system"), true);
	result = await service.retireEmptyDirectories({ allowSystemRoot: true });
	assert.equal(result.rootRetired, true);
});

function makeReceipt(path: string, digest: string, byteLength: number): LegacyArtifactReceipt {
	return {
		path,
		artifactKind: "memo_index",
		byteLength,
		mtime: 1,
		sha256: digest,
		legacySchemaVersion: 3,
		readableRecordCount: 1,
		disposition: "imported",
		requiredArtifact: {
			path: `upgrade/packages/memo_index-${digest}.json`,
			sha256: "b".repeat(64),
			byteLength: 10,
		},
		errorCode: null,
	};
}

function makeCommit(receipt: LegacyArtifactReceipt): MigrationCommit {
	return {
		kind: "knomo.catalog-v2.migration-commit",
		schemaVersion: 1,
		importerVersion: 1,
		generationDigest: "c".repeat(64),
		writerId: "w_00000000000000000000000000000001",
		committedAt: "2026-08-11T00:00:00.000Z",
		legacySources: [{
			artifactDigest: receipt.sha256,
			artifactKind: receipt.artifactKind,
			disposition: "imported",
			receipt: receipt.requiredArtifact!,
		}],
		requiredArtifacts: [{ artifactKind: "migration_package", ...receipt.requiredArtifact! }],
		domainCounts: {
			identityClaims: 0,
			deletedRecords: 0,
			relations: 0,
			reviewOrdinals: 0,
			pendingCreates: 0,
			diagnostics: 0,
			quarantinedArtifacts: 0,
		},
		verification,
	};
}

const verification: MigrationCommitVerification = {
	structure: {
		requiredArtifactsVerified: true,
		existingMemoIdsPreserved: true,
		domainCountsVerified: true,
		deletedPayloadsVerified: true,
		dailyHashesUnchanged: true,
	},
	runtime: {
		v2ColdStartPassed: true,
		outboxDrained: true,
		legacyReadsDisabled: true,
		legacyWriterRemoved: true,
	},
	catalog: {
		coverage: "complete",
		observationCount: 0,
		identifiedCount: 0,
		observedCount: 0,
		ambiguousCount: 0,
		failedPaths: [],
	},
};

function createFolderTree(initialPaths: string[]): {
	app: App;
	trashed: string[];
	has: (path: string) => boolean;
	addFile: (path: string) => void;
	onTrash: ((path: string) => void) | null;
	failRootOnce: boolean;
} {
	const entries = new Map<string, TAbstractFile>();
	const trashed: string[] = [];
	const result = {
		app: null as unknown as App,
		trashed,
		has: (path: string) => entries.has(path),
		addFile: (path: string) => {
			const file = Object.assign(new TFile(), { path, name: path.split("/").pop() ?? "" });
			entries.set(path, file);
			const parent = entries.get(path.slice(0, path.lastIndexOf("/")));
			if (parent instanceof TFolder) parent.children.push(file);
		},
		onTrash: null as ((path: string) => void) | null,
		failRootOnce: false,
	};
	for (const path of [...initialPaths].sort((left, right) => left.split("/").length - right.split("/").length)) {
		const folder = Object.assign(new TFolder(), { path, name: path.split("/").pop() ?? "", children: [] as TAbstractFile[] });
		entries.set(path, folder);
		const parent = entries.get(path.slice(0, path.lastIndexOf("/")));
		if (parent instanceof TFolder) parent.children.push(folder);
	}
	result.app = {
		vault: { getAbstractFileByPath: (path: string) => entries.get(path) ?? null },
		fileManager: {
			trashFile: async (file: TAbstractFile) => {
				if (file.path === "Memos/_knomo-system" && result.failRootOnce) {
					result.failRootOnce = false;
					throw new Error("trash failed");
				}
				trashed.push(file.path);
				const parent = entries.get(file.path.slice(0, file.path.lastIndexOf("/")));
				if (parent instanceof TFolder) parent.children = parent.children.filter((child) => child !== file);
				entries.delete(file.path);
				result.onTrash?.(file.path);
			},
		},
	} as unknown as App;
	return result;
}
