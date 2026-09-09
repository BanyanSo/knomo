import test from "node:test";
import assert from "node:assert/strict";
import { ensureObsidianStub } from "./helpers/obsidianStub";

test("声明式设置未调用 display 时也更新迁移入口，并清除已就绪的处理行", async () => {
 await ensureObsidianStub();
 const { KnomoSettingTab } = await import("../src/ui/KnomoSettingTab");
 const { t } = await import("../src/i18n");
 const tab = Object.create(KnomoSettingTab.prototype) as InstanceType<typeof KnomoSettingTab>;
 let currentConfiguration = "missing";
 let legacyMigration = "idle";
 let definitions: ReturnType<InstanceType<typeof KnomoSettingTab>["getSettingDefinitions"]> = [];
 Object.assign(tab, {
  settingsVisible: false,
  catalogReadService: { getRuntimeAttentionSnapshot: () => ({ currentConfiguration, legacyMigration, monthly: "ready", catalogLifecycle: { state: "ready" } }) },
  knomoCurrentConfigService: { getStatus: () => currentConfiguration },
  legacyTrashMigrationService: { getReport: () => ({ status: legacyMigration }) },
  update: () => { definitions = tab.getSettingDefinitions(); },
  display: () => { throw new Error("Declarative settings must not use display"); },
 });
 const attention = () => definitions[0] as { visible: boolean; items: { name: string }[] };
 tab.refreshAttentionIfVisible();
 assert.deepEqual(attention().items.map(item => item.name), [t("settings.currentConfig.name")]);
 currentConfiguration = "ready";
 legacyMigration = "recovery_required";
 tab.refreshAttentionIfVisible();
 assert.deepEqual(attention().items.map(item => item.name), [t("settings.legacyMigration.name")]);
 legacyMigration = "ready";
 tab.refreshAttentionIfVisible();
 assert.equal(attention().visible, false);
 assert.deepEqual(attention().items, []);
});

test("旧版设置隐藏时不绘制，打开时刷新", async () => {
 await ensureObsidianStub();
 const { KnomoSettingTab } = await import("../src/ui/KnomoSettingTab");
 const tab = Object.create(KnomoSettingTab.prototype) as InstanceType<typeof KnomoSettingTab>;
 let displays = 0;
 Object.assign(tab, { settingsVisible: false, update: undefined, display: () => { displays++; } });
 tab.refreshAttentionIfVisible();
 assert.equal(displays, 0);
 Object.assign(tab, { settingsVisible: true });
 tab.refreshAttentionIfVisible();
 assert.equal(displays, 1);
});

