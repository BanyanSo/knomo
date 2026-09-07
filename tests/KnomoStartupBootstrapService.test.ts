import assert from "node:assert/strict";
import test from "node:test";

import { getIdentityLedgerRootPath } from "../src/services/IdentityLedgerProtocol";
import { IdentityLedgerService } from "../src/services/IdentityLedgerService";
import { IdentityReceiptStore } from "../src/services/IdentityReceiptStore";
import { KnomoCurrentStateStore } from "../src/services/KnomoCurrentStateStore";
import { KnomoBootstrapStateStore } from "../src/services/KnomoBootstrapStateStore";
import { DiaryMemoParser } from "../src/services/DiaryMemoParser";
import { HistoricalIdentityBootstrapService } from "../src/services/HistoricalIdentityBootstrapService";
import { KnomoDataRootMigrationService } from "../src/services/KnomoDataRootMigrationService";
import {
	buildKnomoSharedConfig,
	getKnomoSharedConfigRootPath,
} from "../src/services/KnomoSharedConfigProtocol";
import { KnomoSharedConfigService } from "../src/services/KnomoSharedConfigService";
import { KnomoStartupBootstrapService } from "../src/services/KnomoStartupBootstrapService";
import type { KnomoSharedConfigStatus } from "../src/types/knomoConfig";
import { InMemoryVault } from "./helpers/InMemoryVault";

const WRITER_ID = "w_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

test("已有 Daily 的首次启动发布配置并导入历史身份，同时间同正文保持独立", async () => {
	const sourcePath = "Daily/2026-08-22.md";
	const content = "## Memos\n- 09:00 已有正文\n- 09:00 重复正文\n- 09:00 重复正文\n";
	const vault = new InMemoryVault({ [sourcePath]: content });
	installLayoutWorkspace(vault);
	let location = { knomoDataRoot: "Knomo", knomoDataRootConfigured: false };
	let initializingRoot: string | null = null;
	const ledger = new IdentityLedgerService(vault.app, {
		getRootPath: () => location.knomoDataRootConfigured ? getIdentityLedgerRootPath(location.knomoDataRoot) : null,
		getWriterId: async () => WRITER_ID,
		currentStateStore: new KnomoCurrentStateStore(vault.app, () => getIdentityLedgerRootPath(location.knomoDataRoot), "current"),
	});
	const shared = createSharedConfig(vault, () => location, "## Memos");
	const receipts = new KnomoBootstrapStateStore(new KnomoCurrentStateStore(vault.app, () => initializingRoot ?? location.knomoDataRoot));
	const parsed = await new DiaryMemoParser().parse({ sourcePath, logicalDate: "2026-08-22", bytes: new TextEncoder().encode(content) });
	const historical = new HistoricalIdentityBootstrapService(ledger, {
		checkpointStore: receipts,
		getCatalogCoverage: async () => ({ kind: "complete", coveredFromDate: "2026-08-22", pendingFileCount: 0, coveredFileCount: 1, totalFileCount: 1, sharedConfigurationComplete: shared.isCoverageComplete() }),
		getCatalogLifecycle: () => ({ state: "ready", persistent: true, writable: true, reason: null }),
		getObservationBatches: async () => [{ file: { sourcePath, sourceRevision: parsed.sourceRevision, logicalDate: "2026-08-22", mtime: 1, size: content.length, parserVersion: 5, settingsFingerprint: "test", observationCount: parsed.observations.length, auditedAt: 1 }, observations: parsed.observations, catalogRevision: 1 }],
	});
	const migration = new KnomoDataRootMigrationService(vault.app, ledger, () => location,
		async (root) => { location = { knomoDataRoot: root, knomoDataRootConfigured: true }; });
	const startup = new KnomoStartupBootstrapService(vault.app, {
		getLocation: () => location,
		initializeDataRoot: async (root) => { await migration.migrate(root); },
		authorizeInitialImport: async (root) => {
			initializingRoot = root;
			try { await historical.authorizeInitialImport(root); }
			finally { initializingRoot = null; }
		},
		onNewDataRootReady: async () => { await historical.run("not_applicable"); },
		identity: ledger,
		sharedConfig: shared,
	});
	await startup.initialize();
	assert.equal(startup.getSnapshot().status, "ready");
	assert.equal(shared.getStatus(), "ready");
	assert.equal(historical.getStatus(), "completed");
	const bindings = parsed.observations.map((observation) => ledger.resolveObservation(observation));
	assert.equal(bindings.every((binding) => binding !== null), true);
	assert.equal(new Set(bindings.map((binding) => binding!.memoId)).size, 3);
	assert.equal(vault.read(sourcePath), content);
	assert.equal(vault.paths().some((path) => path.includes("receipts") || path.endsWith(".jsonl") && path.includes("/identity/")), false);
	// 模拟用户删除 Knomo 文件、保留原有本机配置和服务缓存。
	for (const path of vault.paths().filter((path) => path.startsWith("Knomo/"))) vault.remove(path);
	await shared.initialize();
	assert.notEqual(shared.getStatus(), "ready");
	await ledger.rebuildReplicaFromVault();
	await shared.rebuildReplicaFromVault();
	await historical.authorizeInitialImport(location.knomoDataRoot, true);
	await startup.initializeNewDataRoot(location.knomoDataRoot);
	assert.equal(shared.getStatus(), "ready");
	assert.equal(historical.getStatus(), "completed");
	assert.equal(parsed.observations.every((observation) => ledger.resolveObservation(observation) !== null), true);
	assert.equal(vault.read(sourcePath), content);
});

test("首次启动持久化授权后配置发布失败，重启自动续建且不重复授权", async () => {
	const vault = new InMemoryVault();
	installLayoutWorkspace(vault);
	let location = { knomoDataRoot: "Knomo", knomoDataRootConfigured: false };
	let initializingRoot: string | null = null;
	const ledger = createLedger(vault, () => location);
	const receipts = new IdentityReceiptStore(vault.app, {
		getRootPath: () => initializingRoot ?? (location.knomoDataRootConfigured ? location.knomoDataRoot : null),
		getWriterId: async () => WRITER_ID,
		getKnownIdentityEventIds: () => ledger.getKnownIdentityEventIds(),
	});
	const migration = new KnomoDataRootMigrationService(vault.app, ledger, () => location,
		async (root) => { location = { knomoDataRoot: root, knomoDataRootConfigured: true }; });
	const shared = createSharedConfig(vault, () => location, "## Memos");
	const publish = shared.publishLocalConfig.bind(shared);
	let fail = true;
	shared.publishLocalConfig = async () => {
		if (fail) throw new Error("publication interrupted");
		await publish();
	};
	let authorizations = 0;
	const options = {
		getLocation: () => location,
		initializeDataRoot: async (root: string) => { await migration.migrate(root); },
		authorizeInitialImport: async (root: string) => {
			authorizations += 1;
			initializingRoot = root;
			try {
				await receipts.setMeta("historicalIdentityBootstrap", {
					state: "pending", reason: "initial_import", authorizationRoot: root,
				});
			} finally { initializingRoot = null; }
		},
		hasPendingInitialImport: async () => (await receipts.getMeta<{ state: string }>("historicalIdentityBootstrap"))?.state === "pending",
		identity: ledger,
		sharedConfig: shared,
	};
	await assert.rejects(new KnomoStartupBootstrapService(vault.app, options).initialize(), /publication interrupted/u);
	assert.equal(location.knomoDataRootConfigured, true);
	fail = false;
	const restarted = new KnomoStartupBootstrapService(vault.app, options);
	await restarted.initialize();
	assert.equal(restarted.getSnapshot().status, "ready");
	assert.equal(authorizations, 1);
	assert.equal(shared.getStatus(), "ready");
});

test("首次启动自动创建数据根并发布配置，重启不重复授权", async () => {
	const vault = new InMemoryVault();
	installLayoutWorkspace(vault);
	let location = { knomoDataRoot: "Knomo", knomoDataRootConfigured: false };
	const ledger = createLedger(vault, () => location);
	const migration = new KnomoDataRootMigrationService(
		vault.app,
		ledger,
		() => location,
		async (root) => { location = { knomoDataRoot: root, knomoDataRootConfigured: true }; },
	);
	const shared = createSharedConfig(vault, () => location, "## Memos");
	let authorizationCount = 0;
	await ledger.initialize();
	await shared.initialize();
	const bootstrap = new KnomoStartupBootstrapService(vault.app, {
		getLocation: () => location,
		initializeDataRoot: async (root) => { await migration.migrate(root); },
		authorizeInitialImport: async () => { authorizationCount += 1; },
		identity: ledger,
		sharedConfig: shared,
	});

	await bootstrap.initialize();
	await bootstrap.initialize();

	assert.equal(location.knomoDataRootConfigured, true);
	assert.equal(authorizationCount, 1);
	assert.notEqual(vault.app.vault.getAbstractFileByPath(`${getIdentityLedgerRootPath("Knomo")}/writers`), null);
	assert.equal(shared.getStatus(), "ready");
	assert.equal(shared.getEffectiveConfig().daily.headings[0], "## Memos");
	assert.equal(vault.paths().some((path) => path.startsWith(`${getKnomoSharedConfigRootPath("Knomo")}/`)), true);
	assert.deepEqual(bootstrap.getSnapshot(), {
		status: "ready",
		stage: null,
		error: null,
	});
});

test("已配置根在布局就绪前暂不可见时等待 Vault 完成加载后自动恢复", async () => {
	const vault = new InMemoryVault();
	const markLayoutReady = installLayoutWorkspace(vault, false);
	const location = { knomoDataRoot: "Knomo", knomoDataRootConfigured: true };
	const ledger = createLedger(vault, () => location);
	const shared = createSharedConfig(vault, () => location, "## Memos");
	const bootstrap = new KnomoStartupBootstrapService(vault.app, {
		getLocation: () => location,
		initializeDataRoot: async () => { throw new Error("已配置根不应重新初始化"); },
		identity: ledger,
		sharedConfig: shared,
	});

	const initialization = bootstrap.initialize();
	await Promise.resolve();

	assert.equal(vault.app.vault.getAbstractFileByPath(getIdentityLedgerRootPath("Knomo")), null);
	assert.equal(bootstrap.getSnapshot().status, "initializing");
	await vault.app.vault.createFolder("Knomo");
	await vault.app.vault.createFolder("Knomo/_knomo-data");
	await vault.app.vault.createFolder(getIdentityLedgerRootPath("Knomo"));
	await vault.app.vault.createFolder(`${getIdentityLedgerRootPath("Knomo")}/writers`);
	await shared.initialize();
	await shared.publishLocalConfig();
	markLayoutReady();
	await initialization;

	assert.equal(bootstrap.getSnapshot().status, "ready");
	assert.equal(shared.getStatus(), "ready");
});

test("1.2.9 已有目录在 Vault 延迟确认新目录时自动初始化", async () => {
	const vault = new InMemoryVault();
	installLayoutWorkspace(vault);
	await vault.app.vault.createFolder("Knomo");
	const createFolder = vault.app.vault.createFolder.bind(vault.app.vault);
	let injectedFolderRace = false;
	vault.app.vault.createFolder = async (path) => {
		if (!injectedFolderRace && path === "Knomo/_knomo-data") {
			injectedFolderRace = true;
			setTimeout(() => { void createFolder(path); }, 0);
			throw new Error("Folder already exists.");
		}
		return createFolder(path);
	};
	let location = { knomoDataRoot: "Knomo", knomoDataRootConfigured: false };
	const ledger = createLedger(vault, () => location);
	const migration = new KnomoDataRootMigrationService(
		vault.app,
		ledger,
		() => location,
		async (root) => { location = { knomoDataRoot: root, knomoDataRootConfigured: true }; },
	);
	const shared = createSharedConfig(vault, () => location, "## Memos");
	const bootstrap = new KnomoStartupBootstrapService(vault.app, {
		getLocation: () => location,
		initializeDataRoot: async (root) => { await migration.migrate(root); },
		identity: ledger,
		sharedConfig: shared,
	});

	await bootstrap.initialize();

	assert.equal(injectedFolderRace, true);
	assert.equal(location.knomoDataRootConfigured, true);
	assert.equal(bootstrap.getSnapshot().status, "ready");
});

test("已配置但 Identity 根丢失时保留真实失败阶段，不伪造新的 Identity Ledger", async () => {
	const vault = new InMemoryVault();
	installLayoutWorkspace(vault);
	const location = { knomoDataRoot: "Knomo", knomoDataRootConfigured: true };
	const ledger = createLedger(vault, () => location);
	const shared = createSharedConfig(vault, () => location, "## Memos");
	let initializeCalls = 0;
	const bootstrap = new KnomoStartupBootstrapService(vault.app, {
		getLocation: () => location,
		initializeDataRoot: async () => { initializeCalls += 1; },
		identity: ledger,
		sharedConfig: shared,
	});

	await assert.rejects(bootstrap.initialize(), /Identity Ledger root is missing/u);

	assert.equal(initializeCalls, 0);
	assert.equal(shared.getStatus(), "missing");
	assert.equal(vault.app.vault.getAbstractFileByPath(getIdentityLedgerRootPath("Knomo")), null);
	assert.deepEqual(bootstrap.getSnapshot(), {
		status: "unavailable",
		stage: "identity",
		error: "Configured Identity Ledger root is missing.",
	});
});

test("已有共享配置时启动不追加事件也不覆盖其他设备配置", async () => {
	const vault = new InMemoryVault();
	installLayoutWorkspace(vault);
	const location = { knomoDataRoot: "Knomo", knomoDataRootConfigured: true };
	await vault.app.vault.createFolder("Knomo/_knomo-data");
	await vault.app.vault.createFolder(getIdentityLedgerRootPath("Knomo"));
	await vault.app.vault.createFolder(`${getIdentityLedgerRootPath("Knomo")}/writers`);
	const ledger = createLedger(vault, () => location);
	const writer = createSharedConfig(vault, () => location, "## Shared");
	await writer.initialize();
	await writer.publishLocalConfig();
	const pathsBefore = vault.paths();
	const reader = createSharedConfig(vault, () => location, "## Local");
	await reader.initialize();
	const bootstrap = new KnomoStartupBootstrapService(vault.app, {
		getLocation: () => location,
		initializeDataRoot: async () => { throw new Error("不应初始化已配置根"); },
		identity: ledger,
		sharedConfig: reader,
	});

	await bootstrap.initialize();

	assert.deepEqual(vault.paths(), pathsBefore);
	assert.equal(reader.getEffectiveConfig().daily.headings[0], "## Shared");
});

test("并发明确初始化复用同一个操作", async () => {
	const vault = new InMemoryVault();
	installLayoutWorkspace(vault);
	let location = { knomoDataRoot: "Knomo", knomoDataRootConfigured: false };
	let releaseInitialization!: () => void;
	const initializationBlocked = new Promise<void>((resolve) => { releaseInitialization = resolve; });
	let initializeCalls = 0;
	let sharedStatus: KnomoSharedConfigStatus = "missing";
	const bootstrap = new KnomoStartupBootstrapService(vault.app, {
		getLocation: () => location,
		initializeDataRoot: async () => {
			initializeCalls += 1;
			await initializationBlocked;
			await vault.app.vault.createFolder(`${getIdentityLedgerRootPath("Knomo")}/writers`);
			location = { ...location, knomoDataRootConfigured: true };
		},
		identity: {
			initialize: async () => undefined,
			getStatus: () => "absent",
		},
		sharedConfig: {
			initialize: async () => undefined,
			getStatus: () => sharedStatus,
			getLastError: () => null,
			publishLocalConfig: async () => { sharedStatus = "ready"; },
			resolveWithLocalConfig: async () => { sharedStatus = "ready"; },
		},
	});

	const first = bootstrap.initializeNewDataRoot("Knomo");
	const second = bootstrap.initializeNewDataRoot("Knomo");

	assert.equal(first, second);
	assert.equal(bootstrap.getSnapshot().status, "initializing");
	releaseInitialization();
	await first;
	assert.equal(initializeCalls, 1);
	assert.equal(bootstrap.getSnapshot().status, "ready");
});

test("采用当前设备设置复用初始化流程并显式收敛共享配置冲突", async () => {
	const vault = new InMemoryVault();
	installLayoutWorkspace(vault);
	const location = { knomoDataRoot: "Knomo", knomoDataRootConfigured: true };
	await vault.app.vault.createFolder(`${getIdentityLedgerRootPath("Knomo")}/writers`);
	let sharedStatus: KnomoSharedConfigStatus = "conflicted";
	let resolveCalls = 0;
	let authorizationCalls = 0;
	const bootstrap = new KnomoStartupBootstrapService(vault.app, {
		getLocation: () => location,
		initializeDataRoot: async () => { throw new Error("不应初始化已配置根"); },
		authorizeInitialImport: async () => { authorizationCalls += 1; },
		identity: {
			initialize: async () => undefined,
			getStatus: () => "absent",
		},
		sharedConfig: {
			initialize: async () => undefined,
			getStatus: () => sharedStatus,
			getLastError: () => null,
			publishLocalConfig: async () => undefined,
			resolveWithLocalConfig: async () => {
				resolveCalls += 1;
				sharedStatus = "ready";
			},
		},
	});

	await bootstrap.initialize();
	assert.equal(bootstrap.getSnapshot().status, "conflicted");

	await bootstrap.useCurrentDeviceSettings();

	assert.equal(resolveCalls, 1);
	assert.equal(authorizationCalls, 0);
	assert.equal(bootstrap.getSnapshot().status, "ready");
});

test("重新检查只重读已就绪共享配置，不发布当前设备设置", async () => {
	const vault = new InMemoryVault();
	installLayoutWorkspace(vault);
	const location = { knomoDataRoot: "Knomo", knomoDataRootConfigured: true };
	await vault.app.vault.createFolder(`${getIdentityLedgerRootPath("Knomo")}/writers`);
	let sharedStatus: KnomoSharedConfigStatus = "unavailable";
	let publishCalls = 0;
	const bootstrap = new KnomoStartupBootstrapService(vault.app, {
		getLocation: () => location,
		initializeDataRoot: async () => { throw new Error("已配置根不应重新初始化"); },
		identity: {
			initialize: async () => undefined,
			getStatus: () => "absent",
		},
		sharedConfig: {
			initialize: async () => { sharedStatus = "ready"; },
			getStatus: () => sharedStatus,
			getLastError: () => null,
			publishLocalConfig: async () => { publishCalls += 1; },
			resolveWithLocalConfig: async () => { throw new Error("重新检查不应解决配置"); },
		},
	});

	await bootstrap.retryInitialization();

	assert.equal(publishCalls, 0);
	assert.equal(bootstrap.getSnapshot().status, "ready");
});

test("普通启动和重新检查发现共享配置缺失时都等待用户明确发布", async () => {
	const vault = new InMemoryVault();
	installLayoutWorkspace(vault);
	const location = { knomoDataRoot: "Knomo", knomoDataRootConfigured: true };
	await vault.app.vault.createFolder(`${getIdentityLedgerRootPath("Knomo")}/writers`);
	let publishCalls = 0;
	const bootstrap = new KnomoStartupBootstrapService(vault.app, {
		getLocation: () => location,
		initializeDataRoot: async () => { throw new Error("已配置根不应重新初始化"); },
		identity: {
			initialize: async () => undefined,
			getStatus: () => "absent",
		},
		sharedConfig: {
			initialize: async () => undefined,
			getStatus: () => "missing",
			getLastError: () => null,
			publishLocalConfig: async () => { publishCalls += 1; },
			resolveWithLocalConfig: async () => { throw new Error("重新检查不应解决配置"); },
		},
	});

	await bootstrap.initialize();
	assert.equal(publishCalls, 0);
	await bootstrap.retryInitialization();

	assert.equal(publishCalls, 0);
	assert.deepEqual(bootstrap.getSnapshot(), {
		status: "unconfigured",
		stage: "shared_config",
		error: null,
	});
});

test("布局就绪前卸载会取消初始化且不写入失败状态", async () => {
	const vault = new InMemoryVault();
	const markLayoutReady = installLayoutWorkspace(vault, false);
	const cancellation = new AbortController();
	let initializeCalls = 0;
	const bootstrap = new KnomoStartupBootstrapService(vault.app, {
		getLocation: () => ({ knomoDataRoot: "Knomo", knomoDataRootConfigured: false }),
		initializeDataRoot: async () => { initializeCalls += 1; },
		identity: {
			initialize: async () => undefined,
			getStatus: () => "absent",
		},
		sharedConfig: {
			initialize: async () => undefined,
			getStatus: () => "missing",
			getLastError: () => null,
			publishLocalConfig: async () => undefined,
			resolveWithLocalConfig: async () => undefined,
		},
		cancellationSignal: cancellation.signal,
	});

	const initialization = bootstrap.initialize();
	cancellation.abort();
	await assert.rejects(initialization, /cancelled/u);
	markLayoutReady();
	await Promise.resolve();

	assert.equal(initializeCalls, 0);
	assert.notEqual(bootstrap.getSnapshot().status, "unavailable");
});

function createLedger(
	vault: InMemoryVault,
	getLocation: () => { knomoDataRoot: string; knomoDataRootConfigured: boolean },
): IdentityLedgerService {
	return new IdentityLedgerService(vault.app, {
		getRootPath: () => {
			const location = getLocation();
			return location.knomoDataRootConfigured ? getIdentityLedgerRootPath(location.knomoDataRoot) : null;
		},
		getWriterId: async () => WRITER_ID,
	});
}

function createSharedConfig(
	vault: InMemoryVault,
	getLocation: () => { knomoDataRoot: string; knomoDataRootConfigured: boolean },
	heading: string,
): KnomoSharedConfigService {
	return new KnomoSharedConfigService(vault.app, {
		getRootPath: () => {
			const location = getLocation();
			return location.knomoDataRootConfigured ? getKnomoSharedConfigRootPath(location.knomoDataRoot) : null;
		},
		getWriterId: async () => WRITER_ID,
		getCurrentLocale: () => "en",
		getLocalConfig: async (monthlyLocale) => buildKnomoSharedConfig(
			{ folder: "Daily", format: "YYYY-MM-DD" },
			{
				dailyHeading: heading,
				legacyDailyHeadings: [],
				monthlyMemoFolder: "Knomo",
				monthlyMemoFileFormat: "Memos-YYYY-MM.md",
				monthlyDateHeadingFormat: "## YYYY-MM-DD",
				monthlyDateOrder: "asc",
			},
			monthlyLocale,
		),
		createEventId: () => "c_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
		now: () => new Date("2026-08-23T00:00:00.000Z"),
	});
}

function installLayoutWorkspace(vault: InMemoryVault, layoutReady = true): () => void {
	let ready = layoutReady;
	const callbacks: Array<() => void> = [];
	const workspace = {
		get layoutReady() { return ready; },
		onLayoutReady: (callback: () => void) => {
			if (ready) callback();
			else callbacks.push(callback);
		},
	};
	(vault.app as unknown as { workspace: typeof workspace }).workspace = workspace;
	return () => {
		if (ready) return;
		ready = true;
		for (const callback of callbacks.splice(0)) callback();
	};
}
