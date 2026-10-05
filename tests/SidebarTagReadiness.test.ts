import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { ensureObsidianStub } from "./helpers/obsidianStub";
import { KnomoViewStateController } from "../src/ui/KnomoViewStateController";
import { DesktopSidebarStateController } from "../src/ui/DesktopSidebarStateController";
import type { CatalogLibraryIndexesResult } from "../src/types/catalogView";

async function fixture(layout: "mobile" | "desktop-narrow" | "desktop-wide") {
	await ensureObsidianStub();
	const { Platform } = await import("obsidian");
	Object.assign(Platform, { isMobile: layout === "mobile" });
	const { KnomoView } = await import("../src/ui/KnomoView");
	const dom = new JSDOM("<body><aside><div id='tags'></div><div id='stats'></div></aside></body>");
	interface Options { cls?: string; text?: string; attr?: Record<string, string> }
	Object.assign(dom.window.HTMLElement.prototype, {
		createEl(this: HTMLElement, tag: string, options: Options = {}) {
			const child = this.ownerDocument.createElement(tag);
			child.className = options.cls ?? ""; child.textContent = options.text ?? "";
			for (const [key, value] of Object.entries(options.attr ?? {})) child.setAttribute(key, value);
			this.appendChild(child); return child;
		},
		createDiv(this: HTMLElement, options: Options) { return this.createEl("div", options); },
		createSpan(this: HTMLElement, options: Options) { return this.createEl("span", options); },
		empty(this: HTMLElement) { this.replaceChildren(); },
		setAttr(this: HTMLElement, key: string, value: string) { this.setAttribute(key, value); },
		setText(this: HTMLElement, value: string) { this.textContent = value; },
		getText(this: HTMLElement) { return this.textContent ?? ""; },
		toggleClass(this: HTMLElement, name: string, active: boolean) { this.classList.toggle(name, active); },
		removeClass(this: HTMLElement, name: string) { this.classList.remove(name); },
	});
	const tags = dom.window.document.getElementById("tags")!;
	const stats = dom.window.document.getElementById("stats")!;
	const state = new KnomoViewStateController();
	state.activeTagKey = "project/child";
	const expanded = new Set(["project"]);
	const sidebar = new DesktopSidebarStateController(); sidebar.setCollapsed(true);
	const coverage = { kind: "complete" as const, coveredFromDate: "2026-09-01", pendingFileCount: 0, coveredFileCount: 1, totalFileCount: 1 };
	let reads = 0;
	let releaseFacets!: (result: CatalogLibraryIndexesResult) => void;
	const facetsPromise = new Promise<CatalogLibraryIndexesResult>(resolve => { releaseFacets = resolve; });
	let releaseTags!: () => void;
	const tagPromise = new Promise<void>(resolve => { releaseTags = resolve; });
	const snapshot = { revision: 1, status: "ready", displayByKey: new Map<string, string>(), suggestions: [] };
	const view = Object.create(KnomoView.prototype) as {
		toggleSidebar(): void; ensureSidebarIndexes(): Promise<void>; renderTags(): void; renderPublishedSidebarTags(): void;
		libraryIndexRequest: Promise<void> | null; trashViewClosed: boolean;
	};
	Object.assign(view, {
		currentLayout: layout, viewStateController: state, desktopSidebarStateController: sidebar, expandedTagGroups: expanded,
		statsEls: [stats],
		rootEl: tags.parentElement, allTagsEl: tags, trashViewClosed: false, popupState: { scopeMenuOpen: false },
		catalogCoverage: coverage, catalogRevision: 1, libraryIndexRevision: 1, libraryIndexRun: 0,
		libraryIndexCoverageKey: JSON.stringify(["complete", null, "2026-09-01", 0, 1, 1]),
		libraryTagFacets: [{ key: "project/child", label: "Project/Child", count: 2 }],
		librarySummary: { memoCount: 2, tagCount: 1, imageCount: 0, wordCount: 2 },
		libraryIndexesUpdating: false, libraryIndexRequest: null, libraryIndexRequestedKey: null,
		vaultTagIndex: { getSnapshot: () => snapshot, ensureReady: () => snapshot.status === "ready" ? Promise.resolve() : tagPromise },
		trashMemoController: { ensureLoaded: async () => {} },
		getCatalogReadService: () => ({ getLibraryIndexes: () => { reads++; return facetsPromise; } }),
		syncRootState: () => {}, persistSidebarPreferences: async () => {}, renderStats: () => {},
		getRootInnerWidth: () => 500, closeTimeBuoyPicker: () => {}, closeCardMenu: () => {},
	});
	const result: CatalogLibraryIndexesResult = {
		value: { summary: { memoCount: 3, tagCount: 1, imageCount: 0, wordCount: 3 }, facets: [{ key: "project/child", label: "Project/Child", count: 3 }] },
		complete: true, invalidated: false, coverage, catalogRevision: 1,
		lifecycle: { state: "ready", persistent: true, writable: true, reason: null },
	};
	const renderStats = () => (KnomoView.prototype as unknown as { renderStats(): void }).renderStats.call(view);
	return { view, state, expanded, tags, stats, renderStats, snapshot, reads: () => reads, releaseTags, releaseFacets: () => releaseFacets(result), close: () => dom.window.close() };
}

for (const layout of ["mobile", "desktop-narrow", "desktop-wide"] as const) {
	for (const first of ["waiter", "subscription"] as const) {
		test(`${layout}: cold publication paints once with ${first} first`, async () => {
			const h = await fixture(layout);
			try {
				h.snapshot.status = "building";
				h.view.toggleSidebar();
				const initialTree = h.tags.firstElementChild;
				h.snapshot.displayByKey.set("project/child", "PROJECT/CHILD");
				h.snapshot.revision++;
				h.snapshot.status = "ready";
				if (first === "subscription") h.view.renderPublishedSidebarTags();
				const subscriptionTree = h.tags.firstElementChild;
				h.releaseTags(); await Promise.resolve();
				const publishedTree = h.tags.firstElementChild;
				if (first === "subscription") assert.equal(publishedTree, subscriptionTree);
				assert.notEqual(publishedTree, initialTree);
				assert.equal(h.tags.querySelector("[data-tag-key='project/child'] .knomo-tag-name")?.textContent, "CHILD");
				// 执行订阅帧使用的生产入口，已经绘制的新快照不能再替换 DOM。
				h.view.renderPublishedSidebarTags();
				assert.equal(h.tags.firstElementChild, publishedTree);
				assert.equal(h.reads(), 0);
			} finally { h.close(); }
		});
	}

	test(`${layout}: opening renders ready facets without a new notification and preserves filters on reopen`, async () => {
		const h = await fixture(layout);
		try {
			h.view.renderTags();
			h.tags.replaceChildren();
			h.view.toggleSidebar();
			const firstTree = h.tags.firstElementChild;
			await Promise.resolve();
			assert.equal(h.tags.firstElementChild, firstTree, "已就绪索引返回后不重复构造标签树");
			assert.equal(h.tags.querySelector("[data-tag-key='project/child']")?.getAttribute("aria-pressed"), "true");
			assert.equal(h.tags.querySelector("[data-tag-toggle='project']")?.getAttribute("aria-expanded"), "true");
			assert.equal(h.reads(), 0);
			h.view.toggleSidebar();
			Object.assign(h.view, { libraryTagFacets: [{ key: "project/child", label: "Project/Child", count: 7 }] });
			h.snapshot.displayByKey.set("project/child", "PROJECT/CHILD");
			h.view.toggleSidebar();
			assert.equal(h.tags.querySelector("[data-tag-key='project/child'] .knomo-tag-name")?.textContent, "CHILD");
			assert.equal(h.tags.querySelector("[data-tag-key='project/child']")?.parentElement?.querySelector(".knomo-tag-count")?.textContent, "7");
			assert.equal(h.state.activeTagKey, "project/child");
			assert.equal(h.expanded.has("project"), true);
			h.releaseTags(); await Promise.resolve();
		} finally { h.close(); }
	});

	test(`${layout}: opening loads missing facets independently and merges reads while tags build`, async () => {
		const h = await fixture(layout);
		try {
			Object.assign(h.view, { libraryTagFacets: null, libraryIndexRevision: -1 }); h.snapshot.status = "building";
			h.view.toggleSidebar();
			assert.equal(h.tags.getAttribute("aria-busy"), "true");
			assert.ok(h.tags.querySelector(".knomo-muted-text"));
			assert.equal(h.reads(), 1);
			const opening = h.view.ensureSidebarIndexes();
			assert.equal(h.reads(), 1);
			h.releaseFacets(); await h.view.libraryIndexRequest;
			assert.equal(h.tags.querySelectorAll("[data-tag-key='project/child']").length, 1);
			h.snapshot.displayByKey.set("project/child", "PROJECT/CHILD");
			h.snapshot.revision++;
			h.snapshot.status = "ready";
			// 模拟分面完成或订阅先绘制了最新快照，等待完成不得再次替换节点。
			h.view.renderTags();
			const publishedTree = h.tags.firstElementChild;
			h.releaseTags(); await opening;
			assert.equal(h.tags.firstElementChild, publishedTree, "最新快照已经绘制时不补绘");
			assert.equal(h.tags.querySelector("[data-tag-key='project/child'] .knomo-tag-name")?.textContent, "CHILD");
			assert.equal(h.tags.hasAttribute("aria-busy"), false);
		} finally { h.close(); }
	});

	test(`${layout}: opening refreshes invalid facets while keeping existing data`, async () => {
		for (const invalidation of [{ libraryIndexRevision: -1 }, { libraryIndexCoverageKey: "obsolete" }]) {
			const h = await fixture(layout);
			try {
				Object.assign(h.view, invalidation);
				h.view.toggleSidebar();
				assert.equal(h.reads(), 1);
				assert.equal(h.tags.querySelectorAll("[data-tag-key='project/child']").length, 1);
				h.releaseFacets(); await h.view.libraryIndexRequest;
				assert.equal(h.tags.querySelector("[data-tag-key='project/child']")?.parentElement?.querySelector(".knomo-tag-count")?.textContent, "3");
				await h.view.ensureSidebarIndexes();
				assert.equal(h.reads(), 1);
			} finally { h.close(); }
		}
	});

	test(`${layout}: unchanged refresh preserves tag nodes and reacts to selection, counts and loading`, async () => {
		const h = await fixture(layout);
		try {
			h.view.toggleSidebar();
			const first = h.tags.firstElementChild;
			h.view.renderTags();
			assert.equal(h.tags.firstElementChild, first, "分页或 UI 刷新不能重建未变化的标签树");
			h.state.activeTagKey = null;
			h.view.renderTags();
			assert.equal(h.tags.querySelector("[data-tag-key='project/child']")?.getAttribute("aria-pressed"), "false");
			h.expanded.delete("project");
			h.view.renderTags();
			assert.equal(h.tags.querySelector("[data-tag-toggle='project']")?.getAttribute("aria-expanded"), "false");
			Object.assign(h.view, { libraryTagFacets: [{ key: "project/child", label: "Project/Child", count: 9 }], libraryIndexesUpdating: true });
			h.view.renderTags();
			assert.equal(h.tags.querySelector(".knomo-tag-count")?.textContent, "9");
			assert.equal(h.tags.getAttribute("aria-busy"), "true");
			Object.assign(h.view, { libraryIndexesUpdating: false });
			h.view.renderTags();
			assert.equal(h.tags.hasAttribute("aria-busy"), false);
		} finally { h.close(); }
	});

	test(`${layout}: statistics update values and loading without replacing metric nodes`, async () => {
		const h = await fixture(layout);
		try {
			h.renderStats();
			const metrics = Array.from(h.stats.querySelectorAll(".knomo-stat"));
			h.renderStats();
			metrics.forEach((metric, index) => assert.equal(h.stats.querySelectorAll(".knomo-stat")[index], metric));
			Object.assign(h.view, { librarySummary: { memoCount: 5, tagCount: 2, imageCount: 4, wordCount: 10 }, libraryIndexesUpdating: true });
			h.renderStats();
			assert.deepEqual(Array.from(h.stats.querySelectorAll(".knomo-stat-value"), node => node.textContent), ["5", "2", "4"]);
			assert.equal(h.stats.getAttribute("aria-busy"), "true");
			Object.assign(h.view, { libraryIndexesUpdating: false });
			h.renderStats();
			assert.equal(h.stats.hasAttribute("aria-busy"), false);
			metrics.forEach((metric, index) => assert.equal(h.stats.querySelectorAll(".knomo-stat")[index], metric));
		} finally { h.close(); }
	});
}

for (const layout of ["mobile", "desktop-narrow", "desktop-wide"] as const) {
	for (const action of ["close", "destroy"] as const) {
		test(`${layout}: late sidebar tag readiness does not repaint after ${action}`, async () => {
			const h = await fixture(layout);
			try {
				h.snapshot.status = "building";
				h.view.toggleSidebar();
				const pending = h.view.ensureSidebarIndexes();
				if (action === "close") h.view.toggleSidebar(); else h.view.trashViewClosed = true;
				h.tags.textContent = "retained";
				h.snapshot.revision++;
				h.releaseTags(); await pending;
				h.view.renderPublishedSidebarTags();
				assert.equal(h.tags.textContent, "retained");
			} finally { h.close(); }
		});
	}
}
