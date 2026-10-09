import test from "node:test";
import assert from "node:assert/strict";
import { createMobilePopupFixture } from "./helpers/mobilePopupFixture";

interface SearchView {
	currentLayout: string;
	mobileSearchHeaderActionEl: HTMLElement | null;
	ensureMobileSearchHeaderAction(): void;
	registerMobileMenuTriggerEvents(): void;
	app: { workspace: { getActiveViewOfType(): unknown } };
}

async function harness() {
	const f = await createMobilePopupFixture();
	const { win } = f;
	const doc = win.document;
	// 模拟宿主 addAction 的挂载位置；使用实际 View 的按钮创建、事件接线和搜索打开入口。
	const header = doc.body.createDiv({ cls: "view-header" });
	const actions = header.createDiv({ cls: "view-actions" });
	const state = { focused: false, opens: 0, now: 0 };
	const timers = new Map<number, { due: number; run: () => void }>();
	let next = 0;
	win.setTimeout = (run, delay = 0) => { timers.set(++next, { due: state.now + delay, run: run as () => void }); return next; };
	win.clearTimeout = id => { timers.delete(id!); };
	win.performance.now = () => state.now;
	doc.hasFocus = () => state.focused;
	const view: SearchView = Object.assign(f.view as unknown as SearchView, {
		rootEl: f.root, mobileSearchHeaderActionEl: null, activeNav: "all",
		mobileHeaderTitleController: { getAnchor: () => null },
		mobileSearchController: { openPage: () => { state.opens++; } },
		addAction: (_icon: string, _title: string, callback: () => void) => {
			const action = actions.createDiv({ cls: "clickable-icon view-action" });
			action.appendChild(doc.createElementNS("http://www.w3.org/2000/svg", "svg"));
			action.addEventListener("click", callback);
			return action;
		},
	});
	view.app.workspace = { getActiveViewOfType: () => view };
	view.registerMobileMenuTriggerEvents();
	view.ensureMobileSearchHeaderAction();
	const button = view.mobileSearchHeaderActionEl!;
	assert.equal(f.root.contains(button), false);
	const advance = (ms: number) => {
		const end = state.now + ms;
		for (;;) {
			const task = [...timers].filter(([, value]) => value.due <= end).sort((a, b) => a[1].due - b[1].due)[0];
			if (!task) break;
			state.now = task[1].due; timers.delete(task[0]); task[1].run();
		}
		state.now = end;
	};
	const tap = (target: Element = button.querySelector("svg")!) => {
		doc.elementFromPoint = () => target;
		for (const type of ["touchstart", "touchend"]) {
			const event = new win.Event(type, { bubbles: true, cancelable: true });
			const points = [{ identifier: 1, clientX: 20, clientY: 20 }];
			Object.defineProperties(event, {
				timeStamp: { value: type === "touchstart" ? 0 : 145 },
				touches: { value: type === "touchstart" ? points : [] }, changedTouches: { value: points },
			});
			target.dispatchEvent(event);
			assert.equal(event.defaultPrevented, false, "保留原生触摸激活窗口的机会");
		}
	};
	return { f, view, button, state, advance, tap, close: () => f.close() };
}

test("冷启动标题栏搜索首击缺失 click，窗口激活后沿原入口打开一次", async () => {
	const h = await harness();
	try {
		h.tap(); h.advance(46); h.state.focused = true;
		assert.equal(h.state.opens, 0);
		h.advance(54); assert.equal(h.state.opens, 1);
		h.button.dispatchEvent(new h.f.win.MouseEvent("click", { bubbles: true, cancelable: true, detail: 1, clientX: 20, clientY: 20 }));
		h.advance(1000); assert.equal(h.state.opens, 1, "迟到兼容 click 不得再次打开搜索");
	} finally { h.close(); }
});

test("先点击其他控件激活窗口，或原生 click 正常到达时，搜索只打开一次", async () => {
	for (const alreadyFocused of [false, true]) {
		const h = await harness();
		try {
			h.state.focused = alreadyFocused;
			h.tap(); h.state.focused = true;
			h.button.click(); h.advance(1000);
			assert.equal(h.state.opens, 1);
		} finally { h.close(); }
	}
});

test("标题栏搜索待恢复期间切换视图、布局、移除或禁用入口，不再打开搜索", async () => {
	for (const scenario of ["inactive", "desktop", "removed", "disabled", "replaced"]) {
		const h = await harness();
		try {
			h.tap();
			if (scenario === "inactive") h.view.app.workspace.getActiveViewOfType = () => null;
			if (scenario === "desktop") h.view.currentLayout = "desktop";
			if (scenario === "removed") h.button.remove();
			if (scenario === "disabled") h.button.setAttribute("aria-disabled", "true");
			if (scenario === "replaced") { h.view.mobileSearchHeaderActionEl = null; h.view.ensureMobileSearchHeaderAction(); }
			h.state.focused = true; h.advance(1000);
			assert.equal(h.state.opens, 0, scenario);
		} finally { h.close(); }
	}
});

test("首击恢复仅识别当前 View 的搜索入口，不接管其他标题栏同样式按钮", async () => {
	const h = await harness();
	try {
		const other = h.f.win.document.body.createDiv({ cls: "clickable-icon view-action knomo-mobile-header-action" });
		let calls = 0; other.addEventListener("click", () => calls++);
		h.tap(other); h.state.focused = true; h.advance(1000);
		assert.equal(calls, 0);
		assert.equal(h.state.opens, 0);
	} finally { h.close(); }
});
