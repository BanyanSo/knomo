import { MarkdownRenderer } from "obsidian";
import type { App, Component } from "obsidian";
import { t } from "../i18n";

import type { MemoViewItem as MemoRecord } from "../types/memoView";
import {
	getMarkdownTaskLines,
	parseMarkdownTaskStructure,
	type MarkdownTaskMarker,
	type WritableMarkdownTaskMarker,
} from "../utils/markdownTasks";
import { normalizeTagKey } from "../utils/tags";
import { MarkdownRenderQueue } from "./MarkdownRenderQueue";
import type { MarkdownRenderPriority } from "./MarkdownRenderQueue";

export type MemoMarkdownSurface = "card-flow" | "mobile-search";

interface MemoMarkdownRendererOptions {
	app: App;
	createComponent: () => Component;
	getDocument: () => Document;
	getGeneration: (surface: MemoMarkdownSurface) => number;
	concurrency: number;
	scheduleTask?: (callback: () => void) => number;
	cancelTask?: (id: number) => void;
}

interface MarkdownRenderToken {
	generation: number;
	requestId: number;
	surfaceEpoch: number;
}

export class MemoMarkdownRenderer {
	private readonly cardFlowQueue: MarkdownRenderQueue;
	private readonly mobileSearchQueue: MarkdownRenderQueue;
	private readonly activeComponents = createSurfaceMap(() => new Map<HTMLElement, Component>());
	private readonly pendingComponents = createSurfaceMap(() => new Set<Component>());
	private readonly latestRequestIds = createSurfaceMap(() => new WeakMap<HTMLElement, number>());
	private readonly surfaceEpochs = createSurfaceMap(() => 0);
	private readonly unloadedComponents = new WeakSet<Component>();
	private nextRequestId = 0;

	constructor(private readonly options: MemoMarkdownRendererOptions) {
		this.cardFlowQueue = new MarkdownRenderQueue({
			concurrency: options.concurrency,
			scheduleTask: options.scheduleTask,
			cancelTask: options.cancelTask,
			getGeneration: () => options.getGeneration("card-flow"),
		});
		this.mobileSearchQueue = new MarkdownRenderQueue({
			concurrency: options.concurrency,
			scheduleTask: options.scheduleTask,
			cancelTask: options.cancelTask,
			getGeneration: () => options.getGeneration("mobile-search"),
		});
	}

	queueMemoMarkdown(
		memo: MemoRecord,
		container: HTMLElement,
		generation: number,
		priority: MarkdownRenderPriority,
		previewText: string,
		surface: MemoMarkdownSurface,
	): void {
		const token = this.createRenderToken(container, generation, surface);
		this.getQueue(surface).enqueue(
			priority,
			generation,
			() => this.renderMemoMarkdown(memo, container, token, previewText, surface),
			container,
		);
	}

	queueSourceReferenceMarkdown(
		container: HTMLElement,
		text: string,
		sourcePath: string,
		generation: number,
		surface: MemoMarkdownSurface,
	): void {
		const token = this.createRenderToken(container, generation, surface);
		this.getQueue(surface).enqueue(
			"normal",
			generation,
			() => this.renderSourceReferenceMarkdown(container, text, sourcePath, token, surface),
			container,
		);
	}

	prioritizeVisible(surface: MemoMarkdownSurface, root: HTMLElement, scrollTop = root.scrollTop): void {
		const bounds = root.getBoundingClientRect();
		const offset = root.scrollTop - scrollTop;
		// 重建尚未恢复滚动时，按目标位置判断；集中读布局，不在逐任务执行时反复测量。
		this.getQueue(surface).prioritizeTargets(target => {
			if (!root.contains(target)) return false;
			const rect = target.getBoundingClientRect();
			return rect.bottom + offset > bounds.top && rect.top + offset < bounds.bottom;
		});
	}

	clear(surface: MemoMarkdownSurface = "card-flow"): void {
		this.getQueue(surface).clear();
		this.surfaceEpochs[surface] += 1;
		for (const component of this.activeComponents[surface].values()) {
			this.unloadComponent(component);
		}
		this.activeComponents[surface].clear();
		for (const component of this.pendingComponents[surface]) {
			this.unloadComponent(component);
		}
		this.pendingComponents[surface].clear();
	}

	setPaused(paused: boolean): void {
		this.cardFlowQueue.setPaused(paused);
		this.mobileSearchQueue.setPaused(paused);
	}

	getTaskCheckboxInput(target: EventTarget | null): HTMLInputElement | null {
		const node = target as Node | null;
		if (!node?.instanceOf(HTMLElement)) {
			return null;
		}
		if (node.tagName !== "INPUT" || node.closest(".knomo-card-content") === null) {
			return null;
		}
		const input = node as HTMLInputElement;
		if (input.type !== "checkbox" || input.getAttr("data-knomo-task-index") === null) {
			return null;
		}
		return input;
	}

	getTaskCheckboxIndex(input: HTMLInputElement): number | null {
		const value = input.getAttr("data-knomo-task-index");
		if (value === null) {
			return null;
		}
		const taskIndex = Number(value);
		return Number.isInteger(taskIndex) && taskIndex >= 0 ? taskIndex : null;
	}

	syncTaskCheckboxesForMemo(containers: readonly (HTMLElement | null)[], memo: MemoRecord): void {
		const tasks = getMarkdownTaskLines(memo.contentSnapshot);
		for (const container of containers) {
			if (container === null) {
				continue;
			}
			for (const checkboxEl of container.findAll(".knomo-task-checkbox")) {
				const input = checkboxEl as HTMLInputElement;
				if (input.getAttr("data-knomo-memo-id") === memo.id) {
					const index = this.getTaskCheckboxIndex(input);
					if (index !== null && tasks[index] !== undefined) applyTaskCheckboxDomState(input, tasks[index].marker);
				}
			}
		}
	}

	syncTaskCheckboxDom(input: HTMLInputElement, memo: MemoRecord): void {
		const taskIndex = this.getTaskCheckboxIndex(input);
		if (taskIndex === null) {
			return;
		}
		const task = getMarkdownTaskLines(memo.contentSnapshot)[taskIndex] ?? null;
		if (task === null) {
			return;
		}
		applyTaskCheckboxDomState(input, task.marker);
	}

	applyTaskCheckboxDomState(input: HTMLInputElement, marker: MarkdownTaskMarker | WritableMarkdownTaskMarker): void {
		applyTaskCheckboxDomState(input, marker);
	}

	private getQueue(surface: MemoMarkdownSurface): MarkdownRenderQueue {
		return surface === "card-flow" ? this.cardFlowQueue : this.mobileSearchQueue;
	}

	private async renderMemoMarkdown(
		memo: MemoRecord,
		container: HTMLElement,
		token: MarkdownRenderToken,
		previewText: string,
		surface: MemoMarkdownSurface,
	): Promise<void> {
		if (!this.isCurrentRender(container, token, surface)) {
			return;
		}
		const renderTarget = container.createDiv();
		renderTarget.detach();
		const component = this.createRenderComponent(surface);
		let adopted = false;
		try {
			await MarkdownRenderer.render(
				this.options.app,
				previewText,
				renderTarget,
				memo.dailyRef.path,
				component,
			);
			if (!this.isCurrentRender(container, token, surface)) {
				return;
			}
			this.releaseContainerComponent(container, surface);
			container.empty();
			while (renderTarget.firstChild !== null) {
				container.appendChild(renderTarget.firstChild);
			}
			prepareRenderedMemoMarkdown(container, memo);
			this.adoptRenderComponent(container, component, surface);
			adopted = true;
		} catch {
			if (!this.isCurrentRender(container, token, surface)) {
				return;
			}
			this.releaseContainerComponent(container, surface);
			container.setText(previewText);
		} finally {
			if (!adopted) {
				this.releasePendingComponent(component, surface);
			}
		}
	}

	private async renderSourceReferenceMarkdown(
		container: HTMLElement,
		text: string,
		sourcePath: string,
		token: MarkdownRenderToken,
		surface: MemoMarkdownSurface,
	): Promise<void> {
		if (!this.isCurrentRender(container, token, surface)) {
			return;
		}
		const renderTarget = container.createDiv();
		renderTarget.detach();
		const component = this.createRenderComponent(surface);
		let adopted = false;
		try {
			await MarkdownRenderer.render(this.options.app, text, renderTarget, sourcePath, component);
			if (!this.isCurrentRender(container, token, surface)) {
				return;
			}
			this.releaseContainerComponent(container, surface);
			container.empty();
			while (renderTarget.firstChild !== null) {
				container.appendChild(renderTarget.firstChild);
			}
			for (const imageEl of container.findAll("img")) {
				imageEl.setAttr("loading", "lazy");
			}
			prepareInternalLinks(container, sourcePath);
			this.adoptRenderComponent(container, component, surface);
			adopted = true;
		} catch {
			if (!this.isCurrentRender(container, token, surface)) {
				return;
			}
			this.releaseContainerComponent(container, surface);
			container.setText(text);
		} finally {
			if (!adopted) {
				this.releasePendingComponent(component, surface);
			}
		}
	}

	private createRenderToken(
		container: HTMLElement,
		generation: number,
		surface: MemoMarkdownSurface,
	): MarkdownRenderToken {
		const requestId = this.nextRequestId;
		this.nextRequestId += 1;
		this.latestRequestIds[surface].set(container, requestId);
		return {
			generation,
			requestId,
			surfaceEpoch: this.surfaceEpochs[surface],
		};
	}

	private createRenderComponent(surface: MemoMarkdownSurface): Component {
		const component = this.options.createComponent();
		component.load();
		this.pendingComponents[surface].add(component);
		return component;
	}

	private adoptRenderComponent(
		container: HTMLElement,
		component: Component,
		surface: MemoMarkdownSurface,
	): void {
		this.pendingComponents[surface].delete(component);
		this.activeComponents[surface].set(container, component);
	}

	private releaseContainerComponent(container: HTMLElement, surface: MemoMarkdownSurface): void {
		const component = this.activeComponents[surface].get(container);
		if (component === undefined) {
			return;
		}
		this.activeComponents[surface].delete(container);
		this.unloadComponent(component);
	}

	private releasePendingComponent(component: Component, surface: MemoMarkdownSurface): void {
		this.pendingComponents[surface].delete(component);
		this.unloadComponent(component);
	}

	private unloadComponent(component: Component): void {
		if (this.unloadedComponents.has(component)) {
			return;
		}
		this.unloadedComponents.add(component);
		component.unload();
	}

	private isCurrentRender(
		container: HTMLElement,
		token: MarkdownRenderToken,
		surface: MemoMarkdownSurface,
	): boolean {
		return token.generation === this.options.getGeneration(surface)
			&& token.surfaceEpoch === this.surfaceEpochs[surface]
			&& token.requestId === this.latestRequestIds[surface].get(container);
	}
}

function createSurfaceMap<T>(createValue: () => T): Record<MemoMarkdownSurface, T> {
	return {
		"card-flow": createValue(),
		"mobile-search": createValue(),
	};
}

export function prepareRenderedMemoMarkdown(container: HTMLElement, memo: MemoRecord): void {
	preserveMemoCardLineBreaks(container);
	for (const imageEl of container.findAll("img")) {
		imageEl.setAttr("loading", "lazy");
	}
	prepareInternalLinks(container, memo.dailyRef.path);
	for (const tagEl of container.findAll(".tag")) {
		const tag = tagEl.getText().replace(/^#/, "");
		const tagKey = normalizeTagKey(tag);
		if (tagKey.length > 0) {
			tagEl.setAttr("data-tag", tag);
			tagEl.setAttr("data-tag-key", tagKey);
		}
	}
	prepareRenderedTaskCheckboxes(container, memo);
}

export function prepareInternalLinks(container: HTMLElement, sourcePath: string): void {
	const links = Array.from(container.querySelectorAll<HTMLAnchorElement>("a.internal-link"));
	for (const linkEl of links) {
		linkEl.setAttr("data-knomo-source-path", sourcePath);
	}
}

export function prepareRenderedTaskCheckboxes(container: HTMLElement, memo: MemoRecord): void {
	const { tasks, listLines, hasRawTaskHtml } = parseMarkdownTaskStructure(memo.contentSnapshot);
	const inputs = container.findAll("input[type='checkbox']") as HTMLInputElement[];
	for (const input of inputs) {
		input.disabled = true;
		input.setAttr("title", t("task.refreshRequired"));
	}
	if (tasks.length === 0 || hasRawTaskHtml) return;
	// 对齐完整列表结构，不能用第 N 个 input 猜测第 N 个源码任务。
	const items = container.findAll("li");
	if (items.length !== listLines.length) return;
	const itemsByLine = new Map<number, HTMLElement | null>();
	listLines.forEach((line, index) => itemsByLine.set(line, itemsByLine.has(line) ? null : items[index]));
	const inputsByItem = new Map<Element, HTMLInputElement | null>();
	for (const input of inputs) {
		const item = input.closest("li");
		if (item !== null) inputsByItem.set(item, inputsByItem.has(item) ? null : input);
	}
	const bindings: Array<{ input: HTMLInputElement; item: HTMLElement; taskIndex: number }> = [];
	for (const task of tasks) {
		const item = itemsByLine.get(task.lineIndex);
		if (!item || !item.hasClass("task-list-item")) return;
		const input = inputsByItem.get(item);
		if (!input) return;
		const marker = item.getAttr("data-task");
		// 宿主可用空字符串表示未完成，源码则固定使用单个空格；缺失属性仍拒绝绑定。
		const renderedMarker = marker === "" ? " " : marker?.toLowerCase();
		if (renderedMarker !== task.marker.toLowerCase()) return;
		bindings.push({ input, item, taskIndex: task.index });
	}
	for (const { input, item, taskIndex } of bindings) {
		input.disabled = false;
		input.setAttr("title", "");
		input.addClass("knomo-task-checkbox");
		input.setAttr("data-knomo-memo-id", memo.id);
		input.setAttr("data-knomo-task-index", String(taskIndex));
		item.setAttr("data-knomo-task-index", String(taskIndex));
	}
}

export function applyTaskCheckboxDomState(input: HTMLInputElement, marker: MarkdownTaskMarker | WritableMarkdownTaskMarker): void {
	const renderedMarker = marker === "X" ? "x" : marker;
	input.checked = renderedMarker !== " ";
	input.indeterminate = renderedMarker === "-";
	input.setAttr("data-task", renderedMarker);
	const taskItem = input.closest("li");
	if (taskItem?.instanceOf(HTMLElement)) {
		taskItem.setAttr("data-task", renderedMarker);
	}
}

// 只处理宿主渲染后的正文软换行，不改写 Daily 或传给宿主的 Markdown。
function preserveMemoCardLineBreaks(container: HTMLElement): void {
	for (const block of container.findAll("p, li")) {
		if (block.closest("pre, code, .math, .internal-embed, .markdown-embed")) continue;
		preserveInlineLineBreaks(block);
	}
}

function preserveInlineLineBreaks(element: Element): void {
	for (const child of Array.from(element.childNodes)) {
		if (child.nodeType === 1) {
			const inline = child as Element;
			// 不进入嵌入、公式、代码及嵌套块；段落和列表项分别处理。
			if (/^(A|EM|STRONG|DEL|S|MARK|SPAN)$/.test(inline.tagName)
				&& !inline.matches(".math, .internal-embed, .markdown-embed")) preserveInlineLineBreaks(inline);
			continue;
		}
		if (child.nodeType !== 3 || !child.textContent?.includes("\n")) continue;
		const value = child.textContent;
		// 紧凑列表的块间排版空白不是正文换行。
		if (element.tagName === "LI" && value.trim() === "") continue;
		const parts = value.split(/\r?\n/);
		const fragment = (child.ownerDocument!.win as Window & { createFragment: typeof createFragment }).createFragment();
		for (let index = 0; index < parts.length; index++) {
			// Markdown 硬换行通常输出 <br>\n，不能再增加一行。
			if (index > 0 && !(index === 1 && parts[0] === ""
				&& child.previousSibling?.nodeName === "BR")) {
				fragment.createEl("br");
			}
			if (parts[index]) fragment.appendChild(child.ownerDocument!.createTextNode(parts[index]));
		}
		child.parentNode!.replaceChild(fragment, child);
	}
}
