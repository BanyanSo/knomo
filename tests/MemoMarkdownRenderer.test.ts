import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";

import type { MemoViewItem } from "../src/types/memoView";
import { ensureObsidianStub } from "./helpers/obsidianStub";
import { composerMarkdownFixtures } from "./fixtures/composerMarkdown";

test("复用未变卡片时，迟到的 Markdown 将任务绑定到已确认的新句柄", async () => {
	await ensureObsidianStub();
	const { MarkdownRenderer } = await import("obsidian");
	const { MemoMarkdownRenderer } = await import("../src/ui/MemoMarkdownRenderer");
	setDomGlobals();
	const original = MarkdownRenderer.render;
	const gate = deferred<void>();
	let started = false;
	MarkdownRenderer.render = async (_app, _markdown, target) => {
		target.createEl("li", { cls: "task-list-item", attr: { "data-task": " " } }).createEl("input", { attr: { type: "checkbox" } });
		started = true;
		await gate.promise;
	};
	const renderer = new MemoMarkdownRenderer({ app: {} as never, createComponent: () => new TestComponent() as never,
		getDocument: () => ({} as Document), getGeneration: () => 0, concurrency: 1 });
	const memo = makeMemo({ id: "original", contentSnapshot: "- [ ] task" });
	const content = new TestElement("div");
	try {
		renderer.queueMemoMarkdown(memo, content.asHtml(), 0, "normal", memo.contentSnapshot, "card-flow");
		await waitFor(() => started);
		renderer.retainCard({ querySelectorAll: () => [content.asHtml()] } as unknown as HTMLElement, { ...memo, id: "current" });
		renderer.queueMemoMarkdown({ ...memo, id: "stale" }, content.asHtml(), -1, "normal", memo.contentSnapshot, "card-flow");
		gate.resolve();
		await waitFor(() => content.findAll("input").some(input => input.getAttr("data-knomo-memo-id") === "current"));
		assert.equal(memo.id, "original");
	} finally { gate.resolve(); renderer.clear(); MarkdownRenderer.render = original; }
});

test("both Card surfaces pass literal Markdown and Daily sourcePath to the host", async () => {
	await ensureObsidianStub();
	const { MarkdownRenderer } = await import("obsidian");
	const { MemoMarkdownRenderer } = await import("../src/ui/MemoMarkdownRenderer");
	setDomGlobals();
	const original = MarkdownRenderer.render;
	const calls: { markdown: string; path: string }[] = [];
	MarkdownRenderer.render = async (_app, markdown, _container, path) => { calls.push({ markdown, path }); };
	const renderer = new MemoMarkdownRenderer({ app: {} as never, createComponent: () => new TestComponent() as never,
		getDocument: () => ({ createElement: (tag: string) => new TestElement(tag).asHtml() }) as Document, getGeneration: () => 0, concurrency: 1 });
	try {
		const values = ["第一行\n第二行\n第三行", "第一段\n\n第二段", "空格硬换行  \n反斜杠硬换行\\\n最后一行", "**粗体** [[内部链接]] #标签\n继续正文",
			"[[Target#^anchor|自定义来源]] [相对来源](../Folder/Target%20(1).md#%5Eanchor \"title\") [[Target#Heading]]",
			"[[Folder/Target|同名文件一]] [[Other/Target|同名文件二]] ![[Target]] [broken](bad%ZZ.md)",
			...composerMarkdownFixtures.map(f => f.text)];
		for (const surface of ["card-flow", "mobile-search"] as const) {
			for (const markdown of values) {
				const count = calls.length;
				renderer.queueMemoMarkdown(makeMemo({ contentSnapshot: markdown }), new TestElement("div").asHtml(), 0, "normal", markdown, surface);
				await waitFor(() => calls.length > count);
				assert.deepEqual(calls[count], { markdown, path: "Daily/2026-06-02.md" });
			}
		}
	} finally { renderer.clear(); MarkdownRenderer.render = original; }
});

test("按待恢复视口优先渲染深处正文，实际滚动后切换优先目标", async () => {
	await ensureObsidianStub();
	const { MarkdownRenderer } = await import("obsidian");
	const { MemoMarkdownRenderer } = await import("../src/ui/MemoMarkdownRenderer");
	setDomGlobals();
	const original = MarkdownRenderer.render;
	const calls: string[] = [];
	const frames = new Map<number, () => void>();
	let id = 0, scrollTop = 0;
	const targets = Array.from({ length: 300 }, (_, index) => Object.assign(new TestElement("div").asHtml(), {
		getBoundingClientRect: () => ({ top: 100 + index * 100 - scrollTop, bottom: 200 + index * 100 - scrollTop }),
	}));
	const root = {
		get scrollTop() { return scrollTop; },
		getBoundingClientRect: () => ({ top: 100, bottom: 500 }),
		contains: (target: HTMLElement) => targets.includes(target),
	} as HTMLElement;
	MarkdownRenderer.render = async (_app, markdown) => { calls.push(markdown); };
	const renderer = new MemoMarkdownRenderer({
		app: {} as never, createComponent: () => new TestComponent() as never,
		getDocument: () => ({} as Document), getGeneration: () => 0, concurrency: 1,
		scheduleTask: callback => { frames.set(++id, callback); return id; },
		cancelTask: frame => { frames.delete(frame); },
	});
	const frame = async () => {
		const [frameId, callback] = [...frames][0]; frames.delete(frameId); callback();
		for (let tick = 0; tick < 6; tick++) await Promise.resolve();
	};
	try {
		targets.forEach((target, index) => renderer.queueMemoMarkdown(makeMemo(), target, 0,
			index < 12 ? "high" : "normal", String(index), "mobile-search"));
		renderer.prioritizeVisible("mobile-search", root, 24000);
		await frame();
		assert.deepEqual(calls, ["240"]);
		scrollTop = 15000;
		renderer.prioritizeVisible("mobile-search", root);
		await frame();
		assert.deepEqual(calls, ["240", "150"]);
	} finally { renderer.clear("mobile-search"); MarkdownRenderer.render = original; }
});

test("来源引用在移动端排队前可见，两种卡片表面等待宿主时不清空来源行", async () => {
	await ensureObsidianStub();
	const { MarkdownRenderer } = await import("obsidian");
	const { MemoMarkdownRenderer } = await import("../src/ui/MemoMarkdownRenderer");
	const original = MarkdownRenderer.render;
	const frames = new Map<number, () => void>();
	const calls: { text: string; path: string }[] = [];
	let frameId = 0;
	let gate = deferred<void>();
	MarkdownRenderer.render = async (_app, text, target, path) => {
		calls.push({ text, path });
		const paragraph = target.createEl("p");
		paragraph.createSpan({ text: "引用自：" });
		paragraph.createEl("a", { cls: "internal-link", text: "自定义来源", attr: { "data-href": "../旧记录.md#^block-a" } });
		await gate.promise;
	};
	const renderer = new MemoMarkdownRenderer({
		app: {} as never, createComponent: () => new TestComponent() as never,
		getDocument: () => ({} as Document), getGeneration: () => 0, concurrency: 1,
		scheduleTask: callback => { frames.set(++frameId, callback); return frameId; },
		cancelTask: id => { frames.delete(id); },
	});
	try {
		for (const surface of ["card-flow", "mobile-search"] as const) {
			gate = deferred<void>();
			const target = new TestElement("div");
			const text = "引用自：[自定义来源](../旧记录.md#^block-a)";
			const path = "Daily/2026-10-07.md";
			const count = calls.length;
			renderer.queueSourceReferenceMarkdown(target.asHtml(), text, path, 0, surface);
			assert.equal(target.getText(), "引用自：自定义来源", "首帧已有可读来源，不能等待下一帧或宿主完成");
			assert.equal(calls.length, count);
			const placeholder = target.firstChild;
			const [id, callback] = [...frames][0]; frames.delete(id); callback();
			await waitFor(() => calls.length === count + 1);
			assert.equal(target.firstChild, placeholder, "宿主离屏渲染期间保留来源行");
			assert.deepEqual(calls[count], { text, path });
			gate.resolve();
			await waitFor(() => target.firstChild !== placeholder);
			assert.equal(target.getText(), "引用自：自定义来源");
			const link = target.findAll("a.internal-link")[0];
			assert.equal(link.getAttr("data-href"), "../旧记录.md#^block-a");
			assert.equal(link.getAttr("data-knomo-source-path"), path);
		}
	} finally {
		gate.resolve(); renderer.clear(); renderer.clear("mobile-search");
		MarkdownRenderer.render = original;
	}
});

test("来源引用首帧保留 Wiki alias 和长别名，旧代次不得改写当前显示", async () => {
	await ensureObsidianStub();
	const { MemoMarkdownRenderer } = await import("../src/ui/MemoMarkdownRenderer");
	const frames = new Map<number, () => void>();
	let frameId = 0;
	const renderer = new MemoMarkdownRenderer({
		app: {} as never, createComponent: () => new TestComponent() as never,
		getDocument: () => ({} as Document), getGeneration: () => 1, concurrency: 1,
		scheduleTask: callback => { frames.set(++frameId, callback); return frameId; },
		cancelTask: id => { frames.delete(id); },
	});
	try {
		for (const alias of ["20241006-160339", "自定义中文来源与 English alias ".repeat(12), "<img src=x onerror=alert(1)>"]) {
			const target = new TestElement("div");
			renderer.queueSourceReferenceMarkdown(target.asHtml(), "引用自：[[Daily/旧记录#^block-a|" + alias + "]]", "Daily/今天.md", 1, "card-flow");
			assert.equal(target.getText(), "引用自：" + alias);
			assert.equal(target.findAll("img").length, 0);
		}
		const current = new TestElement("div");
		current.createEl("p", { text: "已显示的来源" });
		const original = current.firstChild;
		renderer.queueSourceReferenceMarkdown(current.asHtml(), "引用自：[[Old#^block|旧来源]]", "Daily.md", 0, "card-flow");
		assert.equal(current.firstChild, original);
		assert.equal(current.getText(), "已显示的来源");
	} finally { renderer.clear(); renderer.clear("mobile-search"); }
});

test("来源渲染失败保留可读 alias，刷新失败也保留已显示来源及其组件", async () => {
	await ensureObsidianStub();
	const { MarkdownRenderer } = await import("obsidian");
	const { MemoMarkdownRenderer } = await import("../src/ui/MemoMarkdownRenderer");
	const original = MarkdownRenderer.render;
	let fail = true;
	const components: TestComponent[] = [];
	MarkdownRenderer.render = async (_app, _text, target) => {
		if (fail) throw new Error("render failed");
		target.createEl("p", { text: "引用自：自定义来源" });
	};
	const renderer = new MemoMarkdownRenderer({
		app: {} as never, getDocument: () => ({} as Document), getGeneration: () => 0, concurrency: 1,
		createComponent: () => { const component = new TestComponent(); components.push(component); return component as never; },
	});
	try {
		const text = "引用自：[[Daily/来源#^block-a|自定义来源]]";
		const first = new TestElement("div");
		renderer.queueSourceReferenceMarkdown(first.asHtml(), text, "Daily/今天.md", 0, "card-flow");
		await waitFor(() => components[0].unloadCalls === 1);
		assert.equal(first.getText(), "引用自：自定义来源", "失败不能重新显示原始 Wiki 语法并改变来源行尺寸");
		fail = false;
		const ready = new TestElement("div");
		renderer.queueSourceReferenceMarkdown(ready.asHtml(), text, "Daily/今天.md", 0, "card-flow");
		await waitFor(() => components.length === 2 && ready.firstChild?.getAttr("inert") === null);
		const previous = ready.firstChild;
		fail = true;
		renderer.queueSourceReferenceMarkdown(ready.asHtml(), text, "Daily/今天.md", 0, "card-flow");
		await waitFor(() => components.length === 3 && components[2].unloadCalls === 1);
		assert.equal(ready.firstChild, previous);
		assert.equal(components[1].unloadCalls, 0, "保留的宿主 DOM 仍由原组件管理");
	} finally {
		renderer.clear(); renderer.clear("mobile-search"); MarkdownRenderer.render = original;
	}
	assert.equal(components[1].unloadCalls, 1);
});

test("post-processes memo markdown DOM metadata", async () => {
	await ensureObsidianStub();
	const { prepareRenderedMemoMarkdown, applyTaskCheckboxDomState } = await import("../src/ui/MemoMarkdownRenderer");
	setDomGlobals();
	const container = new TestElement("div");
	container.addClass("knomo-card-content");
	const link = container.createEl("a", {
		cls: "internal-link",
		attr: { href: "Project" },
	});
	const tag = container.createSpan({ cls: "tag", text: "#Project/Knomo" });
	const image = container.createEl("img");
	const taskItem = container.createEl("li", { cls: "task-list-item", attr: { "data-task": " " } });
	const checkbox = taskItem.createEl("input", { attr: { type: "checkbox" } });
	checkbox.disabled = true;

	prepareRenderedMemoMarkdown(container.asHtml(), makeMemo({ contentSnapshot: "- [ ] task" }));

	assert.equal(link.getAttr("data-knomo-source-path"), "Daily/2026-06-02.md");
	assert.equal(image.getAttr("loading"), "lazy");
	assert.equal(tag.getAttr("data-tag"), "Project/Knomo");
	assert.equal(tag.getAttr("data-tag-key"), "project/knomo");
	assert.equal(checkbox.hasClass("knomo-task-checkbox"), true);
	assert.equal(checkbox.getAttr("data-knomo-memo-id"), "memo-1");
	assert.equal(checkbox.getAttr("data-knomo-task-index"), "0");
	assert.equal(taskItem.getAttr("data-knomo-task-index"), "0");
	assert.equal(checkbox.disabled, false);

	applyTaskCheckboxDomState(checkbox.asInput(), "-");

	assert.equal(checkbox.checked, true);
	assert.equal(checkbox.indeterminate, true);
	assert.equal(checkbox.getAttr("data-task"), "-");
	assert.equal(taskItem.getAttr("data-task"), "-");
});

test("未完成任务兼容宿主空 data-task，并保留缺失和不匹配标记的保护", async () => {
	await ensureObsidianStub();
	const { prepareRenderedTaskCheckboxes } = await import("../src/ui/MemoMarkdownRenderer");
	setDomGlobals();
	for (const [source, marker, enabled] of [
		[" ", "", true], [" ", " ", true], ["x", "x", true], ["X", "x", true],
		["-", "-", true], [" ", null, false], ["x", "", false], [" ", "x", false],
	] as const) {
		const container = new TestElement("div");
		const item = container.createEl("li", { cls: "task-list-item", attr: marker === null ? {} : { "data-task": marker } });
		const input = item.createEl("input", { attr: { type: "checkbox" } });
		prepareRenderedTaskCheckboxes(container.asHtml(), makeMemo({ contentSnapshot: `- [${source}] task` }));
		assert.equal(input.disabled, !enabled, JSON.stringify([source, marker]));
		assert.equal(input.getAttr("data-knomo-task-index"), enabled ? "0" : null);
	}
});

test("recognizes delegated task checkbox inputs", async () => {
	await ensureObsidianStub();
	const { MemoMarkdownRenderer } = await import("../src/ui/MemoMarkdownRenderer");
	setDomGlobals();
	const renderer = new MemoMarkdownRenderer({
		app: {} as never,
		createComponent: () => new TestComponent() as never,
		getDocument: () => ({ createElement: (tagName: string) => new TestElement(tagName).asHtml() }) as Document,
		getGeneration: () => 0,
		concurrency: 1,
	});
	const content = new TestElement("div");
	content.addClass("knomo-card-content");
	const input = content.createEl("input", {
		attr: {
			type: "checkbox",
			"data-knomo-task-index": "2",
		},
	});
	const outside = new TestElement("input", {
		attr: {
			type: "checkbox",
			"data-knomo-task-index": "2",
		},
	});

	assert.equal(renderer.getTaskCheckboxInput(input.asHtml()), input.asInput());
	assert.equal(renderer.getTaskCheckboxIndex(input.asInput()), 2);
	assert.equal(renderer.getTaskCheckboxInput(outside.asHtml()), null);
});

test("共享任务映射跳过普通列表并在 DOM 结构不一致时禁止写入", async () => {
	await ensureObsidianStub();
	const { prepareRenderedTaskCheckboxes } = await import("../src/ui/MemoMarkdownRenderer");
	setDomGlobals();
	const container = new TestElement("div");
	container.createEl("li");
	const item = container.createEl("li", { cls: "task-list-item", attr: { "data-task": "x" } });
	const input = item.createEl("input", { attr: { type: "checkbox" } });
	prepareRenderedTaskCheckboxes(container.asHtml(), makeMemo({ contentSnapshot: "- plain\n- [x] task\n\n```\n- [ ] fake\n```" }));
	assert.equal(input.disabled, false);
	assert.equal(input.getAttr("data-knomo-task-index"), "0");
	const mismatched = new TestElement("div");
	const raw = mismatched.createEl("li").createEl("input", { attr: { type: "checkbox" } });
	const valid = mismatched.createEl("li", { cls: "task-list-item", attr: { "data-task": " " } }).createEl("input", { attr: { type: "checkbox" } });
	prepareRenderedTaskCheckboxes(mismatched.asHtml(), makeMemo({ contentSnapshot: "- [ ] task" }));
	assert.equal(raw.disabled, true);
	assert.equal(valid.disabled, true);
	assert.equal(valid.getAttr("data-knomo-task-index"), null);
});

test("长任务列表一次解析并线性绑定，保留普通和嵌套列表位置", async t => {
	await ensureObsidianStub();
	const { parser } = await import("@lezer/markdown");
	const { prepareRenderedTaskCheckboxes } = await import("../src/ui/MemoMarkdownRenderer");
	setDomGlobals();
	const container = new TestElement("div");
	container.createEl("li");
	const inputs = Array.from({ length: 80 }, (_, index) => {
		const item = container.createEl("li", { cls: "task-list-item", attr: { "data-task": index % 2 ? "x" : " " } });
		return item.createEl("input", { attr: { type: "checkbox" } });
	});
	const parse = t.mock.method(parser, "parse");
	const closest = t.mock.method(TestElement.prototype, "closest");
	const contentSnapshot = ["- plain", ...inputs.map((_, index) => `${index % 2 ? "  " : ""}- [${index % 2 ? "X" : " "}] task ${index}`)].join("\r\n");
	prepareRenderedTaskCheckboxes(container.asHtml(), makeMemo({ contentSnapshot }));
	assert.deepEqual(inputs.map(input => input.getAttr("data-knomo-task-index")), inputs.map((_, index) => String(index)));
	assert.ok(inputs.every(input => !input.disabled));
	assert.equal(parse.mock.callCount(), 1, "同一正文只解析一次");
	assert.ok(closest.mock.callCount() <= inputs.length * 2, "不能逐任务重新扫描所有 checkbox");
});

test("原始任务 HTML 使整组复选框保持只读", async () => {
	await ensureObsidianStub();
	const { prepareRenderedTaskCheckboxes } = await import("../src/ui/MemoMarkdownRenderer");
	setDomGlobals();
	const container = new TestElement("div");
	const input = container.createEl("li", { cls: "task-list-item", attr: { "data-task": " " } })
		.createEl("input", { attr: { type: "checkbox" } });
	prepareRenderedTaskCheckboxes(container.asHtml(), makeMemo({ contentSnapshot: "- [ ] task\n\n<input type='checkbox'>" }));
	assert.equal(input.disabled, true);
	assert.equal(input.getAttr("data-knomo-task-index"), null);
});

test("owns one render component per container and unloads it when replaced or cleared", async () => {
	await ensureObsidianStub();
	const obsidian = await import("obsidian");
	const { MemoMarkdownRenderer } = await import("../src/ui/MemoMarkdownRenderer");
	setDomGlobals();
	const markdownRenderer = obsidian.MarkdownRenderer as unknown as {
		render: (
			app: unknown,
			markdown: string,
			container: HTMLElement,
			sourcePath: string,
			component: unknown,
		) => Promise<void>;
	};
	const originalRender = markdownRenderer.render;
	const components: TestComponent[] = [];
	markdownRenderer.render = async (_app, markdown, container) => {
		(container as unknown as TestElement).createSpan({ text: markdown });
	};

	try {
		const renderer = new MemoMarkdownRenderer({
			app: {} as never,
			createComponent: () => {
				const component = new TestComponent();
				components.push(component);
				return component as never;
			},
			getDocument: () => ({ createElement: (tagName: string) => new TestElement(tagName).asHtml() }) as Document,
			getGeneration: () => 0,
			concurrency: 1,
		});
		const container = new TestElement("div");

		renderer.queueMemoMarkdown(makeMemo(), container.asHtml(), 0, "normal", "first", "card-flow");
		await waitFor(() => components.length === 1 && container.getText().includes("first"));
		assert.equal(components[0].loadCalls, 1);
		assert.equal(components[0].unloadCalls, 0);

		renderer.queueMemoMarkdown(makeMemo(), container.asHtml(), 0, "normal", "second", "card-flow");
		await waitFor(() => components.length === 2 && container.getText().includes("second"));
		assert.equal(components[0].unloadCalls, 1);
		assert.equal(components[1].loadCalls, 1);
		assert.equal(components[1].unloadCalls, 0);

		renderer.clear("card-flow");
		assert.equal(components[1].unloadCalls, 1);
	} finally {
		markdownRenderer.render = originalRender;
	}
});

test("unloads an in-flight render component when its generation becomes stale", async () => {
	await ensureObsidianStub();
	const obsidian = await import("obsidian");
	const { MemoMarkdownRenderer } = await import("../src/ui/MemoMarkdownRenderer");
	setDomGlobals();
	const markdownRenderer = obsidian.MarkdownRenderer as unknown as {
		render: () => Promise<void>;
	};
	const originalRender = markdownRenderer.render;
	const renderGate = deferred<void>();
	const components: TestComponent[] = [];
	let generation = 0;
	markdownRenderer.render = () => renderGate.promise;

	try {
		const renderer = new MemoMarkdownRenderer({
			app: {} as never,
			createComponent: () => {
				const component = new TestComponent();
				components.push(component);
				return component as never;
			},
			getDocument: () => ({ createElement: (tagName: string) => new TestElement(tagName).asHtml() }) as Document,
			getGeneration: () => generation,
			concurrency: 1,
		});
		const container = new TestElement("div");

		renderer.queueMemoMarkdown(makeMemo(), container.asHtml(), 0, "normal", "pending", "card-flow");
		await waitFor(() => components.length === 1);
		generation = 1;
		renderer.clear("card-flow");
		renderGate.resolve();
		await waitFor(() => components[0].unloadCalls === 1);

		assert.equal(components[0].loadCalls, 1);
		assert.equal(container.getText(), "");
	} finally {
		markdownRenderer.render = originalRender;
	}
});

test("两个卡片表面保留运行中请求、最新 pending 和搜索版本的过期结果保护", async () => {
	await ensureObsidianStub();
	const { MarkdownRenderer } = await import("obsidian");
	const { MemoMarkdownRenderer } = await import("../src/ui/MemoMarkdownRenderer");
	setDomGlobals();
	const original = MarkdownRenderer.render;
	try {
		for (const surface of ["card-flow", "mobile-search"] as const) {
			const oldGate = deferred<void>(), latestGate = deferred<void>();
			const calls: string[] = [], components: TestComponent[] = [];
			let searchVersion = 1;
			MarkdownRenderer.render = async (_app, markdown, target) => {
				calls.push(markdown);
				(target as unknown as TestElement).createSpan({ text: markdown });
				if (markdown === "old") await oldGate.promise;
				if (markdown === "latest") await latestGate.promise;
			};
			const renderer = new MemoMarkdownRenderer({ app: {} as never,
				createComponent: () => { const component = new TestComponent(); components.push(component); return component as never; },
				getDocument: () => ({} as Document), getGeneration: () => 0, getSearchVersion: () => searchVersion, concurrency: 1 });
			const target = new TestElement("div", { text: "confirmed" });
			const queue = (text: string) => renderer.queueMemoMarkdown(makeMemo({ contentSnapshot: text }), target.asHtml(), 0, "normal", text, surface);
			try {
				queue("old"); queue("obsolete"); queue("latest");
				assert.deepEqual(calls, ["old"]);
				oldGate.resolve();
				await waitFor(() => calls.includes("latest"));
				assert.deepEqual(calls, ["old", "latest"]);
				assert.equal(target.getText(), "confirmed", "旧请求不得覆盖已确认正文");
				assert.equal(components[0].unloadCalls, 1);
				searchVersion++;
				latestGate.resolve();
				await waitFor(() => components[1].unloadCalls === 1);
				assert.equal(target.getText(), "confirmed", "旧搜索版本不得发布结果");
				queue("current");
				await waitFor(() => target.getText() === "current");
			} finally { oldGate.resolve(); latestGate.resolve(); renderer.clear(surface); }
		}
	} finally { MarkdownRenderer.render = original; }
});

function setDomGlobals(): void {
	(globalThis as unknown as { HTMLElement: typeof TestElement }).HTMLElement = TestElement;
}

interface CreateElementOptions {
	cls?: string;
	text?: string;
	attr?: Record<string, string>;
}

class TestElement {
	private children: TestElement[] = [];
	private readonly classes = new Set<string>();
	private readonly attrs = new Map<string, string>();
	private text = "";
	checked = false;
	disabled = false;
	indeterminate = false;
	type = "";

	constructor(
		readonly tagName: string,
		options: CreateElementOptions = {},
		private parent: TestElement | null = null,
	) {
		if (options.cls !== undefined) {
			for (const cls of options.cls.split(/\s+/)) {
				if (cls.length > 0) {
					this.addClass(cls);
				}
			}
		}
		if (options.text !== undefined) {
			this.setText(options.text);
		}
		for (const [key, value] of Object.entries(options.attr ?? {})) {
			this.setAttr(key, value);
		}
	}

	asHtml(): HTMLElement {
		return this as unknown as HTMLElement;
	}

	asInput(): HTMLInputElement {
		return this as unknown as HTMLInputElement;
	}

	get firstChild(): TestElement | null {
		return this.children[0] ?? null;
	}

	createSpan(options: CreateElementOptions = {}): TestElement {
		return this.createEl("span", options);
	}

	createDiv(options: CreateElementOptions = {}): TestElement {
		return this.createEl("div", options);
	}

	createEl(tagName: string, options: CreateElementOptions = {}): TestElement {
		const child = new TestElement(tagName.toUpperCase(), options, this);
		this.children.push(child);
		return child;
	}

	detach(): void {
		this.parent?.removeChild(this);
		this.parent = null;
	}

	appendChild(child: TestElement): TestElement {
		child.parent?.removeChild(child);
		child.parent = this;
		this.children.push(child);
		return child;
	}

	empty(): void {
		for (const child of this.children) {
			child.parent = null;
		}
		this.children = [];
		this.text = "";
	}

	querySelectorAll<T extends Element = Element>(selector: string): T[] {
		return this.findAll(selector) as unknown as T[];
	}

	findAll(selector: string): TestElement[] {
		const result: TestElement[] = [];
		for (const child of this.children) {
			child.collect(selector, result);
		}
		return result;
	}

	closest(selector: string): TestElement | null {
		let current: TestElement | null = this;
		while (current !== null) {
			if (current.matches(selector)) {
				return current;
			}
			current = current.parent;
		}
		return null;
	}

	instanceOf<T>(constructor: abstract new (...args: never[]) => T): this is T {
		return this instanceof constructor;
	}

	setText(value: string): void {
		this.text = value;
	}

	getText(): string {
		return this.text + this.children.map((child) => child.getText()).join("");
	}

	setAttr(key: string, value: string): void {
		this.attrs.set(key, value);
		if (key === "type") {
			this.type = value;
		}
	}

	getAttr(key: string): string | null {
		return this.attrs.get(key) ?? null;
	}

	addClass(cls: string): void {
		this.classes.add(cls);
	}

	hasClass(cls: string): boolean {
		return this.classes.has(cls);
	}

	private collect(selector: string, result: TestElement[]): void {
		if (this.matches(selector)) {
			result.push(this);
		}
		for (const child of this.children) {
			child.collect(selector, result);
		}
	}

	private removeChild(child: TestElement): void {
		this.children = this.children.filter((candidate) => candidate !== child);
	}

	private matches(selector: string): boolean {
		if (selector.startsWith(".")) {
			return this.classes.has(selector.slice(1));
		}
		const tagClassMatch = selector.match(/^([a-z]+)\.([a-z0-9-]+)$/i);
		if (tagClassMatch !== null) {
			return this.tagName === tagClassMatch[1].toUpperCase() && this.classes.has(tagClassMatch[2]);
		}
		const tagAttrMatch = selector.match(/^([a-z]+)\[([^=\]]+)='([^']*)'\]$/i);
		if (tagAttrMatch !== null) {
			return this.tagName === tagAttrMatch[1].toUpperCase() && this.attrs.get(tagAttrMatch[2]) === tagAttrMatch[3];
		}
		return this.tagName === selector.toUpperCase();
	}
}

class TestComponent {
	loadCalls = 0;
	unloadCalls = 0;

	load(): void {
		this.loadCalls += 1;
	}

	unload(): void {
		this.unloadCalls += 1;
	}
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((promiseResolve) => {
		resolve = promiseResolve;
	});
	return { promise, resolve };
}

async function waitFor(predicate: () => boolean): Promise<void> {
	for (let attempt = 0; attempt < 50; attempt += 1) {
		if (predicate()) {
			return;
		}
		await new Promise<void>((resolve) => setTimeout(resolve, 0));
	}
	assert.fail("Timed out waiting for asynchronous render");
}

function makeMemo(overrides: Partial<MemoViewItem> = {}): MemoViewItem {
	return {
		id: "memo-1",
		createdAt: "2026-06-02T00:00:00+08:00",
		updatedAt: "2026-06-02T00:00:00+08:00",
		contentSnapshot: "memo",
		contentHash: "hash",
		status: "active",
		tags: [],
		links: [],
		images: [],
		dailyRef: {
			path: "Daily/2026-06-02.md",
			heading: "Memos",
			sectionType: "heading",
			lineNumberHint: 1,
		},
		...overrides,
	};
}

async function renderCardLineBreaks(html: string): Promise<string> {
	await ensureObsidianStub();
	const { prepareRenderedMemoMarkdown } = await import("../src/ui/MemoMarkdownRenderer");
	const dom = new JSDOM(`<div>${html}</div>`);
	Object.defineProperty(dom.window.document, "win", { value: dom.window });
	Object.assign(dom.window, { createFragment: () => dom.window.document.createDocumentFragment() });
	Object.assign(dom.window.Node.prototype, {
		createEl(this: Node, tag: string) { return this.appendChild(this.ownerDocument!.createElement(tag)); },
	});
	try {
		const container = dom.window.document.querySelector("div")!;
		Object.assign(container, { findAll: (selector: string) => Array.from(container.querySelectorAll(selector)) });
		prepareRenderedMemoMarkdown(container, makeMemo());
		const result = container.innerHTML;
		prepareRenderedMemoMarkdown(container, makeMemo());
		assert.equal(container.innerHTML, result, "重复处理不能新增空行");
		return result;
	} finally { dom.window.close(); }
}

test("卡片普通软换行及行内格式之间的换行可见", async () => {
	assert.equal(await renderCardLineBreaks("<p>第一行\n第二行\n第三行</p>"), "<p>第一行<br>第二行<br>第三行</p>");
	assert.equal(await renderCardLineBreaks("<p><strong>粗体</strong>\n<a href='Note'>链接</a></p>"), '<p><strong>粗体</strong><br><a href="Note">链接</a></p>');
	assert.equal(await renderCardLineBreaks("<p><em>第一行\n第二行</em></p>"), "<p><em>第一行<br>第二行</em></p>");
});

test("已有硬换行不重复，段落间距不变", async () => {
	assert.equal(await renderCardLineBreaks("<p>第一行<br>\n第二行<br>第三行</p>\n<p>另一段</p>"), "<p>第一行<br>第二行<br>第三行</p>\n<p>另一段</p>");
});

test("列表正文保留换行，不转换嵌套块间空白", async () => {
	assert.equal(await renderCardLineBreaks("<ul>\n<li>第一行\n续行<ul>\n<li>子项</li>\n</ul>\n</li>\n</ul>"), "<ul>\n<li>第一行<br>续行<ul>\n<li>子项</li>\n</ul>\n</li>\n</ul>");
});

test("原生紧凑列表在嵌套块前的排版换行不额外生成 br", async () => {
	const native = "<ul>\n<li>first\ncontinuation\n<ul>\n<li>nested</li>\n</ul>\n</li>\n</ul>";
	assert.equal(await renderCardLineBreaks(native), "<ul>\n<li>first<br>continuation<ul>\n<li>nested</li>\n</ul>\n</li>\n</ul>");
});

test("引用及嵌套引用的软换行可见，已有硬换行和段落边界不重复", async () => {
	const quote = '<blockquote><p>first\n<strong>second</strong><br>\nthird</p>\n<p>next</p><blockquote><p>nested\ncontinued</p></blockquote></blockquote>';
	assert.equal(await renderCardLineBreaks(quote), '<blockquote><p>first<br><strong>second</strong><br>third</p>\n<p>next</p><blockquote><p>nested<br>continued</p></blockquote></blockquote>');
});

test("Callout 正文保留软换行且不改写标题、折叠状态和代码", async () => {
	for (const state of ["", " is-collapsible", " is-collapsible is-collapsed"]) {
		const title = '<div class="callout-title"><div class="callout-title-inner"><strong>Title</strong>\ncontinued</div></div>';
		const callout = `<div class="callout${state}" data-callout="note">${title}<div class="callout-content"><p>body\ncontinued<br>\nhard</p><pre><code>a\nb</code></pre></div></div>`;
		assert.equal(await renderCardLineBreaks(callout), `<div class="callout${state}" data-callout="note">${title}<div class="callout-content"><p>body<br>continued<br>hard</p><pre><code>a\nb</code></pre></div></div>`);
	}
});

test("代码、公式、嵌入和表格交给宿主处理", async () => {
	const html = '<pre><code>a\nb</code></pre><p><code>a\nb</code><span class="math">a\nb</span></p><div class="internal-embed"><p>a\nb</p></div><table><tbody><tr><td>a\nb</td></tr></tbody></table>';
	assert.equal(await renderCardLineBreaks(html), html);
});

test("主卡片流和移动搜索渲染完成后都保留换行，源码保持原样", async () => {
	await ensureObsidianStub();
	const { MarkdownRenderer } = await import("obsidian");
	const { MemoMarkdownRenderer } = await import("../src/ui/MemoMarkdownRenderer");
	const original = MarkdownRenderer.render;
	const dom = new JSDOM("<body></body>");
	Object.defineProperty(dom.window.document, "win", { value: dom.window });
	Object.assign(dom.window, { createFragment: () => dom.window.document.createDocumentFragment() });
	Object.assign(dom.window.Node.prototype, {
		createEl(this: Node, tag: string) { return this.appendChild(this.ownerDocument!.createElement(tag)); },
	});
	const prototype = dom.window.HTMLElement.prototype;
	Object.assign(prototype, {
		findAll(this: HTMLElement, selector: string) { return Array.from(this.querySelectorAll(selector)); },
		createDiv(this: HTMLElement) { const div = this.ownerDocument.createElement("div"); this.appendChild(div); return div; },
		detach(this: HTMLElement) { this.remove(); },
		empty(this: HTMLElement) { this.replaceChildren(); },
	});
	const markdown = "第一行\n第二行";
	const memo = { id: "memo-1", contentSnapshot: markdown, dailyRef: { path: "Daily/test.md" } } as MemoViewItem;
	const renderer = new MemoMarkdownRenderer({
		app: {} as never, createComponent: () => ({ load() {}, unload() {} }) as never,
		getDocument: () => dom.window.document, getGeneration: () => 0, concurrency: 1,
	});
	MarkdownRenderer.render = async (_app, text, target, path) => {
		assert.equal(text, markdown);
		assert.equal(path, memo.dailyRef.path);
		// 模拟宿主将软换行保留为段落内文本的输出。
		const paragraph = target.ownerDocument.createElement("p");
		paragraph.textContent = text;
		target.appendChild(paragraph);
	};
	try {
		for (const surface of ["card-flow", "mobile-search"] as const) {
			const target = dom.window.document.createElement("div");
			renderer.queueMemoMarkdown(memo, target, 0, "normal", markdown, surface);
			for (let attempt = 0; attempt < 100 && !target.querySelector("br"); attempt++) {
				await new Promise(resolve => setTimeout(resolve, 5));
			}
			assert.equal(target.innerHTML, "<p>第一行<br>第二行</p>", surface);
			assert.equal(memo.contentSnapshot, markdown);
		}
	} finally {
		renderer.clear(); renderer.clear("mobile-search");
		MarkdownRenderer.render = original;
		dom.window.close();
	}
});

test("两种卡片表面拒绝旧搜索指纹与旧草稿代次的异步 Markdown 结果", async () => {
	await ensureObsidianStub();
	const { MarkdownRenderer } = await import("obsidian");
	const { MemoMarkdownRenderer } = await import("../src/ui/MemoMarkdownRenderer");
	setDomGlobals();
	const original = MarkdownRenderer.render;
	let key = "alpha", version = 0, gate = deferred<void>();
	const components: TestComponent[] = [];
	MarkdownRenderer.render = async (_app, text, target) => {
		target.createEl("p", { text }); await gate.promise;
	};
	const renderer = new MemoMarkdownRenderer({
		app: {} as never, getDocument: () => ({} as Document), getGeneration: () => 0, concurrency: 1,
		getSearchFilter: () => ({ textTerms: [key] }), getSearchVersion: () => version,
		createComponent: () => { const component = new TestComponent(); components.push(component); return component as never; },
	});
	try {
		for (const surface of ["card-flow", "mobile-search"] as const) {
			for (const change of ["query", "draft"] as const) {
				key = "alpha"; gate = deferred<void>();
				const target = new TestElement("div", { text: "current result" });
				const count = components.length;
				renderer.queueMemoMarkdown(makeMemo(), target.asHtml(), 0, "normal", "old render", surface);
				await waitFor(() => components.length > count);
				if (change === "query") key = "beta"; else version++;
				gate.resolve();
				await waitFor(() => components[count].unloadCalls === 1);
				assert.equal(target.getText(), "current result");
			}
		}
	} finally {
		gate.resolve(); renderer.clear(); renderer.clear("mobile-search"); MarkdownRenderer.render = original;
	}
});
