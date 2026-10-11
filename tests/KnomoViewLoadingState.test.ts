import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { t } from "../src/i18n";
import type { CatalogCoverage } from "../src/types/catalog";
import type { CatalogReadState, CatalogReadStatus } from "../src/types/catalogView";
import type { MemoViewItem } from "../src/types/memoView";
import { RecordStatsService } from "../src/services/RecordStatsService";
import { KnomoCardFlowCoordinator } from "../src/ui/KnomoCardFlowCoordinator";
import { renderKnomoCardFlowHeaders } from "../src/ui/KnomoFeed";
import type { CardFlowPresentation } from "../src/ui/KnomoCardFlowPresenter";
import { KnomoViewStateController } from "../src/ui/KnomoViewStateController";
import { RecordStatsViewStateController } from "../src/ui/RecordStatsViewStateController";
import { formatTimeBuoyDate } from "../src/utils/timeBuoyDate";
import { ensureObsidianStub } from "./helpers/obsidianStub";

interface MemoLoad {
	memos: MemoViewItem[];
	fullHistoryLoaded: boolean;
	nextCursor: null;
	coverage: CatalogCoverage;
	readState: CatalogReadState;
	status: CatalogReadStatus;
	catalogRevision: number;
}

test("桌面与移动首查等待时，焦点日期检查和强制重绘不能把加载占位替换为空态", async () => {
	for (const mobile of [false, true]) {
		const h = await createLoadingHarness(mobile);
		const load = deferred<MemoLoad>();
		h.view.loadCatalogMemos = () => load.promise;
		const pending = h.loadInitial();
		try {
			assert.equal(h.title(), t("empty.loadingAllMemos"));
			h.view.handleLocalDateChange();
			assert.equal(h.title(), t("empty.loadingAllMemos"));
			h.view.forceRebuildCardFlow();
			assert.equal(h.title(), t("empty.loadingAllMemos"));
			assert.equal(h.root.querySelector("[role='status']")?.getAttribute("aria-live"), "polite");
			load.resolve(readyLoad([memo("first")]));
			await pending;
			assert.equal(h.title(), null);
			assert.deepEqual(h.cards(), ["first"]);
		} finally {
			load.resolve(readyLoad([memo("first")]));
			await pending;
			h.close();
		}
	}
});

test("移动首查构建中的空结果和已知子集都不能提前确认完成，完成后提交内容", async () => {
	for (const items of [[], [memo("known-subset")]]) {
		const h = await createLoadingHarness(true);
		try {
			h.view.loadCatalogMemos = async () => buildingLoad(items);
			await h.loadInitial();
			h.view.handleLocalDateChange();
			assert.equal(h.title(), t("empty.loadingAllMemos"));
			assert.equal(h.view.hasCommittedCatalogDesktopQuery, false);
			assert.deepEqual(h.cards(), []);
			h.view.loadCatalogMemos = async () => readyLoad([memo("complete")]);
			await h.loadInitial();
			assert.equal(h.view.hasCommittedCatalogDesktopQuery, true);
			assert.deepEqual(h.cards(), ["complete"]);
		} finally { h.close(); }
	}
});

test("两端真实空库在首次结果确认后显示空态，不停留在加载占位", async () => {
	for (const mobile of [false, true]) {
		const h = await createLoadingHarness(mobile);
		try {
			h.view.loadCatalogMemos = async () => readyLoad([]);
			await h.loadInitial();
			assert.equal(h.view.hasCommittedCatalogDesktopQuery, true);
			assert.equal(h.title(), t("empty.generic"));
			h.view.handleLocalDateChange();
			assert.equal(h.title(), t("empty.generic"));
		} finally { h.close(); }
	}
});

test("两端首次读取失败显示错误，重绘不遮盖错误，重试成功后显示内容", async () => {
	for (const mobile of [false, true]) {
		const h = await createLoadingHarness(mobile);
		try {
			h.view.loadCatalogMemos = async () => { throw new Error("Vault read failed"); };
			await h.loadInitial();
			assert.equal(h.title(), t("empty.cardFlowFailed"));
			assert.equal(h.root.querySelector(".knomo-empty-description")?.textContent, "Vault read failed");
			h.view.handleLocalDateChange();
			assert.equal(h.title(), t("empty.cardFlowFailed"));
			h.view.loadCatalogMemos = async () => readyLoad([memo("retry")]);
			await h.loadInitial();
			assert.deepEqual(h.cards(), ["retry"]);
		} finally { h.close(); }
	}
});

test("已提交卡片在刷新等待、焦点重绘和刷新失败期间保留", async () => {
	for (const mobile of [false, true]) {
		const h = await createLoadingHarness(mobile);
		const load = deferred<MemoLoad>();
		try {
			h.view.loadCatalogMemos = async () => readyLoad([memo("existing")]);
			await h.loadInitial();
			const card = h.root.querySelector(".knomo-card");
			h.view.loadCatalogMemos = () => load.promise;
			const pending = h.view.reloadMemos(true);
			assert.equal(h.root.querySelector(".knomo-card"), card);
			h.view.handleLocalDateChange();
			assert.equal(h.title(), null);
			assert.deepEqual(h.cards(), ["existing"]);
			load.reject(new Error("Refresh failed"));
			assert.equal(await pending, false);
			assert.equal(h.root.querySelector(".knomo-card"), card);
		} finally { h.close(); }
	}
});

test("首次加载规则保留随机、漫游、回收站状态和独立页面入口", async () => {
	const h = await createLoadingHarness(false);
	try {
		for (const [nav, title] of [["random", "empty.randomLoading"], ["shuffleDay", "shuffleDay.loadingTitle"], ["trash", "empty.trashEmptyTitle"]] as const) {
			h.view.activeNav = nav;
			h.view.renderCardFlow();
			assert.equal(h.title(), t(title));
		}
		for (const nav of ["time-buoy", "record-stats"] as const) {
			let rendered = false;
			h.view.activeNav = nav;
			h.view[nav === "time-buoy" ? "renderTimeBuoyPage" : "renderRecordStatsPage"] = () => { rendered = true; };
			h.view.renderCardFlow();
			assert.equal(rendered, true);
		}
	} finally { h.close(); }
});

test("移动首查不完整但存在故障时保留诊断操作，不被加载占位遮盖", async () => {
	const h = await createLoadingHarness(true);
	try {
		h.view.loadCatalogMemos = async () => ({ ...buildingLoad([]), status: { content: "scanning", catalog: "partial", projection: "ready", settings: "unavailable" } });
		await h.loadInitial();
		h.view.handleLocalDateChange();
		assert.notEqual(h.root.querySelector("[data-action='open-catalog-settings']"), null);
		assert.equal(h.title(), null);
	} finally { h.close(); }
});

test("日记关闭时首查等待中的重绘保留启用指引", async () => {
	const h = await createLoadingHarness(true);
	try {
		h.view.getDailyNotesStatus = () => ({ enabled: false });
		h.view.handleLocalDateChange();
		assert.equal(h.title(), t("service.dailyNotesDisabled"));
	} finally { h.close(); }
});

// 仅隔离宿主、存储和正文卡片绘制；查询提交、状态判定与空态 DOM 使用实际实现。
async function createLoadingHarness(mobile: boolean) {
	await ensureObsidianStub();
	const { KnomoView } = await import("../src/ui/KnomoView");
	const { Platform } = await import("obsidian");
	const previousMobile = Platform.isMobile;
	Platform.isMobile = mobile;
	const dom = new JSDOM("<!doctype html><body></body>", { pretendToBeVisual: true });
	Object.assign(dom.window.HTMLElement.prototype, {
		createEl(this: HTMLElement, tag: string, options: { cls?: string; text?: string; attr?: Record<string, string> } = {}) {
			const element = this.ownerDocument.createElement(tag);
			if (options.cls) element.className = options.cls;
			if (options.text) element.textContent = options.text;
			for (const [key, value] of Object.entries(options.attr ?? {})) element.setAttribute(key, value);
			return this.appendChild(element);
		},
		createDiv(this: HTMLElement, options?: { cls?: string; text?: string }) { return this.createEl("div", options); },
		createSpan(this: HTMLElement, options?: { text?: string }) { return this.createEl("span", options); },
		empty(this: HTMLElement) { this.replaceChildren(); },
		setAttrs(this: HTMLElement, attrs: Record<string, string>) { for (const [key, value] of Object.entries(attrs)) this.setAttribute(key, value); },
	});
	const root = dom.window.document.body.createDiv({ cls: "knomo-card-flow" });
	const view = Object.assign(Object.create(KnomoView.prototype), {
		containerEl: { win: dom.window }, cardFlowEl: root, trashViewClosed: false,
		viewStateController: new KnomoViewStateController(), currentLayout: mobile ? "mobile" : "desktop-wide",
		settingsService: { getSettings: () => ({ recentTimeFlowEnabled: false, timeBuoyEnabled: true }) },
		lastKnownLocalDate: formatTimeBuoyDate(new Date()), recentLifecycleKey: "", composerOpen: false,
		cardFlowCoordinator: new KnomoCardFlowCoordinator(), renderedCardMemos: new Map(),
		cardImageCache: { capture: () => {} }, cardImageLoadQueue: { clear: () => {} }, memoMarkdownRenderer: { clear: () => {} },
		recordStatsService: new RecordStatsService(), recordStatsViewStateController: new RecordStatsViewStateController(),
		memos: [], catalogTodayTimeBuoys: null, catalogCoverage: null, catalogReadState: "ready", catalogRevision: 0,
		catalogStatus: { content: "ready", catalog: "complete", projection: "ready" }, cardFlowError: null,
		hasCommittedCatalogDesktopQuery: false, catalogDesktopQueryFingerprint: null, catalogDesktopQueryRun: 0,
		catalogCursor: null, catalogHistoryExpansionPending: false, catalogDesktopTotalCount: null,
		catalogDesktopCountRun: 0, catalogDesktopCountController: null, catalogMobileCountController: null,
		memoSourceGeneration: 0, memoLoadingPromise: null, memoLoadingFingerprint: null, filteredMemosCache: null,
		librarySummary: null, mobileSearchController: { isOpen: false },
		randomReunionController: { getSnapshot: () => ({ status: "idle", error: null, memos: null }), cancelPending: () => {} },
		shuffleDayController: { getSnapshot: () => ({ status: "idle", selectedDate: null, memos: [], stats: null, error: null }), cancelPending: () => {} },
		trashMemoController: { getSnapshot: () => ({ trashLoading: false, trashError: null, trashMemos: [] }) },
		getDailyNotesStatus: () => ({ enabled: true }), getFilteredMemos: () => view.memos, getTodayTimeBuoyItems: () => [],
		getDirectCardElements: () => [], resetTimeBuoyCardFlow: () => {}, syncRecordStatsSource: () => {},
		refreshCatalogLibraryIndexes: async () => {}, retainMemoCardPreviews: () => {}, syncSearchControls: () => {},
		getMobileSearchStateKey: () => "", renderMobileSearchResults: () => {}, renderMobileSearchResultsIfChanged: () => {},
		syncUiChrome: () => {}, renderStats: () => {}, renderTags: () => {}, renderTrashCount: () => {}, updateStatus: () => {},
		renderHistoryLoadMore: () => {}, restorePendingCardFlowScrollTop: () => {}, stopDateChangeWatcher: () => {}, startDateChangeWatcher: () => {},
	});
	const renderItems = (presentation: Extract<CardFlowPresentation, { type: "items" }>) => {
		if (root.querySelector(".knomo-empty-state") === null && presentation.headers.length === 0
			&& JSON.stringify(Array.from(root.querySelectorAll(".knomo-card"), card => card.getAttribute("data-memo-id"))) === JSON.stringify(presentation.memos.map(item => item.id))
			&& root.childElementCount > 0) return;
		root.replaceChildren();
		renderKnomoCardFlowHeaders(root, presentation.headers);
		for (const item of presentation.memos) root.createEl("article", { cls: "knomo-card", text: item.contentSnapshot, attr: { "data-memo-id": item.id } });
	};
	view.syncCardFlowPresentation = renderItems;
	return {
		view, root,
		loadInitial: (): Promise<unknown> => mobile ? view.loadInitialMobileMemos() : view.reloadCurrentCatalogQuery(true),
		title: () => root.querySelector(".knomo-empty-title")?.textContent ?? null,
		cards: () => Array.from(root.querySelectorAll(".knomo-card"), card => card.getAttribute("data-memo-id")),
		close: () => { Platform.isMobile = previousMobile; dom.window.close(); },
	};
}

function memo(id: string): MemoViewItem {
	return { id, createdAt: `${formatTimeBuoyDate(new Date())}T10:00`, updatedAt: "", contentHash: id, contentSnapshot: id, status: "active", dailyRef: { path: "Daily.md" } } as MemoViewItem;
}

function readyLoad(memos: MemoViewItem[]): MemoLoad {
	return {
		memos, fullHistoryLoaded: true, nextCursor: null, catalogRevision: 1,
		coverage: { kind: "complete", coveredFromDate: null, pendingFileCount: 0, coveredFileCount: 1, totalFileCount: 1 },
		readState: "ready", status: { content: "ready", catalog: "complete", projection: "ready" },
	};
}

function buildingLoad(memos: MemoViewItem[]): MemoLoad {
	const load = readyLoad(memos);
	return { ...load, coverage: { ...load.coverage, kind: "partial", pendingFileCount: 2, totalFileCount: 3 }, readState: "history_building", status: { content: "scanning", catalog: "partial", projection: "ready" } };
}

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (reason: Error) => void;
	const promise = new Promise<T>((accept, fail) => { resolve = accept; reject = fail; });
	return { promise, resolve, reject };
}
