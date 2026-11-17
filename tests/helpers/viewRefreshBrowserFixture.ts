import { Platform, addIcon } from "obsidian";
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
import { TFile } from "obsidian";
import { KnomoViewStateController } from "../../src/ui/KnomoViewStateController";
import { KnomoCardFlowCoordinator } from "../../src/ui/KnomoCardFlowCoordinator";
import { DiaryMemoParser } from "../../src/services/DiaryMemoParser";
import { MemoCatalogService } from "../../src/services/MemoCatalogService";
import { InMemoryMemoCatalogStore } from "../../src/services/MemoCatalogStore";
import { CatalogReadService } from "../../src/services/CatalogReadService";
import type { BeaconSnapshot } from "../../src/types/beacon";
import { registerKnomoIcons } from "../../src/icons";
import type { BeaconSource } from "../../src/services/BeaconService";
import { toParsedCatalogMemoItem } from "../../src/services/CatalogReadService";
import { BeaconService } from "../../src/services/BeaconService";
import { PluginDataStore } from "../../src/services/PluginDataStore";
import { toCatalogMemoView } from "../../src/types/memoView";

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
	const createSvg = function(this: Element, tag: string, options: { cls?: string; attr?: Record<string, string> } = {}) {
		const svg = document.createElementNS("http://www.w3.org/2000/svg", tag);
		if (options.cls) svg.setAttribute("class", options.cls);
		for (const [key, value] of Object.entries(options.attr ?? {})) svg.setAttribute(key, value);
		this.append(svg); return svg;
	};
	Object.assign(HTMLElement.prototype, { createSvg }); Object.assign(SVGElement.prototype, { createSvg });
}

function prepareBeaconSurface(flow: HTMLElement, options: { mobile: boolean; dark: boolean; reduce: boolean }) {
	registerKnomoIcons();
	document.body.className = options.dark ? "theme-dark" : "theme-light";
	const host = flow.parentElement!;
	host.className = `knomo-plugin ${options.mobile ? "is-layout-mobile" : "is-layout-desktop-wide"}${options.reduce ? " knomo-reduce-glass" : ""}`;
	host.style.width = flow.style.width = options.mobile ? "360px" : "700px";
	document.body.style.setProperty("--background-primary", options.dark ? "#242424" : "#fff");
	document.body.style.setProperty("--background-secondary", options.dark ? "#303030" : "#eee");
	document.body.style.setProperty("--text-normal", options.dark ? "#eee" : "#222");
	document.body.style.setProperty("--text-muted", options.dark ? "#bbb" : "#666");
	document.body.style.setProperty("--interactive-accent", "#8468dc");
}

function hydrateKnomoIcons(flow: HTMLElement) {
	for (const icon of Array.from(flow.querySelectorAll<HTMLElement>("[data-icon]"))) {
		const paths = (addIcon as unknown as { icons: Record<string, string> }).icons[icon.getAttribute("data-icon")!];
		if (paths && !icon.querySelector("svg")) { const svg = icon.createSvg("svg", { attr: { viewBox: "0 0 100 100", "aria-hidden": "true" } }); svg.innerHTML = paths; }
	}
}

export async function beaconGeometry(options: { mobile: boolean; dark: boolean; today: boolean; loaded: boolean; reduce: boolean }) {
	const h = fixture(options.mobile), { view, flow } = h;
	prepareBeaconSurface(flow, options);
	const now = new Date(), date = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
	const memos = Array.from({ length: 35 }, (_, i) => h.makeMemo(i, 0, false, date));
	const selected = options.loaded ? memos[8]! : h.makeMemo(80, 0, false, "2025-01-01");
	let today = options.today;
	let snapshot: BeaconSnapshot = { state: "unset", selection: 0 };
	Object.assign(view, {
		beaconService: { getSnapshot: () => snapshot }, getPageFeedbackContext: () => "beacon",
		memos, getCardFlowViewStateKey: () => "default",
		getVisibleMemoTimeBuoy: (memo: MemoViewItem) => memo.id === selected.id ? { status: today ? "today" : "past", label: "Time buoy" } : undefined,
	});
	// 使用生产分组和头部接线，卡片仍走真实 KnomoCard。
	delete view.prepareRecentTimeFlow;
	Object.assign(view, { settingsService: { getSettings: () => ({ recentTimeFlowEnabled: true }) }, getTodayTimeBuoyItems: () => [] });
	delete view.renderCardFlowHeaders;
	const render = (items = memos) => {
		view.syncCardFlowPresentation({ type: "items", mode: "memo", headers: [], memos: items }, null);
		hydrateKnomoIcons(flow);
	};
	const sample = () => {
		const cards = Array.from(flow.querySelectorAll<HTMLElement>(".knomo-card"));
		const rect = flow.getBoundingClientRect();
		const anchor = cards.find(card => !card.hasAttribute("data-beacon-top") && card.getBoundingClientRect().bottom > rect.top)!;
		const top = flow.querySelector<HTMLElement>("[data-beacon-top]");
		const beacon = top?.querySelector<HTMLElement>(".knomo-card-beacon");
		const buoy = top?.querySelector<HTMLElement>(".knomo-card-time-buoy");
		return { anchor: anchor?.getAttribute("data-memo-id"), offset: anchor ? anchor.getBoundingClientRect().top - rect.top : 0,
			scroll: flow.scrollTop, count: cards.length, topCount: flow.querySelectorAll("[data-beacon-top]").length,
			selectedCount: cards.filter(card => card.getAttribute("data-memo-id") === selected.id).length,
			wave: top?.querySelectorAll(".knomo-card-time-buoy-wave").length ?? 0,
			light: top?.querySelectorAll(".knomo-card-beacon-light").length ?? 0,
			time: top?.querySelector(".knomo-card-time")?.textContent,
			doubleGap: beacon && buoy ? buoy.getBoundingClientRect().left - beacon.getBoundingClientRect().right : null,
			decorations: Array.from(flow.querySelectorAll(".knomo-recent-flow-decoration")).map(item => item.textContent),
			lightHeight: top?.querySelector(".knomo-card-beacon-light")?.getBoundingClientRect().height,
			position: top ? getComputedStyle(top).position : null,
		};
	};
	render(); await frames(); flow.scrollTop = 1400; const before = sample();
	snapshot = { state: "ready", selection: 1, memo: selected }; render(); await frames(); const pinned = sample();
	flow.scrollTop = 0; await frames();
	const visual = sample();
	today = !today; render(); const dateFlip = sample();
	today = options.today; render();
	const oldTop = flow.querySelector<HTMLElement>("[data-beacon-top]")!, oldHeight = oldTop.getBoundingClientRect().height;
	const input = document.createElement("input"); document.body.append(input); input.focus();
	view.renderCardFlow = () => {};
	snapshot = { state: "locating", selection: 1 }; view.handleBeaconChanged();
	const waitingTop = flow.querySelector<HTMLElement>("[data-beacon-top]")!;
	const deferred = { hidden: getComputedStyle(waitingTop.querySelector<HTMLElement>(".knomo-card-body")!).visibility === "hidden",
		inert: waitingTop.hasAttribute("inert"), heightChange: waitingTop.getBoundingClientRect().height - oldHeight, focused: document.activeElement === input };
	snapshot = { state: "ready", selection: 1, memo: selected }; render(); input.remove();
	snapshot = { state: "unset", selection: 2 }; render(); await frames(); const removed = sample();
	// 相关旧源普通卡/浮标卡未跟上时，新旧正文不能双显。
	const changed = { ...selected, id: selected.id + "-new", contentSnapshot: "New confirmed Beacon", catalog: {
		...selected.catalog!, renderKey: selected.id + "-new", key: selected.id + "-new", observationHandle: {
			...selected.catalog!.observationHandle, sourceRevision: "next-revision" },
	} };
	snapshot = { state: "ready", selection: 3, memo: changed }; render(options.loaded ? memos : [selected, ...memos]);
	const delayed = { top: flow.querySelectorAll("[data-beacon-top]").length, status: flow.querySelector(".knomo-beacon-status")?.textContent,
		old: flow.querySelectorAll(`[data-memo-id='${CSS.escape(selected.id)}']`).length,
		new: Array.from(flow.querySelectorAll(".knomo-card-content")).filter(item => item.textContent === changed.contentSnapshot).length };
	// 恢复纯视觉状态用于截图；不增加功能标题或扩大普通分页窗口。
	snapshot = { state: "ready", selection: 4, memo: selected }; render(); flow.scrollTop = 0; await frames();
	return { before, pinned, visual, dateFlip, removed, delayed, deferred, ordinaryCount: memos.length };
}

export async function beaconSourceRefresh(options: { mobile: boolean; loaded: boolean }) {
	const h = fixture(options.mobile), { view, flow } = h;
	prepareBeaconSurface(flow, { ...options, dark: options.mobile, reduce: options.mobile });
	const path = "Daily/2026-11-16.md", date = "2026-11-16";
	let content = "## Memos\n" + Array.from({ length: 35 }, (_, index) => `- 08:30 Memo ${index}${index === 8 ? " ^beacon" : ""}\n`).join("");
	const catalog = new MemoCatalogService(new InMemoryMemoCatalogStore()), parser = new DiaryMemoParser();
	await catalog.open(); const read = new CatalogReadService({ catalog });
	let source: BeaconSource, revision = 0, saved: unknown = {}, gate: Promise<void> | undefined;
	const seed = async () => {
		const parsed = await parser.parse({ sourcePath: path, logicalDate: date, bytes: new TextEncoder().encode(content) });
		source = { path, logicalDate: date, ...parsed };
		await catalog.replaceFile({ inventory: { sourcePath: path, logicalDate: date, mtime: ++revision, size: content.length },
			...parsed, parserVersion: 19, settingsFingerprint: "test", auditedAt: revision });
	};
	await seed();
	const list = async () => (await read.query({ limit: 100 })).items.map(toCatalogMemoView)
		.filter(memo => options.loaded || memo.catalog?.observation.existingBlockId !== "beacon");
	const service = new BeaconService(new PluginDataStore({ loadData: async () => saved,
		saveData: async data => { saved = data; } } as import("obsidian").Plugin), {
		readSource: async () => { await gate; return source; },
		isSourceCurrent: async value => value.sourceRevision === source.sourceRevision,
		createBlockReference: async handle => ({ status: "committed", observation: source.observations.find(item => item.startLine === handle.startLine)!, blockId: "beacon", catalogUpdatePending: false }),
		fromObservation: observation => toParsedCatalogMemoItem(observation, createCatalogCapabilities({ kind: "partial", coveredFromDate: null, pendingFileCount: 0, coveredFileCount: 0, totalFileCount: 0 })),
		onFailure: error => { throw error; },
	});
	Object.assign(view, { beaconService: service, getCardFlowViewStateKey: () => "default", getPageFeedbackContext: () => "beacon-refresh",
		settingsService: { getSettings: () => ({ recentTimeFlowEnabled: true }) }, getTodayTimeBuoyItems: () => [], memos: await list() });
	delete view.prepareRecentTimeFlow; delete view.renderCardFlowHeaders;
	const render = () => view.syncCardFlowPresentation({ type: "items", mode: "memo", headers: [], memos: view.memos }, null);
	view.renderCardFlow = render;
	const unsubscribe = service.subscribe(() => view.handleBeaconChanged());
	try {
		await service.reload(); render(); await service.set(source!.observations[8]!); await h.settle();
		const top = flow.querySelector<HTMLElement>("[data-beacon-top]")!, height = top.getBoundingClientRect().height;
		const input = document.createElement("textarea"); document.body.append(input); input.focus();
		input.dispatchEvent(new CompositionEvent("compositionstart", { data: "输" }));
		let release!: () => void; gate = new Promise<void>(resolve => { release = resolve; });
		content = content.replace("Memo 0", "Neighbor changed\n  extra line"); await seed();
		service.sourceChanged(path); render(); await frames();
		const waitingTop = flow.querySelector<HTMLElement>("[data-beacon-top]")!;
		const waiting = { count: flow.querySelectorAll("[data-beacon-top]").length,
			hidden: getComputedStyle(waitingTop.querySelector<HTMLElement>(".knomo-card-body")!).visibility === "hidden",
			inert: waitingTop.hasAttribute("inert"), heightChange: waitingTop.getBoundingClientRect().height - height,
			focused: document.activeElement === input, state: service.getSnapshot().state };
		gate = undefined; release(); await service.refresh(); view.memos = await list(); render(); await h.settle();
		const ready = { state: service.getSnapshot().state, count: flow.querySelectorAll("[data-beacon-top]").length,
			selected: Array.from(flow.querySelectorAll(".knomo-card-content")).filter(item => item.textContent === "Memo 8").length,
			focused: document.activeElement === input, placeholder: flow.querySelectorAll("[data-beacon-status]").length,
			total: flow.querySelectorAll(".knomo-card").length, expected: view.memos.length + (options.loaded ? 0 : 1) };
		content = content.replace("Memo 8", "Changed target"); await seed(); service.sourceChanged(path); await service.refresh();
		const updated = { state: service.getSnapshot().state, content: service.getSnapshot().memo?.contentSnapshot };
		content = content.replace(" ^beacon", ""); await seed(); service.sourceChanged(path); await service.refresh();
		const rejected = { state: service.getSnapshot().state, reason: service.getSnapshot().reason,
			placeholder: flow.querySelectorAll("[data-beacon-status]").length, status: flow.querySelector(".knomo-beacon-status")?.textContent };
		content = content.replace("Changed target", "Changed target ^beacon"); await seed();
		view.memos = await list(); await service.set(source!.observations[8]!); render();
		gate = new Promise<void>(resolve => { release = resolve; }); service.sourceChanged(path); render();
		await service.remove(service.getSnapshot().selection);
		const removed = { state: service.getSnapshot().state, top: flow.querySelectorAll("[data-beacon-top]").length,
			placeholder: flow.querySelectorAll("[data-beacon-status]").length };
		gate = undefined; release(); await service.refresh();
		input.dispatchEvent(new CompositionEvent("compositionend", { data: "输入" })); input.remove();
		return { waiting, ready, updated, rejected, removed };
	} finally { unsubscribe(); service.dispose(); catalog.close(); }
}

export async function beaconTwoViews(mobile: boolean) {
	const left = fixture(mobile);
	const host = document.createElement("main"); host.className = "knomo-plugin"; document.body.append(host);
	const rightFlow = host.createDiv({ cls: "knomo-card-flow" });
	const right = fixture(mobile, false, rightFlow);
	for (const h of [left, right]) prepareBeaconSurface(h.flow, { mobile, dark: mobile, reduce: mobile });
	const path = "Daily/2026-11-16.md", logicalDate = "2026-11-16", parser = new DiaryMemoParser();
	const catalog = new MemoCatalogService(new InMemoryMemoCatalogStore()); await catalog.open();
	const read = new CatalogReadService({ catalog });
	let content = "## Memos\n" + Array.from({ length: 35 }, (_, i) => `- 08:${String(i).padStart(2, "0")} Memo ${i}${i === 8 ? " ^beacon" : ""}\n`).join("");
	let source!: BeaconSource, stamp = 0, saved: unknown = {}, writes = 0;
	const publish = async () => {
		const parsed = await parser.parse({ sourcePath: path, logicalDate, bytes: new TextEncoder().encode(content) });
		source = { path, logicalDate, ...parsed };
		await catalog.replaceFile({ inventory: { sourcePath: path, logicalDate, mtime: ++stamp, size: content.length },
			...parsed, parserVersion: 19, settingsFingerprint: "test", auditedAt: stamp });
	};
	await publish();
	const service = new BeaconService(new PluginDataStore({ loadData: async () => saved, saveData: async data => { writes++; saved = data; } } as import("obsidian").Plugin), {
		readSource: async () => source,
		isSourceCurrent: async value => value.sourceRevision === source.sourceRevision,
		createBlockReference: async handle => ({ status: "committed", observation: source.observations.find(item => item.startLine === handle.startLine)!, blockId: "beacon", catalogUpdatePending: false }),
		fromObservation: observation => toParsedCatalogMemoItem(observation, createCatalogCapabilities({ kind: "partial", coveredFromDate: null, pendingFileCount: 0, coveredFileCount: 0, totalFileCount: 0 })),
		onFailure: error => { throw error; },
	});
	let hidden = false, defaultScope = true;
	const renderers = [left, right].map((h, i) => {
		Object.assign(h.view, { beaconService: service, getCardFlowViewStateKey: () => "default", isDefaultListState: () => i === 0 ? defaultScope : true,
			getPageFeedbackContext: () => "two-views", settingsService: { getSettings: () => ({ recentTimeFlowEnabled: true }) },
			getTodayTimeBuoyItems: () => [], memos: [] });
		delete h.view.prepareRecentTimeFlow; delete h.view.renderCardFlowHeaders;
		const render = () => { if (i !== 1 || !hidden) h.view.syncCardFlowPresentation({ type: "items", mode: "memo", headers: [], memos: h.view.memos }, null); };
		h.view.renderCardFlow = render; return render;
	});
	const lists = async (i: number) => { const h = [left, right][i]!; h.view.memos = (await read.query({ limit: i === 0 ? 35 : 5 })).items.map(toCatalogMemoView); renderers[i]!(); };
	const off = [left, right].map(h => service.subscribe(() => h.view.handleBeaconChanged()));
	const samples: Array<{ phase: string; counts: number[]; tops: number[] }> = [];
	const sample = (phase: string) => samples.push({ phase, counts: [left, right].map(h => Array.from(h.flow.querySelectorAll<HTMLElement>(".knomo-card"))
		.filter(card => /Memo 8|Edited selected/u.test(card.querySelector(".knomo-card-content")?.textContent ?? "")
			&& !card.hasAttribute("inert") && !card.hasAttribute("data-knomo-readonly-transition")).length),
		tops: [left, right].map(h => h.flow.querySelectorAll("[data-beacon-top]:not([inert])").length) });
	try {
		await service.reload(); await lists(0); await lists(1); await service.set(source.observations[8]!); sample("initial");
		hidden = true;
		content = content.replace("Memo 0", "neighbor changed\n  extra"); await publish(); service.sourceChanged(path);
		service.observeSource(source); await lists(0); sample("query first");
		await Promise.all([service.refresh(), service.refresh()]); sample("binding after query");
		const before = source;
		content = content.replace("Memo 8", "Edited selected"); await publish(); service.sourceChanged(path);
		service.confirmed({ change: { sourcePath: path, logicalDate, beforeSourceRevision: before.sourceRevision, sourceRevision: source.sourceRevision,
			replacements: before.observations.map((item, i) => ({ before: item, after: source.observations[i]! })), inserted: null, changed: source.observations[8]! },
			observations: source.observations, blockAnchors: source.blockAnchors });
		await service.refresh(); sample("binding first"); await lists(0); sample("query after binding");
		hidden = false; await lists(1); sample("hidden resumed");
		defaultScope = false; renderers[0]!(); const filteredTop = left.flow.querySelectorAll("[data-beacon-top]").length;
		defaultScope = true; renderers[0]!(); await service.remove(service.getSnapshot().selection); sample("removed");
		await left.settle(); await right.settle();
		return { samples, filteredTop, writes, sizes: [left.view.memos.length, right.view.memos.length] };
	} finally { for (const dispose of off) dispose(); service.dispose(); catalog.close(); host.remove(); }
}

export async function beaconStylePreview(options: { mobile: boolean; dark: boolean; today: boolean }) {
	const h = fixture(options.mobile), { view, flow } = h;
	prepareBeaconSurface(flow, { ...options, reduce: options.mobile });
	for (const name of ["--font-text", "--font-interface", "--font-text-theme", "--font-interface-theme"]) {
		document.body.style.setProperty(name, 'Arial, "Microsoft YaHei", sans-serif');
	}
	document.body.style.setProperty("--text-faint", options.dark ? "#8e99ab" : "#727780");
	document.body.style.setProperty("--background-modifier-hover", "rgba(128, 128, 128, 0.12)");
	document.body.style.setProperty("--interactive-accent", options.dark ? "#448aff" : "#8468dc");
	flow.style.padding = "12px";
	const now = new Date(), date = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
	const beacon = h.makeMemo(50, 0, false, "2026-11-12"), buoy = h.makeMemo(51, 0, false, "2026-11-10"), ordinary = h.makeMemo(52, 0, false, date);
	beacon.contentSnapshot = "每天留一点时间，做真正重要的事。\n先完成，再完善。保持记录，也保持行动。 #长期主义 #专注";
	buoy.contentSnapshot = "今天，重新看见之前留给自己的提醒。\n保持记录，也保持行动。 #提醒";
	ordinary.contentSnapshot = "读完一章书，记下一个值得实践的想法。 #阅读";
	beacon.catalog!.observation.time = "08:30"; buoy.catalog!.observation.time = "20:15"; ordinary.catalog!.observation.time = "09:18";
	const snapshot: BeaconSnapshot = { state: "ready", selection: 1, memo: beacon };
	Object.assign(view, {
		beaconService: { getSnapshot: () => snapshot }, getPageFeedbackContext: () => "beacon-style", memos: [ordinary],
		settingsService: { getSettings: () => ({ recentTimeFlowEnabled: true }) },
		getTodayTimeBuoyItems: () => [{ memo: buoy }],
		getVisibleMemoTimeBuoy: (memo: MemoViewItem) => memo === buoy || (memo === beacon && options.today) ? { status: "today", label: "今日时光浮标" } : undefined,
	});
	delete view.prepareRecentTimeFlow;
	view.memoMarkdownRenderer.queueMemoMarkdown = (memo: MemoViewItem, container: HTMLElement) => {
		container.replaceChildren();
		for (const line of memo.contentSnapshot.split("\n")) {
			const p = container.createEl("p");
			for (const text of line.split(/(#[^\s#]+)/u)) {
				if (text.startsWith("#")) p.createSpan({ cls: "tag", text }); else p.append(text);
			}
		}
	};
	view.syncCardFlowPresentation({ type: "items", mode: "memo", headers: [], memos: [buoy, ordinary] }, null);
	hydrateKnomoIcons(flow); await frames();
	for (const menu of Array.from(flow.querySelectorAll<HTMLElement>(".knomo-card-menu"))) menu.setText("···");
	const card = flow.querySelector<HTMLElement>("[data-beacon-top]")!;
	const light = card.querySelector<SVGSVGElement>(".knomo-card-beacon-light");
	const paths = Array.from(light?.querySelectorAll("path") ?? []).map(path => {
		const style = getComputedStyle(path);
		return { opacity: Number(style.opacity), stroke: style.stroke, fill: style.fill };
	});
	return { paths, height: light?.getBoundingClientRect().height ?? 0,
		clearance: (light ?? card.querySelector(".knomo-card-time-buoy-wave")!).getBoundingClientRect().top - card.querySelector(".knomo-card-body")!.getBoundingClientRect().bottom,
		pointerEvents: getComputedStyle(light ?? card.querySelector(".knomo-card-time-buoy-wave")!).pointerEvents,
		beaconCount: card.querySelectorAll(".knomo-card-beacon").length, waveCount: card.querySelectorAll(".knomo-card-time-buoy-wave").length,
		cardCount: flow.querySelectorAll(".knomo-card").length, time: card.querySelector(".knomo-card-time")!.textContent,
		accent: getComputedStyle(card.querySelector(".knomo-card-beacon")!).color };
}

const frames = () => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));

function fixture(mobile = false, richMarkdown = false, flowOverride?: HTMLElement) {
	Object.assign(Platform, { isMobile: mobile });
	const flow = flowOverride ?? document.getElementById("flow")!;
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
				observation: { key: id, sourcePath, sourceRevision, logicalDate: date, time: "09:00", timePrecision: "minute", rawBlockHash: `raw-${index}`,
					createdAtKey: `${date}T09:00:${String(59 - index).padStart(2, "0")}` },
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

export async function pagedEditGeometry(options: { surface: "feed" | "buoy"; mobile: boolean; editAbove: boolean; external?: boolean; readonlySource?: boolean }) {
	const h = fixture(options.mobile), { view, flow } = h;
	h.context.enabled = false;
	const today = "2026-11-08", count = options.surface === "feed" ? 150 : 90;
	const makeMemo = (index: number, revision: number) => {
		const memo = h.makeMemo(index, revision, index === 95, "2026-08-08");
		memo.catalog!.timeBuoyDates = [today];
		if (options.readonlySource) {
			const minutes = 150 - index;
			memo.createdAt = `2026-08-08T${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
			if (index < 60) {
				memo.id = memo.id.replace("Daily/", "Other/");
				memo.dailyRef.path = memo.dailyRef.path.replace("Daily/", "Other/");
				memo.catalog!.key = memo.catalog!.renderKey = memo.id;
				memo.catalog!.observationHandle.sourcePath = memo.catalog!.observation.sourcePath = memo.dailyRef.path;
			}
		}
		return memo;
	};
	let memos = Array.from({ length: 150 }, (_, index) => makeMemo(index, 0));
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
			offset: card.getBoundingClientRect().top - top, count: cards().length,
			readonly: flow.querySelectorAll("[data-knomo-readonly-transition]").length };
	};
	const reader = cards()[70]!;
	flow.scrollTop += reader.getBoundingClientRect().top - flow.getBoundingClientRect().top + 12;
	await frames();
	if (options.readonlySource) {
		Object.assign(view, {
			viewStateController: new KnomoViewStateController(), confirmedTodayTimeBuoys: [],
			app: { vault: { getAbstractFileByPath: (path: string) => Object.assign(new TFile(), { path }), read: async () => "external A" } },
			confirmedDailyMemos: { getRevision: () => "revision-0", remove() {}, getChanges: () => [], pending: false },
			randomReunionController: { getSnapshot: () => ({ batchId: 1, memos: null }), applyMemoChanges() {} },
			shuffleDayController: { getSnapshot: () => ({ memos: [] }), applyMemoChanges() {} },
			syncPageFeedback() {}, reportViewRefreshFailure(error: unknown) { throw error; },
		});
		await view.checkConfirmedDailyFile("Daily/2026-08-08.md");
	}
	const samples = [sample()], editedIndex = options.editAbove ? 50 : 70;
	const previous = memos;
	memos = memos.map((before, index) => {
		if (options.readonlySource && index >= 60) return before;
		const memo = makeMemo(index, 1);
		if (index === editedIndex) { memo.contentSnapshot += " updated long paragraph".repeat(40); memo.contentHash = "edited"; }
		return memo;
	});
	if (options.external) {
		view.memos = memos;
		if (options.surface === "buoy") await buoy.loadInitial(); else render();
	} else view.applyCachedMemoChanges(new Map(previous.flatMap((before, index) => options.readonlySource && index >= 60
		? [] : [[before.id, memos[index]!] as const])));
	samples.push(sample()); await h.settle(); samples.push(sample());
	if (options.surface === "buoy") await buoy.loadInitial(); else render();
	await h.settle(); samples.push(sample());
	const readonlyCard = cards().find(card => card.querySelector(".knomo-card-content")?.textContent?.startsWith("Memo 70 "));
	const image = flow.querySelector("img");
	let sameReadonlyCard = false, sameImage = false, releasedOnScopeChange = false;
	if (options.readonlySource) {
		Object.assign(view.memoMarkdownRenderer, { clear() {} }); Object.assign(view.cardImageLoadQueue, { clear() {} });
		Object.assign(view, { cardFlowCoordinator: new KnomoCardFlowCoordinator(),
			restorePendingCardFlowScrollTop: Object.getPrototypeOf(view).restorePendingCardFlowScrollTop,
			clearLoadingIndicators() {}, deferMobileCardFlowRender: () => false,
			recordStatsViewStateController: { clearRendered() {} },
			getCurrentCardFlowPresentation: () => ({ type: "items", mode: "memo", headers: [], memos: view.memos }),
			renderCardFlowPresentation: (presentation: object) => view.syncCardFlowPresentation(presentation, null) });
		view.forceRebuildCardFlow(); await h.settle(); samples.push(sample());
		sameReadonlyCard = readonlyCard === cards().find(card => card.querySelector(".knomo-card-content")?.textContent?.startsWith("Memo 70 "));
		sameImage = image === flow.querySelector("img");
	}
	const readonlyCount = flow.querySelectorAll("[data-knomo-readonly-transition]").length;
	const updated = cards().some(card => card.getAttribute("data-memo-id") === memos[editedIndex]!.id && card.textContent?.includes("updated long paragraph"));
	if (options.readonlySource) {
		view.viewStateController.searchQuery = "new scope"; render();
		releasedOnScopeChange = flow.querySelectorAll("[data-knomo-readonly-transition]").length === 0;
	}
	return { samples, readonlyCount, updated, sameReadonlyCard, sameImage, releasedOnScopeChange };
}

export async function referrerRefreshGeometry(options: { mobile: boolean; remaining: number; position: number }) {
	const h = fixture(options.mobile), { view, flow } = h;
	h.context.enabled = false;
	const store = new InMemoryMemoCatalogStore(), catalog = new MemoCatalogService(store), parser = new DiaryMemoParser();
	await catalog.open();
	let revision = 0;
	const seed = async (sourcePath: string, content: string) => {
		const parsed = parser.parseRevision({ sourcePath, logicalDate: "2026-08-08", content, sourceRevision: `revision-${++revision}` });
		await catalog.replaceFile({ inventory: { sourcePath, logicalDate: "2026-08-08", mtime: revision, size: content.length },
			sourceRevision: parsed.sourceRevision, observations: parsed.observations, blockAnchors: parsed.blockAnchors,
			parserVersion: 19, settingsFingerprint: "test", auditedAt: revision });
	};
	await seed("Daily.md", Array.from({ length: 200 }, (_, index) => `- 09:00 Memo ${index} unchanged text ^memo-${index}\n`).join(""));
	await seed("References.md", Array.from({ length: 200 }, (_, index) => `- 10:00 [[Daily#^memo-${index}]]\n`).join(""));
	await store.setCoverage({ kind: "complete", coveredFromDate: null, pendingFileCount: 0, coveredFileCount: 2, totalFileCount: 2 });
	const read = new CatalogReadService({ catalog });
	const state = new KnomoViewStateController(); state.scopeFilter = "referenced";
	const render = () => view.syncCardFlowPresentation({ type: "items", mode: "memo", headers: [], memos: view.memos }, null);
	Object.assign(view, {
		viewStateController: state, memos: [], catalogDesktopQueryRun: 0, catalogDesktopCountRun: 0, memoSourceGeneration: 0,
		catalogDesktopQueryFingerprint: null, memoLoadingPromise: null, memoLoadingFingerprint: null,
		hasCommittedCatalogDesktopQuery: false, catalogCoverage: null, catalogTodayTimeBuoys: null,
		catalogReadService: read, getCatalogReadService: () => read, shouldShowTodayTimeBuoys: () => false,
		relationCards: { observe() {}, release() {} },
		mobileSearchController: { isOpen: false }, shouldCountCatalogQuery: () => false,
		getFilteredMemos: () => view.memos, getInitialCardBatchSize: () => 150,
		getCardFlowStateKey: () => view.memos.map((memo: MemoViewItem) => memo.id).join(), getMobileSearchStateKey: () => "",
		syncRecordStatsSource() {}, refreshCatalogLibraryIndexes: async () => {}, retainMemoCardPreviews() {}, resetVisibleMemos() {},
		renderCardFlow: render, renderUiState: (request?: { renderCardFlow?: boolean }) => { if (request?.renderCardFlow !== false) render(); },
		renderAllMemosLoadingState() {}, renderMobileSearchResultsIfChanged() {}, renderNextCardBatch() {},
		invalidateRecordStats() {}, recordStatsViewStateController: { clearRendered() {} },
	});
	await view.reloadCurrentCatalogQuery(true); await view.loadNextCatalogPage(); await view.loadNextCatalogPage();
	await h.settle();
	const cards = () => [...flow.querySelectorAll<HTMLElement>(".knomo-card")];
	flow.scrollTop += cards()[options.position]!.getBoundingClientRect().top - flow.getBoundingClientRect().top + 12;
	await frames();
	const sample = () => {
		const top = flow.getBoundingClientRect().top;
		const card = cards().find(card => card.getBoundingClientRect().bottom > top)!;
		return { data: view.memos.length, mounted: cards().length, anchor: card.querySelector(".knomo-card-content")!.textContent,
			offset: card.getBoundingClientRect().top - top, scroll: flow.scrollTop, height: flow.scrollHeight,
			first: cards()[0]!.querySelector(".knomo-card-content")!.textContent, firstTop: cards()[0]!.getBoundingClientRect().top - top };
	};
	const samples = [sample()];
	const firstTargets = await read.query({ hasReferrers: true, limit: 150 });
	const targets = [...firstTargets.items, ...(await read.query({ hasReferrers: true, limit: 150, cursor: firstTargets.nextCursor })).items];
	const unsubscribe = read.relations.subscribe(() => view.onMemoRelationsChanged());
	try {
		await seed("References.md", targets.slice(0, options.remaining).map(memo => `- 10:00 [[Daily#^${memo.observation.existingBlockId}]]\n`).join(""));
		await view.memoLoadingPromise; await h.settle(); samples.push(sample());
		const next = await view.loadNextCatalogPage(); await h.settle();
		return { samples, next, nextCount: view.memos.length, unique: new Set(view.memos.map((memo: MemoViewItem) => memo.id)).size };
	} finally { unsubscribe(); read.relations.dispose(); }
}

export async function mobileRevisionGeometry(options: {
	entry: "internal" | "external" | "cross-file";
	edit: "grow" | "shrink" | "below" | "same" | "remove-anchor" | "reorder";
	chunked?: boolean;
	forceChunkAfterEdited?: boolean;
	input?: "scroll" | "wheel" | "keyboard" | "pointer" | "touch" | "focus" | "composition";
	readonly?: boolean;
	sameBytes?: boolean;
	repeatEdits?: number;
	shrinkBelow?: boolean;
	scrollToBottom?: boolean;
	resourceChanged?: boolean;
	expanded?: boolean;
	restoreSameBytes?: boolean;
	remaining?: number;
}) {
	const h = fixture(true), { view, flow } = h;
	h.context.enabled = false;
	const root = flow.parentElement!;
	root.className = "knomo-plugin is-layout-mobile";
	flow.style.display = "none";
	const changedFileCount = options.expanded ? 100 : 10;
	let memos = Array.from({ length: options.expanded ? 200 : 30 }, (_, index) => h.makeMemo(index, 0, (!!options.sameBytes || !!options.readonly) && index === 13,
		options.entry === "cross-file" && index >= changedFileCount ? "2026-08-08" : "2026-11-08"));
	const edited = options.edit === "below" || options.shrinkBelow ? 24 : 2;
	const longText = " long paragraph with wrapping".repeat(50);
	if (options.edit === "shrink") { memos[edited]!.contentSnapshot += longText; memos[edited]!.contentHash = "long"; }
	const coverage = { kind: "complete" as const, coveredFromDate: null, pendingFileCount: 0, coveredFileCount: 2, totalFileCount: 2 };
	let replacements = 0, unavailable = false, forcedChunk = false;
	const callbacks = new Map<number, () => void>(); let task = 0;
	const requests: number[] = [], taskBindings: string[] = [];
	const controller = new MobileSearchController({
		batchSize: options.expanded ? 50 : 30, debounceMs: 10, getWindow: () => window, getDocument: () => document,
		getRootEl: () => root, isMobileLayout: () => true,
		registerDomEvent: (target, type, callback) => target.addEventListener(type, callback), createHiddenText: (_container, name) => name,
		filterMemos: items => [...items],
		renderMemoCard: (container, memo, generation, index, images, handoff) => {
			replacements++;
			const card = view.renderMemoCardInContainer(container, memo, generation, index, true, false, "mobile-search", null, images, undefined, handoff);
			if (options.forceChunkAfterEdited && index === edited && memo.catalog?.observationHandle.sourceRevision === "revision-1") {
				// 模拟下方卡片渲染较慢，让其后的旧卡确实跨帧保留。
				const deadline = performance.now() + 6;
				while (performance.now() < deadline) { /* 等待本次分片时间预算耗尽。 */ }
				forcedChunk = true;
			}
			if (options.restoreSameBytes) {
				// 模拟 Markdown 队列在静态占位交接后完成正文，任务绑定使用当前渲染参数。
				queueMicrotask(() => {
					const content = card.querySelector(".knomo-card-content")!;
					content.textContent = memo.contentSnapshot;
					content.createEl("input", { attr: { type: "checkbox",
						"data-knomo-memo-id": memo.id, "data-knomo-task-index": "0" } });
				});
			}
			return card;
		},
		retainCard: () => {}, clearMarkdown: () => {}, clearImages: () => {}, setCardFlowPaused: () => {},
		closeSurroundingChrome: () => {}, closeCardMenu: () => {}, syncRootState: () => controller.syncPage(),
		getCardFlowScrollTop: () => 0, restoreCardFlowScrollTop: () => {},
		restoreElementScrollTop: (element, value) => { if (element && value !== null) element.scrollTop = value; },
		handleMarkdownInternalLinkClick: () => {}, handleTaskCheckboxClick: () => {}, handleTaskCheckboxChange: event => {
			const id = (event.target as HTMLElement).getAttribute("data-knomo-memo-id");
			if (id) taskBindings.push(id);
		},
		scheduleRenderTask: callback => { callbacks.set(++task, callback); return task; },
		cancelRenderTask: id => { callbacks.delete(id); },
		loadRemoteResults: async (_filter, cursor) => {
			if (unavailable) throw new Error("Catalog unavailable");
			const offset = cursor ? Number(cursor.catalog.observationKey) : 0;
			requests.push(offset);
			const limit = options.expanded ? 50 : memos.length;
			return { items: memos.slice(offset, offset + limit), catalogRevision: 1, coverage, readState: "ready", invalidated: false, degraded: false,
			nextCursor: offset + limit < memos.length ? { catalog: { catalogRevision: 1, createdAtKey: "next", observationKey: String(offset + limit) } } : null,
			status: { content: "ready", catalog: "complete", projection: "ready" }, capabilities: createCatalogCapabilities(coverage),
			lifecycle: { state: "ready", persistent: true, writable: true, reason: null } };
		},
	});
	controller.searchQuery = "Memo";
	controller.openPage({ focusInput: false });
	const results = controller.results!;
	const page = results.closest<HTMLElement>(".knomo-mobile-search-page")!;
	page.style.cssText = "display:block;position:static;width:360px;height:480px;visibility:visible;opacity:1";
	results.style.cssText = "height:400px;width:360px;overflow:auto;flex:none;overflow-anchor:none";
	await h.settle();
	while (callbacks.size) { const [id, callback] = callbacks.entries().next().value!; callbacks.delete(id); callback(); }
	const cards = () => [...results.querySelectorAll<HTMLElement>(".knomo-card")];
	if (options.expanded) for (let more = 0; more < 2; more++) {
		controller.loadMore(); await frames();
		while (callbacks.size) { const [id, callback] = callbacks.entries().next().value!; callbacks.delete(id); callback(); }
	}
	const readerIndex = options.expanded ? 112 : 12;
	const reader = cards()[readerIndex]!;
	results.scrollTop += reader.getBoundingClientRect().top - results.getBoundingClientRect().top + 8;
	reader.querySelector<HTMLElement>(".knomo-card-menu")!.focus({ preventScroll: true });
	await frames();
	const sample = () => {
		const card = cards().find(card => card.querySelector(".knomo-card-content")?.textContent?.startsWith(`Memo ${readerIndex} `));
		return { scroll: results.scrollTop, maxScroll: results.scrollHeight - results.clientHeight, offset: card ? card.getBoundingClientRect().top - results.getBoundingClientRect().top : null,
			count: cards().length, height: results.scrollHeight, focus: document.activeElement === results ? "results"
				: document.activeElement?.className ?? "", readerFocus: !!card?.contains(document.activeElement) };
	};
	const samples = [sample()], previous = memos;
	const originalImage = results.querySelector("img");
	const beforeReplacements = replacements;
	memos = memos.map((before, index) => {
		if (options.entry === "cross-file" && index >= changedFileCount) return before;
		const after = h.makeMemo(index, 1, !!options.readonly && index === 13);
		if (options.edit === "shrink") return after;
		if (index === edited && options.edit !== "same" && options.edit !== "remove-anchor" && options.edit !== "reorder") {
			after.contentSnapshot += longText; after.contentHash = "edited";
		}
		return after;
	});
	if (options.edit === "remove-anchor") memos.splice(12, 1);
	if (options.edit === "reorder") [memos[2], memos[20]] = [memos[20]!, memos[2]!];
	if (options.sameBytes || options.restoreSameBytes) memos = previous;
	if (options.remaining !== undefined) memos = memos.slice(0, options.remaining);
	let readonlyBindings: number | null = null;
	if (options.readonly) {
		controller.applyMemoChanges(new Map(previous.filter(before => options.entry !== "cross-file"
			|| before.dailyRef.path === previous[0]!.dailyRef.path).map(before => [before.id, null])), [], false, true);
		readonlyBindings = controller.getDisplayedMemos().length;
		samples.push(sample());
		if (options.restoreSameBytes) results.querySelector<HTMLInputElement>("input[type=checkbox]")!.click();
		unavailable = true; await controller.refreshAppliedResults(); samples.push(sample());
		unavailable = false;
		if (options.resourceChanged) h.changeResource();
	}
	if (options.entry === "internal") controller.applyMemoChanges(new Map(previous.map(before => [before.id,
		memos.find(after => after.dailyRef.lineNumberHint === before.dailyRef.lineNumberHint) ?? null])));
	else await controller.refreshAppliedResults();
	if (options.sameBytes) for (let repeat = 0; repeat < 2; repeat++) await controller.refreshAppliedResults();
	samples.push(sample());
	let userPosition: number | null = null;
	if (options.input) {
		if (options.input === "focus" || options.input === "composition") {
			const input = page.querySelector<HTMLInputElement>("input")!;
			input.focus({ preventScroll: true });
			if (options.input === "composition") input.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
		} else {
			if (options.input === "wheel") results.dispatchEvent(new WheelEvent("wheel", { deltaY: 120 }));
			if (options.input === "touch") results.dispatchEvent(new Event("touchstart"));
			if (options.input === "keyboard") results.dispatchEvent(new KeyboardEvent("keydown", { key: "PageDown", bubbles: true }));
			if (options.input === "pointer") results.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
			results.scrollTop = options.scrollToBottom ? results.scrollHeight - results.clientHeight - 10 : results.scrollTop + 120;
			userPosition = results.scrollTop;
			results.dispatchEvent(new Event("scroll"));
		}
	}
	while (callbacks.size) {
		const [id, callback] = callbacks.entries().next().value!; callbacks.delete(id); callback();
		samples.push(sample()); await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
	}
	await h.settle(); samples.push(sample());
	for (let repeat = 0; repeat < (options.repeatEdits ?? 0); repeat++) {
		const before = memos;
		memos = memos.map((_, index) => {
			const memo = h.makeMemo(index, repeat + 2, false);
			if (index === edited && repeat % 2 === 1) { memo.contentSnapshot += longText; memo.contentHash = "long"; }
			return memo;
		});
		controller.applyMemoChanges(new Map(before.map((memo, index) => [memo.id, memos[index]!])));
		samples.push(sample()); await h.settle(); samples.push(sample());
	}
	const finalCount = cards().length;
	if (options.restoreSameBytes) results.querySelector<HTMLInputElement>("input[type=checkbox]")!.click();
	if (options.expanded) { controller.loadMore(); await frames(); }
	while (callbacks.size) { const [id, callback] = callbacks.entries().next().value!; callbacks.delete(id); callback(); }
	return { samples, userPosition, replacements: replacements - beforeReplacements, readonlyBindings, imageLoads: h.loads(), forcedChunk,
		finalCount, nextCount: cards().length, requests, taskBindings,
		readonlyCount: results.querySelectorAll("[data-knomo-readonly-transition]").length,
		disabledCount: results.querySelectorAll("button:disabled, input:disabled").length,
		sameImage: originalImage === results.querySelector("img") };
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
