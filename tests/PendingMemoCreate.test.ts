import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import test from "node:test";

import type { MemoRecord } from "../src/types/memo";
import type { PendingMemoCreate } from "../src/types/pending";
import type { KnomoSettings } from "../src/types/settings";
import type { PendingMemoCreateStoreLike } from "../src/services/PendingMemoCreateStore";

test("journal failure stops before daily and monthly memo writes", async () => {
	const harness = await createHarness();
	harness.pendingStore.failAdd = true;

	await assert.rejects(
		harness.service.createMemo("journal failure"),
		/journal add failed/,
	);

	assert.equal(harness.dailyInsertions(), 0);
	assert.equal(harness.monthlyInsertions(), 0);
	assert.equal(harness.indexStore.memos.size, 0);
});

test("index failure recovers the original memoId without duplicate Markdown blocks", async () => {
	const harness = await createHarness();
	harness.indexStore.failNextAdd = true;

	await assert.rejects(
		harness.service.createMemo("recover me"),
		/Failed to write memo-index while creating memo/,
	);

	const pending = await harness.pendingStore.list();
	assert.equal(pending.length, 1);
	assert.equal(harness.dailyInsertions(), 1);
	assert.equal(harness.monthlyInsertions(), 1);
	assert.equal(harness.indexStore.memos.size, 0);

	assert.equal(await harness.createService().recoverPendingCreates(), 1);
	assert.equal(harness.indexStore.memos.get(pending[0].memoId)?.id, pending[0].memoId);
	assert.equal(harness.dailyInsertions(), 1);
	assert.equal(harness.monthlyInsertions(), 1);
	assert.deepEqual(await harness.pendingStore.list(), []);

	assert.equal(await harness.createService().recoverPendingCreates(), 0);
	assert.equal(harness.dailyInsertions(), 1);
	assert.equal(harness.monthlyInsertions(), 1);
});

test("journal cleanup failure is removed later without replaying committed writes", async () => {
	const harness = await createHarness();
	harness.pendingStore.failNextRemove = true;

	const result = await harness.service.createMemo("cleanup later");
	assert.equal(harness.indexStore.memos.get(result.memo.id)?.id, result.memo.id);
	assert.equal((await harness.pendingStore.list()).length, 1);
	assert.equal(harness.dailyInsertions(), 1);
	assert.equal(harness.monthlyInsertions(), 1);

	assert.equal(await harness.createService().recoverPendingCreates(), 1);
	assert.deepEqual(await harness.pendingStore.list(), []);
	assert.equal(harness.dailyInsertions(), 1);
	assert.equal(harness.monthlyInsertions(), 1);
});

test("prepared daily and monthly writes are idempotent without adding block IDs", async () => {
	await ensureObsidianStub();
	const { TFile } = await import("obsidian");
	const { DailyNoteService } = await import("../src/services/DailyNoteService");
	const { MarkdownBlockService } = await import("../src/services/MarkdownBlockService");
	const { MonthlyArchiveService } = await import("../src/services/MonthlyArchiveService");
	const settings = createTestSettings();
	const date = new Date(2026, 5, 13, 10, 0, 0);
	const dailyFile = Object.assign(new TFile(), { path: "Daily/2026-06-13.md" });
	const monthlyFile = Object.assign(new TFile(), { path: "Memos/Memos-2026-06.md" });
	const contents = new Map<string, string>([
		[dailyFile.path, "# 2026-06-13\n\n## Knomo"],
		[monthlyFile.path, ""],
	]);
	const files = new Map([
		[dailyFile.path, dailyFile],
		[monthlyFile.path, monthlyFile],
	]);
	const app = {
		vault: {
			getAbstractFileByPath: (path: string) => files.get(path) ?? null,
			cachedRead: async (file: { path: string }) => contents.get(file.path) ?? "",
			process: async (file: { path: string }, update: (content: string) => string) => {
				const nextContent = update(contents.get(file.path) ?? "");
				contents.set(file.path, nextContent);
				return nextContent;
			},
		},
	};
	const markdownBlockService = new MarkdownBlockService();
	const dailyNoteService = new DailyNoteService(
		app as never,
		markdownBlockService,
		{
			getConfig: () => ({ folder: "Daily", format: "YYYY-MM-DD" }),
			loadConfig: async () => ({ folder: "Daily", format: "YYYY-MM-DD" }),
		},
	);
	const monthlyArchiveService = new MonthlyArchiveService(app as never, markdownBlockService);
	const block = markdownBlockService.buildMemoBlock("plain memo", "10:00:00");

	const dailyPrepared = await dailyNoteService.prepareMemoBlockInsert(settings, date, block);
	assert.equal((await dailyNoteService.commitPreparedMemoBlock(settings, block, dailyPrepared)).changed, true);
	assert.equal((await dailyNoteService.commitPreparedMemoBlock(settings, block, dailyPrepared)).changed, false);

	const monthlyPrepared = await monthlyArchiveService.prepareMemoBlockInsert(settings, date, block);
	assert.equal((await monthlyArchiveService.commitPreparedMemoBlock(settings, date, block, monthlyPrepared)).changed, true);
	assert.equal((await monthlyArchiveService.commitPreparedMemoBlock(settings, date, block, monthlyPrepared)).changed, false);

	assert.equal((contents.get(dailyFile.path)?.match(/plain memo/g) ?? []).length, 1);
	assert.equal((contents.get(monthlyFile.path)?.match(/plain memo/g) ?? []).length, 1);
	assert.doesNotMatch(contents.get(dailyFile.path) ?? "", /\^[A-Za-z0-9_-]+/);
	assert.doesNotMatch(contents.get(monthlyFile.path) ?? "", /\^[A-Za-z0-9_-]+/);
});

test("pending create store persists operations under the Knomo system folder", async () => {
	await ensureObsidianStub();
	const { TFile, TFolder } = await import("obsidian");
	const { PendingMemoCreateStore } = await import("../src/services/PendingMemoCreateStore");
	const settings = createTestSettings();
	const files = new Map<string, InstanceType<typeof TFile> | InstanceType<typeof TFolder>>();
	const contents = new Map<string, string>();
	const app = {
		vault: {
			getAbstractFileByPath: (path: string) => files.get(path) ?? null,
			createFolder: async (path: string) => {
				const folder = Object.assign(new TFolder(), { path });
				files.set(path, folder);
				return folder;
			},
			create: async (path: string, content: string) => {
				const file = Object.assign(new TFile(), { path });
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
	const store = new PendingMemoCreateStore(app as never, () => settings);
	const operation = createPendingOperation(settings);

	await store.add(operation);
	assert.deepEqual(await store.list(), [operation]);
	await store.update({
		...operation,
		content: "updated",
	});
	assert.equal((await store.list())[0]?.content, "updated");
	await store.remove(operation.memoId);
	assert.deepEqual(await store.list(), []);
	assert.ok(files.has("Memos/_knomo-system/pending-memo-creates.json"));
});

async function createHarness() {
	await ensureObsidianStub();
	const { MarkdownBlockService } = await import("../src/services/MarkdownBlockService");
	const { MemoCommandService } = await import("../src/services/memoCommands");
	const settings = createTestSettings();
	const pendingStore = new MemoryPendingMemoCreateStore();
	const indexStore = new MemoryMemoIndexStore();
	let dailyWritten = false;
	let monthlyWritten = false;
	let dailyInsertions = 0;
	let monthlyInsertions = 0;

	const dailyNoteService = {
		prepareMemoBlockInsert: async (
			_settings: KnomoSettings,
			_createdAt: Date,
			block: string,
		) => ({
			path: "Daily/today.md",
			beforeHash: "daily-before",
			afterHash: "daily-after",
			blockOccurrencesBefore: 0,
			ref: {
				path: "Daily/today.md",
				heading: "## Knomo",
				sectionType: "heading" as const,
				lastKnownBlock: block,
				lastKnownHash: "daily-block",
				lineNumberHint: 2,
				lastSyncedAt: "2026-06-13T10:00:00.000+08:00",
			},
		}),
		commitPreparedMemoBlock: async (
			_settings: KnomoSettings,
			_block: string,
			prepared: PendingMemoCreate["dailyWrite"],
		) => {
			const changed = !dailyWritten;
			if (changed) {
				dailyWritten = true;
				dailyInsertions += 1;
			}
			return {
				file: { path: prepared.path },
				content: "daily-content",
				ref: prepared.ref,
				changed,
			};
		},
	};
	const monthlyArchiveService = {
		prepareMemoBlockInsert: async (
			_settings: KnomoSettings,
			_createdAt: Date,
			block: string,
		) => ({
			path: "Memos/Memos-2026-06.md",
			beforeHash: "monthly-before",
			afterHash: "monthly-after",
			blockOccurrencesBefore: 0,
			ref: {
				path: "Memos/Memos-2026-06.md",
				dateHeading: "## 2026-06-13",
				lastKnownBlock: block,
				lastKnownHash: "monthly-block",
				lineNumberHint: 4,
				lastSyncedAt: "2026-06-13T10:00:00.000+08:00",
			},
		}),
		commitPreparedMemoBlock: async (
			_settings: KnomoSettings,
			_createdAt: Date,
			_block: string,
			prepared: NonNullable<PendingMemoCreate["monthlyWrite"]>,
		) => {
			const changed = !monthlyWritten;
			if (changed) {
				monthlyWritten = true;
				monthlyInsertions += 1;
			}
			return {
				file: { path: prepared.path },
				content: "monthly-content",
				ref: prepared.ref,
				changed,
			};
		},
	};
	const markdownBlockService = new MarkdownBlockService();
	const createService = () => new MemoCommandService(
		{} as never,
		() => settings,
		dailyNoteService as never,
		monthlyArchiveService as never,
		indexStore as never,
		{ mark: () => undefined } as never,
		markdownBlockService,
		pendingStore,
	);
	return {
		service: createService(),
		createService,
		pendingStore,
		indexStore,
		dailyInsertions: () => dailyInsertions,
		monthlyInsertions: () => monthlyInsertions,
	};
}

class MemoryPendingMemoCreateStore implements PendingMemoCreateStoreLike {
	readonly operations = new Map<string, PendingMemoCreate>();
	failAdd = false;
	failNextRemove = false;

	async list(): Promise<PendingMemoCreate[]> {
		return [...this.operations.values()];
	}

	async add(operation: PendingMemoCreate): Promise<void> {
		if (this.failAdd) {
			throw new Error("journal add failed");
		}
		this.operations.set(operation.memoId, operation);
	}

	async update(operation: PendingMemoCreate): Promise<void> {
		this.operations.set(operation.memoId, operation);
	}

	async remove(memoId: string): Promise<void> {
		if (this.failNextRemove) {
			this.failNextRemove = false;
			throw new Error("journal remove failed");
		}
		this.operations.delete(memoId);
	}
}

class MemoryMemoIndexStore {
	readonly memos = new Map<string, MemoRecord>();
	failNextAdd = false;

	async findMemoByIdInPeriod(
		_monthlyMemoFolder: string,
		_period: string,
		memoId: string,
	): Promise<MemoRecord | null> {
		return this.memos.get(memoId) ?? null;
	}

	async addMemoWithId(_monthlyMemoFolder: string, memo: MemoRecord): Promise<MemoRecord> {
		if (this.failNextAdd) {
			this.failNextAdd = false;
			throw new Error("index write failed");
		}
		const existing = this.memos.get(memo.id);
		if (existing !== undefined) {
			return existing;
		}
		this.memos.set(memo.id, memo);
		return memo;
	}
}

function createPendingOperation(settings: KnomoSettings): PendingMemoCreate {
	return {
		memoId: "2026061310000001",
		opId: "op-20260613100000-0001",
		createdAt: "2026-06-13T10:00:00.000+08:00",
		content: "pending",
		block: "- 10:00:00 pending",
		dailyTrailer: null,
		source: "plugin_input",
		sourceMemoId: null,
		sourceReferenceText: null,
		settings,
		dailyWrite: {
			path: "Daily/2026-06-13.md",
			beforeHash: "daily-before",
			afterHash: "daily-after",
			blockOccurrencesBefore: 0,
			ref: {
				path: "Daily/2026-06-13.md",
				heading: "## Knomo",
				sectionType: "heading",
				lastKnownBlock: "- 10:00:00 pending",
				lastKnownHash: "daily-block",
				lineNumberHint: 2,
				lastSyncedAt: "2026-06-13T10:00:00.000+08:00",
			},
		},
		monthlyWrite: null,
	};
}

function createTestSettings(): KnomoSettings {
	return {
		settingsVersion: 2,
		dailyHeading: "## Knomo",
		dailyInsertPosition: "bottom",
		memoTimeFormat: "HH:mm:ss",
		monthlyMemoFolder: "Memos",
		monthlyMemoFileFormat: "Memos-YYYY-MM.md",
		monthlyDateHeadingFormat: "## YYYY-MM-DD",
		monthlyDateOrder: "asc",
		legacyDailyHeadings: [],
		mobileCompactMode: "auto",
		syncDebounceMs: 1000,
		desktopSidebarWidth: 248,
		desktopSidebarCollapsed: false,
		excludeMonthlyMemosFromObsidian: false,
		managedObsidianExcludeRuleOwned: false,
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
			"const moment = (date = new Date()) => ({ format: () => date.toISOString().slice(0, 10) });",
			"module.exports = { TFile, TFolder, Vault, normalizePath, moment };",
		].join("\n"),
	);
}
