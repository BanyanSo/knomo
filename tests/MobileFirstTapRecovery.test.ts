import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { registerMobileFirstTapRecovery } from "../src/ui/MobileMenuTap";

function harness() {
	const dom = new JSDOM("<!doctype html><body><button><svg></svg></button><input><div></div></body>", { pretendToBeVisual: true });
	const win = dom.window, doc = win.document, button = doc.querySelector("button")!;
	const state = { focused: false, visible: true, current: true, now: 0, calls: 0, hit: button as Element | null };
	doc.hasFocus = () => state.focused;
	Object.defineProperty(doc, "visibilityState", { get: () => state.visible ? "visible" : "hidden" });
	doc.elementFromPoint = () => state.hit;
	win.performance.now = () => state.now;
	const timers = new Map<number, { due: number; callback: () => void }>(); let id = 0;
	win.setTimeout = (callback, delay = 0) => { timers.set(++id, { due: state.now + delay, callback: callback as () => void }); return id; };
	win.clearTimeout = timer => { timers.delete(timer!); };
	const release = registerMobileFirstTapRecovery(doc, target => state.current && button.contains(target) ? button : null);
	button.addEventListener("click", () => { state.calls++; });
	const advance = (ms: number) => {
		const end = state.now + ms;
		for (;;) {
			const task = [...timers].filter(([, value]) => value.due <= end).sort((a, b) => a[1].due - b[1].due)[0];
			if (!task) break;
			state.now = task[1].due; timers.delete(task[0]); task[1].callback();
		}
		state.now = end;
	};
	const touch = (type: string, { time = 0, x = 20, ids = [1], target = button as Element } = {}) => {
		const event = new win.Event(type, { bubbles: true, cancelable: true });
		const points = ids.map(identifier => ({ identifier, clientX: x, clientY: 20 }));
		Object.defineProperties(event, { timeStamp: { value: time },
			touches: { value: type === "touchend" || type === "touchcancel" ? [] : points }, changedTouches: { value: points } });
		target.dispatchEvent(event); return event;
	};
	const tap = () => { touch("touchstart"); return touch("touchend", { time: 145 }); };
	return { win, doc, button, state, timers, advance, touch, tap, release, close: () => { release(); win.close(); } };
}

test("重放真机冷启动与菜单退场时序：touchend 未取消、46ms 后窗口 focus、缺失 click 只补执行一次", () => {
	const h = harness();
	try {
		for (let round = 0; round < 2; round++) {
			h.state.focused = false;
			assert.equal(h.tap().defaultPrevented, false, "保留原生触摸激活窗口的机会");
			h.advance(46); h.state.focused = true; h.win.dispatchEvent(new h.win.Event("focus"));
			assert.equal(h.state.calls, round);
			h.advance(54); assert.equal(h.state.calls, round + 1);
			h.advance(1000); assert.equal(h.state.calls, round + 1);
		}
	} finally { h.close(); }
});

test("正常 click 先到即取消补执行，已经聚焦的触摸不启动补偿", () => {
	for (const focused of [false, true]) {
		const h = harness();
		try {
			h.state.focused = focused; h.tap(); h.state.focused = true;
			h.button.click(); h.advance(1000);
			assert.equal(h.state.calls, 1);
			assert.equal(h.timers.size, 0);
		} finally { h.close(); }
	}
});

test("补执行后迟到的兼容 click 被去重；新的真实手势仍正常执行", () => {
	const h = harness();
	try {
		h.tap(); h.state.focused = true; h.advance(100);
		const late = new h.win.MouseEvent("click", { bubbles: true, cancelable: true, detail: 1, clientX: 20, clientY: 20 });
		h.button.dispatchEvent(late); assert.equal(late.defaultPrevented, true); assert.equal(h.state.calls, 1);
		h.tap(); h.button.click(); h.advance(1000); assert.equal(h.state.calls, 2);
	} finally { h.close(); }
});

test("迟到 click 落在补执行后出现的覆盖层时不穿透关闭覆盖层", () => {
	const h = harness();
	try {
		let overlays = 0; const overlay = h.doc.querySelector("div")!; overlay.addEventListener("click", () => overlays++);
		h.tap(); h.state.focused = true; h.advance(100);
		overlay.dispatchEvent(new h.win.MouseEvent("click", { bubbles: true, cancelable: true, detail: 1, clientX: 20, clientY: 20 }));
		assert.equal(overlays, 0);
	} finally { h.close(); }
});

test("拖动、长按、多指、取消、宿主消费和滚动都不补执行", () => {
	for (const scenario of ["move", "long", "multi", "touchcancel", "pointercancel", "scroll", "host", "late-host", "contextmenu"]) {
		const h = harness();
		try {
			h.touch("touchstart", { time: 100 });
			if (scenario === "move") h.touch("touchmove", { x: 40 });
			if (scenario === "multi") h.touch("touchstart", { ids: [1, 2] });
			if (["touchcancel", "pointercancel", "scroll", "contextmenu"].includes(scenario)) h.button.dispatchEvent(new h.win.Event(scenario, { bubbles: true }));
			if (scenario === "host") h.button.addEventListener("touchend", event => event.preventDefault(), { once: true });
			if (scenario === "late-host") h.win.addEventListener("touchend", event => event.preventDefault(), { once: true });
			h.touch("touchend", { time: scenario === "long" ? 900 : 200 });
			h.state.focused = true; h.advance(1000); assert.equal(h.state.calls, 0, scenario);
		} finally { h.close(); }
	}
});

test("等待激活期间的新输入、切页、卸载、隐藏、移除或遮挡使旧触摸失效", () => {
	for (const scenario of ["keydown", "touchstart", "input", "inactive", "unload", "hidden", "removed", "covered", "blur", "timeout"]) {
		const h = harness();
		try {
			h.tap();
			if (scenario === "keydown") h.win.dispatchEvent(new h.win.Event("keydown"));
			if (scenario === "touchstart") h.touch("touchstart", { target: h.doc.body });
			if (scenario === "input") h.doc.querySelector("input")!.focus();
			if (scenario === "inactive") h.state.current = false;
			if (scenario === "unload") h.release();
			if (scenario === "hidden") h.state.visible = false;
			if (scenario === "removed") h.button.remove();
			if (scenario === "covered") h.state.hit = h.doc.body;
			if (scenario === "blur") h.win.dispatchEvent(new h.win.Event("blur"));
			if (scenario !== "timeout") h.state.focused = true;
			h.advance(1000); assert.equal(h.state.calls, 0, scenario); assert.equal(h.timers.size, 0, scenario);
		} finally { h.close(); }
	}
});

test("SVG 起手且 pointerdown 期间窗口激活，仍记住本次手势起始失焦状态", () => {
	const h = harness();
	try {
		const svg = h.button.querySelector("svg")!;
		const down = new h.win.Event("pointerdown", { bubbles: true }); Object.defineProperty(down, "pointerType", { value: "touch" });
		svg.dispatchEvent(down); h.state.focused = true;
		h.touch("touchstart", { target: svg }); h.touch("touchend", { target: svg, time: 120 }); h.advance(100);
		assert.equal(h.state.calls, 1);
	} finally { h.close(); }
});
