import { Platform } from "obsidian";
import { KnomoView } from "../../src/ui/KnomoView";
import { MemoCardImageCache } from "../../src/ui/KnomoCardImages";
import { RecentTimeFlowDecorations } from "../../src/ui/RecentTimeFlowPresentation";
import { BeyondTodayDecorations, createBeyondTodayContext } from "../../src/ui/BeyondTodayPresentation";
import { MemoRelationsPage } from "../../src/ui/MemoRelationsPage";
import { MemoRelationWindow } from "../../src/ui/MemoRelationWindow";
import type { MemoRelationNode } from "../../src/types/memoRelations";
import type { MemoViewItem } from "../../src/types/memoView";
import type { CardImageLoadRequest } from "../../src/ui/CardImageLoadQueue";
import { syncKnomoCardFlowHeaders } from "../../src/ui/KnomoFeed";
import { syncResultCountSummary } from "../../src/ui/ResultCountSummary";
import { getRegularFilterCopy } from "../../src/ui/viewFilters";
import { MobileSearchController, type MobileSearchPage } from "../../src/ui/MobileSearchController";
import { createCatalogCapabilities } from "../../src/services/MemoCapabilityModel";
import { TimeBuoyViewController } from "../../src/ui/TimeBuoyViewController";
import { getKnomoLocale, t } from "../../src/i18n";

export function installDomHelpers(): void {
	Object.assign(HTMLElement.prototype, {
		setAttr(this: HTMLElement, name: string, value: string) { this.setAttribute(name, value); },
		setText(this: HTMLElement, text: string) { this.textContent = text; },
		getAttr(this: HTMLElement, name: string) { return this.getAttribute(name); },
		addClass(this: HTMLElement, ...names: string[]) { this.classList.add(...names); },
		removeClass(this: HTMLElement, ...names: string[]) { this.classList.remove(...names); },
		hasClass(this: HTMLElement, name: string) { return this.classList.contains(name); },
		toggleClass(this: HTMLElement, name: string, on: boolean) { this.classList.toggle(name, on); },
		instanceOf(this: HTMLElement, type: typeof HTMLElement) { return this instanceof type; },
		empty(this: HTMLElement) { this.replaceChildren(); },
		find(this: HTMLElement, selector: string) { return this.querySelector(selector); },
		findAll(this: HTMLElement, selector: string) { return [...this.querySelectorAll(selector)]; },
		setCssProps(this: HTMLElement, props: Record<string, string>) {
			for (const [name, value] of Object.entries(props)) this.style.setProperty(name, value);
		},
		createEl(this: HTMLElement, tag: string, options: { cls?: string; text?: string; attr?: Record<string, string> } = {}) {
			const el = document.createElement(tag);
			el.className = options.cls ?? ""; el.textContent = options.text ?? "";
			for (const [name, value] of Object.entries(options.attr ?? {})) el.setAttribute(name, value);
			this.appendChild(el); return el;
		},
		createDiv(this: HTMLElement, options: object) { return this.createEl("div", options); },
		createSpan(this: HTMLElement, options: object) { return this.createEl("span", options); },
	});
	Object.defineProperties(HTMLElement.prototype, {
		doc: { configurable: true, get(this: HTMLElement) { return this.ownerDocument; } },
		win: { configurable: true, get(this: HTMLElement) { return this.ownerDocument.defaultView; } },
	});
}

const frames = () => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));

function fixture(mobile = false, richMarkdown = false) {
	Object.assign(Platform, { isMobile: mobile });
	const flow = document.getElementById("flow")!;
	flow.replaceChildren(); flow.scrollTop = 0;
	const view = Object.create(KnomoView.prototype);
	const context = { enabled: true, dates: ["2026-11-08", "2026-11-07", "2026-11-06"], pinnedKeys: new Set<string>() };
	let loads = 0, holdImages = false, holdMarkdown = false, resourceVersion = 1;
	let pending: Promise<void>[] = [], starts: Array<() => void> = [];
	const markdown: Array<() => void> = [];
	const renderMarkdown = (content: HTMLElement, source = false) => {
		if (!richMarkdown) return;
		const render = () => {
			content.replaceChildren();
			for (const text of source ? ["Source reference"] : ["First paragraph", "Second paragraph"]) content.createEl("p", { text });
		};
		if (holdMarkdown) markdown.push(render); else render();
	};
	const imageUrl = "data:image/svg+xml," + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="600" height="480"><rect width="600" height="480" fill="steelblue"/></svg>');
	Object.assign(view, {
		cardFlowEl: flow, viewStateController: { activeNav: "all" }, currentLayout: mobile ? "mobile" : "desktop-wide", trashViewClosed: false,
		renderedCardMemos: new Map(), popupState: { activeMenuMemoId: null },
		containerEl: { win: window }, getInitialCardBatchSize: () => 120,
		cardFlowCoordinator: { generation: 1, clearMobileBatchContinuation() {}, removeSentinel() {}, getPendingVisibleCount: () => null, syncBatch() {} },
		cardImageCache: new MemoCardImageCache(), renderedPreviewImages: new WeakMap(),
		memoMarkdownRenderer: {
			queueMemoMarkdown(_memo: MemoViewItem, content: HTMLElement) { renderMarkdown(content); },
			queueSourceReferenceMarkdown(content: HTMLElement) { renderMarkdown(content, true); },
			refreshSearchHits() {}, releaseCard() {},
		},
		cardImageLoadQueue: { forget() {}, update({ images }: CardImageLoadRequest) {
			for (const item of images) {
				loads++;
				const start = () => {
					item.imageEl.src = item.src;
					pending.push(item.imageEl.decode().then(() => { item.onLoad?.(); }));
				};
				if (holdImages) starts.push(start); else start();
			}
		} },
		getVisibleMemoTimeBuoy: () => undefined, isDefaultListState: () => context.enabled,
		prepareRecentTimeFlow() {
			view.recentTimeFlowContext = context; view.recentDecorations = new RecentTimeFlowDecorations(context);
			view.beyondTodayDecorations = new BeyondTodayDecorations(view.activeNav === "review" ? createBeyondTodayContext(new Date(2026, 10, 8)) : null);
		},
		getMemoCardPreview(memo: MemoViewItem) { return { text: memo.contentSnapshot,
			images: memo.images.length ? [{ raw: "![[image.png]]", path: "image.png", resourcePath: "image.png", url: imageUrl, isRemote: false, mtime: resourceVersion }] : [] }; },
		renderCardFlowHeaders: () => [], renderTimeBuoyIntro: () => null, renderCardFlowSentinelIfNeeded() {},
		renderHistoryLoadMore() {}, syncCardMenuState() {}, restorePendingCardFlowScrollTop() {},
	});
	const makeMemo = (index: number, revision: number, image: boolean, date = "2026-11-08"): MemoViewItem => {
		const sourcePath = `Daily/${date}.md`, sourceRevision = `revision-${revision}`;
		const id = `${sourcePath}\0${index}\0${sourceRevision}`;
		return { id, createdAt: date + "T09:00", updatedAt: "", contentSnapshot: `Memo ${index} unchanged text`, contentHash: `content-${index}`,
			status: "active", tags: [], links: [], images: image ? [{ path: "image.png", altText: "", syntax: "obsidian_embed" }] : [],
			dailyRef: { path: sourcePath, heading: "Memos", lineNumberHint: index + 1 },
			catalog: { key: id, renderKey: id,
				capabilities: { markdown: { view: true, copy: true, openDaily: true, edit: true, remove: true, explicitBlockReference: false } },
				observationHandle: { sourcePath, sourceRevision, startLine: index, endLine: index + 1, rawBlockHash: `raw-${index}` },
				observation: { sourcePath, sourceRevision, logicalDate: date, time: "09:00", timePrecision: "minute", rawBlockHash: `raw-${index}` },
				resolved: { capabilities: {} },
			} as unknown as MemoViewItem["catalog"],
		};
	};
	return { view, flow, context, makeMemo, loads: () => loads, hold: () => { holdImages = true; holdMarkdown = true; },
		changeResource: () => { resourceVersion++; },
		settle: async () => { await Promise.all(pending); pending = []; await frames(); },
		release: async () => {
			holdImages = false; holdMarkdown = false;
			for (const start of starts) start(); starts = [];
			for (const render of markdown) render(); markdown.length = 0;
			await Promise.all(pending); await frames();
		},
	};
}

export async function geometry(options: { review: boolean; recent: boolean; image: boolean; position: number; mobile: boolean }) {
	const h = fixture(options.mobile), { view, flow, context } = h;
	context.enabled = options.recent;
	view.viewStateController.activeNav = options.review ? "review" : "all";
	const date = options.review ? "2026-08-08" : "2026-11-08";
	let memos = Array.from({ length: 35 }, (_, i) => h.makeMemo(i, 0, options.image && i === 8, date));
	const render = () => view.syncCardFlowPresentation({ type: "items", mode: "memo", headers: [], memos }, null);
	const sample = () => {
		const rect = flow.getBoundingClientRect();
		const anchor = [...flow.querySelectorAll<HTMLElement>(".knomo-card")].find(card => card.getBoundingClientRect().bottom > rect.top)!;
		return { scroll: flow.scrollTop, height: flow.scrollHeight, anchor: anchor.querySelector(".knomo-card-content")!.textContent,
			offset: anchor.getBoundingClientRect().top - rect.top };
	};
	render(); await h.settle();
	flow.scrollTop = options.position < 0 ? flow.scrollHeight - flow.clientHeight - 40 : options.position;
	await frames();
	const before = sample(), samples = [before], image = flow.querySelector("img");
	for (let revision = 1; revision <= 6; revision++) {
		memos = memos.map((_, i) => h.makeMemo(i, revision, options.image && i === 8, date));
		render(); samples.push(sample()); await h.settle(); samples.push(sample());
	}
	return { samples, sameImage: image === flow.querySelector("img"), loads: h.loads() };
}

export async function pagedEditGeometry(options: { surface: "feed" | "buoy"; mobile: boolean; editAbove: boolean }) {
	const h = fixture(options.mobile), { view, flow } = h;
	h.context.enabled = false;
	const today = "2026-11-08", count = options.surface === "feed" ? 150 : 90;
	let memos = Array.from({ length: 150 }, (_, index) => {
		const memo = h.makeMemo(index, 0, index === 95, "2026-08-08");
		memo.catalog!.timeBuoyDates = [today];
		return memo;
	});
	let rendering = false;
	const buoy = new TimeBuoyViewController({ getNow: () => new Date(2026, 10, 8), queryDate: async () => ({ items: [], stale: [], missingPeriods: [] }),
		queryPage: async request => {
			const offset = Number(request.cursor?.observationKey ?? 0), end = Math.min(offset + request.limit, memos.length);
			return { items: memos.slice(offset, end).map(memo => ({ memo, instance: { memoId: memo.id, targetDate: today } })),
				nextCursor: end < memos.length ? { today, tab: request.tab, catalogRevision: 1, coverageKey: "complete", primaryTargetDate: today,
					createdAtKey: memos[end - 1]!.createdAt, observationKey: String(end) } : null,
				catalogRevision: 1, complete: true, stale: [], missingPeriods: [], metrics: { cursorReads: 1, observationsRead: 30, returned: 30 } };
		}, requestRender: () => { if (rendering) view.renderTimeBuoyPage(); } });
	const render = () => options.surface === "buoy" ? view.renderTimeBuoyPage()
		: view.syncCardFlowPresentation({ type: "items", mode: "memo", headers: [], memos: view.memos }, null);
	Object.assign(view, {
		memos, catalogDesktopQueryRun: 0, catalogTodayTimeBuoys: null,
		getFilteredMemos: () => view.memos, shouldShowTodayTimeBuoys: () => false, getInitialCardBatchSize: () => count,
		randomReunionController: { applyMemoChanges() {} }, shuffleDayController: { applyMemoChanges() {} }, timeBuoyViewController: buoy,
		renderUiState: () => render(), getA11yId: () => "buoy", renderCardFlow: render,
		timeBuoyBatchFrameId: null, timeBuoyRenderedCount: 0, timeBuoyRenderItems: [], timeBuoyLoadMoreObserver: null,
	});
	view.memoMarkdownRenderer.retainCard = () => {};
	if (options.surface === "buoy") {
		view.viewStateController.activeNav = "time-buoy";
		await buoy.loadInitial(); await buoy.loadMore(); await buoy.loadMore();
		view.timeBuoyPanelEl = flow.createEl("section", { cls: "knomo-time-buoy-panel", attr: { id: "buoy-panel-today" } });
		view.timeBuoyRenderItems = buoy.getSnapshot().today;
		rendering = true;
	}
	render(); await h.settle();
	const cards = () => [...flow.querySelectorAll<HTMLElement>(".knomo-card")];
	const sample = () => {
		const top = flow.getBoundingClientRect().top;
		const card = cards().find(card => card.getBoundingClientRect().bottom > top)!;
		return { scroll: flow.scrollTop, anchor: /^Memo \d+/.exec(card.querySelector(".knomo-card-content")!.textContent!)?.[0],
			offset: card.getBoundingClientRect().top - top, count: cards().length };
	};
	const reader = cards()[70]!;
	flow.scrollTop += reader.getBoundingClientRect().top - flow.getBoundingClientRect().top + 12;
	await frames();
	const samples = [sample()], editedIndex = options.editAbove ? 50 : 70;
	const previous = memos;
	memos = memos.map((before, index) => {
		const memo = h.makeMemo(index, 1, index === 95, "2026-08-08");
		memo.catalog!.timeBuoyDates = [today];
		if (index === editedIndex) { memo.contentSnapshot += " updated long paragraph".repeat(40); memo.contentHash = "edited"; }
		return memo;
	});
	view.applyCachedMemoChanges(new Map(previous.map((before, index) => [before.id, memos[index]!])));
	samples.push(sample()); await h.settle(); samples.push(sample());
	if (options.surface === "buoy") await buoy.loadInitial(); else render();
	await h.settle(); samples.push(sample());
	return { samples };
}

export async function surface(surface: "buoy" | "subject", richMarkdown = false, imageChange: "none" | "modified" | "removed" | "same-key" = "none") {
	const h = fixture(false, richMarkdown), { view, flow } = h;
	h.context.enabled = false; view.prepareRecentTimeFlow();
	let memo = h.makeMemo(0, 0, true), refresh: () => void;
	if (richMarkdown) memo = { ...memo, contentSnapshot: "First paragraph\n\nSecond paragraph\n\n[[source#^block]]" };
	if (surface === "buoy") {
		const items = () => [{ memo, primaryTargetDate: "2099-12-31", targetDates: ["2099-12-31"] }];
		Object.assign(view, {
			getA11yId: () => "test", getCardFlowScrollTop: () => flow.scrollTop, restoreCardFlowScrollTop: () => {},
			timeBuoyViewController: { getSnapshot: () => ({ activeTab: "upcoming", upcoming: items(), today: [], past: [], loading: false,
				error: null, refreshError: null, complete: true, nextCursor: null }) },
			timeBuoyBatchFrameId: null, timeBuoyRenderedCount: 1, timeBuoyRenderItems: items(), timeBuoyLoadMoreObserver: null,
			timeBuoyPanelEl: flow.createEl("section", { cls: "knomo-time-buoy-panel", attr: { id: "test-panel-upcoming" } }),
		});
		view.appendTimeBuoyBatchItems(view.timeBuoyPanelEl, items(), 0, view.renderGeneration);
		refresh = () => view.renderTimeBuoyPage();
	} else {
		const detail = Object.create(MemoRelationsPage.prototype);
		Object.assign(detail, { subject: flow.createDiv({ cls: "knomo-relations-subject" }), memos: new Map(),
			options: { releaseCard: (card: HTMLElement) => view.removeCardImageTargets(card),
				renderCard: (root: HTMLElement, item: MemoViewItem, index: number, handoff?: unknown) =>
					view.renderMemoCardInContainer(root, item, view.renderGeneration, index, true, false, "relations", null, null, undefined, handoff) } });
		refresh = () => detail.renderSubject(memo); refresh();
	}
	await h.settle();
	const previousMemo = memo;
	const image = flow.querySelector("img"), measure = () => ({ imageHeight: flow.querySelector(".knomo-card-images")?.getBoundingClientRect().height ?? 0,
		cardHeight: flow.querySelector(".knomo-card")!.getBoundingClientRect().height, sameImage: image === flow.querySelector("img"), loads: h.loads() });
	const before = measure(); h.hold();
	memo = { ...h.makeMemo(0, 1, true), contentSnapshot: richMarkdown ? memo.contentSnapshot : "Memo 0 changed text", contentHash: richMarkdown ? memo.contentHash : "changed" };
	if (richMarkdown) Object.assign(memo.catalog!.observation, { rawBlockHash: "changed-format" });
	if (imageChange === "same-key") {
		memo.id = previousMemo.id; memo.catalog!.renderKey = previousMemo.catalog!.renderKey;
		if (surface === "subject") {
			// subject 的已确认原位修改先使展示标记失效，再执行同一渲染入口。
			flow.querySelector<HTMLElement>(".knomo-relations-subject")!.dataset.subject = "";
		}
	}
	if (imageChange === "modified") h.changeResource();
	if (imageChange === "removed") memo.images = [];
	refresh(); await frames(); const waiting = measure();
	await h.release();
	return { before, waiting, after: measure(), buttonMemo: flow.querySelector(".knomo-card-image-button")?.getAttribute("data-memo-id"), memoId: memo.id };
}

export async function referrerImages() {
	const h = fixture(), { view, flow } = h;
	h.context.enabled = false; view.prepareRecentTimeFlow();
	let memo = h.makeMemo(0, 0, true);
	const node = () => ({ handle: memo.catalog!.observationHandle } as MemoRelationNode);
	const list = flow.createDiv();
	const window = new MemoRelationWindow(list, flow, 260, async (row, _node, index, ...extra: unknown[]) => {
		view.renderMemoCardInContainer(row, memo, view.renderGeneration, index, true, false, "relations", null, null, undefined, extra[0]);
	}, row => view.removeCardImageTargets(row));
	try {
		window.setNodes([node()]); await window.settled(); await h.settle();
		const image = flow.querySelector("img"), before = flow.querySelector(".knomo-card-images")!.getBoundingClientRect().height;
		h.hold(); memo = { ...h.makeMemo(0, 1, true), contentSnapshot: "Referrer edited", contentHash: "changed" };
		window.setNodes([node()]); await window.settled(); await frames();
		const waiting = flow.querySelector(".knomo-card-images")!.getBoundingClientRect().height;
		await h.release();
		return { before, waiting, sameImage: image === flow.querySelector("img"), loads: h.loads() };
	} finally { window.dispose(); }
}

export async function scrollRestoreRace() {
	const { view, flow } = fixture();
	flow.createDiv().style.height = "2400px";
	view.restoreElementScrollTop(flow, 100);
	flow.scrollTop = 400;
	await frames();
	return flow.scrollTop;
}

export async function resultSummaryGeometry(options: { mobile: boolean; width: number; fontSize: number; position: number; count: number | null }) {
	const h = fixture(options.mobile), { view, flow } = h;
	h.context.enabled = false;
	const root = flow.parentElement!;
	root.classList.toggle("is-layout-mobile", options.mobile);
	root.classList.toggle("is-layout-desktop-wide", !options.mobile);
	root.style.width = flow.style.width = `${options.width}px`;
	root.style.setProperty("--knomo-text-ui-base", `${options.fontSize}px`);
	const query = "memo 2026 {{count}} 长条件 Long condition with words and 日期筛选";
	const memos = Array.from({ length: 35 }, (_, i) => h.makeMemo(i, 0, false));
	const copy = getRegularFilterCopy({ activeNav: "all", activeTag: null, activeTagKey: null, searchQuery: query,
		searchDateFilter: null, recordStatsSearchFilter: null, scopeFilter: "all" }, null, true)!;
	const summary = copy.summary;
	let finishCount!: (result: { count: number | null; complete: boolean; catalogRevision: number; coverage: MobileSearchPage["coverage"] }) => void;
	let countStarted!: () => void;
	const counting = new Promise<void>(resolve => { countStarted = resolve; });
	let controller: MobileSearchController | undefined;
	const render = () => view.syncCardFlowPresentation({ type: "items", mode: "memo", headers: [{ type: "result-summary", summary }], memos }, null);
	if (!options.mobile) {
		view.renderCardFlowHeaders = (container: HTMLElement, headers: Parameters<typeof syncKnomoCardFlowHeaders>[1]) => syncKnomoCardFlowHeaders(container, headers, "summary");
		render();
	} else {
		const coverage = { kind: "complete" as const, coveredFromDate: null, pendingFileCount: 0, coveredFileCount: 1, totalFileCount: 1 };
		controller = new MobileSearchController({
			batchSize: 50, debounceMs: 10, getWindow: () => window, getDocument: () => document,
			getRootEl: () => root, isMobileLayout: () => true, registerDomEvent: () => {}, createHiddenText: (_container, name) => name,
			filterMemos: items => [...items], renderMemoCard: (container, memo, generation, index) => view.renderMemoCardInContainer(container, memo, generation, index, true, false, "mobile-search"),
			clearMarkdown: () => {}, clearImages: () => {}, setCardFlowPaused: () => {}, closeSurroundingChrome: () => {}, closeCardMenu: () => {},
			syncRootState: () => {}, getCardFlowScrollTop: () => 0, restoreCardFlowScrollTop: () => {}, restoreElementScrollTop: () => {},
			handleMarkdownInternalLinkClick: () => {}, handleTaskCheckboxClick: () => {}, handleTaskCheckboxChange: () => {},
			loadRemoteResults: async () => ({ items: memos, catalogRevision: 1, coverage, readState: "ready", invalidated: false, degraded: false,
				nextCursor: { catalog: { catalogRevision: 1, createdAtKey: "next", observationKey: "next" } },
				status: { content: "ready", catalog: "complete", projection: "ready" }, capabilities: createCatalogCapabilities(coverage),
				lifecycle: { state: "ready", persistent: true, writable: true, reason: null } }),
			countRemoteResults: () => new Promise(resolve => { finishCount = resolve; countStarted(); }),
		});
		Object.assign(controller, { resultsEl: flow, open: true });
		controller.searchQuery = query;
		await counting;
	}
	await h.settle();
	const element = flow.querySelector<HTMLElement>(".knomo-result-summary")!;
	const fixed = element.firstChild, slot = element.querySelector<HTMLElement>(".knomo-result-summary-count")!;
	const card = flow.querySelector<HTMLElement>(".knomo-card")!;
	const reference = root.createDiv({ cls: "knomo-list-summary" });
	reference.style.position = "fixed";
	reference.style.visibility = "hidden";
	const naturalLayout = (count: number | null, pending: boolean) => {
		const text = count === null ? pending ? "..." : "—" : String(count);
		reference.style.width = `${element.getBoundingClientRect().width}px`;
		reference.textContent = t(summary.template, { ...summary.params, count: text });
		const before = t(summary.template, { ...summary.params, count: "\u0000count\u0000" }).split("\u0000count\u0000")[0]!;
		const range = document.createRange();
		range.setStart(reference.firstChild!, before.length);
		range.setEnd(reference.firstChild!, before.length + text.length);
		return { height: reference.getBoundingClientRect().height, countWidth: range.getBoundingClientRect().width };
	};
	flow.scrollTop = options.position; await frames();
	const anchor = [...flow.querySelectorAll<HTMLElement>(".knomo-card")].find(item => item.getBoundingClientRect().bottom > flow.getBoundingClientRect().top)!;
	const sample = () => ({ height: element.getBoundingClientRect().height, offset: anchor.getBoundingClientRect().top - flow.getBoundingClientRect().top,
		scroll: flow.scrollTop, value: Number(getComputedStyle(slot.querySelector(".knomo-result-summary-value")!).opacity),
		dots: Number(getComputedStyle(slot.querySelector(".knomo-result-summary-dots")!).opacity) });
	const pendingLayout = naturalLayout(null, true);
	const samples = [sample()];
	for (let index = 0; index < 3; index++) { await new Promise(resolve => setTimeout(resolve, 35)); samples.push(sample()); }
	const dotAnimation = getComputedStyle(slot.querySelector(".knomo-result-summary-dots > span")!).animationName;
	summary.count = options.count; summary.pending = false;
	if (controller) {
		finishCount({ count: options.count, complete: options.count !== null, catalogRevision: 1,
			coverage: { kind: "complete", coveredFromDate: null, pendingFileCount: 0, coveredFileCount: 1, totalFileCount: 1 } });
		await Promise.resolve(); await Promise.resolve();
	} else render();
	const revealAnimation = getComputedStyle(slot.querySelector(".knomo-result-summary-value")!).animationName;
	const finalLayout = naturalLayout(options.count, false);
	const countWidthError = Math.abs(slot.getBoundingClientRect().width - finalLayout.countWidth);
	samples.push(sample());
	for (let index = 0; index < 6; index++) { await new Promise(resolve => setTimeout(resolve, 30)); samples.push(sample()); }
	// 扫过连续窄宽度，覆盖数量槽临近换行边界的情况。
	flow.scrollTop = 0;
	const widthChanges: number[] = [];
	const naturalLayoutErrors: number[] = [];
	for (let width = 240; width <= 460; width++) {
		root.style.width = flow.style.width = `${width}px`;
		syncResultCountSummary(element, { ...summary, count: null, pending: true });
		const before = [element.getBoundingClientRect().height, card.getBoundingClientRect().top];
		naturalLayoutErrors.push(Math.abs(before[0]! - naturalLayout(null, true).height));
		syncResultCountSummary(element, { ...summary, count: options.count, pending: false });
		widthChanges.push(element.getBoundingClientRect().height - before[0], card.getBoundingClientRect().top - before[1]);
		const natural = naturalLayout(options.count, false);
		naturalLayoutErrors.push(Math.abs(element.getBoundingClientRect().height - natural.height), Math.abs(slot.getBoundingClientRect().width - natural.countWidth));
	}
	root.style.width = flow.style.width = `${options.width}px`;
	reference.remove();
	controller?.removePage();
	return { locale: getKnomoLocale(), samples, pendingLayout, finalLayout, countWidthError, dotAnimation, revealAnimation,
		maxWidthShift: Math.max(...widthChanges.map(Math.abs)), maxNaturalLayoutError: Math.max(...naturalLayoutErrors),
		sameSummary: element === flow.querySelector(".knomo-result-summary"), sameFixed: fixed === element.firstChild,
		sameSlot: slot === element.querySelector(".knomo-result-summary-count"), sameCard: card === flow.querySelector(".knomo-card") };
}
