import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { MobileViewFocusRecovery } from "../src/ui/MobileViewFocusRecovery";

function harness(modal = false) {
	const dom = new JSDOM("<!doctype html><body><main></main><button></button><input></body>", { pretendToBeVisual: true });
	const win = dom.window;
	const doc = win.document;
	win.focus = () => {};
	// 默认模拟可见节点；隐藏残留焦点由单独用例设置。
	win.HTMLElement.prototype.getClientRects = () => [new win.DOMRect(0, 0, 100, 40)] as unknown as DOMRectList;
	const root = doc.querySelector("main")!;
	const owner = modal ? doc.createElement("div") : null;
	if (owner) { owner.className = "modal-container"; doc.body.append(owner); owner.append(root); }
	const state = { active: true, visible: true, foreground: true, acceptFocus: true, root: root as HTMLElement | null, calls: 0, now: 0 };
	Object.defineProperty(doc, "visibilityState", { get: () => state.visible ? "visible" : "hidden" });
	doc.hasFocus = () => state.foreground;
	win.performance.now = () => state.now;
	const timers = new Map<number, { due: number; callback: () => void }>();
	const frames = new Map<number, FrameRequestCallback>();
	let next = 0;
	win.requestAnimationFrame = callback => { frames.set(++next, callback); return next; };
	win.cancelAnimationFrame = id => { frames.delete(id); };
	win.setTimeout = (callback, delay = 0) => { timers.set(++next, { due: state.now + delay, callback: callback as () => void }); return next; };
	win.clearTimeout = id => { if (id !== undefined) timers.delete(id); };
	const nativeFocus = root.focus.bind(root);
	root.focus = options => { state.calls++; assert.equal(options?.preventScroll, true); if (state.acceptFocus) nativeFocus(options); };
	const recovery = new MobileViewFocusRecovery({ getRoot: () => state.root, canRecover: () => state.active,
		...(owner ? { getOwner: () => owner } : {}) });
	const advance = (milliseconds: number) => {
		const end = state.now + milliseconds;
		for (;;) {
			const task = [...timers.entries()].filter(([, value]) => value.due <= end).sort((a, b) => a[1].due - b[1].due)[0];
			if (!task) break;
			state.now = task[1].due; timers.delete(task[0]); task[1].callback();
		}
		state.now = end;
	};
	return { win, doc, root, owner, state, frames, timers, recovery, advance,
		frame: () => { const tasks = [...frames.values()]; frames.clear(); for (const callback of tasks) callback(0); },
		close: () => { recovery.cancel(); win.close(); } };
}

test("自有 Modal 可以恢复窗口及元素焦点，但新 Modal 或用户选中的控件使旧恢复永久失效", () => {
	for (const scenario of ["ready", "new-modal", "other-control"]) {
		const h = harness(true);
		try {
			let requests = 0; h.state.foreground = false; h.win.focus = () => { requests++; };
			h.recovery.recover();
			assert.equal(h.doc.activeElement, h.root); assert.equal(requests, 1);
			h.root.blur();
			if (scenario === "new-modal") {
				const other = h.doc.createElement("div"); other.className = "modal-container"; h.doc.body.append(other);
				h.frame(); other.remove();
			} else if (scenario === "other-control") {
				const button = h.doc.createElement("button"); h.owner!.append(button); button.focus(); h.frame();
			} else { h.state.foreground = true; h.frame(); }
			const calls = h.state.calls; h.advance(1000); h.frame();
			assert.equal(h.state.calls, calls);
			if (scenario !== "ready") assert.equal(h.timers.size, 0);
		} finally { h.close(); }
	}
});

test("Modal 的原生按钮交接保留 Tab 顺序，不应用普通容器的 tabindex=-1", () => {
	const h = harness(true);
	try {
		const button = h.doc.createElement("button"); h.owner!.append(button); h.state.root = button;
		h.recovery.recover();
		assert.equal(h.doc.activeElement, button);
		assert.equal(button.hasAttribute("tabindex"), false);
		assert.equal(button.tabIndex, 0);
	} finally { h.close(); }
});

test("返回活动视图时在首次交互之前恢复非编辑焦点，不派发点击", () => {
	const h = harness();
	try {
		let clicks = 0;
		h.doc.addEventListener("click", () => clicks++);
		h.recovery.recover();
		assert.equal(h.doc.activeElement, h.root);
		assert.equal(h.root.tabIndex, -1);
		assert.equal(clicks, 0);
		h.frame();
		assert.equal(h.state.calls, 1, "已就绪时不重复聚焦");
		h.root.blur();
		h.state.active = false; h.recovery.recover();
		assert.equal(h.state.calls, 1);
		h.state.active = true; h.recovery.recover();
		assert.equal(h.doc.activeElement, h.root, "下一次返回也不需要用户先点醒视图");
	} finally { h.close(); }
});

test("宿主在首帧及更晚的激活阶段覆盖焦点时仍可恢复", () => {
	const h = harness();
	try {
		h.recovery.recover(); h.root.blur();
		h.frame();
		assert.equal(h.doc.activeElement, h.root);
		assert.equal(h.state.calls, 2);
		h.advance(400); h.root.blur(); h.advance(150);
		assert.equal(h.doc.activeElement, h.root);
		assert.equal(h.state.calls, 3);
	} finally { h.close(); }
});

test("编辑器或宿主弹窗已有焦点时不抢焦点", () => {
	for (const scenario of ["input", "contenteditable", "modal", "menu", "suggestion"] as const) {
		const h = harness();
		try {
			let expected: Element | null = h.doc.body;
			if (scenario === "input") { expected = h.doc.querySelector("input")!; (expected as HTMLElement).focus(); }
			else if (scenario === "contenteditable") {
				const editor = h.doc.createElement("div"); editor.setAttribute("contenteditable", "true"); editor.tabIndex = 0;
				h.doc.body.appendChild(editor); editor.focus(); expected = editor;
			} else {
				const popup = h.doc.createElement("div");
				popup.className = scenario === "modal" ? "modal-container" : scenario === "menu" ? "menu" : "suggestion-container";
				popup.getClientRects = () => [new h.win.DOMRect(0, 0, 100, 100)] as unknown as DOMRectList;
				h.doc.body.appendChild(popup);
			}
			h.recovery.recover(); h.frame();
			assert.equal(h.doc.activeElement, expected, scenario);
			assert.equal(h.state.calls, 0, scenario);
		} finally { h.close(); }
	}
});

test("用户操作、后台、切页、节点替换及卸载使延迟恢复失效", () => {
	for (const scenario of ["pointerdown", "touchstart", "keydown", "click", "compositionstart", "hidden", "inactive", "replaced", "removed", "cancel"] as const) {
		const h = harness();
		try {
			h.recovery.recover(); h.root.blur();
			if (scenario === "hidden") { h.state.visible = false; h.doc.dispatchEvent(new h.win.Event("visibilitychange")); }
			else if (scenario === "inactive") h.state.active = false;
			else if (scenario === "replaced") h.state.root = h.doc.createElement("main");
			else if (scenario === "removed") h.root.remove();
			else if (scenario === "cancel") h.recovery.cancel();
			else assert.equal(h.doc.dispatchEvent(new h.win.Event(scenario, { cancelable: true })), true);
			h.frame();
			assert.equal(h.state.calls, 1, scenario);
			assert.equal(h.frames.size, 0, scenario);
		} finally { h.close(); }
	}
});

test("前台恢复前不聚焦，恢复后再处理；延迟期间取得输入焦点也不会被覆盖", () => {
	const h = harness();
	try {
		h.state.visible = false; h.recovery.recover();
		assert.equal(h.state.calls, 0);
		h.state.visible = true; h.doc.dispatchEvent(new h.win.Event("visibilitychange")); h.frame();
		const input = h.doc.querySelector("input")!; input.focus(); h.frame();
		assert.equal(h.doc.activeElement, input);
		assert.equal(h.state.calls, 1);
	} finally { h.close(); }
});


test("KnomoView 恢复入口遵守活动视图、编辑器和搜索状态，并注册卸载清理", async () => {
	const { ensureObsidianStub } = await import("./helpers/obsidianStub");
	await ensureObsidianStub();
	const { KnomoView } = await import("../src/ui/KnomoView");
	const { Platform } = await import("obsidian");
	const platform = Platform as unknown as { isMobile: boolean };
	const wasMobile = platform.isMobile;
	platform.isMobile = true;
	try {
		for (const scenario of ["active", "composer", "search", "other-view", "closed", "desktop"] as const) {
			const h = harness();
			const cleanups: Array<() => void> = [];
			try {
				const view = Object.assign(Object.create(KnomoView.prototype), {
					containerEl: { doc: h.doc }, rootEl: h.root, mobileViewFocusRecovery: null,
					trashViewClosed: scenario === "closed", currentLayout: scenario === "desktop" ? "desktop-wide" : "mobile",
					composerOpen: scenario === "composer", mobileSearchController: { isOpen: scenario === "search" },
					register: (cleanup: () => void) => cleanups.push(cleanup),
				}) as { recoverMobileViewFocus(): void; app: { workspace: { getActiveViewOfType(): unknown } } };
				view.app = { workspace: { getActiveViewOfType: () => scenario === "other-view" ? null : view } };
				view.recoverMobileViewFocus();
				assert.equal(h.state.calls, scenario === "active" ? 1 : 0, scenario);
				assert.equal(cleanups.length, 1);
				for (const cleanup of cleanups) cleanup();
				assert.equal(h.frames.size, 0);
			} finally { for (const cleanup of cleanups) cleanup(); h.close(); }
		}
	} finally { platform.isMobile = wasMobile; }
});

test("宿主迟到就绪或菜单蒙版晚于 onHide 移除时，恢复请求不会在首帧丢失", () => {
	for (const scenario of ["rejected", "menu-backdrop"] as const) {
		const h = harness();
		try {
			const backdrop = h.doc.createElement("div"); backdrop.className = "suggestion-bg";
			backdrop.getClientRects = () => [new h.win.DOMRect(0, 0, 100, 100)] as unknown as DOMRectList;
			if (scenario === "menu-backdrop") h.doc.body.appendChild(backdrop);
			else h.state.acceptFocus = false;
			h.recovery.recover(() => true, true); h.frame(); h.advance(450);
			assert.notEqual(h.doc.activeElement, h.root);
			backdrop.remove(); h.state.acceptFocus = true; h.advance(150);
			assert.equal(h.doc.activeElement, h.root, scenario + " 无需新的点击或窗口事件");
		} finally { h.close(); }
	}
});

test("窗口未聚焦时，首次原生导航手势交接焦点并完整保留点击", () => {
	const h = harness();
	try {
		h.state.foreground = false; h.state.acceptFocus = false; h.recovery.recover(); h.frame();
		const button = h.doc.querySelector("button")!; let clicks = 0;
		button.addEventListener("click", () => clicks++);
		h.state.acceptFocus = true;
		assert.equal(button.dispatchEvent(new h.win.Event("touchstart", { bubbles: true, cancelable: true })), true);
		assert.equal(h.doc.activeElement, h.root, "宿主控件位于 Knomo 根节点之外，仍可在手势内交接焦点");
		button.click(); assert.equal(clicks, 1);
		assert.equal(h.frames.size + h.timers.size, 0);
	} finally { h.close(); }
});

test("主动轮询有界，显式取消后窗口事件不再唤醒旧请求", () => {
	const h = harness();
	try {
		h.state.acceptFocus = false; h.recovery.recover(); h.frame(); h.advance(10000);
		const calls = h.state.calls;
		assert.equal(h.timers.size, 0);
		h.recovery.cancel();
		h.state.acceptFocus = true; h.win.dispatchEvent(new h.win.Event("focus")); h.advance(500); h.frame();
		assert.equal(h.state.calls, calls);
		assert.equal(h.frames.size + h.timers.size, 0);
	} finally { h.close(); }
});

test("新恢复请求替换旧请求后，已排队的旧回调不能取消当前恢复", () => {
	const h = harness(); let originalCurrent = true;
	try {
		h.state.acceptFocus = false; h.recovery.recover(() => originalCurrent);
		const obsolete = [...h.frames.values()]; originalCurrent = false;
		h.state.acceptFocus = true; h.recovery.recover(); h.root.blur();
		for (const callback of obsolete) callback(0);
		h.advance(150); h.frame();
		assert.equal(h.doc.activeElement, h.root);
		assert.ok(h.timers.size > 0, "旧回调不得释放新请求的监听与预算");
	} finally { h.close(); }
});

test("冷启动和菜单退场留下其他 leaf 的输入焦点时交接给当前 Knomo", () => {
	for (const deferred of [false, true]) {
		const h = harness();
		try {
			const oldLeaf = h.doc.body.appendChild(h.doc.createElement("section"));
			oldLeaf.className = "workspace-leaf";
			const oldInput = oldLeaf.appendChild(h.doc.createElement("textarea"));
			oldInput.focus();
			h.recovery.recover(() => true, deferred); h.frame();
			assert.equal(h.doc.activeElement, h.root);
			oldInput.focus(); h.advance(150); h.frame();
			assert.equal(h.doc.activeElement, h.root, "宿主迟到恢复旧 leaf 的焦点也不能取消交接");
			oldInput.dispatchEvent(new h.win.Event("pointerdown", { bubbles: true }));
			oldInput.focus(); h.advance(150); h.frame();
			assert.equal(h.doc.activeElement, oldInput, "用户主动选择后立即让出焦点");
		} finally { h.close(); }
	}
});

test("等待超过五秒且 hasFocus 为真时，首个宿主按钮手势仍完成交接且不拦截点击", () => {
	const h = harness();
	try {
		h.state.acceptFocus = false; h.recovery.recover(); h.frame(); h.advance(6000);
		assert.equal(h.timers.size, 0, "停止主动轮询");
		h.state.acceptFocus = true;
		const button = h.doc.querySelector("button")!;
		let clicks = 0; button.addEventListener("click", () => clicks++);
		assert.equal(button.dispatchEvent(new h.win.Event("touchstart", { bubbles: true, cancelable: true })), true);
		assert.equal(h.doc.activeElement, h.root);
		button.click(); assert.equal(clicks, 1);
		assert.equal(h.frames.size + h.timers.size, 0);
	} finally { h.close(); }
});

test("隐藏编辑器残留焦点可以交接，可见编辑器的新焦点仍受保护", () => {
	for (const hidden of [true, false]) {
		const h = harness();
		try {
			const input = h.doc.querySelector("input")!;
			input.focus();
			if (hidden) input.setAttribute("aria-hidden", "true");
			h.recovery.recover(); h.frame();
			assert.equal(h.doc.activeElement, hidden ? h.root : input);
		} finally { h.close(); }
	}
});

test("首个手势直接落在宿主按钮的 SVG 图标上也能交接焦点", () => {
	const h = harness();
	try {
		h.state.foreground = false; h.state.acceptFocus = false; h.recovery.recover();
		const button = h.doc.querySelector("button")!;
		const icon = button.appendChild(h.doc.createElementNS("http://www.w3.org/2000/svg", "svg"));
		h.state.acceptFocus = true;
		assert.equal(icon.dispatchEvent(new h.win.Event("pointerdown", { bubbles: true, cancelable: true })), true);
		assert.equal(h.doc.activeElement, h.root);
		assert.equal(h.frames.size + h.timers.size, 0);
	} finally { h.close(); }
});

test("DOM 根节点已聚焦但窗口失焦时仍请求窗口激活，得到窗口焦点后不重复请求", () => {
	const h = harness();
	try {
		h.root.tabIndex = -1; h.root.focus({ preventScroll: true }); h.state.foreground = false;
		let requests = 0; h.win.focus = () => { requests++; h.state.foreground = true; };
		h.recovery.recover();
		assert.equal(requests, 1); assert.equal(h.doc.activeElement, h.root);
		h.advance(1000); h.frame(); assert.equal(requests, 1);
	} finally { h.close(); }
});

test("窗口激活是异步请求，未完成时不能因已有 DOM 焦点提前终止", () => {
	const h = harness();
	try {
		h.state.foreground = false;
		let requests = 0; h.win.focus = () => { requests++; };
		h.recovery.recover(); h.advance(300);
		assert.equal(h.doc.activeElement, h.root); assert.ok(requests >= 2); assert.equal(h.doc.hasFocus(), false);
		h.state.active = false; h.advance(500); const stopped = requests; h.advance(1000); assert.equal(requests, stopped);
	} finally { h.close(); }
});
