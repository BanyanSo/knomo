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
import { DelayedLoadingIndicator } from "../src/ui/DelayedLoadingIndicator";
import { formatTimeBuoyDate } from "../src/utils/timeBuoyDate";
import { ensureObsidianStub } from "./helpers/obsidianStub";
import { createReferenceMemo } from "./helpers/referenceMemo";

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
			assert.equal(h.title(), null, "快速首查不能先闪现加载文字");
			h.view.handleLocalDateChange();
			assert.equal(h.title(), null);
			h.view.forceRebuildCardFlow();
			assert.equal(h.title(), null);
			h.revealLoading();
			assert.ok(h.root.querySelector(".knomo-loading-skeleton"));
			assert.equal(h.root.querySelector(".knomo-loading-placeholder")?.textContent, "", "等待骨架不显示系统阶段文案");
			assert.equal(h.root.querySelector("[role='status']")?.getAttribute("aria-live"), "polite");
			const status = h.root.querySelector("[role='status']");
			h.view.forceRebuildCardFlow();
			assert.equal(h.root.querySelector("[role='status']"), status, "重复重绘不重复创建朗读区域");
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
			assert.equal(h.title(), null);
			h.revealLoading();
			assert.ok(h.root.querySelector(".knomo-loading-placeholder"));
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
		assert.equal(h.view.hasCommittedCatalogDesktopQuery, false);
	} finally { h.close(); }
});

test("快速首查完成后旧计时器不能再覆盖卡片，切换独立页面会取消提示", async () => {
	for (const mobile of [false, true]) {
		const h = await createLoadingHarness(mobile);
		try {
			h.view.loadCatalogMemos = async () => readyLoad([memo("fast")]);
			await h.loadInitial();
			h.revealLoading();
			assert.deepEqual(h.cards(), ["fast"]);
			assert.equal(h.root.querySelector(".knomo-loading-placeholder"), null);
			h.view.hasCommittedCatalogDesktopQuery = false;
			h.view.initialCatalogQueryPending = true;
			h.view.memos = [];
			h.view.renderCardFlow();
			h.view.activeNav = "random";
			h.view.forceRebuildCardFlow();
			h.revealLoading();
			assert.equal(h.title(), t("empty.randomLoading"));
		} finally { h.close(); }
	}
});

test("Monthly 故障可见，但不能把构建中的子集提交为首批完整结果", async () => {
	for (const mobile of [false, true]) {
		const h = await createLoadingHarness(mobile);
		try {
			h.view.loadCatalogMemos = async () => ({ ...buildingLoad([memo("subset")]), status: { content: "scanning", catalog: "partial", projection: "failed" } });
			await h.loadInitial();
			assert.equal(h.view.hasCommittedCatalogDesktopQuery, false);
			assert.deepEqual(h.cards(), []);
			assert.ok(h.root.querySelector("[data-action='open-catalog-settings']"));
			h.revealLoading();
			assert.ok(h.root.querySelector(".knomo-loading-placeholder"));
		} finally { h.close(); }
	}
});

test("部分文件失败等待重试时退出忙碌占位并保留重试入口", async () => {
	const h = await createLoadingHarness(true);
	try {
		h.view.loadCatalogMemos = async () => ({ ...buildingLoad([]), status: { content: "scanning", catalog: "partial", projection: "ready", scan: { state: "waiting-retry", failedFileCount: 1 } } });
		await h.loadInitial();
		h.revealLoading();
		assert.equal(h.root.querySelector(".knomo-loading-placeholder"), null);
		assert.ok(h.root.querySelector("[data-action='refresh-catalog-sync-state']"));
		assert.equal(h.view.hasCommittedCatalogDesktopQuery, false);
	} finally { h.close(); }
});

test("首查被取消且没有扫描在运行时不留下正在加载或真实空库", async () => {
	const { CatalogQueryCancelledError } = await import("../src/services/MemoCatalogStore");
	for (const mobile of [false, true]) {
		const h = await createLoadingHarness(mobile);
		try {
			h.view.loadCatalogMemos = async () => { throw new CatalogQueryCancelledError(); };
			await h.loadInitial();
			h.revealLoading();
			assert.equal(h.root.querySelector(".knomo-loading-placeholder"), null);
			assert.equal(h.title(), null);
		} finally { h.close(); }
	}
});

test("尚未提交 Catalog 首查时重新查询不能撤下已确认保存的卡片", async () => {
	const h = await createLoadingHarness(false);
	const load = deferred<MemoLoad>();
	try {
		h.view.hasConfirmedMemoPresentation = true;
		h.view.memos = [memo("saved")];
		h.view.renderCardFlow();
		const card = h.root.querySelector(".knomo-card");
		h.view.loadCatalogMemos = () => load.promise;
		const pending = h.loadInitial();
		assert.equal(h.root.querySelector(".knomo-card"), card);
		assert.equal(h.root.querySelector(".knomo-loading-placeholder"), null);
		load.resolve(readyLoad([memo("saved")]));
		await pending;
	} finally { load.resolve(readyLoad([])); h.close(); }
});

test("统计首次等待遇到设置故障或日记关闭，直接显示指引而不是无限加载", async () => {
	const h = await createLoadingHarness(false);
	try {
		h.view.activeNav = "record-stats";
		h.view.catalogStatus = { content: "scanning", catalog: "partial", projection: "ready", settings: "unavailable" };
		h.view.renderCardFlow();
		assert.ok(h.root.querySelector("[data-action='open-catalog-settings']"));
		assert.equal(h.root.querySelector("[aria-busy='true']"), null);
		h.view.getDailyNotesStatus = () => ({ enabled: false });
		h.view.renderCardFlow();
		assert.ok(h.root.textContent?.includes(t("service.dailyNotesDisabled")));
		assert.equal(h.root.querySelector(".knomo-record-stats-loading"), null);
	} finally { h.close(); }
});

test("历史未完整时保存过其他范围的卡片，不得把不匹配筛选当成真实空库", async () => {
	const h = await createLoadingHarness(false);
	try {
		h.view.hasConfirmedMemoPresentation = true;
		h.view.memos = [memo("saved-elsewhere")];
		h.view.getFilteredMemos = () => [];
		h.view.loadCatalogMemos = async () => buildingLoad([]);
		await h.loadInitial();
		assert.equal(h.view.hasCommittedCatalogDesktopQuery, false);
		assert.equal(h.title(), null);
		assert.ok(h.root.querySelector(".knomo-loading-placeholder"));
		h.view.hasCommittedCatalogDesktopQuery = true;
		h.view.renderCardFlow();
		assert.equal(h.title(), null);
		assert.ok(h.root.textContent?.includes(t("catalog.incompleteResults")));
	} finally { h.close(); }
});

test("隐藏视图时延迟回调不能绘制骨架，重新显示后从安静等待恢复", async () => {
	const h = await createLoadingHarness(false);
	try {
		h.view.initialCatalogQueryPending = true;
		h.view.renderCardFlow();
		h.setShown(false);
		h.revealLoading();
		assert.equal(h.root.querySelector(".knomo-loading-skeleton"), null);
		h.setShown(true);
		h.view.handleLocalDateChange();
		assert.equal(h.root.querySelector(".knomo-loading-skeleton"), null);
		h.revealLoading();
		assert.ok(h.root.querySelector(".knomo-loading-skeleton"));
	} finally { h.close(); }
});

test("全部笔记首屏已有卡片后，后台快照前进或今日索引待就绪不短暂显示失败，真实读取失败仍提示", async context => {
	await ensureObsidianStub();
	const { InMemoryMemoCatalogStore } = await import("../src/services/MemoCatalogStore");
	const { MemoCatalogService } = await import("../src/services/MemoCatalogService");
	const { CatalogReadService } = await import("../src/services/CatalogReadService");
	const { TimeBuoyViewController } = await import("../src/ui/TimeBuoyViewController");
	for (const mobile of [false, true]) {
		for (const stage of ["list-invalidated", "list-busy", "today-invalidated", "today-revision", "today-pending", "today-incomplete", "today-io"] as const) {
			await context.test(`${stage}, mobile=${mobile}`, async () => {
				const h = await createLoadingHarness(mobile);
				const store = new InMemoryMemoCatalogStore(), catalog = new MemoCatalogService(store);
				try {
					const today = formatTimeBuoyDate(new Date());
					const observation = { ...createReferenceMemo().catalog!.observation, sourcePath: `Daily/${today}.md`,
						logicalDate: today, createdAtKey: `${today}T09:00:00` };
					await catalog.open();
					await catalog.replaceFile({ inventory: { sourcePath: observation.sourcePath, logicalDate: today, mtime: 1, size: 1 },
						sourceRevision: observation.sourceRevision, observations: [observation], parserVersion: 1, settingsFingerprint: "settings", auditedAt: 1 });
					const coverage: CatalogCoverage = { kind: "complete", configurationComplete: true, coveredFromDate: today,
						pendingFileCount: 0, coveredFileCount: 1, totalFileCount: 1 };
					await store.setCoverage(coverage);
					const read = new CatalogReadService({ catalog });
					let changed = false;
					const query = read.query.bind(read);
					read.query = async (...args: Parameters<typeof query>) => {
						const page = await query(...args);
						if (stage === "list-invalidated" && changed) { changed = false; return { ...page, invalidated: true }; }
						if (stage === "list-busy" && changed) return { ...page, invalidated: true };
						return page;
					};
					const queryToday = read.queryTimeBuoysForDate.bind(read);
					read.queryTimeBuoysForDate = async (...args: Parameters<typeof queryToday>) => {
						if (stage === "today-io" && changed) throw new Error("today index I/O failed");
						const result = await queryToday(...args);
						if (stage === "today-invalidated" && changed) { changed = false; return { ...result, invalidated: true }; }
						if (stage === "today-revision" && changed) { changed = false; return { ...result, catalogRevision: (result.catalogRevision ?? 0) + 1 }; }
						if (stage === "today-incomplete" && changed) return { ...result, missingPeriods: [today.slice(0, 7)] };
						return result;
					};
					const feedback = h.root.ownerDocument.body.createDiv(); feedback.hidden = true; feedback.createSpan();
					const shown: boolean[] = [];
					Object.defineProperty(feedback, "hidden", { get: () => feedback.hasAttribute("hidden"),
						set: (value: boolean) => { shown.push(!value); feedback.toggleAttribute("hidden", value); } });
					Object.assign(h.view, { getCatalogReadService: () => read, pageFeedbackEl: feedback, pageRefreshError: null,
						timeBuoyViewController: new TimeBuoyViewController({ getNow: () => new Date(),
							isTodayIndexReady: date => read.getCoverageForRange(date, date), queryDate: (date, cursor, signal) => read.queryTimeBuoysForDate(date, cursor, signal),
							queryPage: (request, signal) => read.queryTimeBuoyPage(request, signal), requestRender: () => {} }) });
					await h.loadInitial();
					const card = h.root.querySelector(".knomo-card"); assert.ok(card);
					shown.length = 0; changed = true;
					if (stage === "today-pending") await store.setCoverage({ ...coverage, kind: "partial", pendingFileCount: 1 });
					await h.view.reloadMemos(false);
					assert.equal(h.root.querySelector(".knomo-card"), card, stage);
					assert.equal(shown.includes(true), stage === "today-io", `${stage}, mobile=${mobile}`);
					if (stage === "today-pending" || stage === "today-incomplete" || stage === "list-busy") {
						assert.equal(h.view.viewStateController.search.requestStatus, "ready");
						changed = false;
						await store.setCoverage(coverage);
						await h.view.reloadMemos(false);
						assert.equal(shown.includes(true), false);
					}
				} finally { store.close(); h.close(); }
			});
		}
	}
});

test("日记关闭时首查等待中的重绘保留启用指引", async () => {
	const h = await createLoadingHarness(true);
	try {
		h.view.getDailyNotesStatus = () => ({ enabled: false });
		h.view.handleLocalDateChange();
		assert.equal(h.title(), t("service.dailyNotesDisabled"));
	} finally { h.close(); }
});

test("两端旧请求成功或失败的收尾不清除新请求，也不覆盖新卡片", async t => {
	for (const mobile of [false, true]) for (const failure of [false, true]) for (const oldFinishesFirst of [false, true]) {
		await t.test(`${mobile ? "mobile" : "desktop"}/${failure ? "failure" : "success"}/${oldFinishesFirst ? "A-B" : "B-A"}`, async () => {
			const h = await createLoadingHarness(mobile);
			const first = deferred<MemoLoad>(), second = deferred<MemoLoad>();
			let loads = 0;
			const load = () => mobile ? h.view.loadInitialMobileMemos() : h.view.reloadMemos(false);
			try {
				h.view.loadCatalogMemos = () => ++loads === 1 ? first.promise : second.promise;
				const old = load(), firstController = h.view.catalogDesktopQueryController;
				const current = load(), currentController = h.view.catalogDesktopQueryController;
				assert.equal(firstController.signal.aborted, true);
				const finishOld = async () => {
					if (failure) first.reject(new Error("late old I/O failure"));
					else first.resolve(readyLoad([memo("old")]));
					assert.equal(await old, mobile ? undefined : false);
				};
				if (oldFinishesFirst) {
					await finishOld();
					assert.strictEqual(h.view.catalogDesktopQueryController, currentController);
					assert.equal(h.view.initialCatalogQueryPending, true);
				}
				second.resolve(readyLoad([memo("current")]));
				assert.equal(await current, mobile ? undefined : true);
				const card = h.root.querySelector(".knomo-card");
				if (!oldFinishesFirst) await finishOld();
				assert.deepEqual(h.view.memos.map((item: MemoViewItem) => item.id), ["current"]);
				assert.deepEqual(h.cards(), ["current"]);
				assert.strictEqual(h.root.querySelector(".knomo-card"), card);
				assert.equal(h.view.cardFlowError, null);
				assert.equal(h.view.viewStateController.search.requestStatus, "ready");
				assert.equal(h.view.catalogDesktopQueryController, null);
				assert.equal(h.view.initialCatalogQueryPending, false);
			} finally { first.resolve(readyLoad([])); second.resolve(readyLoad([])); h.close(); }
		});
	}
});

test("两端 generation、搜索、fingerprint 和 coverage 中途变化拒绝旧结果，移动 DOM 脱离也不提交", async t => {
	for (const mobile of [false, true]) for (const change of ["source", "search", "fingerprint", "coverage", ...(mobile ? ["detach"] : [])]) {
		await t.test(`${mobile ? "mobile" : "desktop"}/${change}`, async () => {
			const h = await createLoadingHarness(mobile), pending = deferred<MemoLoad>();
			try {
				h.view.hasCommittedCatalogDesktopQuery = true;
				h.view.memos = [memo("committed")];
				h.view.renderCardFlow();
				const card = h.root.querySelector(".knomo-card");
				h.view.loadCatalogMemos = () => pending.promise;
				const loading = mobile ? h.view.loadInitialMobileMemos() : h.view.reloadMemos(false);
				if (change === "source") h.view.memoSourceGeneration++;
				if (change === "search") h.view.viewStateController.search.updateDraft("changed");
				if (change === "fingerprint") h.view.viewStateController.activeTagKey = "changed";
				if (change === "coverage") h.view.catalogCoverage = buildingLoad([]).coverage;
				if (change === "detach") h.root.remove();
				const coverage = h.view.catalogCoverage;
				pending.resolve(readyLoad([memo("stale")]));
				assert.equal(await loading, mobile ? undefined : false);
				assert.deepEqual(h.view.memos.map((item: MemoViewItem) => item.id), ["committed"]);
				assert.strictEqual(h.root.querySelector(".knomo-card"), card);
				assert.strictEqual(h.view.catalogCoverage, coverage);
				assert.equal(h.view.cardFlowError, null);
				assert.equal(h.view.catalogDesktopQueryController, null);
				assert.equal(h.view.initialCatalogQueryPending, false);
			} finally { pending.resolve(readyLoad([])); h.close(); }
		});
	}
});

test("关闭查询代次后重新加载，两端迟到结果不能覆盖重新打开的内容", async () => {
	for (const mobile of [false, true]) {
		const h = await createLoadingHarness(mobile), beforeClose = deferred<MemoLoad>();
		const load = () => mobile ? h.view.loadInitialMobileMemos() : h.view.reloadMemos(false);
		try {
			h.view.loadCatalogMemos = () => beforeClose.promise;
			const old = load(), controller = h.view.catalogDesktopQueryController;
			h.view.trashViewClosed = true;
			h.view.cancelCatalogDesktopQuery();
			assert.equal(controller.signal.aborted, true);
			h.view.trashViewClosed = false;
			h.view.loadCatalogMemos = async () => readyLoad([memo("reopened")]);
			await load();
			beforeClose.resolve(readyLoad([memo("before-close")]));
			await old;
			assert.deepEqual(h.cards(), ["reopened"]);
			assert.equal(h.view.initialCatalogQueryPending, false);
		} finally { beforeClose.resolve(readyLoad([])); h.close(); }
	}
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
	let shown = true;
	let reveal: (() => void) | null = null;
	const loading = new DelayedLoadingIndicator({
		scheduleTask: callback => { reveal = callback; return 1; },
		cancelTask: () => { reveal = null; },
	});
	const view = Object.assign(Object.create(KnomoView.prototype), {
		loadingIndicators: new Map([["cards", loading]]),
		containerEl: { win: dom.window, isShown: () => shown }, cardFlowEl: root, trashViewClosed: false,
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
		if (root.querySelector(".knomo-empty-state, .knomo-loading-placeholder") === null && presentation.headers.length === 0
			&& JSON.stringify(Array.from(root.querySelectorAll(".knomo-card"), card => card.getAttribute("data-memo-id"))) === JSON.stringify(presentation.memos.map(item => item.id))
			&& root.childElementCount > 0) return;
		root.replaceChildren();
		renderKnomoCardFlowHeaders(root, presentation.headers);
		for (const item of presentation.memos) root.createEl("article", { cls: "knomo-card", text: item.contentSnapshot, attr: { "data-memo-id": item.id } });
	};
	view.syncCardFlowPresentation = renderItems;
	return {
		view, root, revealLoading: () => { reveal?.(); }, setShown: (value: boolean) => { shown = value; },
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
