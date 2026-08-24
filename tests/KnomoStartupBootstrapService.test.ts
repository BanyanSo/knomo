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
import { InMemoryVault } from "./helpers/InMemoryVault";

const WRITER_ID = "w_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

test("首次启用默认创建 Identity 根并发布共享配置", async () => {
	const vault = new InMemoryVault();
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
		sharedConfig: shared,
	});

	await bootstrap.initialize();

	assert.equal(location.knomoDataRootConfigured, true);
	assert.notEqual(vault.app.vault.getAbstractFileByPath(`${getIdentityLedgerRootPath("Knomo")}/writers`), null);
	assert.equal(shared.getStatus(), "ready");
	assert.equal(shared.getEffectiveConfig().daily.headings[0], "## Memos");
	assert.equal(vault.paths().some((path) => path.startsWith(`${getKnomoSharedConfigRootPath("Knomo")}/`)), true);
});

test("已配置但 Identity 根丢失时只补共享配置，不伪造新的 Identity Ledger", async () => {
	const vault = new InMemoryVault();
	const location = { knomoDataRoot: "Knomo", knomoDataRootConfigured: true };
	const shared = createSharedConfig(vault, () => location, "## Memos");
	await shared.initialize();
	let initializeCalls = 0;
	const bootstrap = new KnomoStartupBootstrapService(vault.app, {
		getLocation: () => location,
		initializeDataRoot: async () => { initializeCalls += 1; },
		sharedConfig: shared,
	});

	await bootstrap.initialize();

	assert.equal(initializeCalls, 0);
	assert.equal(shared.getStatus(), "ready");
	assert.equal(vault.app.vault.getAbstractFileByPath(getIdentityLedgerRootPath("Knomo")), null);
});

test("已有共享配置时启动不追加事件也不覆盖其他设备配置", async () => {
	const vault = new InMemoryVault();
	const location = { knomoDataRoot: "Knomo", knomoDataRootConfigured: true };
	await vault.app.vault.createFolder("Knomo/_knomo-data");
	const writer = createSharedConfig(vault, () => location, "## Shared");
	await writer.initialize();
	await writer.publishLocalConfig();
	const pathsBefore = vault.paths();
	const reader = createSharedConfig(vault, () => location, "## Local");
	await reader.initialize();
	const bootstrap = new KnomoStartupBootstrapService(vault.app, {
		getLocation: () => location,
		initializeDataRoot: async () => { throw new Error("不应初始化已配置根"); },
		sharedConfig: reader,
	});

	await bootstrap.initialize();

	assert.deepEqual(vault.paths(), pathsBefore);
	assert.equal(reader.getEffectiveConfig().daily.headings[0], "## Shared");
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
		getLocalConfig: async () => buildKnomoSharedConfig(
			{ folder: "Daily", format: "YYYY-MM-DD" },
			{
				dailyHeading: heading,
				legacyDailyHeadings: [],
				monthlyMemoFolder: "Knomo",
				monthlyMemoFileFormat: "Memos-YYYY-MM.md",
				monthlyDateHeadingFormat: "## YYYY-MM-DD",
				monthlyDateOrder: "asc",
			},
		),
		createEventId: () => "c_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
		now: () => new Date("2026-08-23T00:00:00.000Z"),
	});
}
