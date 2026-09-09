import assert from "node:assert/strict";
import test from "node:test";
import { ensureObsidianStub } from "./helpers/obsidianStub";

test("手机打开侧边栏立即请求数量，不等待标签索引，也不进入回收站", async () => {
	const view = await fixture();
	let counts = 0;
	let release!: () => void;
	view.trashMemoController = { ensureLoaded: async () => { counts++; } };
	view.vaultTagIndex = { ensureReady: () => new Promise<void>((resolve) => { release = resolve; }) };
	const opened = view.ensureSidebarIndexes();
	assert.equal(counts, 1);
	assert.equal(view.viewStateController.activeNav, "all");
	release();
	await opened;
});

test("手机侧边栏隐藏时不读 Trash，可见时合并变化，关闭视图后不刷新", async () => {
	const view = await fixture();
	let reads = 0;
	view.trashMemoController = { ensureLoaded: async () => { reads++; } };
	view.scheduleTrashCountRefresh();
	assert.equal(view.timers.size, 0);
	view.viewStateController.mobileDrawerOpen = true;
	view.scheduleTrashCountRefresh();
	view.scheduleTrashCountRefresh();
	view.scheduleTrashCountRefresh();
	assert.equal(view.timers.size, 1);
	view.flushTimers();
	assert.equal(reads, 1);
	view.scheduleTrashCountRefresh();
	view.trashViewClosed = true;
	view.flushTimers();
	assert.equal(reads, 1);
});

test("徽标区分未知、真实空、读取失败以及有效数量", async () => {
	const view = await fixture();
	let state = { trashCount: null as number | null, trashCountLoading: true, trashCountError: null as string | null };
	const attrs = new Map<string, string>();
	let text = "";
	view.trashMemoController = { getSnapshot: () => state };
	view.trashCountEls = [{ setText: (value: string) => { text = value; },
		toggleAttribute: (key: string, value: boolean) => { if (value) attrs.set(key, ""); else attrs.delete(key); },
		setAttr: (key: string, value: string) => { attrs.set(key, value); },
		removeAttribute: (key: string) => { attrs.delete(key); } }];
	view.renderTrashCount();
	assert.equal(text, "—");
	assert.equal(attrs.get("aria-busy"), "true");
	assert.equal(attrs.has("hidden"), false);
	state = { trashCount: 0, trashCountLoading: false, trashCountError: null };
	view.renderTrashCount();
	assert.equal(attrs.has("hidden"), true);
	state.trashCountError = "read failed";
	view.renderTrashCount();
	assert.equal(text, "!");
	assert.equal(attrs.has("hidden"), false);
	state = { trashCount: 2, trashCountLoading: false, trashCountError: null };
	view.renderTrashCount();
	assert.equal(text, "2");
	assert.equal(attrs.has("aria-busy"), false);
});

async function fixture() {
	await ensureObsidianStub();
	const { Platform } = await import("obsidian");
	Object.assign(Platform, { isMobile: true });
	const { KnomoView } = await import("../src/ui/KnomoView");
	const timers = new Map<number, () => void>();
	let next = 0;
	const view = Object.create(KnomoView.prototype) as {
		ensureSidebarIndexes(): Promise<void>;
		scheduleTrashCountRefresh(): void;
		renderTrashCount(): void;
		trashMemoController: object;
		vaultTagIndex: object;
		trashCountEls: object[];
		trashViewClosed: boolean;
		trashCountRefreshTimer: number | null;
		viewStateController: { mobileDrawerOpen: boolean; activeNav: string };
		containerEl: object;
		timers: typeof timers;
		flushTimers(): void;
	};
	view.trashViewClosed = false;
	view.trashCountRefreshTimer = null;
	view.viewStateController = { mobileDrawerOpen: false, activeNav: "all" };
	view.containerEl = { win: { setTimeout: (callback: () => void) => { timers.set(++next, callback); return next; },
		clearTimeout: (id: number) => timers.delete(id) } };
	view.timers = timers;
	view.flushTimers = () => { const pending = [...timers.values()]; timers.clear(); for (const callback of pending) callback(); };
	return view;
}

test("生产 Vault 监听覆盖本地操作及同步事件，并注册生命周期清理", async () => {
	await ensureObsidianStub();
	const { default: KnomoPlugin } = await import("../src/main");
	const listeners = new Map<string, (file: { path: string }, oldPath?: string) => void>();
	const calls: unknown[][] = [];
	let registered = 0;
	const plugin = Object.create(KnomoPlugin.prototype) as {
		app: object; settingsService: object; catalogReadService: object;
		registerEvent(ref: unknown): void; registerTrashEvents(store: object): void;
	};
	plugin.app = { vault: { on: (event: string, callback: (file: { path: string }, oldPath?: string) => void) => {
		listeners.set(event, callback); return event;
	} } };
	plugin.settingsService = { getLoadStatus: () => "ready", getSettings: () => ({ monthlyMemoFolder: "Recovery" }) };
	const store = { handleFileChange: (...args: unknown[]) => { calls.push(args); } };
	plugin.registerEvent = () => { registered++; };
	plugin.registerTrashEvents(store);
	for (const event of ["create", "modify", "delete"]) listeners.get(event)!({ path: "Recovery/knomo-trash.json" });
	listeners.get("rename")!({ path: "Other/s1.json" }, "Recovery/knomo-trash.json");
	assert.equal(registered, 4);
	assert.equal(calls.length, 4);
	assert.deepEqual(calls[3], ["Other/s1.json", "Recovery/knomo-trash.json"]);
});
