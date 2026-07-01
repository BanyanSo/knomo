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
	for (const [path, content] of Object.entries(initialFiles)) {
		const file = Object.assign(new TFile(), {
			path,
			name: path.split("/").pop() ?? path,
			extension: path.split(".").pop() ?? "",
		});
		files.set(path, file);
		contents.set(path, content);
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
				return folder;
			},
			create: async (path: string, content: string) => {
				const file = Object.assign(new TFile(), {
					path,
					name: path.split("/").pop() ?? path,
					extension: path.split(".").pop() ?? "",
				});
				files.set(path, file);
				contents.set(path, content);
				return file;
			},
			cachedRead: async (file: { path: string }) => contents.get(file.path) ?? "",
			process: async (file: { path: string }, update: (content: string) => string) => {
				const nextContent = update(contents.get(file.path) ?? "");
				contents.set(file.path, nextContent);
				return nextContent;
			},
		},
	};
	return {
		store: new MemoIndexStore(app as never),
		files,
		contents,
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
