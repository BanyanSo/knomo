import assert from "node:assert/strict";
import test from "node:test";

import { getIdentityLedgerRootPath } from "../src/services/IdentityLedgerProtocol";
import { IdentityLedgerService } from "../src/services/IdentityLedgerService";
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

test("首次启用默认创建 Identity 根并发布共享配置", async () => {
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
	await ledger.initialize();
	await shared.initialize();
	const bootstrap = new KnomoStartupBootstrapService(vault.app, {
		getLocation: () => location,
		initializeDataRoot: async (root) => { await migration.migrate(root); },
		identity: ledger,
		sharedConfig: shared,
	});

	await bootstrap.initialize();

	assert.equal(location.knomoDataRootConfigured, true);
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
	markLayoutReady();
	await initialization;

	assert.equal(bootstrap.getSnapshot().status, "ready");
	assert.equal(shared.getStatus(), "ready");
});

test("1.2.9 已有 Knomo 目录且 Vault 延迟确认新目录时在本次启动内完成初始化", async () => {
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

test("并发启动复用同一个初始化操作", async () => {
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

	const first = bootstrap.initialize();
	const second = bootstrap.initialize();

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
	const bootstrap = new KnomoStartupBootstrapService(vault.app, {
		getLocation: () => location,
		initializeDataRoot: async () => { throw new Error("不应初始化已配置根"); },
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

test("重新检查发现共享配置缺失时等待用户明确发布", async () => {
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
