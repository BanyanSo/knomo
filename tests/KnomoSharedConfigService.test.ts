import assert from "node:assert/strict";
import test from "node:test";

import {
	buildKnomoSharedConfig,
	getKnomoSharedConfigRootPath,
} from "../src/services/KnomoSharedConfigProtocol";
import { KnomoSharedConfigService } from "../src/services/KnomoSharedConfigService";
import type { App, Component } from "obsidian";

import type { KnomoSharedConfig } from "../src/types/knomoConfig";
import type { KnomoSettings } from "../src/types/settings";
import { InMemoryVault } from "./helpers/InMemoryVault";

const WRITER_A = "w_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const WRITER_B = "w_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const WRITER_C = "w_cccccccccccccccccccccccccccccccc";

test("启动监听与显式初始化复用一次共享配置全量刷新", async () => {
	const replica = new InMemoryVault();
	installVaultListenerSupport(replica);
	const service = createService(replica, WRITER_A, "c_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", makeConfig("## Local"));
	const refreshTarget = service as unknown as { refreshFromVault(): Promise<void> };
	const refreshFromVault = refreshTarget.refreshFromVault.bind(service);
	let refreshCount = 0;
	let releaseRefresh!: () => void;
	const refreshBlocked = new Promise<void>((resolve) => { releaseRefresh = resolve; });
	let notificationCount = 0;
	refreshTarget.refreshFromVault = async () => {
		refreshCount += 1;
		await refreshBlocked;
		await refreshFromVault();
	};

	service.start(createOwner(), async () => { notificationCount += 1; });
	const initialization = service.initialize();
	await new Promise<void>((resolve) => { setTimeout(resolve, 0); });

	assert.equal(refreshCount, 1);
	releaseRefresh();
	await initialization;
	await new Promise<void>((resolve) => { setTimeout(resolve, 0); });
	assert.equal(notificationCount, 1);
});

test("插件卸载会取消 active 共享配置刷新，旧结果不得提交或通知", async () => {
	const replica = new InMemoryVault();
	installVaultListenerSupport(replica);
	const service = createService(replica, WRITER_A, "c_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", makeConfig("## Local"));
	const refreshTarget = service as unknown as { refreshFromVault(): Promise<void> };
	const refreshFromVault = refreshTarget.refreshFromVault.bind(service);
	let releaseRefresh!: () => void;
	const refreshBlocked = new Promise<void>((resolve) => { releaseRefresh = resolve; });
	let markRefreshStarted!: () => void;
	const refreshStarted = new Promise<void>((resolve) => { markRefreshStarted = resolve; });
	refreshTarget.refreshFromVault = async () => {
		markRefreshStarted();
		await refreshBlocked;
		await refreshFromVault();
	};
	let notificationCount = 0;
	const owner = createUnloadableOwner();

	service.start(owner.component, async () => { notificationCount += 1; });
	const initialization = service.initialize();
	await refreshStarted;
	owner.unload();
	releaseRefresh();
	await initialization;

	assert.equal(service.getStatus(), "missing");
	assert.equal(service.getSnapshot().revision, "");
	assert.equal(notificationCount, 0);
});

test("共享配置缺失时只使用本机 fallback，初始化不写 Vault", async () => {
	const replica = new InMemoryVault({
		"Daily/2026-08-22.md": "## Memos\n- 09:00 local memo\n",
	});
	const service = createService(replica, WRITER_A, "c_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", makeConfig("## Local"));

	await service.initialize();

	assert.equal(service.getStatus(), "missing");
	assert.equal(service.isCoverageComplete(), false);
	assert.equal(service.isMonthlyProjectionAllowed(), false);
	assert.equal(service.getEffectiveConfig().daily.headings[0], "## Local");
	assert.equal(replica.paths().some((path) => path.includes("/_knomo-data/schema/")), false);
});

test("共享配置读取失败时保留底层错误", async () => {
	const replica = new InMemoryVault();
	const root = getKnomoSharedConfigRootPath("Knomo");
	await replica.app.vault.create(root, "not-a-folder");
	const service = createService(replica, WRITER_A, "c_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", makeConfig("## Local"));

	await service.initialize();

	assert.equal(service.getStatus(), "unavailable");
	assert.match(service.getLastError() ?? "", /root is not a folder/u);
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
	assert.equal("schemaVersion" in reader.getEffectiveConfig(), false);
	assert.equal("rendererVersion" in reader.getEffectiveConfig().monthly, false);
	assert.equal(left.paths().some((path) => left.read(path)?.includes("schemaVersion")), false);
	assert.deepEqual(reader.getSnapshot(), writer.getSnapshot());
});

test("设备语言变化不会静默改写已持久化的 Monthly locale", async () => {
	const replica = new InMemoryVault();
	await replica.app.vault.createFolder("Knomo/_knomo-data");
	let currentLocale = "en";
	const service = createService(
		replica,
		WRITER_A,
		["c_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "c_dddddddddddddddddddddddddddddddd"],
		makeConfig("## Shared"),
		() => currentLocale,
	);
	await service.initialize();
	await service.publishLocalConfig();
	const before = service.getSnapshot();

	currentLocale = "fr";
	await service.refreshLocalConfig();
	await service.publishLocalConfig();

	assert.equal(service.getEffectiveConfig().monthly.locale, "en");
	assert.equal(service.getSnapshot().eventCount, before.eventCount);
});

test("发布与共享配置相同的本机设置不触发变更通知", async () => {
	const replica = new InMemoryVault();
	await replica.app.vault.createFolder("Knomo/_knomo-data");
	const service = createService(
		replica,
		WRITER_A,
		["c_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "c_dddddddddddddddddddddddddddddddd"],
		makeConfig("## Shared"),
	);
	await service.initialize();
	await service.publishLocalConfig();
	let notifyCount = 0;
	(service as unknown as { onChanged: () => void }).onChanged = () => {
		notifyCount += 1;
	};

	await service.publishLocalConfig();

	assert.equal(notifyCount, 0);
});

test("发布共享配置不等待后台派生刷新完成", async () => {
	const replica = new InMemoryVault();
	await replica.app.vault.createFolder("Knomo/_knomo-data");
	const service = createService(
		replica,
		WRITER_A,
		"c_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
		makeConfig("## Shared"),
	);
	await service.initialize();
	let releaseRefresh!: () => void;
	let refreshStarted = false;
	let refreshFinished = false;
	const refreshBlocked = new Promise<void>((resolve) => { releaseRefresh = resolve; });
	(service as unknown as { onChanged: () => Promise<void> }).onChanged = async () => {
		refreshStarted = true;
		await refreshBlocked;
		refreshFinished = true;
	};

	const publication = service.publishLocalConfig();
	const returnedBeforeRefresh = await Promise.race([
		publication.then(() => true),
		new Promise<boolean>((resolve) => { setTimeout(() => resolve(false), 100); }),
	]);
	releaseRefresh();
	await publication;
	await (service as unknown as { changeNotificationQueue: Promise<void> }).changeNotificationQueue;

	assert.equal(returnedBeforeRefresh, true);
	assert.equal(refreshStarted, true);
	assert.equal(refreshFinished, true);
	assert.equal(service.getStatus(), "ready");
});

test("显式使用当前 Obsidian 语言后，各设备最终读取同一 Monthly locale", async () => {
	const left = new InMemoryVault();
	await left.app.vault.createFolder("Knomo/_knomo-data");
	let currentLocale = "en";
	const writer = createService(
		left,
		WRITER_A,
		["c_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "c_dddddddddddddddddddddddddddddddd"],
		makeConfig("## Shared"),
		() => currentLocale,
	);
	await writer.initialize();
	await writer.publishLocalConfig();

	currentLocale = "fr_FR";
	assert.equal(await writer.useCurrentObsidianLocale(), true);
	assert.equal(writer.getEffectiveConfig().monthly.locale, "fr-fr");

	const right = new InMemoryVault();
	right.deliverFrom(left);
	const reader = createService(
		right,
		WRITER_B,
		"c_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
		makeConfig("## Other"),
		() => "de",
	);
	await reader.initialize();
	assert.equal(reader.getEffectiveConfig().monthly.locale, "fr-fr");
});

test("两设备离线选择不同 locale 时保留冲突并暂停 Monthly", async () => {
	const leftVault = new InMemoryVault();
	const rightVault = new InMemoryVault();
	await leftVault.app.vault.createFolder("Knomo/_knomo-data");
	await rightVault.app.vault.createFolder("Knomo/_knomo-data");
	const left = createService(
		leftVault,
		WRITER_A,
		"c_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
		makeConfig("## Local"),
		() => "en",
	);
	const right = createService(
		rightVault,
		WRITER_B,
		"c_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
		makeConfig("## Local"),
		() => "fr",
	);
	await left.initialize();
	await right.initialize();
	await left.publishLocalConfig();
	await right.publishLocalConfig();

	const merged = new InMemoryVault({
		"Daily/2026-08-22.md": "## Memos\n- 09:00 unchanged\n",
	});
	merged.deliverFrom(leftVault);
	merged.deliverFrom(rightVault);
	const reader = createService(
		merged,
		WRITER_C,
		"c_dddddddddddddddddddddddddddddddd",
		makeConfig("## Local"),
		() => "de",
	);
	await reader.initialize();

	assert.equal(reader.getStatus(), "conflicted");
	assert.equal(reader.isCoverageComplete(), false);
	assert.equal(reader.isMonthlyProjectionAllowed(), false);
	assert.equal(merged.read("Daily/2026-08-22.md"), "## Memos\n- 09:00 unchanged\n");
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

test("非法共享配置文件只隔离共享配置，仍保留本机 Daily fallback 且不覆盖 Monthly", async () => {
	const replica = new InMemoryVault();
	const root = getKnomoSharedConfigRootPath("Knomo");
	await replica.app.vault.create(
		`${root}/writers/${WRITER_A}/segments/segment-c_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-${"a".repeat(64)}.jsonl`,
		'{"unexpected":true}\n',
	);
	const service = createService(replica, WRITER_B, "c_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", makeConfig("## Local"));

	await service.initialize();

	assert.equal(service.getStatus(), "conflicted");
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
		getCurrentLocale: () => "en",
		getLocalConfig: async (monthlyLocale) => makeConfig("## Shared", monthlyLocale),
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
	eventId: string | string[],
	localConfig: KnomoSharedConfig,
	getCurrentLocale: () => string = () => "en",
): KnomoSharedConfigService {
	const eventIds = Array.isArray(eventId) ? eventId : [eventId];
	let eventIndex = 0;
	return new KnomoSharedConfigService(replica.app, {
		getRootPath: () => getKnomoSharedConfigRootPath("Knomo"),
		getWriterId: async () => writerId,
		getCurrentLocale,
		getLocalConfig: async (monthlyLocale) => ({
			...localConfig,
			monthly: { ...localConfig.monthly, locale: monthlyLocale },
		}),
		createEventId: () => eventIds[Math.min(eventIndex++, eventIds.length - 1)] ?? eventIds[0] ?? "",
		now: () => new Date("2026-08-22T00:00:00.000Z"),
	});
}

function installVaultListenerSupport(vault: InMemoryVault): void {
	(vault.app.vault as App["vault"] & { on: () => object }).on = () => ({});
}

function createOwner(): Component {
	return {
		registerEvent: () => undefined,
		register: () => undefined,
	} as unknown as Component;
}

function createUnloadableOwner(): { component: Component; unload: () => void } {
	const cleanups: Array<() => void> = [];
	return {
		component: {
			registerEvent: () => undefined,
			register: (cleanup: () => void) => { cleanups.push(cleanup); },
		} as unknown as Component,
		unload: () => { cleanups.forEach((cleanup) => cleanup()); },
	};
}

function makeConfig(heading: string, locale = "en"): KnomoSharedConfig {
	return buildKnomoSharedConfig(
		{ folder: "Daily", format: "YYYY-MM-DD" },
		makeSettings(heading),
		locale,
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
