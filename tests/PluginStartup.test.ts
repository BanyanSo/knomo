import assert from "node:assert/strict";
import test, { before, type TestContext } from "node:test";
import "fake-indexeddb/auto";
import type { App, PluginManifest } from "obsidian";
import { ensureObsidianStub } from "./helpers/obsidianStub";
import type { CatalogQueryPage } from "../src/types/catalog";

let Plugin: typeof import("../src/main").default;
let Settings: typeof import("../src/services/SettingsService").SettingsService;
let Daily: typeof import("../src/services/DailyNotesProvider").DailyNotesProvider;
let Indexed: typeof import("../src/services/IndexedDbMemoCatalogStore").IndexedDbMemoCatalogStore;
let Memory: typeof import("../src/services/MemoCatalogStore").InMemoryMemoCatalogStore;
let Coordinator: typeof import("../src/services/CatalogIndexCoordinator").CatalogIndexCoordinator;

before(async () => {
	await ensureObsidianStub();
	({ default: Plugin } = await import("../src/main"));
	({ SettingsService: Settings } = await import("../src/services/SettingsService"));
	({ DailyNotesProvider: Daily } = await import("../src/services/DailyNotesProvider"));
	({ IndexedDbMemoCatalogStore: Indexed } = await import("../src/services/IndexedDbMemoCatalogStore"));
	({ InMemoryMemoCatalogStore: Memory } = await import("../src/services/MemoCatalogStore"));
	({ CatalogIndexCoordinator: Coordinator } = await import("../src/services/CatalogIndexCoordinator"));
});

function deferred() {
	let resolve!: () => void;
	let reject!: (reason: unknown) => void;
	const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
	return { promise, resolve, reject };
}

// 只推进一个事件循环边界，不依赖任意毫秒延迟。
const turn = () => new Promise<void>(resolve => setImmediate(resolve));

function harness(t: TestContext, dailyState: "ready" | "disabled" | "unavailable" = "ready") {
	const settings = deferred(), daily = deferred(), db = deferred(), defaults = deferred(), background = deferred();
	const calls: string[] = [];
	const layouts: Array<() => void> = [];
	const queries: Array<Promise<CatalogQueryPage>> = [];
	let primary: InstanceType<typeof Indexed> | undefined;
	let provider: InstanceType<typeof Daily> | undefined;
	const app = {
		vault: { configDir: ".obsidian", getName: () => t.name, on: () => ({}),
			adapter: { read: async () => { throw new Error("Daily unavailable"); } } },
		metadataCache: { on: () => ({}) },
		workspace: { containerEl: { win: { setTimeout, clearTimeout }, doc: { visibilityState: "visible", body: { removeClass() {}, findAll: () => [] } } },
			on: () => ({}), getLeavesOfType: () => [], onLayoutReady: (callback: () => void) => layouts.push(callback) },
		...(dailyState === "unavailable" ? {} : { internalPlugins: { plugins: {
			"daily-notes": { enabled: dailyState === "ready", instance: dailyState === "ready" ? { options: { folder: "Daily", format: "YYYY-MM-DD" } } : undefined },
		} } }),
	} as unknown as App;
	const plugin = new Plugin(app, {} as PluginManifest);
	Object.assign(plugin, {
		app, manifest: { version: "test" }, loadData: async () => ({ timeBuoyEnabled: false }),
		registerView: () => {
			calls.push("view");
			// 模拟 layout-ready 之前恢复视图的首次真实 store 查询。
			const catalog = (plugin as unknown as { memoCatalogService: import("../src/services/MemoCatalogService").MemoCatalogService }).memoCatalogService;
			queries.push(catalog.query({ limit: 10 }));
		},
		registerHoverLinkSource() {}, addRibbonIcon() {}, addCommand() {}, registerObsidianProtocolHandler() {}, addSettingTab() {},
	});
	const loadSettings = Settings.prototype.loadSettings;
	t.mock.method(Settings.prototype, "loadSettings", async function (this: InstanceType<typeof Settings>) {
		calls.push("settings");
		await settings.promise;
		return loadSettings.call(this);
	});
	t.mock.method(Settings.prototype, "initializeTimeBuoyDefault", async function (this: InstanceType<typeof Settings>) {
		calls.push("defaults");
		await defaults.promise;
		return this.getSettings();
	});
	t.mock.method(Settings.prototype, "initializeMonthlyExcludeDefault", async function (this: InstanceType<typeof Settings>) {
		calls.push("monthly-defaults");
		return this.getSettings();
	});
	const loadDaily = Daily.prototype.loadConfig;
	t.mock.method(Daily.prototype, "loadConfig", async function (this: InstanceType<typeof Daily>) {
		provider = this;
		calls.push("daily");
		await daily.promise;
		return loadDaily.call(this);
	});
	const open = Indexed.prototype.open;
	t.mock.method(Indexed.prototype, "open", async function (this: InstanceType<typeof Indexed>) {
		primary = this;
		calls.push("db");
		await db.promise;
		await open.call(this);
		calls.push("db-ready");
	});
	const close = Indexed.prototype.close;
	t.mock.method(Indexed.prototype, "close", function (this: InstanceType<typeof Indexed>) {
		calls.push("close");
		close.call(this);
	});
	// 停在 P2/inventory 入口，P1 测试不执行后续阶段。
	t.mock.method(Coordinator.prototype, "initialize", () => background.promise);
	t.after(() => { plugin.unload(); background.resolve(); });
	return { plugin, calls, settings, daily, db, defaults, queries, layouts,
		getPrimary: () => primary!, getDaily: () => provider!,
		release: () => { settings.resolve(); daily.resolve(); db.resolve(); defaults.resolve(); } };
}

test("P1 三分支先启动再汇合，默认值仍等待设置，视图恢复查询等待 DB", async t => {
	const h = harness(t);
	const loading = h.plugin.onload();
	await turn();
	assert.deepEqual(h.calls, ["settings", "daily", "db"]);
	h.settings.resolve();
	await turn();
	assert.equal(h.calls.includes("defaults"), true);
	h.daily.resolve();
	h.defaults.resolve();
	await turn();
	assert.equal(h.calls.includes("view"), false);
	h.db.resolve();
	await loading;
	assert.equal(h.calls.filter(call => call === "daily").length, 1);
	assert.ok(h.calls.indexOf("view") > h.calls.indexOf("db-ready"));
	const [page] = await Promise.all(h.queries);
	assert.equal(page!.lifecycle.state, "ready");
	assert.notEqual(page!.coverage.kind, "complete");
	assert.equal(h.calls.includes("monthly-defaults"), false);
	assert.ok(h.layouts.length > 0);
});

for (const dailyState of ["disabled", "unavailable"] as const) {
	test(`P1 Daily ${dailyState} 只读取一次并保留未知配置`, async t => {
		const h = harness(t, dailyState);
		const loading = h.plugin.onload();
		h.release();
		await loading;
		assert.equal(h.calls.filter(call => call === "daily").length, 1);
		assert.equal(h.getDaily().getConfig(), null);
		assert.equal((await h.queries[0])!.lifecycle.state, "ready");
	});
}

test("P1 设置失败不初始化时间浮标默认值，其余分支仍完成", async t => {
	const h = harness(t);
	h.plugin.loadData = async () => { throw new Error("settings unreadable"); };
	const loading = h.plugin.onload();
	h.settings.resolve();
	h.daily.resolve(); h.db.resolve();
	await loading;
	assert.equal(h.calls.includes("defaults"), false);
	assert.equal(h.plugin.settingsService.getLoadStatus(), "unavailable");
	assert.equal(h.calls.filter(call => call === "daily").length, 1);
	assert.equal((await h.queries[0])!.lifecycle.state, "ready");
});

test("P1 DB 已打开仍等待时间浮标默认值，默认值失败保留现有关闭语义", async t => {
	const h = harness(t);
	const loading = h.plugin.onload();
	h.settings.resolve(); h.daily.resolve(); h.db.resolve();
	await turn();
	await h.getPrimary().open();
	assert.equal(h.calls.includes("defaults"), true);
	assert.equal(h.calls.includes("view"), false);
	h.defaults.reject(new Error("default persistence failed"));
	await loading;
	assert.equal(h.plugin.settingsService.getSettings().timeBuoyEnabled, false);
	assert.equal((await h.queries[0])!.lifecycle.state, "ready");
});

test("P1 DB 已打开但设置仍在等待时卸载，立即关闭连接且不再初始化默认值", async t => {
	const h = harness(t);
	const loading = h.plugin.onload();
	h.db.resolve();
	await h.getPrimary().open();
	h.plugin.unload();
	assert.equal(h.getPrimary().getLifecycle().writable, false);
	h.release();
	await loading;
	assert.equal(h.calls.includes("view"), false);
	assert.equal(h.calls.includes("defaults"), false);
});

test("P1 后续装配抛错也关闭已打开的数据库", async t => {
	const h = harness(t);
	h.plugin.registerView = () => { throw new Error("view registration failed"); };
	const loading = h.plugin.onload();
	h.release();
	await assert.rejects(loading, /view registration failed/);
	assert.equal(h.getPrimary().getLifecycle().writable, false);
});

test("P1 DB 拒绝立即处理并降级，慢设置期间无未处理 rejection", async t => {
	const h = harness(t);
	const loading = h.plugin.onload();
	h.db.reject(new Error("IndexedDB unavailable"));
	await turn();
	h.settings.resolve(); h.daily.resolve(); h.defaults.resolve();
	await loading;
	assert.equal((await h.queries[0])!.lifecycle.persistent, false);
	assert.notEqual((await h.queries[0])!.coverage.kind, "complete");
});

for (const fallback of [false, true]) {
	test(`P1 等待 open 时卸载，晚到的 ${fallback ? "fallback" : "DB"} 关闭且不注册视图`, async t => {
		const h = harness(t);
		const loading = h.plugin.onload();
		await turn();
		h.plugin.unload();
		if (fallback) h.db.reject(new Error("IndexedDB unavailable"));
		h.release();
		await loading;
		assert.equal(h.calls.includes("view"), false);
		assert.equal(h.calls.includes("defaults"), false);
		assert.equal(h.layouts.length, 0);
		assert.ok(h.calls.includes("close"));
		assert.equal(h.getPrimary().getLifecycle().writable, false);
		const catalog = (h.plugin as unknown as { memoCatalogService: import("../src/services/MemoCatalogService").MemoCatalogService }).memoCatalogService;
		await assert.rejects(catalog.query({ limit: 10 }));
	});
}

test("P1 DB 与 fallback 均失败时及时收尾，慢设置完成后不继续装配", async t => {
	const h = harness(t);
	t.mock.method(Memory.prototype, "open", async () => { throw new Error("fallback failed"); });
	const loading = h.plugin.onload();
	const rejected = assert.rejects(loading, /fallback failed/);
	h.db.reject(new Error("primary failed"));
	await turn();
	h.release();
	await rejected;
	await turn();
	assert.ok(h.calls.includes("close"));
	assert.equal(h.calls.includes("defaults"), false);
	assert.equal(h.calls.includes("view"), false);
});
