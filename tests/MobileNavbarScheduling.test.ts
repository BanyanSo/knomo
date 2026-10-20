import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { ensureObsidianStub } from "./helpers/obsidianStub";

test("移动导航栏持续缺失时稳定同步会结束，空闲一分钟不继续调度", async (context) => {
	const h = await createHarness();
	try {
		h.controller.start();
		await h.advance(60_000);
		context.diagnostic(`60s: ${h.syncCalls} sync calls, ${h.tasks.size} pending tasks`);
		assert.equal(h.tasks.size, 0);
		const settledCalls = h.syncCalls;
		await h.advance(60_000);
		assert.equal(h.syncCalls, settledCalls);
	} finally { h.close(); }
});

for (const appearance of ["insert", "class"] as const) {
	test(`移动导航栏在稳定窗口后通过 ${appearance} 出现，无新布局事件也恢复按钮`, async () => {
		const h = await createHarness();
		try {
			h.controller.start();
			const navbar = appearance === "class" ? h.addNavbar(false) : null;
			await h.advance(5_000);
			if (navbar) navbar.classList.add("mobile-navbar");
			else h.addNavbar();
			await h.flushMutations();
			await h.advance(1_000);
			h.assertRestored();
			assert.equal(h.waitingObservers().length, 0);
			assert.equal(h.tasks.size, 0);
			h.doc.querySelector<HTMLButtonElement>(".knomo-mobile-navbar-sidebar-action")!.click();
			h.doc.querySelector<HTMLButtonElement>(".knomo-mobile-create-fab")!.click();
			await h.advance(1_000);
			assert.deepEqual(h.actions, ["sidebar", "composer"]);
		} finally { h.close(); }
	});
}

for (const event of ["active-leaf-change", "layout-change", "visibilitychange", "resize", "orientationchange", "requestSync"]) {
	test(`移动导航栏切页释放等待后，${event} 可重新恢复当前视图`, async () => {
		const h = await createHarness();
		try {
			h.controller.start();
			await h.advance(1_000);
			h.state.active = false;
			h.workspaceEvent("active-leaf-change");
			await h.advance(1_000);
			assert.equal(h.waitingObservers().length, 0);
			assert.equal(h.tasks.size, 0);
			h.addNavbar();
			await h.flushMutations();
			assert.equal(h.doc.querySelector(".knomo-mobile-create-fab"), null);
			h.state.active = true;
			if (event === "requestSync") h.controller.requestSync();
			else if (event === "active-leaf-change" || event === "layout-change") h.workspaceEvent(event);
			else (event === "visibilitychange" ? h.doc : h.win).dispatchEvent(new h.win.Event(event));
			await h.advance(1_000);
			h.assertRestored();
			assert.equal(h.tasks.size, 0);
		} finally { h.close(); }
	});
}

test("移动导航栏等待在 stop 后释放，旧观察回调不能干扰重启后的等待", async () => {
	const h = await createHarness();
	try {
		h.controller.start();
		await h.advance(20);
		const old = h.waitingObservers()[0];
		assert.ok(old);
		h.controller.stop();
		assert.equal(h.tasks.size, 0);
		assert.equal(h.observed.size, 0);
		const stoppedCalls = h.syncCalls;
		h.workspaceEvent("layout-change");
		h.win.dispatchEvent(new h.win.Event("resize"));
		await h.advance(1_000);
		assert.equal(h.syncCalls, stoppedCalls);
		h.controller.start();
		await h.advance(20);
		h.callbacks.get(old)!([], old);
		assert.equal(h.waitingObservers().length, 1);
		h.addNavbar();
		await h.flushMutations();
		await h.advance(1_000);
		h.assertRestored();
	} finally { h.close(); }
});

test("活动期间替换导航栏和 header 25 轮只观察当前四个根，旧节点和回调不再唤醒", async (context) => {
	const h = await createHarness();
	const addHeader = () => {
		const header = h.doc.createElement("header");
		header.className = "view-header";
		header.innerHTML = '<div class="view-header-nav-buttons"></div><div class="view-actions"></div>';
		h.doc.body.appendChild(header);
		return header;
	};
	try {
		let navbar = h.addNavbar();
		let header = addHeader();
		h.controller.start();
		await h.advance(1_000);
		const oldObserver = [...h.observed.keys()][0]!;
		const oldNavbar = navbar;
		for (let round = 0; round < 25; round++) {
			navbar.remove(); header.remove();
			navbar = h.addNavbar(); header = addHeader();
			h.workspaceEvent("layout-change");
			await h.advance(1_000);
			const roots = [...h.observed.values()].flatMap(elements => [...elements]);
			assert.equal(roots.length, 4);
			assert.ok(roots.every(element => element.isConnected));
			h.assertRestored();
		}
		context.diagnostic("25 replacements: 4 current roots, 0 detached roots");
		const settled = h.syncCalls;
		oldNavbar.classList.add("old-mutation");
		h.callbacks.get(oldObserver)!([{ type: "attributes", target: oldNavbar, addedNodes: [], removedNodes: [] } as unknown as MutationRecord], oldObserver);
		await h.advance(1_000);
		assert.equal(h.syncCalls, settled);
		header.classList.add("current-mutation");
		await h.flushMutations();
		await h.advance(1_000);
		assert.ok(h.syncCalls > settled);
		h.state.active = false;
		h.workspaceEvent("active-leaf-change");
		await h.advance(1_000);
		assert.equal(h.observed.size, 0);
		h.state.active = true;
		h.workspaceEvent("active-leaf-change");
		await h.advance(1_000);
		h.assertRestored();
		h.controller.stop();
		assert.equal(h.observed.size, 0);
		assert.equal(h.tasks.size, 0);
	} finally { h.close(); }
});

test("只替换 header 也释放旧根，相同根不重新注册，角色重叠保留 navbar 子树观察", async () => {
	const h = await createHarness();
	try {
		const navbar = h.addNavbar();
		navbar.classList.add("view-header");
		const chrome = h.doc.createElement("div");
		chrome.className = "view-header-nav-buttons view-actions";
		navbar.appendChild(chrome);
		h.controller.start();
		await h.advance(1_000);
		assert.equal([...h.observed.values()][0]!.size, 2);
		const original = [...h.observed.keys()][0];
		h.controller.requestSync();
		await h.advance(1_000);
		assert.equal([...h.observed.keys()][0], original);
		const nextChrome = chrome.cloneNode() as HTMLElement;
		chrome.replaceWith(nextChrome);
		h.workspaceEvent("layout-change");
		await h.advance(1_000);
		const roots = [...h.observed.values()][0]!;
		assert.deepEqual(roots, new Set([navbar, nextChrome]));
		const settled = h.syncCalls;
		nextChrome.appendChild(h.doc.createElement("span"));
		await h.flushMutations();
		await h.advance(1_000);
		assert.ok(h.syncCalls > settled);
	} finally { h.close(); }
});

test("活动导航栏消失时释放旧根，并继续等待晚到的替代导航栏", async () => {
	const h = await createHarness();
	try {
		const navbar = h.addNavbar();
		h.controller.start();
		await h.advance(1_000);
		navbar.remove();
		h.workspaceEvent("layout-change");
		await h.advance(1_000);
		assert.equal(h.observed.size, 1);
		assert.equal(h.waitingObservers().length, 1);
		assert.ok([...h.observed.values()].every(roots => !roots.has(navbar)));
		h.addNavbar();
		await h.flushMutations();
		await h.advance(1_000);
		h.assertRestored();
		assert.equal(h.waitingObservers().length, 0);
	} finally { h.close(); }
});

async function createHarness() {
	await ensureObsidianStub();
	const { Platform } = await import("obsidian");
	const { MobileNavbarCompactController } = await import("../src/ui/MobileNavbarCompactController");
	const dom = new JSDOM("<!doctype html><body><main class='knomo-plugin'></main></body>", { pretendToBeVisual: true });
	const win = dom.window;
	const doc = win.document;
	const mobile = Platform.isMobile;
	const oldElement = Object.getOwnPropertyDescriptor(global, "HTMLElement");
	Object.assign(Platform, { isMobile: true });
	Object.defineProperty(global, "HTMLElement", { configurable: true, value: win.HTMLElement });
	Object.assign(win.HTMLElement.prototype, {
		instanceOf(this: HTMLElement, type: typeof HTMLElement) { return this instanceof type; },
		addClass(this: HTMLElement, name: string) { if (!this.classList.contains(name)) this.classList.add(name); },
		removeClass(this: HTMLElement, name: string) { if (this.classList.contains(name)) this.classList.remove(name); },
		hasClass(this: HTMLElement, name: string) { return this.classList.contains(name); },
		toggleClass(this: HTMLElement, name: string, force: boolean) { this.classList.toggle(name, force); },
		findAll(this: HTMLElement, selector: string) { return Array.from(this.querySelectorAll(selector)); },
		setAttr(this: HTMLElement, name: string, value: string) { this.setAttribute(name, value); },
		setCssProps(this: HTMLElement, props: Record<string, string>) {
			for (const [key, value] of Object.entries(props)) this.style.setProperty(key, value);
		},
		createEl(this: HTMLElement, tag: string, options: { cls?: string; attr?: Record<string, string> } = {}) {
			const element = doc.createElement(tag);
			if (options.cls) element.className = options.cls;
			for (const [key, value] of Object.entries(options.attr ?? {})) element.setAttribute(key, value);
			this.appendChild(element);
			return element;
		},
	});
	let now = 0, nextId = 0, syncCalls = 0;
	const tasks = new Map<number, { at: number; callback: () => void }>();
	const schedule = (callback: () => void, delay: number) => {
		const id = ++nextId;
		tasks.set(id, { at: now + delay, callback });
		return id;
	};
	win.setTimeout = (callback: TimerHandler, delay = 0) => {
		assert.equal(typeof callback, "function");
		return schedule(callback as () => void, delay);
	};
	win.clearTimeout = id => { if (id !== undefined) tasks.delete(id); };
	win.requestAnimationFrame = callback => schedule(() => callback(now), 16);
	win.cancelAnimationFrame = id => { tasks.delete(id); };
	const observed = new Map<MutationObserver, Set<Node>>();
	const callbacks = new Map<MutationObserver, MutationCallback>();
	const NativeObserver = win.MutationObserver;
	win.MutationObserver = class extends NativeObserver {
		constructor(callback: MutationCallback) { super(callback); callbacks.set(this, callback); }
		observe(target: Node, options?: MutationObserverInit): void {
			super.observe(target, options);
			const roots = observed.get(this) ?? new Set<Node>();
			roots.add(target);
			observed.set(this, roots);
		}
		disconnect(): void { super.disconnect(); observed.delete(this); }
	};
	const state = { active: true };
	const actions: string[] = [];
	const workspaceListeners = new Map<string, Set<() => void>>();
	const domCleanups: Array<() => void> = [];
	const view = {
		containerEl: Object.assign(doc.querySelector<HTMLElement>("main")!, { doc, win }),
		app: { workspace: {
			on(event: string, callback: () => void) {
				const listeners = workspaceListeners.get(event) ?? new Set<() => void>();
				listeners.add(callback); workspaceListeners.set(event, listeners);
				return { event, callback };
			},
			offref(ref: { event: string; callback: () => void }) { workspaceListeners.get(ref.event)?.delete(ref.callback); },
		} },
		registerDomEvent(target: EventTarget, event: string, callback: EventListener) {
			target.addEventListener(event, callback);
			domCleanups.push(() => target.removeEventListener(event, callback));
		},
	};
	const controller = new MobileNavbarCompactController(view as never, {
		isActive: () => state.active, isComposerOpen: () => false,
		toggleSidebar: () => actions.push("sidebar"), openComposer: () => actions.push("composer"),
	});
	const sync = controller.sync.bind(controller);
	controller.sync = () => { syncCalls++; sync(); };
	const flushMutations = async () => { await Promise.resolve(); await Promise.resolve(); };
	return {
		controller, win, doc, state, tasks, observed, callbacks, actions, flushMutations,
		get syncCalls() { return syncCalls; },
		waitingObservers: () => [...observed].filter(([, roots]) => roots.has(doc.body)).map(([observer]) => observer),
		workspaceEvent: (event: string) => { for (const callback of workspaceListeners.get(event) ?? []) callback(); },
		addNavbar(ready = true) {
			const wrapper = doc.createElement("div");
			wrapper.innerHTML = `<nav class="${ready ? "mobile-navbar" : ""}"><div class="mobile-navbar-actions"><button class="mobile-navbar-action-tabs"></button></div></nav>`;
			doc.body.appendChild(wrapper);
			return wrapper.firstElementChild!;
		},
		async advance(duration: number) {
			const end = now + duration;
			let iterations = 0;
			for (;;) {
				const next = [...tasks].sort((left, right) => left[1].at - right[1].at)[0];
				if (!next || next[1].at > end) break;
				assert.ok(++iterations < 10_000, "调度不得形成零间隔循环");
				now = next[1].at; tasks.delete(next[0]); next[1].callback();
				await flushMutations();
			}
			now = end;
			await flushMutations();
		},
		assertRestored() {
			assert.equal(doc.body.classList.contains("knomo-mobile-navbar-compact-active"), true);
			assert.equal(doc.querySelectorAll(".mobile-navbar .knomo-mobile-navbar-sidebar-action").length, 1);
			assert.equal(doc.querySelectorAll(".knomo-plugin > .knomo-mobile-create-fab").length, 1);
		},
		close() {
			controller.stop();
			for (const cleanup of domCleanups) cleanup();
			dom.window.close();
			Object.assign(Platform, { isMobile: mobile });
			if (oldElement) Object.defineProperty(global, "HTMLElement", oldElement);
			else Reflect.deleteProperty(global, "HTMLElement");
		},
	};
}
