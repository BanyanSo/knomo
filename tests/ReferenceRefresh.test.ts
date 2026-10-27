import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import type { MemoViewItem } from "../src/types/memoView";
import { ensureObsidianStub } from "./helpers/obsidianStub";

test("metadata 刷新按已加载 Memo 数量线性查找，两个 surface 保持独立", async () => {
	const reads: number[] = [];
	for (const size of [10, 100]) {
		const h = await referenceHarness(Array.from({ length: size }, (_, index) => `plain ${index}`), 1);
		try {
			await h.warm();
			let idReads = 0;
			for (const memo of h.memos) {
				const id = memo.id;
				Object.defineProperty(memo, "id", { get: () => { idReads++; return id; } });
			}
			h.emit("metadata:changed", "Notes/Unrelated.md");
			await h.flush();
			reads.push(idReads);
			assert.equal(h.calls.length, 0);
		} finally { h.close(); }
	}
	console.log("Reference memo lookup reads", JSON.stringify({ sizes: [10, 100], reads }));
	assert.ok(reads[1] <= reads[0] * 12, "十倍卡片不应产生近百倍的 Memo 查找");
});

test("metadata 工作量测量经过生产事件、View 和 Markdown 渲染器", async () => {
	const measured: unknown[] = [];
	const counts: number[][] = [];
	for (const size of [10, 100]) {
		const contents = Array.from({ length: size }, (_, index) => index < size * 0.7 ? `plain ${index}`
			: index < size * 0.9 ? `link ${index} [[Target|alias]]` : `body ${index} [[Source#^block|来源别名]]`);
		const h = await referenceHarness(contents);
		try {
			await h.warm();
			const rows = [];
			for (const [name, paths] of [
				["unrelated", ["Notes/Unrelated.md"]],
				["target", ["Notes/Target.md"]],
				["source", ["Notes/Source.md"]],
				["burst", [...Array<string>(10).fill("Notes/Unrelated.md"), "Notes/Target.md", "Notes/Source.md"]],
			] as const) {
				h.reset();
				const children = h.targets.map(target => target.firstChild);
				for (const path of paths) h.emit("metadata:changed", path);
				await h.flush();
				rows.push({ name, renders: h.calls.length, loads: h.metrics.loads, unloads: h.metrics.unloads,
					replaced: h.targets.filter((target, index) => target.firstChild !== children[index]).length });
			}
			measured.push({ cardsPerSurface: size, views: 2, surfacesPerView: 2, rows });
			counts.push(rows.map(row => row.renders));
		} finally { h.close(); }
	}
	console.log("Reference refresh measurement", JSON.stringify(measured));
	assert.deepEqual(counts, [[0, 8, 4, 12], [0, 80, 40, 120]]);
});

test("关联 Wiki、Markdown 和来源引用按 Daily 上下文刷新，保留 alias、缺失目标和同名竞争", async () => {
	const wiki = "[[Notes/Target#Heading|Wiki 原样别名]]";
	const markdown = '[原样 alias](../Notes/Target%20(1).md#Heading "title")';
	const source = "body [[Source#^block|来源原样别名]]";
	const missing = "[[Missing#Heading|缺失别名]]";
	const h = await referenceHarness([wiki, markdown, source, missing, "[self](#Heading)", "[web](https://example.com)"], 1);
	h.resolutions.set("Notes/Target", "Notes/Target.md");
	h.resolutions.set("../Notes/Target (1).md", "Notes/Target (1).md");
	try {
		await h.warm();
		for (const [path, text] of [["Notes/Target.md", wiki], ["Notes/Target (1).md", markdown],
			["Notes/Source.md", "来源原样别名"], ["Other/Target.md", wiki]]) {
			h.reset(); h.emit("metadata:changed", path); await h.flush();
			assert.equal(h.calls.length, 4, "关联目标两次，unresolved 保守刷新两次");
			assert.equal(h.calls.filter(call => call.text.includes(text)).length, 2);
			assert.ok(h.calls.every(call => call.path === "Daily/2026-10-19.md"));
		}
		h.resolutions.set("Missing", "Notes/Missing.md");
		h.reset(); h.emit("metadata:changed", "Notes/Missing.md"); await h.flush();
		assert.deepEqual(h.calls.map(call => call.text), [missing, missing]);
		h.reset(); h.emit("metadata:changed", "Notes/Unrelated.md"); await h.flush();
		assert.equal(h.calls.length, 0);
		h.reset(); h.emit("metadata:changed", "Daily/2026-10-19.md"); await h.flush();
		assert.equal(h.calls.length, h.targets.length, "源上下文变化仍刷新包括页内锚点在内的全部目标");
		assert.ok(h.resolutionInputs.every(input => input.source === "Daily/2026-10-19.md"));
	} finally { h.close(); }
});

test("来源引用刷新只替换内容，保留来源图标和外层容器", async () => {
	const h = await referenceHarness(["body [[Source#^block|来源别名]]"], 1);
	try {
		await h.warm();
		const contents = h.targets.filter(target => target.classList.contains("knomo-source-reference-content"));
		assert.equal(contents.length, 2);
		const shells = contents.map(content => ({ parent: content.parentElement!, icon: content.previousElementSibling, child: content.firstChild }));
		h.emit("metadata:changed", "Notes/Source.md"); await h.flush();
		assert.equal(h.calls.length, 2);
		for (const [index, content] of contents.entries()) {
			assert.equal(content.parentElement, shells[index].parent);
			assert.equal(content.previousElementSibling, shells[index].icon);
			assert.ok(shells[index].icon?.isConnected);
			assert.notEqual(content.firstChild, shells[index].child);
			assert.ok(content.textContent?.includes("来源别名"));
		}
	} finally { h.close(); }
});

test("嵌入的传递依赖、代码、HTML、未知链接语法和坏编码保留保守刷新", async () => {
	const values = ["![[Target]]", "![[Parent#Heading]]", "![alt](../Notes/Target.png)",
		"```dataview\nLIST\n```", "<span>host processor</span>", "[label][definition]\n\n[definition]: Target",
		"[broken](bad%ZZ.md)", "$host math$", "unrecognized [value]"];
	const h = await referenceHarness(values, 1);
	try {
		await h.warm(); h.emit("metadata:changed", "Notes/Nested-Child.md"); await h.flush();
		assert.equal(h.calls.length, values.length * 2);
		for (const value of values) assert.equal(h.calls.filter(call => call.text === value).length, 2);
	} finally { h.close(); }
});

test("重命名、文件及文件夹删除、未知事件保留全量刷新", async () => {
	const h = await referenceHarness(["plain", "[[Target|alias]]", "body [[Source#^id|source alias]]"], 1);
	try {
		await h.warm();
		for (const [event, path, oldPath] of [
			["vault:rename", "Notes/New.md", "Notes/Target.md"],
			["vault:rename", "Moved", "Notes"],
			["vault:delete", "Notes/Target.md", undefined],
			["vault:delete", "Notes", undefined],
			["metadata:changed", undefined, undefined],
		] as const) {
			h.reset(); h.emit(event, path, oldPath); await h.flush();
			assert.equal(h.calls.length, h.targets.length);
		}
	} finally { h.close(); }
});

test("宿主失败和尚未完成的渲染继续接收 metadata 刷新，成功后才跳过无关事件", async () => {
	const h = await referenceHarness(["plain", "body [[Source#^id|alias]]"], 1);
	let release = () => {};
	try {
		await h.warm();
		h.setRenderHook(async () => { throw new Error("host failed"); });
		h.emit("vault:rename", "Other.md", "Old.md"); await h.flush();
		h.setRenderHook(async () => {});
		h.reset(); h.emit("metadata:changed", "Notes/Unrelated.md"); await h.flush();
		assert.equal(h.calls.length, h.targets.length, "正文及仍保留旧组件的来源行都须可重试");
		h.reset(); h.emit("metadata:changed", "Notes/Unrelated.md"); await h.flush();
		assert.equal(h.calls.length, 0);
		const gate = new Promise<void>(resolve => { release = resolve; });
		h.setRenderHook(() => gate);
		h.reset(); h.emit("vault:rename", "Other.md", "Old.md"); await h.flush();
		assert.equal(h.calls.length, h.targets.length);
		h.emit("metadata:changed", "Notes/Unrelated.md"); await h.flush();
		release(); await h.flush();
		assert.equal(h.calls.length, h.targets.length * 2, "active 保留，最新 pending 在 active 完成后运行");
	} finally { release(); await h.flush(); h.close(); }
});

test("输入变化、clear、多 View 关闭和 unload 不被无关路径跳过或遗留调度", async () => {
	const h = await referenceHarness(["plain", "[[Target]]"]);
	try {
		await h.warm();
		h.memos[0].contentSnapshot = "new input";
		h.emit("metadata:changed", "Notes/Unrelated.md"); await h.flush();
		assert.equal(h.calls.length, 4, "已显示输入变化时两 View 两表面都须重新渲染");
		h.renderers[0].clear(); h.renderers[0].clear("mobile-search");
		h.reset(); h.emit("metadata:changed", "Notes/Unrelated.md"); await h.flush();
		assert.equal(h.calls.length, 4, "clear 后没有可跳过的已完成渲染");
		h.views[0].trashViewClosed = true;
		h.reset(); h.emit("metadata:changed", "Notes/Target.md"); await h.flush();
		assert.equal(h.calls.length, 2, "仅剩余 View 的两个表面更新");
		h.reset(); h.emit("metadata:changed", "Notes/Target.md");
		const staleTimers = [...h.timers.values()];
		h.close(); assert.equal(h.timers.size, 0);
		for (const callback of staleTimers) callback();
		await h.flush(); assert.equal(h.calls.length, 0);
	} finally { h.close(); }
});

test("相同 Markdown 在搜索版本或渲染代次变化后仍更新，不沿用旧的完成标记", async () => {
	const h = await referenceHarness(["plain"], 1);
	try {
		await h.warm();
		h.bumpSearchVersion();
		h.emit("metadata:changed", "Notes/Unrelated.md"); await h.flush();
		assert.equal(h.calls.length, 2, "搜索版本变化后须在两个表面更新");
		h.reset(); h.advanceGeneration();
		h.emit("metadata:changed", "Notes/Unrelated.md"); await h.flush();
		assert.equal(h.calls.length, 2, "新代次保留容器时也不能使用旧完成标记");
	} finally { h.close(); }
});

test("渲染期间到达的 metadata 路径归入下一批，不丢失或混入上一批", async () => {
	const h = await referenceHarness(["[[Target]]", "[[Other]]"], 1);
	h.resolutions.set("Other", "Notes/Other.md");
	try {
		await h.warm();
		let sent = false;
		h.setRenderHook(async () => { if (!sent) { sent = true; h.emit("metadata:changed", "Notes/Other.md"); } });
		h.emit("metadata:changed", "Notes/Target.md"); await h.flush();
		assert.deepEqual(h.calls.map(call => call.text), ["[[Target]]", "[[Target]]"]);
		assert.equal(h.timers.size, 1);
		h.reset(); await h.flush();
		assert.deepEqual(h.calls.map(call => call.text), ["[[Other]]", "[[Other]]"]);
	} finally { h.close(); }
});

test("两个 surface 的不同 occurrence 由生产查找和渲染链分别刷新，移动结果不依赖普通数组", async () => {
	const h = await referenceHarness(["ordinary [[Target|normal]]"], 1, ["mobile [[Target|search]]"]);
	try {
		await h.warm();
		h.emit("metadata:changed", "Notes/Target.md"); await h.flush();
		assert.deepEqual(h.calls.map(call => [call.text, call.path]), [
			["ordinary [[Target|normal]]", "Daily/2026-10-19.md"],
			["mobile [[Target|search]]", "Daily/2026-10-20.md"],
		]);
		assert.equal(h.views[0].memos.length, 1);
		assert.equal(h.views[0].memos[0].id, "0");
	} finally { h.close(); }
});

async function referenceHarness(contents: readonly string[], viewCount = 2, mobileContents: readonly string[] = contents) {
	await ensureObsidianStub();
	const { MarkdownRenderer, TFile } = await import("obsidian");
	const { default: KnomoPlugin } = await import("../src/main");
	const { KnomoView } = await import("../src/ui/KnomoView");
	const { MemoMarkdownRenderer } = await import("../src/ui/MemoMarkdownRenderer");
	const { getMemoDisplayContent, getMemoSourceReferenceMeta } = await import("../src/ui/KnomoCardMetadata");
	const originalRender = MarkdownRenderer.render;
	const calls: { text: string; path: string }[] = [];
	const metrics = { loads: 0, unloads: 0 };
	const resolutions = new Map<string, string>([["Target", "Notes/Target.md"], ["Source", "Notes/Source.md"]]);
	const resolutionInputs: { path: string; source: string }[] = [];
	const metadataCache = { getFirstLinkpathDest: (path: string, source: string) => {
		resolutionInputs.push({ path, source });
		const target = resolutions.get(path);
		return target === undefined ? null : Object.assign(new TFile(), { path: target });
	} };
	const timers = new Map<number, () => void>();
	let nextTimer = 0;
	const listeners = new Map<string, (file?: { path: string }, oldPath?: string) => void>();
	const cleanups: Array<() => void> = [];
	const views: Array<{ refreshReferences(paths?: readonly string[]): Promise<void>; trashViewClosed: boolean;
		cardFlowCoordinator: { generation: number }; memos: MemoViewItem[];
		mobileSearchController: { generation: number; results: HTMLElement; getDisplayedMemos(): readonly MemoViewItem[] } }> = [];
	let generation = 1, searchVersion = 1;
	const renderers: InstanceType<typeof MemoMarkdownRenderer>[] = [];
	const doms: JSDOM[] = [];
	const targets: HTMLElement[] = [];
	const memos: MemoViewItem[] = contents.map((contentSnapshot, index) => ({ id: String(index), contentSnapshot,
		createdAt: "2026-10-19T09:00", updatedAt: "2026-10-19T09:00", contentHash: String(index), status: "active",
		tags: [], links: [], images: [], dailyRef: { path: "Daily/2026-10-19.md", heading: "Memos", lineNumberHint: index + 1 } }));
	const mobileMemos = mobileContents === contents ? memos : mobileContents.map((contentSnapshot, index) => ({
		...memos[index], id: "mobile-" + index, contentSnapshot, dailyRef: { ...memos[index].dailyRef, path: "Daily/2026-10-20.md" },
	}));
	const app = {
		metadataCache: { ...metadataCache, on: (name: string, callback: (file?: { path: string }) => void) => {
			listeners.set(`metadata:${name}`, callback); return name;
		} },
		vault: { on: (name: string, callback: (file?: { path: string }, oldPath?: string) => void) => {
			listeners.set(`vault:${name}`, callback); return name;
		} },
		workspace: { containerEl: { win: {
			setTimeout: (callback: () => void) => { timers.set(++nextTimer, callback); return nextTimer; },
			clearTimeout: (id: number) => { timers.delete(id); },
		} }, getLeavesOfType: () => views.map(view => ({ view })) },
	};
	let renderHook: (text: string) => Promise<void> = async () => {};
	MarkdownRenderer.render = async (_app, text, target, path) => {
		calls.push({ text, path });
		target.createEl("p", { text });
		await renderHook(text);
	};
	for (let index = 0; index < viewCount; index++) {
		const dom = new JSDOM("<body><main></main><aside></aside></body>");
		doms.push(dom);
		installDomMethods(dom);
		const doc = dom.window.document;
		const renderer = new MemoMarkdownRenderer({ app: app as never, getDocument: () => doc,
			getGeneration: () => generation, getSearchVersion: () => searchVersion, concurrency: 4, createComponent: () => ({
				load: () => { metrics.loads++; }, unload: () => { metrics.unloads++; },
			}) as never });
		renderers.push(renderer);
		const [flow, search] = [doc.querySelector<HTMLElement>("main")!, doc.querySelector<HTMLElement>("aside")!];
		for (const root of [flow, search]) {
			for (const memo of root === search ? mobileMemos : memos) {
				const card = doc.createElement("div");
				card.className = "knomo-card"; card.setAttribute("data-memo-id", memo.id); root.appendChild(card);
				const body = doc.createElement("div"); body.className = "knomo-card-content"; card.appendChild(body); targets.push(body);
				if (getMemoSourceReferenceMeta(memo).type !== "none") {
					const source = doc.createElement("div"); source.className = "knomo-source-reference"; card.appendChild(source);
					const icon = doc.createElement("span"); icon.className = "knomo-reference-icon"; source.appendChild(icon);
					const content = doc.createElement("div"); content.className = "knomo-source-reference-content"; source.appendChild(content); targets.push(content);
				}
			}
		}
		const view = Object.create(KnomoView.prototype);
		Object.assign(view, { app, trashViewClosed: false, cardFlowEl: flow, cardFlowCoordinator: { generation: 1 },
			memos, mobileSearchController: { results: search, generation: 1, getDisplayedMemos: () => mobileMemos }, memoMarkdownRenderer: renderer,
			catalogTodayTimeBuoys: null, randomReunionController: { getSnapshot: () => ({ memos: [] }) },
			shuffleDayController: { getSnapshot: () => ({ memos: [] }) }, timeBuoyViewController: { getMemos: () => [] },
			trashMemoController: { getSnapshot: () => ({ trashMemos: [] }) },
			getMemoCardPreview: (memo: MemoViewItem) => ({ text: getMemoDisplayContent(memo) }),
			refresh: () => assert.fail("metadata 不得触发列表重查"),
		});
		views.push(view);
	}
	const plugin = Object.create(KnomoPlugin.prototype);
	Object.assign(plugin, { app, register: (cleanup: () => void) => cleanups.push(cleanup), registerEvent: () => {} });
	plugin.registerReferenceEvents();
	const flush = async () => {
		for (const [id, callback] of [...timers]) { timers.delete(id); callback(); }
		await new Promise<void>(resolve => setImmediate(resolve));
	};
	const reset = () => { calls.length = 0; metrics.loads = 0; metrics.unloads = 0; };
	let closed = false;
	return { calls, metrics, views, memos, targets, resolutions, resolutionInputs, timers, renderers, reset, flush,
		bumpSearchVersion: () => { searchVersion++; },
		advanceGeneration: () => {
			generation++;
			for (const view of views) { view.cardFlowCoordinator.generation = generation; view.mobileSearchController.generation = generation; }
		},
		setRenderHook: (hook: (text: string) => Promise<void>) => { renderHook = hook; },
		emit: (event: string, path?: string, oldPath?: string) => listeners.get(event)!(path === undefined ? undefined : { path }, oldPath),
		warm: async () => {
			await Promise.all(views.map(view => view.refreshReferences())); await flush();
			assert.equal(calls.length, targets.length); assert.equal(metrics.unloads, 0, "首轮宿主渲染应全部被采用");
			assert.ok(targets.every(target => target.childNodes.length > 0)); reset();
		},
		close: () => {
			if (closed) return;
			closed = true;
			for (const cleanup of cleanups) cleanup();
			for (const renderer of renderers) { renderer.clear(); renderer.clear("mobile-search"); }
			MarkdownRenderer.render = originalRender;
			for (const dom of doms) dom.window.close();
		},
	};
}

function installDomMethods(dom: JSDOM): void {
	const win = dom.window;
	Object.defineProperty(win.document, "win", { value: win });
	Object.assign(win, { createFragment: () => win.document.createDocumentFragment() });
	const createEl = function(this: Node, tag: string, options: { cls?: string; text?: string; attr?: Record<string, string> } = {}) {
		const element = this.ownerDocument!.createElement(tag);
		if (options.cls) element.className = options.cls;
		if (options.text) element.textContent = options.text;
		for (const [name, value] of Object.entries(options.attr ?? {})) element.setAttribute(name, value);
		this.appendChild(element); return element;
	};
	Object.assign(win.Node.prototype, { createEl });
	Object.assign(win.HTMLElement.prototype, {
		findAll(this: HTMLElement, selector: string) { return Array.from(this.querySelectorAll(selector)); },
		createDiv(this: HTMLElement) { return createEl.call(this, "div"); },
		createSpan(this: HTMLElement, options: { text?: string } = {}) { return createEl.call(this, "span", options); },
		detach(this: HTMLElement) { this.remove(); },
		empty(this: HTMLElement) { this.replaceChildren(); },
		setText(this: HTMLElement, value: string) { this.textContent = value; },
		setAttr(this: HTMLElement, name: string, value: string) { this.setAttribute(name, value); },
	});
}
