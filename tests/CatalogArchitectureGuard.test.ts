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
		"LegacyTrashMigrationService",
		"IndependentTrashService",
	]) {
		assert.equal(main.includes(serviceName), true, `main.ts should wire ${serviceName}.`);
	}
	assert.equal(main.includes("sessionWriterId"), false);
	assert.equal(main.includes("getWriterId: () => localWriterIdentityService.getWriterId()"), false);
	const coordinator = fs.readFileSync("src/services/CatalogIndexCoordinator.ts", "utf8");
	assert.equal(coordinator.includes("knomo-catalog-${"), true);
	assert.equal(coordinator.includes("knomo-catalog-v"), false);
});

test("生产装配停用开发期持久化，tracked contract 不读取本地 architecture", () => {
	const main = fs.readFileSync("src/main.ts", "utf8");
	for (const retired of [
		"IdentityPublicationStore",
		"KnomoSharedReplicaStore",
		"KnomoSharedStorageService",
		"KnomoSharedStorageCoordinator",
		"SharedReviewService",
		"CausalSharedConfigService",
		"SharedStorageDataRootService",
	]) {
		assert.equal(main.includes(retired), false, `main.ts must not wire retired ${retired}.`);
	}
	assert.equal(main.includes("new IdentityReceiptStore(this.app"), false);
	assert.equal(main.includes("new KnomoBootstrapStateStore("), false);
	assert.equal(main.includes("currentStateStore: new KnomoCurrentStateStore("), false);
	assert.equal(main.includes("getIdentityLedgerRootPath(settings.knomoDataRoot)"), false);
	assert.equal(main.includes("getKnomoCurrentConfigRootPath(settings.knomoDataRoot)"), false);

	const trackedContractFiles = [
		...listFiles("src"),
		...listFiles("scripts"),
		...listFiles("tests"),
	].filter((file) => /\.(?:ts|mts|cts|js|mjs|cjs)$/u.test(file));
	const executableDependency = /(?:from|import\s*\()[^\n]*(?:\.\.\/)+(?:architecture|docs\/architecture)(?:\/|["'])/u;
	assert.deepEqual(trackedContractFiles.filter((file) => executableDependency.test(
		fs.readFileSync(file, "utf8").replace(/\\/gu, "/"),
	)), []);
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

test("Monthly 与 Catalog 共享低优先级队列，显式旧版迁移独立分片", () => {
	const main = fs.readFileSync("src/main.ts", "utf8");
	const monthlyInput = fs.readFileSync("src/services/MonthlyProjectionInputBuilder.ts", "utf8");
	const monthlyCoordinator = fs.readFileSync("src/services/MonthlyProjectionCoordinator.ts", "utf8");
	const catalogCoordinator = fs.readFileSync("src/services/CatalogIndexCoordinator.ts", "utf8");
	const settingTab = fs.readFileSync("src/ui/KnomoSettingTab.ts", "utf8");
	assert.equal((main.match(/workQueue: lowPriorityWorkQueue/gu) ?? []).length, 2);
	assert.match(main, /initializeCatalogRuntime\(\{/u);
	assert.match(main, /initializeCatalog: \(\) => this\.catalogIndexCoordinator!\.initialize\(\)/u);
	const startup = fs.readFileSync("src/services/CatalogStartup.ts", "utf8");
	assert.ok(startup.indexOf("await options.initializeCatalog()") < startup.indexOf("await options.initializeMonthly()"));
	assert.equal(monthlyInput.includes("dailyInventory.listPeriod(period)"), true);
	assert.equal(monthlyCoordinator.includes("invalidatePeriods(await this.options.inputBuilder.listPeriods())"), false);
	assert.equal(monthlyCoordinator.includes("await this.yieldControl()"), true);
	const saveDataRoot = settingTab.slice(
		settingTab.indexOf("private async saveKnomoDataRoot"),
		settingTab.indexOf("private async toggleMonthlyMemosExcludeRule"),
	);
	assert.equal(saveDataRoot.includes("rebuildPeriod"), false);
	assert.equal(catalogCoordinator.includes("runLowPriorityTask(() => this.drainSlice())"), true);
});

test("当前配置监听等待 layout ready，启动后续阶段遵守卸载取消信号", () => {
	const main = fs.readFileSync("src/main.ts", "utf8");
	const listenerStart = main.slice(
		main.indexOf("this.app.workspace.onLayoutReady(() => {"),
		main.indexOf("this.monthlyProjectionCoordinator.start"),
	);
	const afterLayoutInitialization = main.slice(
		main.indexOf("private async initializeAfterLayoutWithCatalogSafely"),
		main.indexOf("private async showLegacyMigrationCompletionNotice"),
	);

	assert.equal(listenerStart.includes("identityLedgerService.start"), false);
	assert.equal(listenerStart.includes("knomoCurrentConfigService.start"), true);
	assert.equal(listenerStart.includes("lowPriorityWorkQueue.signal.aborted"), true);
	assert.equal(main.includes("cancellationSignal: lowPriorityWorkQueue.signal"), true);
	assert.match(main, /settingTab\?\.refreshAttentionIfVisible\(\)/u);
	assert.equal(afterLayoutInitialization.includes("const isCancelled = () => cancellationSignal?.aborted === true"), true);
});

test("普通事件和手动刷新不触发旧源导入，生产 runtime 无身份恢复队列", () => {
	const main = fs.readFileSync("src/main.ts", "utf8");
	assert.doesNotMatch(main, /identityRecoveryCoordinator|snapshotRevisionTransitionQueue|reconcileIdentityLedger/u);
	const settled = main.slice(main.indexOf("onCatalogSettled: async () =>"), main.indexOf("const markdownMutationService"));
	assert.doesNotMatch(settled, /legacyTrashMigrationService/u);
	const refresh = main.slice(main.indexOf("private runManualRefresh()"));
	assert.doesNotMatch(refresh, /legacyTrashMigrationService/u);
	assert.doesNotMatch(main, /legacyTrashMigrationService\.start/u);
	const migration = fs.readFileSync("src/services/LegacyTrashMigrationService.ts", "utf8");
	assert.doesNotMatch(migration, /vault\.on\(|getCatalogCoverage|getObservationBatches|completionStore/u);
});

function listFiles(root: string): string[] {
	return fs.readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
		const fullPath = path.join(root, entry.name);
		return entry.isDirectory() ? listFiles(fullPath) : [fullPath];
	});
}


test("P7 删除身份协议与临时适配器，真实正文和恢复服务仍保留", () => {
 const retired = ["IdentityLedgerService","IdentityLedgerProtocol","IdentityCurrentState","LocalWriterIdentityService","IdentityReceiptStore","IdentityRevisionTransitionQueue","IdentityRecoveryCoordinator","HistoricalIdentityBootstrapService","KnomoCurrentStateStore","KnomoBootstrapStateStore","KnomoSharedConfigService","KnomoSharedConfigProtocol","SharedReplicaCache","KnomoDataRootMigrationService","LegacyIndexMigrationService","MemoObservationIdentity","KnomoBasicDataRecovery","KnomoAutomaticRecovery","LegacyMigrationAcknowledgementService"];
 for (const name of retired) assert.equal(fs.existsSync('src/services/' + name + '.ts'), false, name);
 assert.equal(fs.existsSync('src/types/identityLedger.ts'), false);
 for (const name of ['DailyMemoWriteGateway', 'MarkdownMutationService', 'CatalogIndexCoordinator', 'MonthlyProjectionCoordinator', 'IndependentTrashService', 'TrashSnapshotStore', 'LegacyTrashMigrationService']) {
  assert.equal(fs.existsSync('src/services/' + name + '.ts'), true, name);
 }
 for (const file of listFiles('src').filter(file => file.endsWith('.ts'))) {
  const source = fs.readFileSync(file, 'utf8');
  assert.doesNotMatch(source, /IdentityHandle|IdentityLedger|bindingId|writerId|prepareRecoverableDelete|removePermanently|confirm-identity/, file);
 }
});


test("Trash 唯一集合 Store；生产依赖图没有旧根、开发 marker 或 Catalog Trash 查询", () => {
 const forbidden = /RecoveryDataRootService|knomoDataRoot|knomoDataRootConfigured|getDataRoot\(|_knomo-data|legacy-index-completion|LegacyMigrationMarkerStore|getTrashSnapshotPath|managed(?:Legacy)?SystemFolderExcludeRule/u;
 const production = listFiles("src").filter((file) => file.endsWith(".ts"));
 assert.deepEqual(production.filter((file) => forbidden.test(file) || forbidden.test(fs.readFileSync(file, "utf8"))), []);
 const catalog = fs.readFileSync("src/services/CatalogReadService.ts", "utf8");
 assert.equal(/Trash|trash|getDeletedSummary|listDeleted|readSnapshots/u.test(catalog), false);
 const controller = fs.readFileSync("src/ui/TrashMemoController.ts", "utf8");
 assert.equal(/getDeletedMemoSummary|listDeletedMemos|trashSummaryOperation|trashCountDirty|removeTrashMemo/u.test(controller), false);
 const store = fs.readFileSync("src/services/TrashSnapshotStore.ts", "utf8");
 assert.equal(/getFiles\(|getMarkdownFiles\(|adapter\.list\(|snapshotId.*\.json/u.test(store), false);
});
