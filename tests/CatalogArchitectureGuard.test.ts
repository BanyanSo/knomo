import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

test("生产装配保留 Catalog 和当前回收站入口", async () => {
	const main = fs.readFileSync("src/main.ts", "utf8");
	assert.equal(main.includes("initializeMonthlyExcludeDefaultSafely"), true);
	for (const serviceName of [
		"CatalogReadService",
		"MemoCommandService",
		"IndependentTrashService",
	]) {
		assert.equal(main.includes(serviceName), true, `main.ts should wire ${serviceName}.`);
	}
	const coordinator = fs.readFileSync("src/services/CatalogIndexCoordinator.ts", "utf8");
	assert.equal(coordinator.includes("knomo-catalog-${"), true);
	assert.equal(coordinator.includes("knomo-catalog-v"), false);
});

test("可执行代码独立于本地架构资料", () => {
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
		"getLibraryIndexes",
		"query",
		"count",
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
	assert.match(main, /onProgress: \(coverage, scan\) => this\.updateOpenViewCatalogProgress\(coverage, scan\)/u);
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
	assert.equal(parser.includes("headings"), false);
	assert.equal(coordinator.includes("headings"), false);
	assert.equal(monthly.includes("headings"), false);
});

test("Monthly 与 Catalog 共享低优先级队列并分片执行", () => {
	const main = fs.readFileSync("src/main.ts", "utf8");
	const monthlyInput = fs.readFileSync("src/services/MonthlyProjectionInputBuilder.ts", "utf8");
	const monthlyCoordinator = fs.readFileSync("src/services/MonthlyProjectionCoordinator.ts", "utf8");
	const catalogCoordinator = fs.readFileSync("src/services/CatalogIndexCoordinator.ts", "utf8");
	assert.equal((main.match(/workQueue: lowPriorityWorkQueue/gu) ?? []).length, 2);
	assert.match(main, /initializeCatalogRuntime\(\{/u);
	assert.match(main, /trackCatalogInventory\(this\.catalogIndexCoordinator\.initialize\(\)\)/u);
	assert.match(main, /initializeCatalog: \(\) => catalogInitialization/u);
	const startup = fs.readFileSync("src/services/CatalogStartup.ts", "utf8");
	const initializeCatalog = startup.indexOf("await options.initializeCatalog()");
	assert.ok(initializeCatalog >= 0 && initializeCatalog < startup.indexOf("await options.initializeMonthly()"));
	assert.equal(monthlyInput.includes("dailyInventory.listPeriod(period)"), true);
	assert.equal(monthlyCoordinator.includes("invalidatePeriods(await this.options.inputBuilder.listPeriods())"), false);
	assert.equal(monthlyCoordinator.includes("await this.yieldControl()"), true);
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
		main.indexOf("private runManualRefresh"),
	);

	assert.equal(listenerStart.includes("knomoCurrentConfigService.start"), true);
	assert.equal(listenerStart.includes("lowPriorityWorkQueue.signal.aborted"), true);
	assert.equal(main.includes("cancellationSignal: lowPriorityWorkQueue.signal"), true);
	assert.match(main, /settingTab\?\.refreshAttentionIfVisible\(\)/u);
	assert.equal(afterLayoutInitialization.includes("const isCancelled = () => cancellationSignal?.aborted === true"), true);
});

function listFiles(root: string): string[] {
	return fs.readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
		const fullPath = path.join(root, entry.name);
		return entry.isDirectory() ? listFiles(fullPath) : [fullPath];
	});
}


test("生产源码无退役的迁移、共享数据根和持久身份协议依赖", () => {
	const retired = [
		/Legacy(?:ArtifactInventory|IndexReader|TrashMigrationService|MigrationMarkerStore)|initializeRecovery/iu,
		/identityRecoveryCoordinator|snapshotRevisionTransitionQueue|reconcileIdentityLedger|identityLedgerService|sessionWriterId|localWriterIdentityService/u,
		/IdentityPublicationStore|IdentityReceiptStore|IdentityHandle|IdentityLedger|bindingId|writerId|prepareRecoverableDelete|removePermanently|confirm-identity/u,
		/KnomoShared(?:ReplicaStore|StorageService|StorageCoordinator)|SharedReviewService|CausalSharedConfigService|SharedStorageDataRootService|KnomoBootstrapStateStore|KnomoCurrentStateStore|getKnomoCurrentConfigRootPath/u,
		/RecoveryDataRootService|knomoDataRoot|getDataRoot\(|_knomo-data|legacy-index-completion|getTrashSnapshotPath|managed(?:Legacy)?SystemFolderExcludeRule/u,
	];
	for (const file of listFiles("src").filter(file => file.endsWith(".ts"))) {
		const source = fs.readFileSync(file, "utf8");
		for (const pattern of retired) {
			assert.doesNotMatch(file, pattern);
			assert.doesNotMatch(source, pattern, file);
		}
	}
});

test("Trash 使用独立集合文件，Catalog 与卡片控制器不接管存储", () => {
 const catalog = fs.readFileSync("src/services/CatalogReadService.ts", "utf8");
 assert.equal(/Trash|trash|getDeletedSummary|listDeleted|readSnapshots/u.test(catalog), false);
 const controller = fs.readFileSync("src/ui/TrashMemoController.ts", "utf8");
 assert.equal(/getDeletedMemoSummary|listDeletedMemos|trashSummaryOperation|trashCountDirty|removeTrashMemo/u.test(controller), false);
 const store = fs.readFileSync("src/services/TrashSnapshotStore.ts", "utf8");
 assert.equal(/getFiles\(|getMarkdownFiles\(|adapter\.list\(|snapshotId.*\.json/u.test(store), false);
});
