import assert from "node:assert/strict";
import test from "node:test";

import {
	buildKnomoSharedConfig,
	getKnomoSharedConfigRootPath,
} from "../src/services/KnomoSharedConfigProtocol";
import { KnomoSharedConfigService } from "../src/services/KnomoSharedConfigService";
import type { KnomoSharedConfig } from "../src/types/knomoConfig";
import type { KnomoSettings } from "../src/types/settings";
import { InMemoryVault } from "./helpers/InMemoryVault";

const WRITER_A = "w_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const WRITER_B = "w_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const WRITER_C = "w_cccccccccccccccccccccccccccccccc";

test("共享配置缺失时只使用本机 fallback，初始化不写 Vault", async () => {
	const replica = new InMemoryVault({
		"Daily/2026-08-22.md": "## Memos\n- 09:00 local memo\n",
	});
	const service = createService(replica, WRITER_A, "c_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", makeConfig("## Local"));

	await service.initialize();

	assert.equal(service.getStatus(), "missing");
	assert.equal(service.isCoverageComplete(), false);
	assert.equal(service.isMonthlyProjectionAllowed(), true);
	assert.equal(service.getEffectiveConfig().daily.headings[0], "## Local");
	assert.equal(replica.paths().some((path) => path.includes("/_knomo-data/schema/")), false);
});

test("共享配置事件在设备间同步，并且相同事件字节得到相同有效配置", async () => {
	const left = new InMemoryVault();
	await left.app.vault.createFolder("Knomo/_knomo-data");
	const writer = createService(left, WRITER_A, "c_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", makeConfig("## Shared"));
	await writer.initialize();
	await writer.publishLocalConfig();

	const right = new InMemoryVault();
	right.deliverFrom(left);
	const reader = createService(right, WRITER_B, "c_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", makeConfig("## Other local"));
	await reader.initialize();

	assert.equal(reader.getStatus(), "ready");
	assert.equal(reader.isCoverageComplete(), true);
	assert.equal(reader.getEffectiveConfig().daily.headings[0], "## Shared");
	assert.deepEqual(reader.getSnapshot(), writer.getSnapshot());
});

test("并发不同配置保留分叉并暂停 Monthly，显式 resolution 后收敛", async () => {
	const replica = new InMemoryVault();
	await replica.app.vault.createFolder("Knomo/_knomo-data");
	const left = createService(replica, WRITER_A, "c_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", makeConfig("## Left"));
	const right = createService(replica, WRITER_B, "c_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", makeConfig("## Right"));
	await left.initialize();
	await right.initialize();
	await left.publishLocalConfig();
	await right.publishLocalConfig();

	const resolver = createService(replica, WRITER_C, "c_cccccccccccccccccccccccccccccccc", makeConfig("## Chosen"));
	await resolver.initialize();
	assert.equal(resolver.getStatus(), "conflicted");
	assert.equal(resolver.isCoverageComplete(), false);
	assert.equal(resolver.isMonthlyProjectionAllowed(), false);
	assert.equal(resolver.getEffectiveConfig().daily.headings[0], "## Chosen");
	assert.equal(resolver.getSnapshot().headEventIds.length, 2);

	await resolver.resolveWithLocalConfig();

	assert.equal(resolver.getStatus(), "ready");
	assert.equal(resolver.getEffectiveConfig().daily.headings[0], "## Chosen");
	assert.equal(resolver.getSnapshot().headEventIds.length, 1);
	const reloaded = createService(replica, WRITER_A, "c_dddddddddddddddddddddddddddddddd", makeConfig("## Stale local"));
	await reloaded.initialize();
	assert.equal(reloaded.getStatus(), "ready");
	assert.deepEqual(reloaded.getEffectiveConfig(), resolver.getEffectiveConfig());
});

test("P2 第 8 步：两设备离线配置事件按任意到达顺序保持同一冲突状态", async () => {
	const leftVault = new InMemoryVault();
	const rightVault = new InMemoryVault();
	await leftVault.app.vault.createFolder("Knomo/_knomo-data");
	await rightVault.app.vault.createFolder("Knomo/_knomo-data");
	const left = createService(leftVault, WRITER_A, "c_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", makeConfig("## Left"));
	const right = createService(rightVault, WRITER_B, "c_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", makeConfig("## Right"));
	await left.initialize();
	await right.initialize();
	await left.publishLocalConfig();
	await right.publishLocalConfig();

	const mergedAB = new InMemoryVault();
	mergedAB.deliverFrom(leftVault);
	mergedAB.deliverFrom(rightVault);
	const mergedBA = new InMemoryVault();
	mergedBA.deliverFrom(rightVault);
	mergedBA.deliverFrom(leftVault);
	const readerAB = createService(mergedAB, WRITER_C, "c_cccccccccccccccccccccccccccccccc", makeConfig("## Local"));
	const readerBA = createService(mergedBA, WRITER_C, "c_dddddddddddddddddddddddddddddddd", makeConfig("## Local"));
	await readerAB.initialize();
	await readerBA.initialize();

	assert.equal(readerAB.getStatus(), "conflicted");
	assert.equal(readerAB.isMonthlyProjectionAllowed(), false);
	assert.deepEqual(readerAB.getSnapshot(), readerBA.getSnapshot());
});

test("未知配置 schema 只隔离共享配置，仍保留本机 Daily fallback 且不覆盖 Monthly", async () => {
	const replica = new InMemoryVault();
	const root = getKnomoSharedConfigRootPath("Knomo");
	await replica.app.vault.create(
		`${root}/writers/${WRITER_A}/segments/segment-c_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-${"a".repeat(64)}.jsonl`,
		'{"schemaVersion":99}\n',
	);
	const service = createService(replica, WRITER_B, "c_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", makeConfig("## Local"));

	await service.initialize();

	assert.equal(service.getStatus(), "unsupported");
	assert.equal(service.getEffectiveConfig().daily.headings[0], "## Local");
	assert.equal(service.isCoverageComplete(), false);
	assert.equal(service.isMonthlyProjectionAllowed(), false);
});

test("用户迁移 Knomo Data Root 时逐字节复制并验证共享配置事件", async () => {
	const replica = new InMemoryVault();
	await replica.app.vault.createFolder("Knomo-A/_knomo-data");
	const service = new KnomoSharedConfigService(replica.app, {
		getRootPath: () => getKnomoSharedConfigRootPath("Knomo-A"),
		getWriterId: async () => WRITER_A,
		getLocalConfig: async () => makeConfig("## Shared"),
		createEventId: () => "c_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
		now: () => new Date("2026-08-22T00:00:00.000Z"),
	});
	await service.initialize();
	await service.publishLocalConfig();
	await replica.app.vault.createFolder("Knomo-B/_knomo-data");
	const sourceRoot = getKnomoSharedConfigRootPath("Knomo-A");

	await service.copyAndVerifyDataRoot("Knomo-A", "Knomo-B");

	for (const sourcePath of replica.paths().filter((path) => path.startsWith(`${sourceRoot}/`))) {
		const targetPath = `${getKnomoSharedConfigRootPath("Knomo-B")}${sourcePath.slice(sourceRoot.length)}`;
		assert.equal(replica.read(targetPath), replica.read(sourcePath));
	}
});

function createService(
	replica: InMemoryVault,
	writerId: string,
	eventId: string,
	localConfig: KnomoSharedConfig,
): KnomoSharedConfigService {
	return new KnomoSharedConfigService(replica.app, {
		getRootPath: () => getKnomoSharedConfigRootPath("Knomo"),
		getWriterId: async () => writerId,
		getLocalConfig: async () => localConfig,
		createEventId: () => eventId,
		now: () => new Date("2026-08-22T00:00:00.000Z"),
	});
}

function makeConfig(heading: string): KnomoSharedConfig {
	return buildKnomoSharedConfig(
		{ folder: "Daily", format: "YYYY-MM-DD" },
		makeSettings(heading),
	);
}

function makeSettings(heading: string): KnomoSettings {
	return {
		settingsVersion: 4,
		dailyHeading: heading,
		dailyInsertPosition: "bottom",
		memoTimeFormat: "HH:mm:ss",
		knomoDataRoot: "Knomo",
		knomoDataRootConfigured: true,
		monthlyMemoFolder: "Monthly",
		monthlyMemoFileFormat: "YYYY-MM.md",
		monthlyDateHeadingFormat: "## YYYY-MM-DD",
		monthlyDateOrder: "asc",
		legacyDailyHeadings: [],
		timeBuoyEnabled: false,
		mobileCompactMode: "auto",
		syncDebounceMs: 1_000,
		desktopSidebarWidth: 248,
		desktopSidebarCollapsed: false,
		excludeMonthlyMemosFromObsidian: false,
		pinnedTags: [],
	};
}
