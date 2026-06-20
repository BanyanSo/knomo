import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import type { MemoIndex } from "../src/types";
import type { MemoRecord, ParsedMemoBlock } from "../src/types/memo";
import type { KnomoSettings } from "../src/types/settings";
import { hashText } from "../src/utils/hash";

test("monthly archive rebuild writes every active memo from daily notes without changing memoId", async () => {
	await ensureObsidianStub();
	const { TFile, TFolder } = await import("obsidian");
	const { MarkdownBlockService } = await import("../src/services/MarkdownBlockService");
	const { MonthlyArchiveService } = await import("../src/services/MonthlyArchiveService");
	const { MonthlyArchiveRebuildService } = await import("../src/services/MonthlyArchiveRebuildService");
	const markdownBlockService = new MarkdownBlockService();
	const firstDaily = Object.assign(new TFile(), { path: "Daily/2026-06-02.md", extension: "md" });
	const secondDaily = Object.assign(new TFile(), { path: "Daily/2026-06-03.md", extension: "md" });
	const monthlyFolder = Object.assign(new TFolder(), { path: "Memos", children: [] });
	const files = new Map<string, unknown>([
		[firstDaily.path, firstDaily],
		[secondDaily.path, secondDaily],
		[monthlyFolder.path, monthlyFolder],
	]);
	const contents = new Map<string, string>([
		[firstDaily.path, "## Memos\n- 08:00 first memo\n- 09:00 second memo ^abc123"],
		[secondDaily.path, "## Memos\n- 10:00 third memo"],
	]);
	const firstBlock = parseBlock(markdownBlockService, "- 08:00 first memo");
	const secondBlock = parseBlock(markdownBlockService, "- 09:00 second memo ^abc123");
	const deletedBlock = parseBlock(markdownBlockService, "- 10:00 deleted memo");
	const index = createIndex("2026-06", [
		createMemo("memo-a", "2026-06-02T08:00:00", firstDaily.path, firstBlock),
		createMemo("memo-b", "2026-06-02T09:00:00", firstDaily.path, secondBlock),
		{ ...createMemo("memo-deleted", "2026-06-03T10:00:00", secondDaily.path, deletedBlock), status: "deleted" },
	]);
	const indexStore = createIndexStore(index);
	const app = createApp(files, contents, TFile, TFolder);
	const archiveService = new MonthlyArchiveService(app as never, markdownBlockService);
	const rebuildService = new MonthlyArchiveRebuildService(
		app as never,
		createSettings,
		archiveService,
		indexStore as never,
		{ mark: () => undefined } as never,
		markdownBlockService,
	);

	const result = await rebuildService.rebuildPeriod("2026-06", {
		replaceExisting: false,
		createBackup: false,
	});

	assert.equal(result.rebuilt, 2);
	assert.equal(result.issues, 0);
	assert.equal(result.archiveChanged, true);
	const monthlyContent = contents.get("Memos/Memos-2026-06.md") ?? "";
	assert.match(monthlyContent, /- 08:00 first memo/);
	assert.match(monthlyContent, /- 09:00 second memo \^abc123/);
	assert.doesNotMatch(monthlyContent, /deleted memo/);
	assert.doesNotMatch(monthlyContent, /first memo \^/);
	assert.deepEqual(Object.keys(index.memos).sort(), ["memo-a", "memo-b", "memo-deleted"]);
	assert.equal(index.memos["memo-a"]?.id, "memo-a");
	assert.equal(index.memos["memo-b"]?.monthlyRef.path, "Memos/Memos-2026-06.md");
	assert.equal(index.memos["memo-b"]?.monthlyRef.lastKnownBlock, secondBlock.rawBlock);
});

test("monthly archive rebuild records missing and ambiguous daily blocks without using snapshots", async () => {
	await ensureObsidianStub();
	const { TFile, TFolder } = await import("obsidian");
	const { MarkdownBlockService } = await import("../src/services/MarkdownBlockService");
	const { MonthlyArchiveService } = await import("../src/services/MonthlyArchiveService");
	const { MonthlyArchiveRebuildService } = await import("../src/services/MonthlyArchiveRebuildService");
	const markdownBlockService = new MarkdownBlockService();
	const daily = Object.assign(new TFile(), { path: "Daily/2026-06-04.md", extension: "md" });
	const validDaily = Object.assign(new TFile(), { path: "Daily/2026-06-05.md", extension: "md" });
	const monthlyFolder = Object.assign(new TFolder(), { path: "Memos", children: [] });
	const files = new Map<string, unknown>([
		[daily.path, daily],
		[validDaily.path, validDaily],
		[monthlyFolder.path, monthlyFolder],
	]);
	const contents = new Map<string, string>([
		[daily.path, "## Memos\n- 08:00 duplicate memo\n- 08:00 duplicate memo"],
		[validDaily.path, "## Memos\n- 09:00 valid memo"],
	]);
	const ambiguousBlock = parseBlock(markdownBlockService, "- 08:00 duplicate memo");
	const missingBlock = parseBlock(markdownBlockService, "- 07:00 stale snapshot must not return");
	const validBlock = parseBlock(markdownBlockService, "- 09:00 valid memo");
	const ambiguousMemo = createMemo("memo-ambiguous", "2026-06-04T08:00:00", daily.path, ambiguousBlock);
	ambiguousMemo.dailyRef.lineNumberHint = null;
	const index = createIndex("2026-06", [
		ambiguousMemo,
		createMemo("memo-missing", "2026-06-01T07:00:00", "Daily/2026-06-01.md", missingBlock),
		createMemo("memo-valid", "2026-06-05T09:00:00", validDaily.path, validBlock),
	]);
	const indexStore = createIndexStore(index);
	const app = createApp(files, contents, TFile, TFolder);
	const rebuildService = new MonthlyArchiveRebuildService(
		app as never,
		createSettings,
		new MonthlyArchiveService(app as never, markdownBlockService),
		indexStore as never,
		{ mark: () => undefined } as never,
		markdownBlockService,
	);

	const result = await rebuildService.rebuildPeriod("2026-06", {
		replaceExisting: false,
		createBackup: false,
	});

	assert.equal(result.rebuilt, 1);
	assert.equal(result.issues, 2);
	const monthlyContent = contents.get("Memos/Memos-2026-06.md") ?? "";
	assert.match(monthlyContent, /valid memo/);
	assert.doesNotMatch(monthlyContent, /stale snapshot must not return/);
	assert.doesNotMatch(monthlyContent, /duplicate memo/);
	assert.equal(index.memos["memo-missing"]?.issue?.code, "daily_file_missing");
	assert.equal(index.memos["memo-ambiguous"]?.issue?.type, "daily_block_ambiguous");
	assert.equal(index.memos["memo-valid"]?.syncStatus, "synced");
});

test("monthly archive rebuild does not create an index when the period index is missing", async () => {
	await ensureObsidianStub();
	const { TFile, TFolder } = await import("obsidian");
	const { MarkdownBlockService } = await import("../src/services/MarkdownBlockService");
	const { MonthlyArchiveService } = await import("../src/services/MonthlyArchiveService");
	const { MonthlyArchiveRebuildService } = await import("../src/services/MonthlyArchiveRebuildService");
	const markdownBlockService = new MarkdownBlockService();
	const monthlyFolder = Object.assign(new TFolder(), { path: "Memos", children: [] });
	const files = new Map<string, unknown>([[monthlyFolder.path, monthlyFolder]]);
	const contents = new Map<string, string>();
	const app = createApp(files, contents, TFile, TFolder);
	let mergeCalled = false;
	const rebuildService = new MonthlyArchiveRebuildService(
		app as never,
		createSettings,
		new MonthlyArchiveService(app as never, markdownBlockService),
		{
			loadExistingPeriod: async () => null,
			mergePeriod: async () => {
				mergeCalled = true;
			},
		} as never,
		{ mark: () => undefined } as never,
		markdownBlockService,
	);

	await assert.rejects(
		() => rebuildService.rebuildPeriod("2026-06", { replaceExisting: false, createBackup: false }),
		(error: unknown) => error instanceof Error && error.message.includes("Monthly memo-index does not exist"),
	);
	assert.equal(mergeCalled, false);
	assert.equal(files.has("Memos/Memos-2026-06.md"), false);
});

test("loadExistingPeriod returns null without creating an empty memo-index", async () => {
	await ensureObsidianStub();
	const { MemoIndexStore } = await import("../src/services/MemoIndexStore");
	let createCalled = false;
	const store = new MemoIndexStore({
		vault: {
			getAbstractFileByPath: () => null,
			create: async () => {
				createCalled = true;
			},
		},
	} as never);

	const index = await store.loadExistingPeriod("Memos", "2026-06");

	assert.equal(index, null);
	assert.equal(createCalled, false);
});

test("memo-index loading restores historical reference metadata", async () => {
	await ensureObsidianStub();
	const { MemoIndexStore } = await import("../src/services/MemoIndexStore");
	const { MarkdownBlockService } = await import("../src/services/MarkdownBlockService");
	const { TFile, TFolder } = await import("obsidian");
	const markdownBlockService = new MarkdownBlockService();
	const indexFolder = Object.assign(new TFolder(), {
		path: "Memos/_knomo-system/indexes",
		children: [] as unknown[],
	});
	const indexFile = Object.assign(new TFile(), {
		path: "Memos/_knomo-system/indexes/memo-index-2026-06.json",
		name: "memo-index-2026-06.json",
	});
	indexFolder.children = [indexFile];
	const source = createMemo(
		"2026060208000000",
		"2026-06-02T08:00:00",
		"Daily/2026-06-02.md",
		parseBlock(markdownBlockService, "- 08:00 source ^abc123"),
	);
	const childBlock = parseBlock(
		markdownBlockService,
		"- 09:00 child [[Daily/2026-06-02#^abc123|20260602-080000-00]]",
	);
	const child = createMemo("2026060209000001", "2026-06-02T09:00:00", "Daily/2026-06-02.md", childBlock);
	const indexData = JSON.stringify(createIndex("2026-06", [source, child]));
	const store = new MemoIndexStore({
		vault: {
			getAbstractFileByPath: (path: string) => {
				if (path === indexFolder.path) return indexFolder;
				if (path === indexFile.path) return indexFile;
				return null;
			},
			cachedRead: async () => indexData,
		},
		metadataCache: {
			getFirstLinkpathDest: (linkPath: string) => linkPath === "Daily/2026-06-02"
				? { path: "Daily/2026-06-02.md" }
				: null,
		},
	} as never);

	const memos = await store.loadAll("Memos");
	const recovered = memos.find((memo) => memo.id === child.id);

	assert.equal(recovered?.sourceMemoId, source.id);
	assert.equal(recovered?.references[0]?.referenceText, "[[Daily/2026-06-02#^abc123|20260602-080000-00]]");
});

test("automatic monthly archive recovery leaves a restored file unchanged", async () => {
	await ensureObsidianStub();
	const { TFile, TFolder } = await import("obsidian");
	const { MarkdownBlockService } = await import("../src/services/MarkdownBlockService");
	const { MonthlyArchiveService } = await import("../src/services/MonthlyArchiveService");
	const { MonthlyArchiveRebuildService } = await import("../src/services/MonthlyArchiveRebuildService");
	const markdownBlockService = new MarkdownBlockService();
	const daily = Object.assign(new TFile(), { path: "Daily/2026-06-02.md", extension: "md" });
	const monthly = Object.assign(new TFile(), { path: "Memos/Memos-2026-06.md", extension: "md" });
	const monthlyFolder = Object.assign(new TFolder(), { path: "Memos", children: [monthly] });
	const files = new Map<string, unknown>([
		[daily.path, daily],
		[monthly.path, monthly],
		[monthlyFolder.path, monthlyFolder],
	]);
	const contents = new Map<string, string>([
		[daily.path, "## Memos\n- 08:00 daily memo"],
		[monthly.path, "restored original"],
	]);
	const block = parseBlock(markdownBlockService, "- 08:00 daily memo");
	const index = createIndex("2026-06", [createMemo("memo-a", "2026-06-02T08:00:00", daily.path, block)]);
	const indexStore = createIndexStore(index);
	const app = createApp(files, contents, TFile, TFolder);
	const rebuildService = new MonthlyArchiveRebuildService(
		app as never,
		createSettings,
		new MonthlyArchiveService(app as never, markdownBlockService),
		indexStore as never,
		{ mark: () => undefined } as never,
		markdownBlockService,
	);

	const result = await rebuildService.rebuildPeriod("2026-06", {
		replaceExisting: false,
		createBackup: false,
	});

	assert.equal(result.archiveChanged, false);
	assert.equal(result.indexChanged, false);
	assert.equal(contents.get(monthly.path), "restored original");
});

function createApp(
	files: Map<string, unknown>,
	contents: Map<string, string>,
	TFile: new () => { path: string },
	TFolder: new () => { path: string; children: unknown[] },
): unknown {
	return {
		vault: {
			getAbstractFileByPath: (path: string) => files.get(path) ?? null,
			cachedRead: async (file: { path: string }) => contents.get(file.path) ?? "",
			process: async (file: { path: string }, callback: (content: string) => string) => {
				const next = callback(contents.get(file.path) ?? "");
				contents.set(file.path, next);
				return next;
			},
			create: async (path: string, content: string) => {
				const file = Object.assign(new TFile(), { path, extension: "md" });
				files.set(path, file);
				contents.set(path, content);
				return file;
			},
			createFolder: async (path: string) => {
				const folder = Object.assign(new TFolder(), { path, children: [] });
				files.set(path, folder);
				return folder;
			},
		},
	};
}

function createIndexStore(index: MemoIndex): unknown {
	return {
		loadExistingPeriod: async () => index,
		backupIndexes: async () => "Memos/_knomo-system/backups/rebuild-monthly",
		mergePeriod: async (_folder: string, _period: string, merge: (current: MemoIndex) => MemoIndex) => {
			const next = merge(index);
			Object.assign(index, next);
			return index;
		},
	};
}

function createIndex(period: string, memos: MemoRecord[]): MemoIndex {
	return {
		schemaVersion: 2,
		period,
		updatedAt: "2026-06-01T00:00:00",
		memos: Object.fromEntries(memos.map((memo) => [memo.id, memo])),
	};
}

function createMemo(id: string, createdAt: string, dailyPath: string, block: ParsedMemoBlock): MemoRecord {
	return {
		id,
		createdAt,
		updatedAt: createdAt,
		contentSnapshot: block.content,
		contentHash: block.contentHash,
		status: "active",
		syncStatus: "synced",
		source: "plugin_input",
		version: 1,
		tags: block.tags,
		links: block.links,
		images: block.images,
		references: [],
		sourceMemoId: null,
		issue: null,
		lastMarkdownSyncAt: null,
		lastMarkdownSyncSource: null,
		dailyRef: {
			path: dailyPath,
			heading: "## Memos",
			sectionType: "heading",
			lastKnownBlock: block.rawBlock,
			lastKnownHash: hashText(block.rawBlock),
			lineNumberHint: 2,
			lastSyncedAt: null,
		},
		monthlyRef: {
			path: "Memos/Memos-2026-06.md",
			dateHeading: `## ${createdAt.slice(0, 10)}`,
			lastKnownBlock: block.rawBlock,
			lastKnownHash: hashText(block.rawBlock),
			lineNumberHint: 5,
			lastSyncedAt: null,
		},
	};
}

function parseBlock(service: { parseMemoBlock(lines: string[], startLine: number): ParsedMemoBlock | null }, rawBlock: string): ParsedMemoBlock {
	const block = service.parseMemoBlock(rawBlock.split("\n"), 0);
	if (block === null) {
		throw new Error(`Invalid test memo block: ${rawBlock}`);
	}
	return block;
}

function createSettings(): KnomoSettings {
	return {
		settingsVersion: 1,
		dailyHeading: "## Memos",
		dailyInsertPosition: "bottom",
		memoTimeFormat: "HH:mm",
		monthlyMemoFolder: "Memos",
		monthlyMemoFileFormat: "Memos-YYYY-MM.md",
		monthlyDateHeadingFormat: "## YYYY-MM-DD",
		monthlyDateOrder: "asc",
		legacyDailyHeadings: [],
		mobileCompactMode: "auto",
		syncDebounceMs: 0,
		desktopSidebarWidth: 360,
		desktopSidebarCollapsed: false,
		excludeMonthlyMemosFromObsidian: false,
		pinnedTags: [],
	};
}

async function ensureObsidianStub(): Promise<void> {
	const stubPath = resolve(__dirname, "../node_modules/obsidian/index.js");
	await mkdir(dirname(stubPath), { recursive: true });
	await writeFile(
		stubPath,
		[
			"class TFile {}",
			"class TFolder { constructor() { this.children = []; } }",
			"const Vault = { recurseChildren() {} };",
			"const normalizePath = (value) => value.replace(/\\\\/g, '/').replace(/\\/+/g, '/').replace(/^\\//, '').replace(/\\/$/, '');",
			"function getLanguage() { return 'en'; }",
			"let localeValue = 'en';",
			"const moment = (date = new Date()) => ({ format: () => date.toISOString().slice(0, 10) });",
			"moment.locale = (value) => { if (typeof value === 'string') localeValue = value; return localeValue; };",
			"module.exports = { TFile, TFolder, Vault, normalizePath, getLanguage, moment };",
		].join("\n"),
	);
}
