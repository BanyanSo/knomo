import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { canFocusSurface, clickFromPointer, focusForNavigation, isKeyboardActivation, releaseNavigationFocus } from "../src/ui/NavigationFocus";

test("helper 的 detail=0 点击保留指针来源，键盘/辅助技术和后续点击不受污染", () => {
	const dom = new JSDOM("<button></button>", { pretendToBeVisual: true });
	try {
		const button = dom.window.document.querySelector("button")!;
		const sources: boolean[] = [];
		button.addEventListener("click", event => { assert.equal(event.detail, 0); sources.push(isKeyboardActivation(event)); });
		clickFromPointer(button); button.click();
		assert.deepEqual(sources, [false, true]);
		const pointer = new dom.window.MouseEvent("click", { detail: 0 });
		Object.defineProperty(pointer, "pointerType", { value: "touch" });
		assert.equal(isKeyboardActivation(pointer), false);
	} finally { dom.window.close(); }
});

test("指针导航仍聚焦，抑制只属于当前目标，键盘和生命周期清理立即恢复提示", () => {
	const dom = new JSDOM("<main><button id='a'></button><button id='b'></button></main>", { pretendToBeVisual: true });
	try {
		const doc = dom.window.document, a = doc.querySelector<HTMLButtonElement>("#a")!, b = doc.querySelector<HTMLButtonElement>("#b")!;
		focusForNavigation(a, false);
		assert.equal(doc.activeElement, a); assert.ok(a.hasAttribute("data-knomo-pointer-focus"));
		doc.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Tab", bubbles: true }));
		assert.equal(a.hasAttribute("data-knomo-pointer-focus"), false);
		focusForNavigation(a, false); focusForNavigation(b, false);
		assert.equal(a.hasAttribute("data-knomo-pointer-focus"), false); assert.ok(b.hasAttribute("data-knomo-pointer-focus"));
		releaseNavigationFocus(doc.querySelector("main")!);
		assert.equal(b.hasAttribute("data-knomo-pointer-focus"), false);
		focusForNavigation(a, false); b.focus();
		assert.equal(a.hasAttribute("data-knomo-pointer-focus"), false);
	} finally { dom.window.close(); }
});

test("焦点交接只避让可见的其他界面，Modal 只能豁免自身容器", () => {
	const dom = new JSDOM("<main></main><div class='modal-container'><button></button></div>", { pretendToBeVisual: true });
	try {
		const doc = dom.window.document, modal = doc.querySelector<HTMLElement>(".modal-container")!, button = doc.querySelector("button")!;
		modal.getClientRects = () => [{}] as unknown as DOMRectList;
		assert.equal(canFocusSurface(doc.querySelector("main")!), false);
		assert.equal(canFocusSurface(button, modal), true);
		const newer = doc.createElement("div"); newer.className = "modal-container"; newer.getClientRects = () => [{}] as unknown as DOMRectList; doc.body.append(newer);
		assert.equal(canFocusSurface(button, modal), false);
		newer.remove(); modal.setAttribute("inert", "");
		assert.equal(canFocusSurface(button, modal), false);
	} finally { dom.window.close(); }
});
