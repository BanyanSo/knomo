import assert from "node:assert/strict";
import test from "node:test";

import type { MemoRecord } from "../src/types/memo";
import { hashMemoContent, hashText } from "../src/utils/hash";
import { ensureObsidianStub } from "./helpers/obsidianStub";

test("MemoIndexStore loads an empty memo-index as an empty period", async () => {
	const { store } = await createHarness({
		"Memos/_knomo-system/indexes/memo-index-2026-06.json": "",
	});

	const index = await store.loadPeriod("Memos", "2026-06");

	assert.equal(index.schemaVersion, 2);
	assert.equal(index.period, "2026-06");
	assert.deepEqual(index.memos, {});
});

test("MemoIndexStore reports invalid JSON with the target period", async () => {
	const { store } = await createHarness({
		"Memos/_knomo-system/indexes/memo-index-2026-06.json": "{",
	});

	await assert.rejects(
		store.loadPeriod("Memos", "2026-06"),
		/Invalid memo-index JSON for 2026-06:/,
	);
});

test("MemoIndexStore reports invalid memo-index schema with the target period", async () => {
	const { store } = await createHarness({
		"Memos/_knomo-system/indexes/memo-index-2026-06.json": JSON.stringify({
			schemaVersion: 2,
			period: "2026-06",
			updatedAt: "2026-06-13T10:00:00.000+08:00",
			memos: [],
		}),
	});

	await assert.rejects(
		store.loadPeriod("Memos", "2026-06"),
		/Invalid memo-index schema for 2026-06\./,
	);
});

test("MemoIndexStore reports invalid memo records with memoId and field", async () => {
	const memo = createMemo("memo-1");
	const { store } = await createHarness({
		"Memos/_knomo-system/indexes/memo-index-2026-06.json": JSON.stringify({
			schemaVersion: 2,
			period: "2026-06",
			updatedAt: "2026-06-13T10:00:00.000+08:00",
			memos: {
				[memo.id]: {
					...memo,
					dailyRef: {
						...memo.dailyRef,
						path: 42,
					},
				},
			},
		}),
	});

	await assert.rejects(
		store.loadPeriod("Memos", "2026-06"),
		/Invalid memo-index record for 2026-06: memoId=memo-1, field=dailyRef\.path\./,
	);
});

test("MemoIndexStore rejects memo records whose map key and id differ", async () => {
	const memo = createMemo("memo-1");
	const { store } = await createHarness({
		"Memos/_knomo-system/indexes/memo-index-2026-06.json": JSON.stringify({
			schemaVersion: 2,
			period: "2026-06",
			updatedAt: "2026-06-13T10:00:00.000+08:00",
			memos: {
				"memo-key": memo,
			},
		}),
	});

	await assert.rejects(
		store.loadPeriod("Memos", "2026-06"),
		/Invalid memo-index record for 2026-06: memoId=memo-key, field=id\./,
	);
});

test("MemoIndexStore loads valid memo records without changing their fields", async () => {
	const memo = createMemo("memo-1");
	const { store } = await createHarness({
		"Memos/_knomo-system/indexes/memo-index-2026-06.json": JSON.stringify({
			schemaVersion: 2,
			period: "2026-06",
			updatedAt: "2026-06-13T10:00:00.000+08:00",
			memos: {
				[memo.id]: memo,
			},
		}),
	});

	const index = await store.loadPeriod("Memos", "2026-06");

	assert.deepEqual(index.memos[memo.id], memo);
});

test("MemoIndexStore read-only loads do not create missing index files", async () => {
	const { store, contents } = await createHarness({});

	assert.deepEqual(await store.loadExistingPeriods("Memos", ["2026-06"]), []);
	assert.deepEqual(await store.loadAllExisting("Memos"), []);
	assert.equal(contents.has("Memos/_knomo-system/indexes/memo-index-2026-06.json"), false);
});

test("MemoIndexStore lists and reads likely sync-conflict index files", async () => {
	const activeMemo = createMemoAtLine("memo-active", 1);
	const conflictMemo = createMemoAtLine("memo-conflict", 2);
	const numberedCopyMemo = createMemoAtLine("memo-numbered-copy", 3);
	const typoConflictMemo = createMemoAtLine("memo-typo-conflict", 4);
	const { store } = await createHarness({
		"Memos/_knomo-system/indexes/memo-index-2026-06.json": JSON.stringify({
			schemaVersion: 2,
			period: "2026-06",
			updatedAt: "2026-06-13T10:00:00.000+08:00",
			memos: {
				[activeMemo.id]: activeMemo,
			},
		}),
		"Memos/_knomo-system/indexes/memo-index-2026-06 conflict.json": JSON.stringify({
			schemaVersion: 2,
			period: "2026-06",
			updatedAt: "2026-06-13T10:01:00.000+08:00",
			memos: {
				[conflictMemo.id]: conflictMemo,
			},
		}),
		"Memos/_knomo-system/indexes/memo-index-2026-06 2.json": JSON.stringify({
			schemaVersion: 2,
			period: "2026-06",
			updatedAt: "2026-06-13T10:02:00.000+08:00",
			memos: {
				[numberedCopyMemo.id]: numberedCopyMemo,
			},
		}),
		"Memos/_knomo-system/indexes/memo-index-2026-06-confilict.json": JSON.stringify({
			schemaVersion: 2,
			period: "2026-06",
			updatedAt: "2026-06-13T10:03:00.000+08:00",
			memos: {
				[typoConflictMemo.id]: typoConflictMemo,
			},
		}),
	});

	assert.deepEqual(store.listPotentialSyncConflictFiles("Memos"), [
		{
			kind: "memo-index",
			path: "Memos/_knomo-system/indexes/memo-index-2026-06 2.json",
			period: "2026-06",
		},
		{
			kind: "memo-index",
			path: "Memos/_knomo-system/indexes/memo-index-2026-06 conflict.json",
			period: "2026-06",
		},
		{
			kind: "memo-index",
			path: "Memos/_knomo-system/indexes/memo-index-2026-06-confilict.json",
			period: "2026-06",
		},
	]);
	assert.deepEqual(
		(await store.loadRepairRecoverableMemos("Memos")).map((memo) => memo.id).sort(),
		["memo-active", "memo-conflict", "memo-numbered-copy", "memo-typo-conflict"],
	);
});

test("MemoIndexStore repair recoverable load skips corrupt canonical indexes", async () => {
	const activeMemo = createMemoAtLine("memo-active", 1);
	const conflictMemo = {
		...createMemoAtLine("memo-conflict", 2),
		createdAt: "2026-07-13T10:00:02.000+08:00",
		updatedAt: "2026-07-13T10:00:02.000+08:00",
	};
	const invalidDateMemo = {
		...createMemoAtLine("memo-invalid-date", 3),
		createdAt: "not-a-date",
		updatedAt: "not-a-date",
	};
	const { store } = await createHarness({
		"Memos/_knomo-system/indexes/memo-index-2026-06.json": JSON.stringify({
			schemaVersion: 2,
			period: "2026-06",
			updatedAt: "2026-06-13T10:00:00.000+08:00",
			memos: {
				[activeMemo.id]: activeMemo,
			},
		}),
		"Memos/_knomo-system/indexes/memo-index-2026-07.json": "{",
		"Memos/_knomo-system/indexes/memo-index-2026-07 conflict.json": JSON.stringify({
			schemaVersion: 2,
			period: "2026-07",
			updatedAt: "2026-07-13T10:00:00.000+08:00",
			memos: {
				[conflictMemo.id]: conflictMemo,
				[invalidDateMemo.id]: invalidDateMemo,
			},
		}),
	});

	assert.deepEqual(
		(await store.loadRepairRecoverableMemos("Memos")).map((memo) => memo.id).sort(),
		["memo-active", "memo-conflict"],
	);
});

test("MemoIndexStore trashes only scoped sync-conflict index copies", async () => {
	const { store, files, trashedPaths } = await createHarness({
		"Memos/_knomo-system/indexes/memo-index-2026-05 conflict.json": "{}",
		"Memos/_knomo-system/indexes/memo-index-2026-06.json": "{}",
		"Memos/_knomo-system/indexes/memo-index-2026-06 2.json": "{}",
		"Memos/_knomo-system/indexes/memo-index-2026-06 conflict.json": "{}",
		"Memos/_knomo-system/indexes/memo-index-2026-06-confilict.json": "{}",
	});

	const result = await store.trashPotentialSyncConflictFiles("Memos", new Set(["2026-06"]));

	assert.deepEqual(result, {
		deleted: 3,
		failed: 0,
		firstFailedPath: null,
	});
	assert.deepEqual(trashedPaths.sort(), [
		"Memos/_knomo-system/indexes/memo-index-2026-06 2.json",
		"Memos/_knomo-system/indexes/memo-index-2026-06 conflict.json",
		"Memos/_knomo-system/indexes/memo-index-2026-06-confilict.json",
	]);
	assert.equal(files.has("Memos/_knomo-system/indexes/memo-index-2026-05 conflict.json"), true);
	assert.equal(files.has("Memos/_knomo-system/indexes/memo-index-2026-06.json"), true);
	assert.equal(files.has("Memos/_knomo-system/indexes/memo-index-2026-06 2.json"), false);
	assert.equal(files.has("Memos/_knomo-system/indexes/memo-index-2026-06 conflict.json"), false);
	assert.equal(files.has("Memos/_knomo-system/indexes/memo-index-2026-06-confilict.json"), false);
});

test("MemoIndexStore compacts duplicate active memos that point to the same daily block", async () => {
	const ambiguousMemo = {
		...createMemo("memo-ambiguous"),
		updatedAt: "2026-06-13T10:01:00.000+08:00",
		issue: {
			type: "daily_block_ambiguous" as const,
			code: "daily_block_ambiguous",
			detectedAt: "2026-06-13T10:01:00.000+08:00",
			message: "Multiple memo blocks may match under the current daily note heading, so Knomo cannot sync automatically.",
		},
	};
	const cleanMemo = {
		...ambiguousMemo,
		id: "memo-clean",
		updatedAt: "2026-06-13T10:02:00.000+08:00",
		issue: null,
	};
	const distinctMemo = {
		...createMemoAtLine("memo-distinct", 2),
	};
	const { store, contents } = await createHarness({
		"Memos/_knomo-system/indexes/memo-index-2026-06.json": JSON.stringify({
			schemaVersion: 2,
			period: "2026-06",
			updatedAt: "2026-06-13T10:00:00.000+08:00",
			memos: {
				[ambiguousMemo.id]: ambiguousMemo,
				[cleanMemo.id]: cleanMemo,
				[distinctMemo.id]: distinctMemo,
			},
		}),
	});

	assert.deepEqual((await store.loadAll("Memos")).map((memo) => memo.id).sort(), ["memo-clean", "memo-distinct"]);
	assert.deepEqual((await store.loadAllExisting("Memos")).map((memo) => memo.id).sort(), ["memo-clean", "memo-distinct"]);
	const scannedMemoIds: string[] = [];
	await store.scanAllExisting("Memos", (_period, memos) => {
		scannedMemoIds.push(...memos.map((memo) => memo.id));
	});
	assert.deepEqual(scannedMemoIds.sort(), ["memo-clean", "memo-distinct"]);

	const removed = await store.compactDuplicateDailyBlockMemos("Memos", new Set(["2026-06"]));

	const index = JSON.parse(contents.get("Memos/_knomo-system/indexes/memo-index-2026-06.json") ?? "") as { memos: Record<string, unknown> };
	assert.equal(removed, 1);
	assert.deepEqual(Object.keys(index.memos).sort(), ["memo-clean", "memo-distinct"]);
});

test("MemoIndexStore purges a deleted memo from its createdAt period", async () => {
	const deletedMemo = {
		...createMemo("memo-1"),
		status: "deleted" as const,
		deletedAt: "2026-06-13T10:01:00.000+08:00",
	};
	const sameIdOtherPeriod = {
		...deletedMemo,
		createdAt: "2026-05-13T10:00:00.000+08:00",
		updatedAt: "2026-05-13T10:00:00.000+08:00",
	};
	const { store, contents } = await createHarness({
		"Memos/_knomo-system/indexes/memo-index-2026-05.json": JSON.stringify({
			schemaVersion: 2,
			period: "2026-05",
			updatedAt: "2026-05-13T10:00:00.000+08:00",
			memos: {
				[sameIdOtherPeriod.id]: sameIdOtherPeriod,
			},
		}),
		"Memos/_knomo-system/indexes/memo-index-2026-06.json": JSON.stringify({
			schemaVersion: 2,
			period: "2026-06",
			updatedAt: "2026-06-13T10:00:00.000+08:00",
			memos: {
				[deletedMemo.id]: deletedMemo,
			},
		}),
	});

	await store.purgeDeletedMemoRecord("Memos", deletedMemo);

	const purgedIndex = JSON.parse(contents.get("Memos/_knomo-system/indexes/memo-index-2026-06.json") ?? "") as { memos: Record<string, unknown> };
	const untouchedIndex = JSON.parse(contents.get("Memos/_knomo-system/indexes/memo-index-2026-05.json") ?? "") as { memos: Record<string, unknown> };
	assert.deepEqual(purgedIndex.memos, {});
	assert.deepEqual(untouchedIndex.memos[sameIdOtherPeriod.id], sameIdOtherPeriod);
});

async function createHarness(initialFiles: Record<string, string>) {
	await ensureObsidianStub();
	const { TFile, TFolder } = await import("obsidian");
	const { MemoIndexStore } = await import("../src/services/MemoIndexStore");
	const files = new Map<string, InstanceType<typeof TFile> | InstanceType<typeof TFolder>>();
	const contents = new Map<string, string>();
	const trashedPaths: string[] = [];
	const ensureFolderInMap = (path: string): InstanceType<typeof TFolder> => {
		const existing = files.get(path);
		if (existing instanceof TFolder) {
			return existing;
		}
		const folder = Object.assign(new TFolder(), {
			path,
			name: path.split("/").pop() ?? path,
			children: [] as Array<InstanceType<typeof TFile> | InstanceType<typeof TFolder>>,
		});
		files.set(path, folder);
		const parentPath = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : null;
		if (parentPath !== null) {
			ensureFolderInMap(parentPath).children.push(folder);
		}
		return folder;
	};
	const addFileToMap = (path: string, content: string): InstanceType<typeof TFile> => {
		const file = Object.assign(new TFile(), {
			path,
			name: path.split("/").pop() ?? path,
			extension: path.split(".").pop() ?? "",
		});
		const parentPath = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : null;
		if (parentPath !== null) {
			ensureFolderInMap(parentPath).children.push(file);
		}
		files.set(path, file);
		contents.set(path, content);
		return file;
	};
	for (const [path, content] of Object.entries(initialFiles)) {
		addFileToMap(path, content);
	}
	const app = {
		vault: {
			getAbstractFileByPath: (path: string) => files.get(path) ?? null,
			createFolder: async (path: string) => {
				const folder = Object.assign(new TFolder(), {
					path,
					name: path.split("/").pop() ?? path,
					children: [],
				});
				files.set(path, folder);
				const parentPath = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : null;
				if (parentPath !== null) {
					ensureFolderInMap(parentPath).children.push(folder);
				}
				return folder;
			},
			create: async (path: string, content: string) => {
				return addFileToMap(path, content);
			},
			cachedRead: async (file: { path: string }) => contents.get(file.path) ?? "",
			process: async (file: { path: string }, update: (content: string) => string) => {
				const nextContent = update(contents.get(file.path) ?? "");
				contents.set(file.path, nextContent);
				return nextContent;
			},
		},
		fileManager: {
			trashFile: async (file: { path: string }) => {
				trashedPaths.push(file.path);
				files.delete(file.path);
				contents.delete(file.path);
				const parentPath = file.path.includes("/") ? file.path.slice(0, file.path.lastIndexOf("/")) : null;
				const parent = parentPath === null ? null : files.get(parentPath);
				if (parent instanceof TFolder) {
					parent.children = parent.children.filter((child) => child.path !== file.path);
				}
			},
		},
	};
	return {
		store: new MemoIndexStore(app as never),
		files,
		contents,
		trashedPaths,
	};
}

function createMemo(id: string): MemoRecord {
	const rawBlock = "- 10:00:00 memo content";
	const content = "memo content";
	return {
		id,
		createdAt: "2026-06-13T10:00:00.000+08:00",
		updatedAt: "2026-06-13T10:00:00.000+08:00",
		contentSnapshot: content,
		contentHash: hashMemoContent(content),
		status: "active",
		syncStatus: "synced",
		source: "plugin_input",
		version: 1,
		tags: [],
		links: [],
		images: [],
		references: [],
		sourceMemoId: null,
		issue: null,
		lastMarkdownSyncAt: null,
		lastMarkdownSyncSource: null,
		dailyRef: {
			path: "Daily/2026-06-13.md",
			heading: "## Memos",
			sectionType: "heading",
			lastKnownBlock: rawBlock,
			lastKnownHash: hashText(rawBlock),
			lineNumberHint: 1,
			lastSyncedAt: null,
		},
		monthlyRef: {
			path: "Memos/Memos-2026-06.md",
			dateHeading: "## 2026-06-13",
			lastKnownBlock: rawBlock,
			lastKnownHash: hashText(rawBlock),
			lineNumberHint: 1,
			lastSyncedAt: null,
		},
	};
}

function createMemoAtLine(id: string, lineNumber: number): MemoRecord {
	const second = String(lineNumber).padStart(2, "0");
	const content = `memo content ${lineNumber}`;
	const rawBlock = `- 10:00:${second} ${content}`;
	const timestamp = `2026-06-13T10:00:${second}.000+08:00`;
	return {
		...createMemo(id),
		createdAt: timestamp,
		updatedAt: timestamp,
		contentSnapshot: content,
		contentHash: hashMemoContent(content),
		dailyRef: {
			path: "Daily/2026-06-13.md",
			heading: "## Memos",
			sectionType: "heading",
			lastKnownBlock: rawBlock,
			lastKnownHash: hashText(rawBlock),
			lineNumberHint: lineNumber,
			lastSyncedAt: null,
		},
		monthlyRef: {
			path: "Memos/Memos-2026-06.md",
			dateHeading: "## 2026-06-13",
			lastKnownBlock: rawBlock,
			lastKnownHash: hashText(rawBlock),
			lineNumberHint: lineNumber,
			lastSyncedAt: null,
		},
	};
}
