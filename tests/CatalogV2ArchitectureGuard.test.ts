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

test("P1 第 7 步正式入口只保留旧数据只读兼容导入，不创建旧写运行时", () => {
	const source = fs.readFileSync(path.resolve("src/main.ts"), "utf8");
	for (const forbidden of [
		/\.\/services\/MemoIndexStore/u,
		/\.\/services\/MemoSummaryService/u,
		/\.\/services\/SyncOrchestrator/u,
		/\.\/services\/FileWatchService/u,
		/new\s+MemoIndexStore\s*\(/u,
		/new\s+SyncOrchestrator\s*\(/u,
		/CatalogV2MutationRuntime|CatalogV2StateShadowCoordinator|CatalogV2UpgradeCoordinator/u,
		/CatalogV2ImmutableStateWriter|CatalogV2OperationWriter|CatalogV2SystemRootService/u,
		/initialize-vault-protocol|request-catalog-authority-transfer|approve-catalog-authority-transfer/u,
	]) {
		assert.doesNotMatch(source, forbidden);
	}
	assert.match(source, /new CatalogV2ReadOnlyCompatibilitySource\(/u);
	assert.match(source, /new CatalogV3LegacyIdentityImporter\(/u);
});

test("P1 第 7 步兼容源只读且 installMode 不再参与展示或 Markdown mutation", () => {
	const source = fs.readFileSync(path.resolve("src/services/CatalogV2ReadOnlyCompatibilitySource.ts"), "utf8");
	const importer = fs.readFileSync(path.resolve("src/services/CatalogV3LegacyIdentityImporter.ts"), "utf8");
	const readService = fs.readFileSync(path.resolve("src/services/CatalogV2ReadService.ts"), "utf8");
	const feature = fs.readFileSync(path.resolve("src/services/CatalogV2FeatureService.ts"), "utf8");
	const main = fs.readFileSync(path.resolve("src/main.ts"), "utf8");

	assert.match(source, /loadConfiguredVaultContext\(catalogDataRoot\)/u);
	assert.match(source, /getKnomoDataRoot/u);
	assert.doesNotMatch(`${source}\n${importer}`, /\.vault\.(?:create|modify|process|delete|trash)\s*\(/u);
	assert.doesNotMatch(`${source}\n${importer}`, /\.vault\.(?:getFiles|getMarkdownFiles)\s*\(/u);
	assert.match(importer, /importVerifiedLegacyEvents\(/u);
	assert.doesNotMatch(importer, /fileManager\.trashFile|LegacyCleanup/u);
	assert.doesNotMatch(readService, /this\.options\.(?:getInstallMode|installMode)/u);
	assert.doesNotMatch(feature, /this\.options\.(?:getInstallMode|installMode)/u);
	assert.doesNotMatch(main, /CatalogV2InstallMode|installMode|initialize-vault-protocol/u);
});

test("P0 启动边界：视图只等待本地查询和 fallback 配置，Identity 与兼容导入后台完成", () => {
	const source = fs.readFileSync(path.resolve("src/main.ts"), "utf8");
	const registerViewAt = source.indexOf("this.registerView(");
	assert.notEqual(registerViewAt, -1);
	for (const prerequisite of [
		"await this.memoCatalogService.open();",
		"await knomoSharedConfigService.initializeLocalConfig();",
		"identityLedgerService.start(this",
	]) {
		const prerequisiteAt = source.indexOf(prerequisite);
		assert.notEqual(prerequisiteAt, -1, prerequisite);
		assert.ok(prerequisiteAt < registerViewAt, prerequisite);
	}
	for (const deferred of [
		"await identityLedgerService.initialize();",
		"await knomoSharedConfigService.initialize();",
		"await this.legacyIdentityImporter?.run();",
	]) {
		const deferredAt = source.indexOf(deferred, registerViewAt);
		assert.notEqual(deferredAt, -1, deferred);
		assert.ok(deferredAt > registerViewAt, deferred);
	}
	assert.doesNotMatch(source, /catalogV2StateStore|catalogV2TransactionStore/u);
});

test("P0 同步窗口：Identity 与共享配置注册监听后立即补一次 refresh", () => {
	for (const file of ["IdentityLedgerService.ts", "KnomoSharedConfigService.ts"]) {
		const source = fs.readFileSync(path.resolve("src/services", file), "utf8");
		const start = source.slice(source.indexOf("start("), source.indexOf("async initialize("));
		assert.match(start, /this\.scheduleRefresh\(\)/u, file);
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

test("后台刷新状态不写入 Composer 的内联状态区域", () => {
	const view = fs.readFileSync(path.resolve("src/ui/KnomoView.ts"), "utf8");
	assert.doesNotMatch(view, /updateStatus\(t\("catalog\.savedRefreshPending"/u);
});

test("非空未配置 Vault 不覆盖 Observation 列表，首次保存不再请求身份初始化", () => {
	const view = fs.readFileSync(path.resolve("src/ui/KnomoView.ts"), "utf8");
	assert.doesNotMatch(view, /getCatalogOnboardingPresentation/u);
	assert.match(view, /getCatalogReadStatusHeaders/u);
	const saveInput = view.slice(view.indexOf("private async saveInput()"), view.indexOf("private showTimeBuoySaveFeedback"));
	assert.doesNotMatch(saveInput, /nonempty_unconfigured|initializeCatalogVaultFromView|capabilities\.createNew/u);
});

test("P0 第 3 步普通正文入口只依赖 MarkdownMutationService", () => {
	const markdown = fs.readFileSync(path.resolve("src/services/MarkdownMutationService.ts"), "utf8");
	const feature = fs.readFileSync(path.resolve("src/services/CatalogV2FeatureService.ts"), "utf8");
	const main = fs.readFileSync(path.resolve("src/main.ts"), "utf8");
	assert.doesNotMatch(markdown, /CatalogV2MutationRuntime|ResolvedMemoHandle|IdentityHandle|IndexedDb|bootstrap|installMode|StateGeneration/u);
	assert.match(main, /new MarkdownMutationService\(this\.app/u);
	for (const [method, nextMethod] of [
		["async create(", "async copy("],
		["async copy(", "async move("],
		["async move(", "async repairIdentity("],
		["async edit(", "async toggleTask("],
		["async toggleTask(", "async delete("],
		["async removePermanently(", "async delete("],
		["async createReferenceText(", "async recordReview("],
	] as const) {
		const body = feature.slice(feature.indexOf(method), feature.indexOf(nextMethod));
		assert.match(body, /getMarkdownMutations\(\)/u, method);
		assert.doesNotMatch(body, /getWritableHandle|getMutationRuntime|assertSharedMutationReady/u, method);
	}
});

test("P0 第 4 步 Identity Ledger 使用配置数据根与无控制面的不可变事件", () => {
	const protocol = fs.readFileSync(path.resolve("src/services/IdentityLedgerProtocol.ts"), "utf8");
	const service = fs.readFileSync(path.resolve("src/services/IdentityLedgerService.ts"), "utf8");
	const migration = fs.readFileSync(path.resolve("src/services/KnomoDataRootMigrationService.ts"), "utf8");
	const types = fs.readFileSync(path.resolve("src/types/identityLedger.ts"), "utf8");
	const main = fs.readFileSync(path.resolve("src/main.ts"), "utf8");
	assert.match(protocol, /IDENTITY_LEDGER_RELATIVE_ROOT = "_knomo-data\/identity\/v3"/u);
	assert.match(protocol, /getIdentityLedgerRootPath/u);
	assert.doesNotMatch(`${protocol}\n${service}\n${main}`, /_knomo-identity/u);
	assert.match(service, /options\.getRootPath\(\)/u);
	assert.match(service, /app\.vault\.create\(path, content\)/u);
	assert.match(service, /parseIdentityLedgerSegment\(rootPath, file\.path, await this\.app\.vault\.cachedRead\(file\)\)/u);
	assert.doesNotMatch(service, /\.vault\.(?:modify|process|delete|trash)\s*\(/u);
	assert.doesNotMatch(`${protocol}\n${service}\n${migration}\n${types}`, /bootstrap|genesis|authority|epoch|generation|manifest|vaultInstanceId/iu);
	assert.doesNotMatch(`${service}\n${migration}`, /\.vault\.(?:getFiles|getMarkdownFiles)\s*\(/u);
	assert.doesNotMatch(types, /existingBlockId/u);
	assert.doesNotMatch(service, /snapshots?\//u);
	assert.match(main, /new IdentityLedgerService\(this\.app/u);
	assert.match(main, /knomoDataRootConfigured/u);
	assert.match(main, /identityLedgerService\.start\(this/u);
});

test("P0 第 4 步 create 固定按 intent、Daily、claim 顺序执行", () => {
	const feature = fs.readFileSync(path.resolve("src/services/CatalogV2FeatureService.ts"), "utf8");
	const body = feature.slice(feature.indexOf("async create("), feature.indexOf("async copy("));
	const intentAt = body.indexOf("this.beginIdentityCreate(");
	const dailyAt = body.indexOf("this.getMarkdownMutations().create(");
	const claimAt = body.indexOf("this.finishIdentityCreate(");
	assert.ok(intentAt >= 0 && dailyAt > intentAt && claimAt > dailyAt);
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
	assert.doesNotMatch(settings, /inspectPendingMutations\(\)|recoverPendingMutation\(/u);
	assert.match(settings, /legacyIdentityImporter\.getReport\(\)/u);
});

test("P1 第 7 步正式入口不再使用 protocol-v2 写控制面或共享 GC", () => {
	const main = fs.readFileSync(path.resolve("src/main.ts"), "utf8");
	const monthly = fs.readFileSync(path.resolve("src/services/CatalogV2MonthlyProjectionCoordinator.ts"), "utf8");
	const inputBuilder = fs.readFileSync(path.resolve("src/services/CatalogV2ProjectionInputBuilder.ts"), "utf8");
	assert.doesNotMatch(main, /CatalogV2ImmutableStateWriter|CatalogV2VaultProtocol/u);
	assert.match(main, /CatalogV2ReadOnlyCompatibilitySource/u);
	assert.match(main, /CatalogV3LegacyIdentityImporter/u);
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

test("P1 第 7 步启动与只读兼容路径不恢复 V2 共享写控制面", () => {
	const main = fs.readFileSync(path.resolve("src/main.ts"), "utf8");
	const feature = fs.readFileSync(path.resolve("src/services/CatalogV2FeatureService.ts"), "utf8");
	const monthly = fs.readFileSync(path.resolve("src/services/CatalogV2MonthlyProjectionCoordinator.ts"), "utf8");
	const compaction = fs.readFileSync(path.resolve("src/services/CatalogV2StateCompactionService.ts"), "utf8");
	assert.doesNotMatch(main, /getGenerationSelectionKind|catalogUpgradeAuthorized|canPersistMigrationArtifacts|canWriteSharedUpgrade/u);
	assert.doesNotMatch(main, /CatalogV2StateShadowCoordinator|CatalogV2MutationRuntime|CatalogV2UpgradeCoordinator/u);
	assert.match(main, /new CatalogV2FeatureService\([\s\S]{0,220}?null,[\s\S]{0,80}?null,[\s\S]{0,80}?null/u);
	assert.doesNotMatch(feature, /commitUniqueExternalRebinds|createObserved/u);
	assert.match(feature, /createNew:\s*this\.markdownMutations !== null/u);
	assert.match(feature, /adoptExisting:\s*this\.canAdoptIdentityLedgerObservation\(\)/u);
	assert.match(feature, /identityLedger\.adoptObservation\(refreshed\.observation\)/u);
	assert.doesNotMatch(monthly, /sharedWritesEnabled|projectionAuthorityWriterId|writeProjectionReceipt/u);
	assert.match(compaction, /sharedCompactionEnabled:\s*boolean\s*=\s*false/u);
	const retryMarker = main.indexOf("const catalogWasUsingFallback");
	const retryState = main.slice(
		main.lastIndexOf("async () => {", retryMarker),
		main.indexOf("() => this.openCatalogDataSettings()"),
	);
	assert.match(retryState, /memoCatalogService\?\.open/u);
	assert.match(retryState, /legacyIdentityImporter\?\.run/u);
	assert.doesNotMatch(retryState, /retryOpen|refreshCatalogVaultContext|StateShadow|Transaction/u);
});

test("P1 第 5 步协调使用完整 revision，repair 只写 Identity Ledger", () => {
	const coordinator = fs.readFileSync(path.resolve("src/services/CatalogShadowCoordinator.ts"), "utf8");
	const identity = fs.readFileSync(path.resolve("src/services/IdentityLedgerService.ts"), "utf8");
	const readService = fs.readFileSync(path.resolve("src/services/CatalogV2ReadService.ts"), "utf8");
	const feature = fs.readFileSync(path.resolve("src/services/CatalogV2FeatureService.ts"), "utf8");
	const main = fs.readFileSync(path.resolve("src/main.ts"), "utf8");
	assert.match(coordinator, /onRevisionTransition/u);
	assert.match(coordinator, /before:\s*\{[\s\S]{0,180}sourceRevision:[\s\S]{0,180}observations:/u);
	assert.match(main, /identityLedgerService\.reconcileRevision\(/u);
	assert.match(identity, /baseBindingId:\s*base\.bindingId/u);
	assert.match(identity, /repairs\.length > 0 \? repairs : allChildren/u);
	assert.match(readService, /ledgerState\.kind === "conflicted"/u);
	assert.match(feature, /identityLedger\.repairConflict\(candidateMemoId, refreshed\.observation\)/u);
	const repairBody = identity.slice(identity.indexOf("async repairConflict("), identity.indexOf("async recordReview("));
	assert.match(repairBody, /this\.appendEvent\(/u);
	assert.doesNotMatch(repairBody, /vault\.(?:process|modify|create|delete|trash)|getMarkdownMutations/u);
});

test("P1 第 6 步配置协议独立于 V2 control plane，Monthly 只读取 Daily 与有效配置", () => {
	const main = fs.readFileSync(path.resolve("src/main.ts"), "utf8");
	const protocol = fs.readFileSync(path.resolve("src/services/KnomoSharedConfigProtocol.ts"), "utf8");
	const service = fs.readFileSync(path.resolve("src/services/KnomoSharedConfigService.ts"), "utf8");
	const catalog = fs.readFileSync(path.resolve("src/services/CatalogShadowCoordinator.ts"), "utf8");
	const monthly = fs.readFileSync(path.resolve("src/services/CatalogV2MonthlyProjectionCoordinator.ts"), "utf8");
	const inputBuilder = fs.readFileSync(path.resolve("src/services/CatalogV2ProjectionInputBuilder.ts"), "utf8");

	assert.match(protocol, /KNOMO_SHARED_CONFIG_RELATIVE_ROOT = "_knomo-data\/schema\/config\/v1"/u);
	assert.match(main, /new KnomoSharedConfigService/u);
	assert.match(main, /new KnomoStartupBootstrapService/u);
	assert.match(main, /startupBootstrapService\.initialize\(\)/u);
	assert.match(main, /isConfigurationComplete:\s*\(\) => knomoSharedConfigService\.isCoverageComplete\(\)/u);
	assert.match(main, /isProjectionAllowed:\s*\(\) => knomoSharedConfigService\.isMonthlyProjectionAllowed\(\)/u);
	assert.doesNotMatch(main, /contract\.daily|contract\.monthly/u);
	assert.doesNotMatch(`${protocol}\n${service}`, /IdentityLedger|bootstrap|authority|StateGeneration|vaultInstanceId/u);
	assert.match(catalog, /isConfigurationComplete/u);
	assert.match(monthly, /isProjectionAllowed/u);
	assert.doesNotMatch(inputBuilder, /IdentityLedger|MemoCatalogService|CatalogV2ReadService/u);
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
