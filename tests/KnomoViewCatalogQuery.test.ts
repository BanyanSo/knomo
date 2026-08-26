import assert from "node:assert/strict";
import test from "node:test";

import type { MemoViewItem } from "../src/types/memoView";
import { ensureObsidianStub } from "./helpers/obsidianStub";

test("CAT-QUERY-002：桌面 Catalog 查询只提交最后发起的请求", async () => {
	await ensureObsidianStub();
	const { KnomoView } = await import("../src/ui/KnomoView");
	const first = createDeferred<QueryMemo[]>();
	const second = createDeferred<QueryMemo[]>();
	const loads = [first, second];
	const view = Object.create(KnomoView.prototype) as QueryView;
	view.memoSourceGeneration = 0;
	view.catalogDesktopQueryRun = 0;
	view.memos = [];
	view.viewStateController = { activeNav: "all" };
	view.loadCatalogMemos = async () => {
		const load = loads.shift();
		assert.notEqual(load, undefined);
		return {
			memos: await (load?.promise ?? []),
			nextCursor: null,
			catalogRevision: 1,
			coverage: { kind: "complete", coveredFromDate: "2026-08-01", pendingFileCount: 0, coveredFileCount: 1, totalFileCount: 1 },
			readState: "ready",
			status: { content: "ready", catalog: "complete", identity: "ready", projection: "ready", migration: "none" },
		};
	};
	view.getCardFlowStateKey = () => "card-flow";
	view.getMobileSearchStateKey = () => "mobile-search";
	view.invalidateRecordStats = () => undefined;
	view.invalidateMemoSearchCache = () => undefined;
	view.retainMemoCardPreviews = () => undefined;
	view.resetVisibleMemos = () => undefined;
	view.renderUiState = () => undefined;
	view.forceRebuildCardFlow = () => undefined;
	view.renderMobileSearchResults = () => undefined;
	view.renderCardFlowIfChanged = () => undefined;
	view.renderMobileSearchResultsIfChanged = () => undefined;
	view.randomReunionController = {
		getSnapshot: () => ({ loading: false, memos: null }),
		clearMemos: () => undefined,
		refresh: async () => undefined,
	};
	view.shuffleDayController = { reconcileWithMemos: () => undefined };
	view.refreshCatalogLibraryIndexes = async () => undefined;

	const firstRun = view.reloadMemos(false, true);
	const secondRun = view.reloadMemos(false, true);
	second.resolve([makeMemo("new", "2026-08-24T10:00:00")]);
	assert.equal(await secondRun, true);
	first.resolve([makeMemo("old", "2026-08-23T10:00:00")]);
	assert.equal(await firstRun, false);
	assert.deepEqual(view.memos.map((memo) => memo.id), ["new"]);
});

test("CAT-PAGE-001：分页合并超过旧窗口阈值时不丢失已显示的新记录", async () => {
	await ensureObsidianStub();
	const { mergeCatalogMemoPages } = await import("../src/ui/KnomoView");
	const memos = Array.from({ length: 200 }, (_, index) => makeMemo(
		`memo-${index.toString().padStart(3, "0")}`,
		`2026-08-${(25 - Math.floor(index / 10)).toString().padStart(2, "0")}T${(23 - (index % 10)).toString().padStart(2, "0")}:00:00`,
	));

	const merged = mergeCatalogMemoPages(memos);
	assert.equal(merged.length, 200);
	assert.equal(merged.some((memo) => memo.id === "memo-000"), true);
	assert.equal(merged.some((memo) => memo.id === "memo-199"), true);
});

type QueryMemo = MemoViewItem;

interface QueryView {
	memoSourceGeneration: number;
	catalogDesktopQueryRun: number;
	memos: QueryMemo[];
	viewStateController: { activeNav: "all" };
	cardFlowError?: string | null;
	filteredMemosCache?: null;
	loadCatalogMemos: (loadAll: boolean) => Promise<{
		memos: QueryMemo[];
		nextCursor: null;
		coverage: { kind: "complete"; coveredFromDate: string; pendingFileCount: number; coveredFileCount: number; totalFileCount: number };
		readState: "ready";
		status: { content: "ready"; catalog: "complete"; identity: "ready"; projection: "ready"; migration: "none" };
	}>;
	getCardFlowStateKey: () => string;
	getMobileSearchStateKey: () => string;
	invalidateRecordStats: () => void;
	invalidateMemoSearchCache: () => void;
	retainMemoCardPreviews: () => void;
	resetVisibleMemos: () => void;
	renderUiState: (options: object) => void;
	forceRebuildCardFlow: () => void;
	renderMobileSearchResults: () => void;
	renderCardFlowIfChanged: (key: string) => void;
	renderMobileSearchResultsIfChanged: (key: string) => void;
	randomReunionController: {
		getSnapshot: () => { loading: boolean; memos: null };
		clearMemos: () => void;
		refresh: () => Promise<void>;
	};
	shuffleDayController: { reconcileWithMemos: () => void };
	refreshCatalogLibraryIndexes: () => Promise<void>;
	reloadMemos: (loadAll: boolean, forceRebuild?: boolean) => Promise<boolean>;
}

function createDeferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
	let resolvePromise: (value: T) => void = () => undefined;
	const promise = new Promise<T>((resolve) => {
		resolvePromise = resolve;
	});
	return { promise, resolve: resolvePromise };
}

function makeMemo(id: string, createdAt: string): MemoViewItem {
	return {
		id,
		createdAt,
		updatedAt: createdAt,
		contentSnapshot: id,
		contentHash: `hash-${id}`,
		status: "active",
		tags: [],
		links: [],
		images: [],
		references: [],
		sourceMemoId: null,
		dailyRef: {
			path: `Daily/${createdAt.slice(0, 10)}.md`,
			heading: "## Memos",
			sectionType: "heading",
			lineNumberHint: 1,
		},
	};
}
