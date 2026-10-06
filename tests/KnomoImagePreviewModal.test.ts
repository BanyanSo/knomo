import test from "node:test";
import assert from "node:assert/strict";
import { ensureObsidianStub } from "./helpers/obsidianStub";
import { JSDOM } from "jsdom";
import type { App } from "obsidian";

test("切到已预载图片复用同一节点，连续浏览仅保留当前和邻近图片，关闭释放", async () => {
	const f = await previewFixture(20);
	try {
		f.complete(f.requests[0]);
		const neighbor = f.requests[1];
		f.complete(neighbor);
		f.next();
		assert.equal(f.stage.querySelector("img"), neighbor.imageEl);
		assert.equal(f.requests.filter(request => request.priority === "high").length, 1);
		for (let index = 1; index < 19; index++) {
			f.complete(f.requests.at(-1)!);
			f.next();
			assert.ok(f.requests.filter(request => request.imageEl.hasAttribute("src")).length <= 3);
		}
		f.modal.onClose();
		assert.equal(f.requests.filter(request => request.imageEl.hasAttribute("src")).length, 0);
		const count = f.requests.length;
		f.requests[0].onLoad?.();
		assert.equal(f.requests.length, count);
		assert.equal(f.unlocked(), 1);
	} finally { f.dom.window.close(); }
});

test("单图失败可原地重试，重复点击不重发，预载失败不会阻止后续加载", async () => {
	const f = await previewFixture(1);
	try {
		f.fail(f.requests[0]);
		const retry = f.stage.querySelector<HTMLButtonElement>("button");
		assert.ok(retry);
		retry.click(); retry.click();
		assert.equal(f.requests.length, 2);
		f.requests[0].onError?.();
		f.complete(f.requests[1]);
		assert.ok(f.stage.querySelector("img"));
		assert.equal(f.stage.getAttribute("aria-busy"), null);
		f.modal.onClose();
	} finally { f.dom.window.close(); }
	const neighbors = await previewFixture(2);
	try {
		neighbors.complete(neighbors.requests[0]);
		neighbors.fail(neighbors.requests[1]);
		neighbors.next();
		assert.equal(neighbors.requests.at(-1)?.priority, "high");
		assert.equal(neighbors.requests.at(-1)?.image.path, "1.png");
		neighbors.modal.onClose();
	} finally { neighbors.dom.window.close(); }
});

test("预览移除放大和原图按钮，双指缩放和平移不换图，切图复位", async () => {
	const f = await previewFixture(2);
	try {
		f.complete(f.requests[0]);
		assert.equal(f.modal.contentEl.querySelector(".knomo-image-preview-zoom"), null);
		assert.equal(f.modal.contentEl.querySelector(".knomo-image-preview-original"), null);
		f.touch("touchstart", [[100, 250], [200, 250]]);
		f.touch("touchmove", [[50, 250], [250, 250]]);
		assert.equal(f.stage.classList.contains("is-zoomed"), true);
		assert.equal(f.stage.querySelector<HTMLImageElement>("img")?.style.getPropertyValue("--knomo-preview-scale"), "2");
		f.touch("touchend", [], [[50, 250], [250, 250]]);
		f.touch("touchstart", [[180, 200]]);
		f.touch("touchmove", [[90, 180]]);
		f.touch("touchend", [], [[90, 180]]);
		assert.equal(f.stage.querySelector<HTMLImageElement>("img")?.style.getPropertyValue("--knomo-preview-y"), "-20px");
		assert.match(f.modal.contentEl.textContent ?? "", /1 \/ 2/);
		f.next();
		assert.equal(f.stage.classList.contains("is-zoomed"), false);
		f.complete(f.requests.at(-1)!);
		f.touch("touchstart", [[100, 200], [200, 200]]);
		f.touch("touchmove", [[50, 200], [250, 200]]);
		assert.equal(f.stage.classList.contains("is-zoomed"), true);
		f.touch("touchmove", [[125, 200], [175, 200]]);
		assert.equal(f.stage.classList.contains("is-zoomed"), false, "双指收拢可恢复完整预览");
		f.touch("touchmove", [[50, 200], [250, 200]]);
		f.touch("touchcancel", []);
		for (let tap = 0; tap < 2; tap++) {
			f.touch("touchstart", [[150, 200]]); f.touch("touchend", [], [[150, 200]]);
		}
		assert.equal(f.stage.classList.contains("is-zoomed"), false);
		f.stage.querySelector("img")!.dispatchEvent(new f.dom.window.MouseEvent("click", { bubbles: true }));
		f.stage.querySelector("img")!.dispatchEvent(new f.dom.window.MouseEvent("dblclick", { bubbles: true }));
		assert.equal(f.stage.classList.contains("is-zoomed"), false, "双击合成事件不能重复处理触屏双击");
		f.modal.onClose();
	} finally { f.dom.window.close(); }
});

test("桌面双击可放大再缩回，只有实际拖动才抑制后续点击", async () => {
	const f = await previewFixture(1);
	try {
		f.complete(f.requests[0]);
		const doubleClick = () => {
			let target: Element = f.stage;
			for (let click = 0; click < 2; click++) {
				f.pointer("pointerdown", 150, 200);
				f.pointer("pointermove", 152, 202);
				target = f.pointer("pointerup", 152, 202);
				target.dispatchEvent(new f.dom.window.MouseEvent("click", { bubbles: true, cancelable: true }));
			}
			target.dispatchEvent(new f.dom.window.MouseEvent("dblclick", { bubbles: true, cancelable: true }));
		};
		doubleClick();
		assert.equal(f.stage.classList.contains("is-zoomed"), true);
		doubleClick();
		assert.equal(f.stage.classList.contains("is-zoomed"), false, "无拖动的双击应恢复完整预览");
		doubleClick();
		f.pointer("pointerdown", 150, 200);
		f.pointer("pointermove", 150, 260);
		assert.equal(f.stage.querySelector<HTMLImageElement>("img")?.style.getPropertyValue("--knomo-preview-y"), "60px");
		const target = f.pointer("pointerup", 150, 260);
		const click = new f.dom.window.MouseEvent("click", { bubbles: true, cancelable: true });
		target.dispatchEvent(click);
		assert.equal(click.defaultPrevented, true, "拖动后的合成点击仍需抑制");
		target.dispatchEvent(new f.dom.window.MouseEvent("dblclick", { bubbles: true, cancelable: true }));
		assert.equal(f.stage.classList.contains("is-zoomed"), true);
		f.pointer("pointerdown", 150, 200);
		f.pointer("pointermove", 150, 300, 0);
		assert.equal(f.stage.querySelector<HTMLImageElement>("img")?.style.getPropertyValue("--knomo-preview-y"), "60px",
			"未拖动就移出并松开鼠标，返回预览不应继续平移");
	} finally { f.modal.onClose(); f.dom.window.close(); }
});

async function previewFixture(count: number) {
	const { KnomoImagePreviewModal } = await loadImagePreviewModule();
	type Request = Parameters<ConstructorParameters<typeof KnomoImagePreviewModal>[1]["loadImage"]>[0];
	const dom = new JSDOM("<div class='modal-container'><div class='modal'><div class='modal-title'></div><div class='modal-content'></div></div></div>");
	const doc = dom.window.document;
	const prototype = dom.window.HTMLElement.prototype;
	Object.assign(prototype, {
		addClass(this: HTMLElement, cls: string) { this.classList.add(cls); },
		toggleClass(this: HTMLElement, cls: string, value: boolean) { this.classList.toggle(cls, value); },
		setText(this: HTMLElement, value: string) { this.textContent = value; },
		setAttr(this: HTMLElement, key: string, value: string) { this.setAttribute(key, value); },
		setCssProps(this: HTMLElement, props: Record<string, string>) { for (const [key, value] of Object.entries(props)) this.style.setProperty(key, value); },
		empty(this: HTMLElement) { this.replaceChildren(); },
		createEl(this: HTMLElement, tag: string, options: { cls?: string; text?: string; attr?: Record<string, string> } = {}) {
			const element = doc.createElement(tag);
			element.className = options.cls ?? "";
			element.textContent = options.text ?? "";
			for (const [key, value] of Object.entries(options.attr ?? {})) element.setAttribute(key, value);
			this.appendChild(element);
			return element;
		},
		createDiv(this: HTMLElement, options: { cls?: string; text?: string } = {}) { return this.createEl("div", options); },
	});
	Object.defineProperty(prototype, "win", { get: () => dom.window });
	const requests: Request[] = [];
	const pending = new Set<Request>();
	let unlocks = 0;
	const modal = new KnomoImagePreviewModal({} as App, {
		images: Array.from({ length: count }, (_, index) => ({ raw: "", path: `${index}.png`, url: `https://example.test/${index}.png`, isRemote: true })),
		initialIndex: 0, lockCardFlowScroll: () => undefined, unlockCardFlowScroll: () => { unlocks++; },
		loadImage: request => {
			requests.push(request); pending.add(request); request.imageEl.src = request.image.url!;
			Object.defineProperties(request.imageEl, { offsetWidth: { value: 100 }, offsetHeight: { value: 400 } });
		},
		clearImageLoads: () => { for (const request of pending) request.imageEl.removeAttribute("src"); pending.clear(); },
	});
	Object.assign(modal, { containerEl: doc.querySelector(".modal-container"), modalEl: doc.querySelector(".modal"),
		titleEl: doc.querySelector(".modal-title"), contentEl: doc.querySelector(".modal-content") });
	modal.onOpen();
	const stage = doc.querySelector<HTMLElement>(".knomo-image-preview-stage")!;
	Object.defineProperties(stage, { clientWidth: { value: 320 }, clientHeight: { value: 500 } });
	stage.getBoundingClientRect = () => ({ x: 0, y: 0, left: 0, top: 0, right: 320, bottom: 500, width: 320, height: 500, toJSON: () => ({}) });
	let pointerCaptured = false;
	stage.setPointerCapture = () => { pointerCaptured = true; };
	return { modal, dom, requests, stage,
		complete: (request: Request) => { pending.delete(request); request.onLoad?.(); },
		fail: (request: Request) => { pending.delete(request); request.onError?.(); },
		next: () => doc.querySelector<HTMLButtonElement>(".knomo-image-preview-nav--next")!.click(),
		unlocked: () => unlocks,
		pointer: (type: string, clientX: number, clientY: number, buttons = type === "pointerup" || type === "pointercancel" ? 0 : 1) => {
			const event = new dom.window.MouseEvent(type, { bubbles: true, cancelable: true, clientX, clientY, button: 0, buttons });
			Object.assign(event, { pointerType: "mouse", pointerId: 1 });
			// 模拟捕获后的事件目标和松开后的自动释放，覆盖双击被重定向到舞台的情况。
			const target = pointerCaptured ? stage : stage.querySelector("img") ?? stage;
			target.dispatchEvent(event);
			if (type === "pointerup" || type === "pointercancel") pointerCaptured = false;
			return target;
		},
		touch: (type: string, touches: number[][], changed = touches) => {
			const event = new dom.window.Event(type, { bubbles: true, cancelable: true });
			const list = (points: number[][]) => points.map(([clientX, clientY]) => ({ clientX, clientY }));
			Object.assign(event, { touches: list(touches), changedTouches: list(changed) });
			stage.dispatchEvent(event);
		},
	};
}

test("image preview swipe requires clear horizontal intent", async () => {
	const { getImageSwipeDirection } = await loadImagePreviewModule();

	assert.equal(getImageSwipeDirection(-64, 8, 420), "next");
	assert.equal(getImageSwipeDirection(64, 8, 420), "previous");
	assert.equal(getImageSwipeDirection(-28, 4, 160), "next");
	assert.equal(getImageSwipeDirection(-20, 2, 120), null);
	assert.equal(getImageSwipeDirection(-64, 48, 180), null);
	assert.equal(getImageSwipeDirection(-12, 64, 120), null);
});

test("image preview adjacent indexes wrap without duplicates or overflow", async () => {
	const { getAdjacentImageIndexes } = await loadImagePreviewModule();

	assert.deepEqual(getAdjacentImageIndexes(0, 0), []);
	assert.deepEqual(getAdjacentImageIndexes(0, 1), []);
	assert.deepEqual(getAdjacentImageIndexes(0, 2), [1]);
	assert.deepEqual(getAdjacentImageIndexes(0, 3), [1, 2]);
	assert.deepEqual(getAdjacentImageIndexes(2, 4), [3, 1]);
});

test("image preview loading state toggles class and aria busy", async () => {
	const { setImagePreviewLoadingState } = await loadImagePreviewModule();
	const stage = new TestElement();

	setImagePreviewLoadingState(stage.asHtml(), true);
	assert.equal(stage.hasClass("is-loading"), true);
	assert.equal(stage.getAttr("aria-busy"), "true");

	setImagePreviewLoadingState(stage.asHtml(), false);
	assert.equal(stage.hasClass("is-loading"), false);
	assert.equal(stage.getAttr("aria-busy"), null);
});

async function loadImagePreviewModule(): Promise<typeof import("../src/ui/KnomoImagePreviewModal")> {
	await ensureObsidianStub();
	return import("../src/ui/KnomoImagePreviewModal");
}

class TestElement {
	private readonly classes = new Set<string>();
	private readonly attributes = new Map<string, string>();

	asHtml(): HTMLElement {
		return this as unknown as HTMLElement;
	}

	toggleClass(cls: string, active: boolean): void {
		if (active) {
			this.classes.add(cls);
		} else {
			this.classes.delete(cls);
		}
	}

	hasClass(cls: string): boolean {
		return this.classes.has(cls);
	}

	setAttr(name: string, value: string): void {
		this.attributes.set(name, value);
	}

	getAttr(name: string): string | null {
		return this.attributes.get(name) ?? null;
	}

	removeAttribute(name: string): void {
		this.attributes.delete(name);
	}
}
