import test from "node:test";
import assert from "node:assert/strict";

import { MarkdownBlockService } from "../src/services/MarkdownBlockService";
import { MemoScanService, type ScanDailyMemosResult } from "../src/services/MemoScanService";
import type { MemoIndex } from "../src/types";
import type { MemoRecord } from "../src/types/memo";
import type { KnomoSettings } from "../src/types/settings";
import { hashMemoContent, hashText } from "../src/utils/hash";

test("recovers references once after scanning and writes one index per period", async () => {
	const source = createMemo("source", "source", "- 10:00 source ^abc123");
	const firstChild = createMemo("child-1", "first [[Daily/2026-05-18#^abc123]]", "- 08:00 first [[Daily/2026-05-18#^abc123]]");
	const secondChild = createMemo("child-2", "second [[Daily/2026-05-18#^abc123]]", "- 09:00 second [[Daily/2026-05-18#^abc123]]");
	const memos = [firstChild, secondChild, source];
	const index = createIndex(memos);
	let mergeCalls = 0;
	let selfWriteMarks = 0;
	const service = new MemoScanService(
		{ metadataCache: { getFirstLinkpathDest: () => ({ path: "Daily/2026-05-18.md" }) } } as never,
		() => createSettings(),
		{} as never,
		{} as never,
		{
			getIndexFilePath: () => "Memos/_knomo-system/indexes/memo-index-2026-05.json",
			mergePeriod: async (_folder: string, _period: string, merge: (value: MemoIndex) => MemoIndex) => {
				mergeCalls += 1;
				const next = merge(index);
				index.updatedAt = next.updatedAt;
				index.memos = next.memos;
				return next;
			},
		} as never,
		{ mark: () => { selfWriteMarks += 1; } } as never,
		new MarkdownBlockService(),
	);
	const result = createScanResult();

	await recoverReferencesAfterScan(service, memos, result);

	assert.equal(mergeCalls, 1);
	assert.equal(selfWriteMarks, 1);
	assert.equal(result.updated, 2);
	assert.equal(result.skipped, 1);
	assert.deepEqual(index.memos[firstChild.id].references, [{
		memoId: source.id,
		referenceText: "[[Daily/2026-05-18#^abc123]]",
	}]);
	assert.equal(index.memos[secondChild.id].sourceMemoId, source.id);

	await recoverReferencesAfterScan(service, memos, createScanResult());
	assert.equal(mergeCalls, 1);
});

test("does not overwrite reference metadata changed after the scan snapshot", async () => {
	const source = createMemo("source", "source", "- 10:00 source ^abc123");
	const child = createMemo("child", "child [[Daily/2026-05-18#^abc123]]", "- 08:00 child [[Daily/2026-05-18#^abc123]]");
	const memos = [child, source];
	const index = createIndex(memos);
	index.memos[child.id] = {
		...child,
		updatedAt: "2026-05-18T09:00:00.000+08:00",
		version: child.version + 1,
		sourceMemoId: "manual-source",
		references: [{ memoId: "manual-source", referenceText: "[[Manual#^source]]" }],
	};
	let selfWriteMarks = 0;
	const service = new MemoScanService(
		{ metadataCache: { getFirstLinkpathDest: () => ({ path: "Daily/2026-05-18.md" }) } } as never,
		() => createSettings(),
		{} as never,
		{} as never,
		{
			getIndexFilePath: () => "Memos/_knomo-system/indexes/memo-index-2026-05.json",
			mergePeriod: async (_folder: string, _period: string, merge: (value: MemoIndex) => MemoIndex) => merge(index),
		} as never,
		{ mark: () => { selfWriteMarks += 1; } } as never,
		new MarkdownBlockService(),
	);
	const result = createScanResult();
	result.skipped = 2;

	await recoverReferencesAfterScan(service, memos, result);

	assert.equal(index.memos[child.id].sourceMemoId, "manual-source");
	assert.deepEqual(index.memos[child.id].references, [{
		memoId: "manual-source",
		referenceText: "[[Manual#^source]]",
	}]);
	assert.equal(result.updated, 0);
	assert.equal(result.skipped, 2);
	assert.equal(selfWriteMarks, 0);
});

async function recoverReferencesAfterScan(
	service: MemoScanService,
	memos: MemoRecord[],
	result: ScanDailyMemosResult,
): Promise<void> {
	const internalService = service as unknown as {
		recoverReferencesAfterScan: (
			settings: KnomoSettings,
			existingMemos: MemoRecord[],
			initialMemosById: ReadonlyMap<string, MemoRecord>,
			opId: string,
			result: ScanDailyMemosResult,
			memoIndexStore: unknown,
			adjustSkipped: boolean,
		) => Promise<void>;
	};
	const memoIndexStore = (service as unknown as { memoIndexStore: unknown }).memoIndexStore;
	await internalService.recoverReferencesAfterScan(
		createSettings(),
		memos,
		new Map(memos.map((memo) => [memo.id, memo])),
		"scan-op",
		result,
		memoIndexStore,
		true,
	);
}

function createMemo(id: string, content: string, rawBlock: string): MemoRecord {
	return {
		id,
		createdAt: "2026-05-18T08:00:00.000+08:00",
		updatedAt: "2026-05-18T08:00:00.000+08:00",
		contentSnapshot: content,
		contentHash: hashMemoContent(content),
		status: "active",
		syncStatus: "synced",
		source: "daily_scan",
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
			path: "Daily/2026-05-18.md",
			heading: "## Knomo",
			sectionType: "heading",
			lastKnownBlock: rawBlock,
			lastKnownHash: hashText(rawBlock),
			lineNumberHint: 1,
			lastSyncedAt: null,
		},
		monthlyRef: {
			path: "Memos/Memos-2026-05.md",
			dateHeading: "## 2026-05-18",
			lastKnownBlock: rawBlock,
			lastKnownHash: hashText(rawBlock),
			lineNumberHint: 1,
			lastSyncedAt: null,
		},
	};
}

function createIndex(memos: MemoRecord[]): MemoIndex {
	return {
		schemaVersion: 2,
		period: "2026-05",
		updatedAt: "2026-05-18T08:00:00.000+08:00",
		memos: Object.fromEntries(memos.map((memo) => [memo.id, memo])),
	};
}

function createScanResult(): ScanDailyMemosResult {
	return {
		scannedFiles: 1,
		created: 0,
		updated: 0,
		deleted: 0,
		skipped: 3,
		failed: 0,
		errors: [],
	};
}

function createSettings(): KnomoSettings {
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
		managedSystemFolderExcludeRuleOwned: false,
		pinnedTags: [],
	};
}
