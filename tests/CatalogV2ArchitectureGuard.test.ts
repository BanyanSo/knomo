import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

test("阶段 7 生产 runtime 已退休旧索引、旧 Monthly 同步与 legacy bridge", () => {
	for (const retiredFile of [
		"src/services/MemoIndexStore.ts",
		"src/services/TimeBuoyIndexStore.ts",
		"src/services/MemoSummaryService.ts",
		"src/services/MonthlyArchiveService.ts",
		"src/services/MonthlyArchiveRebuildService.ts",
		"src/services/FileWatchService.ts",
		"src/services/SyncOrchestrator.ts",
		"src/services/CatalogShadowComparator.ts",
		"src/services/PendingMemoCreateStore.ts",
		"src/services/RandomReunionService.ts",
		"src/services/ReferenceService.ts",
		"src/services/memoRepair.ts",
		"src/services/memoRestore.ts",
		"src/services/syncHelpers.ts",
		"src/ui/MobileMemoHydrator.ts",
		"src/ui/MemoTaskUpdateCoordinator.ts",
		"src/types/pending.ts",
	]) {
		assert.equal(fs.existsSync(path.resolve(retiredFile)), false, retiredFile);
	}

	for (const productionFile of [
		"src/main.ts",
		"src/ui/KnomoView.ts",
		"src/ui/KnomoSettingTab.ts",
		"src/services/CatalogV2ReadService.ts",
		"src/services/CatalogV2FeatureService.ts",
		"src/services/RecordStatsService.ts",
		"src/ui/TimeBuoyViewController.ts",
	]) {
		const source = fs.readFileSync(path.resolve(productionFile), "utf8");
		assert.doesNotMatch(source, /memo-index|monthlyRef|syncStatus|LegacyUpgradeSnapshot|CatalogShadowComparator/u, productionFile);
	}

	const memoTypes = fs.readFileSync(path.resolve("src/types/memo.ts"), "utf8");
	const blockService = fs.readFileSync(path.resolve("src/services/MarkdownBlockService.ts"), "utf8");
	assert.doesNotMatch(memoTypes, /MonthlyRef|monthlyRef|MemoSyncStatus|syncStatus|MemoRecord/u);
	assert.doesNotMatch(blockService, /findMemoBlock|lastKnownHash|lineNumberHint|monthly_block/u);

	const stateCoordinator = fs.readFileSync(path.resolve("src/services/CatalogV2StateShadowCoordinator.ts"), "utf8");
	assert.match(stateCoordinator, /const migrationAuthorized = this\.canPersistMigrationArtifacts\(\);/u);
	assert.match(stateCoordinator, /migrationAuthorized \? await this\.collectLegacyInputs\(legacySystemRoot\) : \[\]/u);
	assert.match(stateCoordinator, /migrationAuthorized && classifyLegacyArtifactPath/u);
});

test("阶段 5 v2 production 模块不依赖旧 MemoIndexStore", () => {
	const services = path.resolve("src/services");
	const files = fs.readdirSync(services)
		.filter((name) => name.startsWith("CatalogV2") && name.endsWith(".ts"));
	for (const name of files) {
		const source = fs.readFileSync(path.join(services, name), "utf8");
		assert.doesNotMatch(source, /MemoIndexStore/u, name);
	}
});

test("legacy importer 无 Vault 写入，cleanup 仅使用 FileManager.trashFile", () => {
	const importer = fs.readFileSync(path.resolve("src/services/CatalogV2LegacyImporter.ts"), "utf8");
	assert.doesNotMatch(importer, /\.vault\.(?:create|modify|process|delete|trash)\s*\(/u);
	const cleanup = fs.readFileSync(path.resolve("src/services/CatalogV2LegacyCleanupService.ts"), "utf8");
	assert.match(cleanup, /fileManager\.trashFile\(/u);
	assert.doesNotMatch(cleanup, /\.vault\.(?:delete|trash)\s*\(/u);
});

test("阶段 6 正式入口不创建旧索引运行时或旧文件监听器", () => {
	const source = fs.readFileSync(path.resolve("src/main.ts"), "utf8");
	for (const forbidden of [
		/\.\/services\/MemoIndexStore/u,
		/\.\/services\/MemoSummaryService/u,
		/\.\/services\/SyncOrchestrator/u,
		/\.\/services\/FileWatchService/u,
		/new\s+MemoIndexStore\s*\(/u,
		/new\s+SyncOrchestrator\s*\(/u,
	]) {
		assert.doesNotMatch(source, forbidden);
	}
	assert.match(source, /legacyReadsDisabled:\s*\(\)\s*=>\s*true/u);
	assert.match(source, /legacyWriterRemoved:\s*\(\)\s*=>\s*true/u);
});

test("阶段 6 在注册视图前打开 Catalog 查询依赖", () => {
	const source = fs.readFileSync(path.resolve("src/main.ts"), "utf8");
	const registerViewAt = source.indexOf("this.registerView(");
	assert.notEqual(registerViewAt, -1);
	for (const prerequisite of [
		"await this.memoCatalogService.open();",
		"await catalogV2StateStore?.open();",
		"await catalogV2TransactionStore?.open();",
	]) {
		const prerequisiteAt = source.indexOf(prerequisite);
		assert.notEqual(prerequisiteAt, -1, prerequisite);
		assert.ok(prerequisiteAt < registerViewAt, prerequisite);
	}
});

test("阶段 6 查询使用有界状态切片，卡片窗口不超过 150 条", () => {
	const feature = fs.readFileSync(path.resolve("src/services/CatalogV2FeatureService.ts"), "utf8");
	const readService = fs.readFileSync(path.resolve("src/services/CatalogV2ReadService.ts"), "utf8");
	const view = fs.readFileSync(path.resolve("src/ui/KnomoView.ts"), "utf8");
	assert.match(readService, /getFileRevisionBatch/u);
	assert.doesNotMatch(feature, /observations:\s*\[observation\]/u);
	assert.doesNotMatch(readService, /query\([\s\S]{0,400}loadLocalStateSnapshot/u);
	assert.match(view, /CATALOG_V2_PAGE_SIZE\s*=\s*50/u);
	assert.match(view, /CATALOG_V2_MEMO_WINDOW_LIMIT\s*=\s*150/u);
});

test("阶段 4 Monthly 投影独立于读取服务和 mutation runtime", () => {
	const readService = fs.readFileSync(path.resolve("src/services/CatalogV2ReadService.ts"), "utf8");
	const runtime = fs.readFileSync(path.resolve("src/services/CatalogV2RuntimeCoordinator.ts"), "utf8");
	const mutation = fs.readFileSync(path.resolve("src/services/CatalogV2MutationRuntime.ts"), "utf8");
	const main = fs.readFileSync(path.resolve("src/main.ts"), "utf8");
	const feature = fs.readFileSync(path.resolve("src/services/CatalogV2FeatureService.ts"), "utf8");
	const settings = fs.readFileSync(path.resolve("src/ui/KnomoSettingTab.ts"), "utf8");
	assert.doesNotMatch(readService, /MutationRuntime|OperationWriter|VaultProtocol/u);
	assert.doesNotMatch(readService, /CatalogV2FeatureService/u);
	assert.doesNotMatch(feature, /\n\s*(?:async\s+)?(?:query|getDeletedSummary|listDeleted|queryTimeBuoysForDate|queryAllTimeBuoys|buildRecordStats|getRandomReunionItems|listDailyAggregates|listMemoViewsForDate|filterLegacyUpgradeMemos|listMonthlyProjectionPeriods)\s*\(/u);
	assert.doesNotMatch(runtime, /resumePending|visibilitychange|DeletedPayloadCleanup|MonthlyProjection/u);
	assert.doesNotMatch(mutation, /kind:\s*"monthly_projection"/u);
	assert.match(main, /CatalogV2MonthlyProjectionCoordinator/u);
	assert.doesNotMatch(main, /CatalogV2DeletedPayloadCleanupRunner/u);
	assert.doesNotMatch(main, /CatalogV2RuntimeCoordinator/u);
	assert.doesNotMatch(feature, /runtimeCoordinator\?\.initialize|notifyProjectionPeriods|invalidateProjectionPeriods/u);
	assert.doesNotMatch(settings, /catalogV2FeatureService\.query(?:TimeBuoysForDate|AllTimeBuoys)?\(/u);
	assert.match(settings, /inspectPendingMutations\(\)/u);
	assert.match(settings, /recoverPendingMutation\(item\.mutationId, action\)/u);
});

test("protocol-v2 正式入口只使用不可变状态协议且不执行共享 GC", () => {
	const main = fs.readFileSync(path.resolve("src/main.ts"), "utf8");
	const monthly = fs.readFileSync(path.resolve("src/services/CatalogV2MonthlyProjectionCoordinator.ts"), "utf8");
	const inputBuilder = fs.readFileSync(path.resolve("src/services/CatalogV2ProjectionInputBuilder.ts"), "utf8");
	assert.match(main, /CatalogV2ImmutableStateWriter/u);
	assert.match(main, /CatalogV2VaultProtocol/u);
	assert.doesNotMatch(main, /CatalogV2StateTransport/u);
	assert.doesNotMatch(main, /CatalogV2StateCompactionService/u);
	assert.doesNotMatch(main, /CatalogV2LegacyCleanupService/u);
	assert.doesNotMatch(main, /new\s+InMemoryMemoCatalogStore\(150\)/u);
	assert.doesNotMatch(monthly, /isPeriodCovered/u);
	assert.doesNotMatch(monthly, /VaultProtocol|StateShadow|TransactionStore|projectionAuthorityWriterId|writeProjectionReceipt|generation/u);
	assert.match(inputBuilder, /getMarkdownFiles\(\)/u);
	assert.match(inputBuilder, /this\.parser\.parse\(/u);
	assert.doesNotMatch(inputBuilder, /MemoCatalog|state\.memos|durable/u);
});

test("阶段 5 冻结 schema 不含 Monthly 控制面，Catalog rebuild 不触发共享投影", () => {
	const protocolTypes = fs.readFileSync(path.resolve("src/types/catalogV2Protocol.ts"), "utf8");
	const vaultProtocol = fs.readFileSync(path.resolve("src/services/CatalogV2VaultProtocol.ts"), "utf8");
	const catalog = fs.readFileSync(path.resolve("src/services/CatalogShadowCoordinator.ts"), "utf8");
	const monthly = fs.readFileSync(path.resolve("src/services/CatalogV2MonthlyProjectionCoordinator.ts"), "utf8");
	const inputBuilder = fs.readFileSync(path.resolve("src/services/CatalogV2ProjectionInputBuilder.ts"), "utf8");
	const paths = fs.readFileSync(path.resolve("src/utils/path.ts"), "utf8");
	assert.doesNotMatch(protocolTypes, /projectionAuthorityWriterId|monthly_projection|ProjectionReceipt|VerifiedProjectionInput/u);
	assert.doesNotMatch(vaultProtocol, /kind:\s*"monthly_projection"|writeProjectionReceipt|CatalogV2ProjectionReceipt/u);
	assert.doesNotMatch(paths, /ProjectionReceipt|projections\/receipts/u);
	assert.doesNotMatch(catalog, /onPeriodsInvalidated|MonthlyProjection/u);
	assert.match(monthly, /handleFileChanged/u);
	assert.match(inputBuilder, /getDailyPeriod/u);
});

test("阶段 0 启动与只读路径不提交共享状态", () => {
	const main = fs.readFileSync(path.resolve("src/main.ts"), "utf8");
	const feature = fs.readFileSync(path.resolve("src/services/CatalogV2FeatureService.ts"), "utf8");
	const monthly = fs.readFileSync(path.resolve("src/services/CatalogV2MonthlyProjectionCoordinator.ts"), "utf8");
	const compaction = fs.readFileSync(path.resolve("src/services/CatalogV2StateCompactionService.ts"), "utf8");
	assert.doesNotMatch(main, /getGenerationSelectionKind\(\)\s*===\s*"forked"[\s\S]{0,240}reconcile/u);
	assert.match(main, /canPersistMigrationArtifacts:\s*\(\)\s*=>\s*catalogUpgradeAuthorized/u);
	assert.match(main, /canWriteSharedUpgrade:\s*\(\)\s*=>\s*catalogUpgradeAuthorized/u);
	assert.match(main, /finally\s*\{\s*catalogUpgradeAuthorized\s*=\s*false;/u);
	assert.doesNotMatch(feature, /commitUniqueExternalRebinds|createObserved/u);
	assert.match(feature, /createNew:[\s\S]{0,320}stateStore\?\.isAuthoritative\(\)[\s\S]{0,160}transactionStore\?\.isAuthoritative\(\)/u);
	assert.match(feature, /adoptExisting:\s*false/u);
	assert.match(feature, /Existing Daily memo adoption is disabled/u);
	assert.doesNotMatch(monthly, /sharedWritesEnabled|projectionAuthorityWriterId|writeProjectionReceipt/u);
	assert.match(compaction, /sharedCompactionEnabled:\s*boolean\s*=\s*false/u);
	const retryState = main.slice(
		main.indexOf("async () => {", main.indexOf("() => this.initializeCatalogVaultProtocol")),
		main.indexOf("() => this.openCatalogDataSettings()"),
	);
	assert.match(retryState, /refreshCatalogVaultContext/u);
	assert.match(retryState, /retryOpen/u);
	assert.match(retryState, /memoCatalogService\?\.open/u);
	assert.doesNotMatch(retryState, /catalogV2RuntimeCoordinator\?\.initialize/u);
});

test("正式可达的 v2 文案不暴露底层数据术语", () => {
	for (const file of ["src/i18n/en.ts", "src/i18n/zh-CN.ts"]) {
		const source = fs.readFileSync(path.resolve(file), "utf8");
		const lines = source.split(/\r?\n/u).filter((line) => /"(?:catalog\.|settings\.localHistory|settings\.rebuild\.catalog|settings\.timeBuoy|timeBuoy\.)/u.test(line));
		for (const line of lines) {
			assert.doesNotMatch(line, /\b(?:Catalog|Identity|index|JSON|memoId|writerId|segment)\b|索引|身份/u, `${file}: ${line}`);
		}
	}
});
