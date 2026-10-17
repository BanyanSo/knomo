import test from "node:test";
import assert from "node:assert/strict";
import type { CatalogFeatureCursor, CatalogFeatureQuery, CatalogMemoPage } from "../src/types/catalogView";
import { KnomoViewStateController } from "../src/ui/KnomoViewStateController";
import { ensureObsidianStub } from "./helpers/obsidianStub";
import { createCatalogCapabilities } from "../src/services/MemoCapabilityModel";

test("查询取消：桌面草稿取代旧请求，当前查询继续完成且不显示取消错误", async () => {
	await ensureObsidianStub();
	const { KnomoView } = await import("../src/ui/KnomoView");
	const signals: AbortSignal[] = [];
	const errors: string[] = [];
	const view = createView(KnomoView, async (_request, signal) => {
		assert.ok(signal);
		signals.push(signal);
		if (signals.length === 1) return waitForCancellation(signal);
		return page();
	}, errors);
	const previous = view.reloadMemos(true);
	view.viewStateController.search.updateDraft("beta");
	view.invalidateSearchDraft();
	assert.equal(signals[0].aborted, true);
	view.viewStateController.search.submit();
	assert.equal(await view.reloadMemos(true), true);
	assert.equal(await previous, false);
	assert.equal(signals[1].aborted, false);
	assert.equal(view.viewStateController.search.result?.input, "beta");
	assert.deepEqual(errors, []);
});

test("查询取消：普通分页失效后立即停止，旧 finally 不清掉新查询所有权", async () => {
	await ensureObsidianStub();
	const { KnomoView } = await import("../src/ui/KnomoView");
	let pageSignal: AbortSignal | undefined;
	let releaseCurrent!: (value: CatalogMemoPage) => void;
	const view = createView(KnomoView, async (request, signal) => {
		assert.ok(signal);
		if (request.cursor) { pageSignal = signal; return waitForCancellation(signal); }
		if (request.textTerms) return new Promise(resolve => { releaseCurrent = resolve; });
		return page(CURSOR);
	});
	await view.reloadMemos(true);
	const previousPage = view.loadNextCatalogPage();
	view.viewStateController.searchQuery = "beta";
	const current = view.reloadMemos(true);
	const currentController = view.catalogDesktopQueryController;
	assert.equal(pageSignal?.aborted, true);
	assert.equal(await previousPage, false);
	assert.equal(view.catalogDesktopQueryController, currentController);
	releaseCurrent(page());
	assert.equal(await current, true);
	assert.equal(view.catalogLoadingNextPage, false);
	assert.equal(view.catalogCursor, null);
});

test("查询取消：每个 View 独立拥有请求，近月与全历史补查沿用同一信号", async () => {
	await ensureObsidianStub();
	const { KnomoView } = await import("../src/ui/KnomoView");
	const signals: AbortSignal[] = [];
	const query = async (_request: CatalogFeatureQuery, signal?: AbortSignal): Promise<CatalogMemoPage> => {
		assert.ok(signal);
		signals.push(signal);
		return waitForCancellation(signal);
	};
	const first = createView(KnomoView, query), second = createView(KnomoView, query);
	const firstLoad = first.reloadMemos(true), secondLoad = second.reloadMemos(true);
	first.cancelCatalogDesktopQuery();
	assert.equal(signals[0].aborted, true);
	assert.equal(signals[1].aborted, false);
	second.cancelCatalogDesktopQuery();
	assert.equal(await firstLoad, false);
	assert.equal(await secondLoad, false);
	const sequentialSignals: Array<AbortSignal | undefined> = [];
	const sequential = createView(KnomoView, async (_request, signal) => { sequentialSignals.push(signal); return page(); });
	const request = new AbortController();
	await sequential.loadCatalogMemos(false, request.signal);
	assert.deepEqual(sequentialSignals, [request.signal, request.signal]);
	let reads = 0;
	const nextRequest = new AbortController();
	const interrupted = createView(KnomoView, async () => { reads++; nextRequest.abort(); return page(); });
	await assert.rejects(interrupted.loadCatalogMemos(false, nextRequest.signal), error => error === nextRequest.signal.reason);
	assert.equal(reads, 1, "取消后不能继续全历史补查");
});

const COVERAGE = { kind: "complete" as const, coveredFromDate: "2026-01-01", pendingFileCount: 0, coveredFileCount: 1, totalFileCount: 1 };
const CURSOR: CatalogFeatureCursor = { catalog: { catalogRevision: 1, createdAtKey: "2026-01-01T09:00", observationKey: "first" } };

function page(nextCursor: CatalogFeatureCursor | null = null): CatalogMemoPage {
	return { items: [], nextCursor, catalogRevision: 1, coverage: COVERAGE, readState: "ready", invalidated: false,
		status: { content: "ready", catalog: "complete", projection: "ready" }, degraded: false,
		lifecycle: { state: "ready", persistent: true, writable: true, reason: null }, capabilities: createCatalogCapabilities(COVERAGE) };
}

function waitForCancellation(signal: AbortSignal): Promise<CatalogMemoPage> {
	return new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
}

function createView(
	View: typeof import("../src/ui/KnomoView").KnomoView,
	query: (request: CatalogFeatureQuery, signal?: AbortSignal) => Promise<CatalogMemoPage>,
	errors: string[] = [],
): CancellationView {
	return Object.assign(Object.create(View.prototype), {
		viewStateController: new KnomoViewStateController(), mobileSearchController: { isOpen: false },
		trashViewClosed: false, memoSourceGeneration: 0, catalogDesktopQueryRun: 0, catalogDesktopCountRun: 0,
		catalogDesktopQueryFingerprint: null, catalogDesktopQueryController: null, catalogCursor: null,
		catalogHistoryExpansionPending: false, catalogLoadingNextPage: false, catalogTodayTimeBuoys: null,
		catalogCoverage: COVERAGE, catalogRevision: 1, hasCommittedCatalogDesktopQuery: false, memos: [],
		getCatalogReadService: () => ({ query }), shouldShowTodayTimeBuoys: () => false, shouldCountCatalogQuery: () => false,
		getCardFlowStateKey: () => "cards", getMobileSearchStateKey: () => "mobile", clearSearchDebounce: () => {},
		syncSearchControls: () => {}, retainMemoCardPreviews: () => {}, resetVisibleMemos: () => {},
		renderUiState: () => {}, renderCardFlowIfChanged: () => {}, renderMobileSearchResultsIfChanged: () => {},
		renderAllMemosLoadingState: () => {}, renderCardFlow: () => {}, renderNextCardBatch: () => {},
		syncRecordStatsSource: () => {}, refreshCatalogLibraryIndexes: async () => {}, updateStatus: (message: string) => errors.push(message),
	}) as CancellationView;
}

interface CancellationView {
	viewStateController: KnomoViewStateController;
	catalogDesktopQueryController: AbortController | null;
	catalogLoadingNextPage: boolean;
	catalogCursor: CatalogFeatureCursor | null;
	reloadMemos(loadAll: boolean): Promise<boolean>;
	loadNextCatalogPage(): Promise<boolean>;
	loadCatalogMemos(loadAll: boolean, signal?: AbortSignal): Promise<unknown>;
	invalidateSearchDraft(): void;
	cancelCatalogDesktopQuery(): void;
}
