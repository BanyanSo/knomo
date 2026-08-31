import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { ensureObsidianStub } from "./helpers/obsidianStub";

test("生产源码只暴露无版本 Catalog 模块和存储名称", async () => {
	const sourceFiles = listFiles("src").filter((file) => file.endsWith(".ts"));
	const forbidden = /CatalogV[23]|catalogV[23]|CATALOG_V[23]|catalog-v[23]|catalogShadow|identity-v[23]|catalog\.v[23]Unavailable/u;
	const violations = sourceFiles.flatMap((file) => {
		const relativePath = file.replace(/\\/gu, "/");
		return forbidden.test(relativePath) || forbidden.test(fs.readFileSync(file, "utf8")) ? [relativePath] : [];
	});

	assert.deepEqual(violations, []);
	for (const expected of [
		"src/services/CatalogReadService.ts",
		"src/services/MemoCommandService.ts",
		"src/services/CatalogIndexCoordinator.ts",
		"src/services/DailyMemoWriteGateway.ts",
		"src/services/MonthlyProjection.ts",
	]) {
		assert.equal(fs.existsSync(expected), true, `${expected} should remain the canonical module.`);
	}
	const main = fs.readFileSync("src/main.ts", "utf8");
	assert.equal(main.includes("initializeMonthlyExcludeDefaultSafely"), true);
	for (const serviceName of [
		"CatalogReadService",
		"MemoCommandService",
		"LegacyIndexReader",
		"LegacyIndexMigrationService",
	]) {
		assert.equal(main.includes(serviceName), true, `main.ts should wire ${serviceName}.`);
	}
	const coordinator = fs.readFileSync("src/services/CatalogIndexCoordinator.ts", "utf8");
	assert.equal(coordinator.includes("knomo-catalog-${"), true);
	assert.equal(coordinator.includes("knomo-catalog-v"), false);
	const identityProtocol = fs.readFileSync("src/services/IdentityLedgerProtocol.ts", "utf8");
	assert.equal(identityProtocol.includes("m_[a-f0-9]{32}"), false);
	assert.equal(identityProtocol.includes('case "purge"'), true);
});

test("当前共享协议使用稳定目录且不携带开发期版本字段", async () => {
	await ensureObsidianStub();
	const { IDENTITY_LEDGER_RELATIVE_ROOT } = await import("../src/services/IdentityLedgerProtocol");
	const { KNOMO_SHARED_CONFIG_RELATIVE_ROOT } = await import("../src/services/KnomoSharedConfigProtocol");

	assert.equal(IDENTITY_LEDGER_RELATIVE_ROOT, "_knomo-data/identity");
	assert.equal(KNOMO_SHARED_CONFIG_RELATIVE_ROOT, "_knomo-data/config");
	for (const protocolPath of [
		"src/services/IdentityLedgerProtocol.ts",
		"src/services/IdentityLedgerService.ts",
		"src/services/LegacyIndexMigrationService.ts",
		"src/services/KnomoSharedConfigProtocol.ts",
		"src/services/KnomoSharedConfigService.ts",
		"src/types/identityLedger.ts",
		"src/types/knomoConfig.ts",
	]) {
		const content = fs.readFileSync(protocolPath, "utf8");
		assert.equal(content.includes("schemaVersion"), false, protocolPath);
		assert.equal(content.includes("rendererVersion"), false, protocolPath);
	}
	assert.equal(fs.readFileSync("src/services/LegacyIndexReader.ts", "utf8").includes("schemaVersion"), true);
});

test("全库统计和功能查询只从 Catalog Read Service 获取", () => {
	const view = fs.readFileSync("src/ui/KnomoView.ts", "utf8");
	const readService = fs.readFileSync("src/services/CatalogReadService.ts", "utf8");
	assert.equal(view.includes("getMemoStats(this.memos)"), false);
	assert.equal(view.includes("collectTags(this.memos"), false);
	assert.equal(view.includes("ensureAllMemosLoaded"), false);
	for (const method of [
		"getLibrarySummary",
		"getTagFacets",
		"queryReviewItems",
		"queryRecordStatsDrilldown",
		"getCoverageForRange",
	]) {
		assert.equal(readService.includes(method), true, `${method} should remain a Catalog Read Service API.`);
	}
});

test("Catalog 扫描进度不触发卡片全量刷新，交互路径不构建全库 resolution snapshot", () => {
	const main = fs.readFileSync("src/main.ts", "utf8");
	const readService = fs.readFileSync("src/services/CatalogReadService.ts", "utf8");
	const commandService = fs.readFileSync("src/services/MemoCommandService.ts", "utf8");
	const catalogStore = fs.readFileSync("src/services/MemoCatalogStore.ts", "utf8");
	assert.equal(main.includes("onProgress: (coverage) => this.updateOpenViewCatalogProgress(coverage)"), true);
	assert.equal(main.includes("onProgress: () => this.queueRefreshOpenViews()"), false);
	assert.equal(main.includes("materializeResolutionSnapshot()"), false);
	assert.equal(commandService.includes("materializeResolutionSnapshot()"), false);
	assert.equal(readService.includes("materializeResolutionSnapshot"), false);
	assert.equal(readService.includes("loadResolutionSnapshot"), false);
	assert.equal(catalogStore.includes("saveResolutionSnapshot"), false);
});

test("Daily 写入标题不参与历史读取、Catalog fingerprint 或 Monthly source digest", () => {
	const parser = fs.readFileSync("src/services/DiaryMemoParser.ts", "utf8");
	const coordinator = fs.readFileSync("src/services/CatalogIndexCoordinator.ts", "utf8");
	const monthly = fs.readFileSync("src/services/MonthlyProjectionInputBuilder.ts", "utf8");
	const settingTab = fs.readFileSync("src/ui/KnomoSettingTab.ts", "utf8");
	assert.equal(parser.includes("headings"), false);
	assert.equal(coordinator.includes("headings"), false);
	assert.equal(monthly.includes("headings"), false);
	const saveDailyHeading = settingTab.slice(
		settingTab.indexOf("private async saveDailyHeading"),
		settingTab.indexOf("private async saveMonthlyDateHeadingFormat"),
	);
	assert.equal(saveDailyHeading.includes("rebuildLocalCatalog"), false);
});

test("旧版数据升级从旧 Monthly 目录发现来源，coverage 完成后只建立一次 observation 查找索引", () => {
	const main = fs.readFileSync("src/main.ts", "utf8");
	const migration = fs.readFileSync("src/services/LegacyIndexMigrationService.ts", "utf8");
	const inventory = fs.readFileSync("src/services/LegacyArtifactInventory.ts", "utf8");
	assert.equal(main.includes("() => this.settingsService.getSettings().monthlyMemoFolder"), true);
	assert.equal(migration.indexOf("getCatalogCoverage()") < migration.indexOf("this.loadSource()"), true);
	assert.equal(migration.includes("buildObservationLookup"), true);
	assert.equal(migration.includes("batches.flatMap"), false);
	for (const artifact of ["memo_summary", "time_buoy_index", "time_buoy_state", "backup"]) {
		assert.equal(inventory.includes(`artifactKind: \"${artifact}\"`), true, artifact);
	}
});

test("Monthly 复用按月 Daily inventory，并与 Catalog、旧版数据升级共享低优先级队列", () => {
	const main = fs.readFileSync("src/main.ts", "utf8");
	const monthlyInput = fs.readFileSync("src/services/MonthlyProjectionInputBuilder.ts", "utf8");
	const monthlyCoordinator = fs.readFileSync("src/services/MonthlyProjectionCoordinator.ts", "utf8");
	const catalogCoordinator = fs.readFileSync("src/services/CatalogIndexCoordinator.ts", "utf8");
	const legacyMigration = fs.readFileSync("src/services/LegacyIndexMigrationService.ts", "utf8");
	const settingTab = fs.readFileSync("src/ui/KnomoSettingTab.ts", "utf8");
	assert.equal((main.match(/workQueue: lowPriorityWorkQueue/gu) ?? []).length, 3);
	assert.equal(main.indexOf("catalogIndexCoordinator?.initialize()")
		< main.indexOf("monthlyProjectionCoordinator?.initialize()"), true);
	assert.equal(monthlyInput.includes("dailyInventory.listPeriod(period)"), true);
	assert.equal(monthlyCoordinator.includes("invalidatePeriods(await this.options.inputBuilder.listPeriods())"), false);
	assert.equal(monthlyCoordinator.includes("await this.yieldControl()"), true);
	const saveDataRoot = settingTab.slice(
		settingTab.indexOf("private async saveKnomoDataRoot"),
		settingTab.indexOf("private async toggleMonthlyMemosExcludeRule"),
	);
	assert.equal(saveDataRoot.includes("rebuildPeriod"), false);
	assert.equal(catalogCoordinator.includes("runLowPriorityTask(() => this.drainSlice())"), true);
	assert.equal(legacyMigration.includes("runLowPriorityTask(() => this.runOnce"), true);
});

test("Identity 与共享配置监听等待 layout ready，启动后续阶段遵守卸载取消信号", () => {
	const main = fs.readFileSync("src/main.ts", "utf8");
	const listenerStart = main.slice(
		main.indexOf("this.app.workspace.onLayoutReady(() => {"),
		main.indexOf("this.legacyIndexMigrationService.start"),
	);
	const afterLayoutInitialization = main.slice(
		main.indexOf("private async initializeAfterLayoutWithCatalogSafely"),
		main.indexOf("private async showLegacyMigrationCompletionNotice"),
	);

	assert.equal(listenerStart.includes("identityLedgerService.start"), true);
	assert.equal(listenerStart.includes("knomoSharedConfigService.start"), true);
	assert.equal(listenerStart.includes("lowPriorityWorkQueue.signal.aborted"), true);
	assert.equal(main.includes("cancellationSignal: lowPriorityWorkQueue.signal"), true);
	assert.equal(main.includes("settingTab.refreshAttentionIfVisible()"), true);
	assert.equal(afterLayoutInitialization.includes("const isCancelled = () => cancellationSignal?.aborted === true"), true);
});

test("启动后续工作只由 Catalog settle 调度，且无 pending Identity 时不读取全量 observation", () => {
	const main = fs.readFileSync("src/main.ts", "utf8");
	const reconcile = main.slice(
		main.indexOf("const reconcileIdentityLedger = async () =>"),
		main.indexOf("const projectionInputBuilder"),
	);
	const runtimeInitialization = main.slice(
		main.indexOf("this.runtimeInitializationPromise ="),
		main.indexOf("this.app.workspace.onLayoutReady(() =>", main.indexOf("this.runtimeInitializationPromise =")),
	);
	const catalogSettled = main.slice(
		main.indexOf("onCatalogSettled: async () =>"),
		main.indexOf("dailyInventory,", main.indexOf("onCatalogSettled: async () =>")),
	);

	assert.ok(reconcile.indexOf("hasPendingCreates()") < reconcile.indexOf("loadObservationBatches()"));
	assert.ok(reconcile.indexOf("hasPendingDeletes()") < reconcile.indexOf("loadObservationBatches()"));
	assert.doesNotMatch(runtimeInitialization, /legacyIndexMigrationService\?\.run|reconcileIdentityLedger/u);
	assert.match(catalogSettled, /legacyIndexMigrationService\?\.run/u);
	assert.match(catalogSettled, /reconcileIdentityLedger/u);
});

function listFiles(root: string): string[] {
	return fs.readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
		const fullPath = path.join(root, entry.name);
		return entry.isDirectory() ? listFiles(fullPath) : [fullPath];
	});
}
