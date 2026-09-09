import assert from "node:assert/strict";
import test from "node:test";
import { ensureObsidianStub } from "./helpers/obsidianStub";
import { initializeCatalogRuntime } from "../src/services/CatalogStartup";

test("正式旧插件设置直接保存为当前值并校验，设备偏好不成为迁移完成条件", async () => {
	const f = await fixture();
	f.setSaved({ monthlyMemoFolder: "Legacy", dailyHeading: "## Old", memoTimeFormat: "HH:mm", desktopSidebarWidth: 333 });
	await f.settings.loadSettings();
	await f.settings.persistLegacyConfiguration();
	const saved = f.saved() as { settings: Record<string, unknown> };
	assert.equal(saved.settings.monthlyMemoFolder, "Legacy");
	assert.equal(saved.settings.dailyHeading, "## Old");
	assert.equal(saved.settings.memoTimeFormat, "HH:mm");
	assert.equal(saved.settings.desktopSidebarWidth, undefined);
	assert.equal(f.local().desktopSidebarWidth, 333);
	f.setSaved({ monthlyMemoFolder: "External" });
	await assert.rejects(() => f.settings.persistLegacyConfiguration(), /externally/u);
});

test("Catalog 启动不等待配置、Identity/Trash/迁移；自身失败与取消仍生效", async () => {
	const calls: string[] = [];
	const options = {
		initializeCatalog: async () => { calls.push("catalog"); }, primeCatalog: async () => { calls.push("query"); },
		initializeConfiguration: () => new Promise<void>(() => undefined), initializeMonthly: async () => { calls.push("monthly"); },
		initializeRecovery: async () => { throw new Error("Identity/Trash unavailable"); },
		isCancelled: () => false, onAuxiliaryError: () => { calls.push("recovery-error"); },
	};
	assert.equal(await initializeCatalogRuntime(options), true);
	await Promise.resolve();
	assert.ok(calls.includes("query"));
	assert.equal(calls.includes("monthly"), false);
	await assert.rejects(() => initializeCatalogRuntime({ ...options, initializeCatalog: async () => { throw new Error("catalog failed"); } }), /catalog failed/u);
	assert.equal(await initializeCatalogRuntime({ ...options, isCancelled: () => true }), false);
});

test("无 config segments 时当前值可用，locale 固定，设备偏好只写本地", async () => {
	const f = await fixture();
	await f.current.initialize();
	assert.equal(f.current.getStatus(), "ready");
	assert.equal(f.current.getEffectiveConfig().monthly.locale, "en");
	await f.settings.updateSettings({ monthlyMemoFolder: "Archive" });
	await f.current.refreshLocalConfig();
	assert.equal(f.current.getEffectiveConfig().monthly.folder, "Archive");
	const before = JSON.stringify(f.saved());
	await f.settings.updateSettings({ desktopSidebarWidth: 321, pinnedTags: ["local"] });
	assert.equal(JSON.stringify(f.saved()), before);
	assert.equal(f.local()["desktopSidebarWidth"], 321);
	await f.settings.loadSettings();
	assert.equal(f.settings.getSettings().desktopSidebarWidth, 321);
});

test("配置读取失败不覆盖已有值且不阻断 Daily 范围，写入和 Monthly 暂停", async () => {
	const f = await fixture();
	await f.current.initialize();
	f.setReadFailure(true);
	await assert.rejects(() => f.settings.loadSettings());
	assert.equal(f.current.isCoverageComplete(), true);
	assert.equal(f.current.isMonthlyProjectionAllowed(), false);
	await assert.rejects(() => f.settings.updateSettings({ dailyHeading: "## changed" }), /unreadable/u);
	await f.settings.updateSettings({ desktopSidebarCollapsed: true });
	f.setReadFailure(false);
	await f.current.reloadConfiguration();
	assert.equal(f.current.getStatus(), "ready");
});

async function fixture() {
	await ensureObsidianStub();
	const { SettingsService } = await import("../src/services/SettingsService");
	const { KnomoCurrentConfigService } = await import("../src/services/KnomoCurrentConfigService");
	const { InMemoryVault } = await import("./helpers/InMemoryVault");
	const vault = new InMemoryVault();
	Object.assign(vault.app.vault, { getConfig: () => [], setConfig: async () => undefined });
	let saved: unknown = null;
	let local: Record<string, unknown> = {};
	let failure = false;
	let discardSave = false;
	const plugin = { app: { ...vault.app, loadLocalStorage: () => local, saveLocalStorage: (_key: string, value: Record<string, unknown>) => { local = value; } },
		loadData: async () => { if (failure) throw new Error("read failed"); return saved; }, saveData: async (value: unknown) => { if (!discardSave) saved = value; } };
	const settings = new SettingsService(plugin as never);
	await settings.loadSettings();
	const daily = { onChanged: () => () => undefined, getConfig: () => ({ folder: "Daily", format: "YYYY-MM-DD" }), loadConfig: async () => ({ folder: "Daily", format: "YYYY-MM-DD" }) };
	const current = new KnomoCurrentConfigService(settings, daily as never, () => "en");
	return { settings, current, saved: () => saved, local: () => local,
		setSaved: (value: unknown) => { saved = value; }, discardSaves: () => { discardSave = true; }, setReadFailure: (value: boolean) => { failure = value; } };
}

test("当前配置保存未通过读回验证时不得开放依赖功能", async () => {
	const f = await fixture();
	f.discardSaves();
	await assert.rejects(() => f.current.initialize(), /read-back/u);
	assert.equal(f.current.getStatus(), "unavailable");
	assert.equal(f.current.isCoverageComplete(), true);
	assert.equal(f.current.isMonthlyProjectionAllowed(), false);
});

test("设备 UI 更新不触发 Catalog/Monthly 配置失效，行为配置改变才通知", async () => {
	const f = await fixture();
	await f.current.initialize();
	let changes = 0;
	f.current.start({ register: () => undefined } as never, () => { changes++; });
	await f.settings.updateSettings({ pinnedTags: ["a"] });
	assert.equal(changes, 0);
	await f.settings.updateSettings({ monthlyMemoFolder: "Changed" });
	assert.equal(changes, 1);
});

test("外部配置先到时拒绝用旧内存值覆盖；重读后才可保存", async () => {
	const f = await fixture();
	await f.current.initialize();
	const saved = f.saved() as { settings: Record<string, unknown> };
	f.setSaved({ ...saved, settings: { ...saved.settings, monthlyMemoFolder: "Remote" } });
	await assert.rejects(() => f.settings.updateSettings({ monthlyDateOrder: "desc" }), /changed externally/u);
	assert.equal(f.current.isMonthlyProjectionAllowed(), false);
	assert.equal((f.saved() as typeof saved).settings.monthlyMemoFolder, "Remote");
	await f.current.reloadConfiguration();
	assert.equal(f.current.getEffectiveConfig().monthly.folder, "Remote");
});

test("已知 Obsidian Daily 配置读取暂时失败可继续浏览，显式禁用则清除范围", async () => {
	await ensureObsidianStub();
	const { DailyNotesProvider } = await import("../src/services/DailyNotesProvider");
	let runtime: unknown = { enabled: true, instance: { options: { folder: "Daily" } } };
	const provider = new DailyNotesProvider({ internalPlugins: { getPluginById: () => runtime },
		vault: { configDir: ".obsidian", adapter: { read: async () => { throw new Error("I/O"); } } } } as never);
	let changes = 0;
	provider.onChanged(() => { changes++; });
	assert.equal(provider.getConfig()?.folder, "Daily");
	runtime = null;
	assert.equal((await provider.loadConfig())?.folder, "Daily");
	assert.equal(changes, 1);
	runtime = { enabled: false };
	assert.equal(await provider.loadConfig(), null);
	assert.equal(changes, 2);
});
