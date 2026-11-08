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
