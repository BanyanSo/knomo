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
let Current: typeof import("../src/services/KnomoCurrentConfigService").KnomoCurrentConfigService;
let Monthly: typeof import("../src/services/MonthlyProjectionCoordinator").MonthlyProjectionCoordinator;
let Bootstrap: typeof import("../src/services/KnomoStartupBootstrapService").KnomoStartupBootstrapService;

before(async () => {
	await ensureObsidianStub();
	({ default: Plugin } = await import("../src/main"));
	({ SettingsService: Settings } = await import("../src/services/SettingsService"));
	({ DailyNotesProvider: Daily } = await import("../src/services/DailyNotesProvider"));
	({ IndexedDbMemoCatalogStore: Indexed } = await import("../src/services/IndexedDbMemoCatalogStore"));
	({ InMemoryMemoCatalogStore: Memory } = await import("../src/services/MemoCatalogStore"));
	({ CatalogIndexCoordinator: Coordinator } = await import("../src/services/CatalogIndexCoordinator"));
	({ KnomoCurrentConfigService: Current } = await import("../src/services/KnomoCurrentConfigService"));
	({ MonthlyProjectionCoordinator: Monthly } = await import("../src/services/MonthlyProjectionCoordinator"));
	({ KnomoStartupBootstrapService: Bootstrap } = await import("../src/services/KnomoStartupBootstrapService"));
});

function deferred() {
	let resolve!: () => void;
	let reject!: (reason: unknown) => void;
	const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
	return { promise, resolve, reject };
}

// 只推进一个事件循环边界，不依赖任意毫秒延迟。
const turn = () => new Promise<void>(resolve => setImmediate(resolve));

function harness(t: TestContext, dailyState: "ready" | "disabled" | "unavailable" = "ready", p2 = false) {
	const settings = deferred(), daily = deferred(), db = deferred(), defaults = deferred(), background = deferred();
	const monthly = deferred();
	if (!p2) monthly.resolve();
	const calls: string[] = [];
	const layouts: Array<() => void> = [];
	const queries: Array<Promise<CatalogQueryPage>> = [];
	let primary: InstanceType<typeof Indexed> | undefined;
	let provider: InstanceType<typeof Daily> | undefined;
	let current: InstanceType<typeof Current> | undefined;
	let bootstrap: InstanceType<typeof Bootstrap> | undefined;
	let saved: unknown = p2 ? { dailyHeading: "## Capture", memoTimeFormat: "HH:mm" } : { timeBuoyEnabled: false };
	const app = {
		vault: { configDir: ".obsidian", getName: () => t.name, on: () => ({}),
			adapter: { read: async () => { throw new Error("Daily unavailable"); } },
			getConfig: () => [], setConfig: async () => undefined },
		metadataCache: { on: () => ({}) },
		workspace: { containerEl: { win: { setTimeout, clearTimeout }, doc: { visibilityState: "visible", body: { removeClass() {}, findAll: () => [] } } },
			on: () => ({}), getLeavesOfType: () => [], onLayoutReady: (callback: () => void) => layouts.push(callback) },
		...(dailyState === "unavailable" ? {} : { internalPlugins: { plugins: {
			"daily-notes": { enabled: dailyState === "ready", instance: dailyState === "ready" ? { options: { folder: "Daily", format: "YYYY-MM-DD" } } : undefined },
		} } }),
	} as unknown as App;
	const plugin = new Plugin(app, {} as PluginManifest);
	Object.assign(plugin, {
		app, manifest: { version: "test" }, loadData: async () => saved,
		saveData: async (value: unknown) => { saved = value; },
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
	const timeDefault = Settings.prototype.initializeTimeBuoyDefault;
	t.mock.method(Settings.prototype, "initializeTimeBuoyDefault", async function (this: InstanceType<typeof Settings>) {
		calls.push("defaults");
		await defaults.promise;
		return p2 ? timeDefault.call(this) : this.getSettings();
	});
	const monthlyDefault = Settings.prototype.initializeMonthlyExcludeDefault;
	t.mock.method(Settings.prototype, "initializeMonthlyExcludeDefault", async function (this: InstanceType<typeof Settings>) {
		calls.push("monthly-defaults");
		await monthly.promise;
		return p2 ? monthlyDefault.call(this) : this.getSettings();
	});
	const initialize = Current.prototype.initialize;
	t.mock.method(Current.prototype, "initialize", function (this: InstanceType<typeof Current>) {
		current = this;
		return initialize.call(this);
	});
	const verify = Settings.prototype.verifyCurrentSettings;
	t.mock.method(Settings.prototype, "verifyCurrentSettings", function (this: InstanceType<typeof Settings>, ...args: Parameters<typeof verify>) {
		calls.push("verify");
		return verify.apply(this, args);
	});
	const bootstrapInitialize = Bootstrap.prototype.initialize;
	t.mock.method(Bootstrap.prototype, "initialize", function (this: InstanceType<typeof Bootstrap>, ...args: Parameters<typeof bootstrapInitialize>) {
		bootstrap = this;
		return bootstrapInitialize.apply(this, args);
	});
	t.mock.method(Monthly.prototype, "initialize", async () => { calls.push("monthly"); });
	t.mock.method(Monthly.prototype, "handleConfigurationChanged", async () => { calls.push("monthly-change"); });
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
	// 受控 inventory，不依赖真实文件扫描耗时。
	t.mock.method(Coordinator.prototype, "initialize", () => background.promise);
	t.after(() => { plugin.unload(); background.resolve(); });
	return { plugin, calls, settings, daily, db, defaults, queries, layouts, monthly, background,
		getCurrent: () => current!, getBootstrap: () => bootstrap!, saved: () => saved,
		layout: () => { Object.assign(app.workspace, { layoutReady: true }); layouts.splice(0).forEach(callback => callback()); },
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
	assert.ok(h.calls.indexOf("monthly-defaults") > h.calls.indexOf("defaults"));
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

test("P2 默认值与核验串行且复用，配置不等待 inventory，Monthly 等待两者", async t => {
	const h = harness(t, "ready", true);
	const loading = h.plugin.onload();
	h.release();
	await loading;
	h.layout();
	await turn();
	assert.equal(h.calls.filter(call => call === "monthly-defaults").length, 1);
	assert.equal(h.calls.includes("verify"), false);
	assert.equal(h.calls.includes("monthly"), false);
	const sameAttempt = h.getCurrent().initialize();
	h.monthly.resolve();
	await sameAttempt;
	await turn();
	assert.equal(h.getCurrent().getStatus(), "ready");
	assert.equal(h.getBootstrap().getSnapshot().status, "ready");
	assert.equal(h.calls.filter(call => call === "verify").length, 1);
	assert.equal(h.calls.includes("monthly"), false);
	const saved = h.saved() as { settings: Record<string, unknown> };
	assert.equal(saved.settings.dailyHeading, "## Capture");
	assert.equal(saved.settings.memoTimeFormat, "HH:mm");
	assert.equal(saved.settings.timeBuoyEnabled, true);
	assert.equal(saved.settings.excludeMonthlyMemosFromObsidian, true);
	assert.equal(saved.settings.currentConfigInitialized, true);
	h.background.resolve();
	await turn();
	assert.equal(h.calls.filter(call => call === "monthly").length, 1);
	assert.equal(h.calls.filter(call => call === "verify").length, 1);
});

test("P2 Catalog inventory 失败不阻断独立配置和 Bootstrap 就绪", async t => {
	const h = harness(t, "ready", true);
	const loading = h.plugin.onload(); h.release(); await loading;
	h.layout();
	h.background.reject(new Error("inventory failed"));
	h.monthly.resolve();
	await turn();
	assert.equal(h.getCurrent().getStatus(), "ready");
	assert.equal(h.getBootstrap().getSnapshot().status, "ready");
	assert.equal(h.calls.includes("monthly"), false);
});

test("P2 排除规则失败但 Settings 可读时继续核验并保留失败提示", async t => {
	const h = harness(t, "ready", true);
	Object.assign(h.plugin.app.vault, { getConfig: () => { throw new Error("exclude unreadable"); } });
	const loading = h.plugin.onload(); h.release(); await loading;
	h.monthly.resolve();
	await h.getCurrent().initialize();
	assert.equal(h.plugin.settingsService.hasMonthlyExcludeInitializationFailure(), true);
	assert.equal(h.getCurrent().getStatus(), "ready");
	assert.equal(h.calls.filter(call => call === "verify").length, 1);
});

test("P2 排除默认值持久化失败不标记 ready，Catalog 只读仍可用", async t => {
	const h = harness(t, "ready", true);
	const loading = h.plugin.onload(); h.release(); await loading;
	h.plugin.saveData = async () => { throw new Error("settings write failed"); };
	h.monthly.resolve();
	await assert.rejects(h.getCurrent().initialize());
	assert.notEqual(h.getCurrent().getStatus(), "ready");
	assert.equal((await h.queries[0])!.lifecycle.state, "ready");
	assert.equal(h.calls.includes("monthly"), false);
});

test("P2 显式 reload 等待旧默认值终态，再串行读取与核验", async t => {
	const h = harness(t, "ready", true);
	const loading = h.plugin.onload(); h.release(); await loading;
	const retry = h.getCurrent().reloadConfiguration();
	await turn();
	assert.equal(h.calls.filter(call => call === "settings").length, 1);
	assert.equal(h.calls.includes("verify"), false);
	h.monthly.resolve();
	await retry;
	assert.equal(h.calls.filter(call => call === "settings").length, 2);
	assert.equal(h.calls.filter(call => call === "verify").length, 2);
	assert.equal(h.getCurrent().getStatus(), "ready");
});

test("P2 Monthly 默认值等待中卸载，后到结果不再核验或发布就绪", async t => {
	const h = harness(t, "ready", true);
	const loading = h.plugin.onload(); h.release(); await loading;
	const pending = h.getCurrent().initialize();
	h.plugin.unload(); h.monthly.resolve();
	await assert.rejects(pending, /cancelled/);
	assert.equal(h.calls.includes("verify"), false);
	assert.notEqual(h.getCurrent().getStatus(), "ready");
	assert.notEqual(h.getBootstrap().getSnapshot().status, "ready");
});
