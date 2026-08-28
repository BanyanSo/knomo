import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { TFile } from "obsidian";

import {
	MONTHLY_PROJECTION_CHECKPOINT_META_KEY,
	MonthlyProjectionCoordinator,
} from "../src/services/MonthlyProjectionCoordinator";
import { MonthlyProjectionInputBuilder } from "../src/services/MonthlyProjectionInputBuilder";
import type { MonthlyProjectionSettings } from "../src/services/MonthlyProjection";
import { DiaryMemoParser } from "../src/services/DiaryMemoParser";
import { InMemoryMemoCatalogStore } from "../src/services/MemoCatalogStore";
import { SelfWriteTracker } from "../src/services/SelfWriteTracker";
import { LowPriorityWorkQueue } from "../src/services/LowPriorityWorkQueue";
import type { LowPriorityWorkRunner } from "../src/services/LowPriorityWorkQueue";
import { InMemoryVault } from "./helpers/InMemoryVault";

const MONTHLY_PATH = "Memos/2026-08.md";
const DAILY_A = "## Memos\n- 09:00 unresolved memo\n";
const DAILY_B = "## Memos\n- 10:00 ambiguous memo\n";
const LEGACY_MONTHLY_MARKER = [
	"<!-- knomo:monthly-archive",
	"Knomo 月度归档文件：此文件根据日记自动生成。请勿直接在此编辑 memo；请在 Knomo 或对应日记中编辑。",
	"-->",
].join("\n");

test("Monthly 的完整输入只来自实际 Daily，空或 partial Catalog 不能造成子集覆盖", async () => {
	const fixture = createFixture({
		"Daily/2026-08-01.md": DAILY_A,
		"Daily/2026-08-02.md": DAILY_B,
	});

	const built = await fixture.inputBuilder.build("2026-08");
	assert.deepEqual(built.sourcePaths, ["Daily/2026-08-01.md", "Daily/2026-08-02.md"]);
	assert.deepEqual(built.observations.map((item) => item.content), ["unresolved memo", "ambiguous memo"]);
	assert.equal(built.observations.length, 2);

	assert.deepEqual(await fixture.coordinator.rebuildPeriod("2026-08"), { projected: 1, failed: 0 });
	const monthly = fixture.replica.read(MONTHLY_PATH) ?? "";
	assert.match(monthly, /unresolved memo/u);
	assert.match(monthly, /ambiguous memo/u);
	assert.equal(fixture.replica.paths().some((path) => path.includes("_knomo-data")), false);
});

test("Monthly 与 Catalog 共用全区域 Parser 语义，source 输入不包含写入标题", async () => {
	const daily = {
		"Daily/2026-08-27.md": "- 12:58 root\n### Ideas\n- 14:26 under ideas\n",
	};
	const fixture = createFixture(daily);
	const built = await fixture.inputBuilder.build("2026-08");

	assert.deepEqual(built.observations.map((item) => [item.time, item.section, item.content]), [
		["12:58", null, "root"],
		["14:26", "### Ideas", "under ideas"],
	]);
	assert.equal(typeof built.sourceDigest, "string");
});

test("启动只投影当前月，历史 Monthly 保持原字节且各月份复用同一 Daily inventory", async () => {
	const historicalMonthly = "用户编辑过的旧 Monthly\n";
	const fixture = createFixture({
		"Daily/2026-07-01.md": "- 09:00 July\n",
		"Daily/2026-08-01.md": "- 09:00 August\n",
		"Memos/2026-07.md": historicalMonthly,
	}, () => true, { currentPeriod: () => "2026-08" });
	const vault = fixture.replica.app.vault as unknown as { getMarkdownFiles(): TFile[] };
	const getMarkdownFiles = vault.getMarkdownFiles.bind(vault);
	let inventoryReadCount = 0;
	vault.getMarkdownFiles = () => {
		inventoryReadCount += 1;
		return getMarkdownFiles();
	};

	await fixture.coordinator.initialize();
	assert.deepEqual(await fixture.coordinator.run(true), { projected: 1, failed: 0 });
	assert.equal(fixture.replica.read("Memos/2026-07.md"), historicalMonthly);
	assert.match(fixture.replica.read("Memos/2026-08.md") ?? "", /August/u);
	assert.equal(inventoryReadCount, 1);

	await fixture.coordinator.rebuildPeriod("2026-07");
	assert.equal(inventoryReadCount, 1);
});

test("当前月只有空 Daily 时只检查候选月份，不创建 Monthly 文件", async () => {
	const fixture = createFixture({
		"Daily/2026-08-01.md": "# Journal\nordinary note\n",
	}, () => true, { currentPeriod: () => "2026-08" });

	await fixture.coordinator.initialize();
	assert.deepEqual(await fixture.coordinator.run(true), { projected: 1, failed: 0 });
	assert.equal(fixture.replica.read(MONTHLY_PATH), null);
	assert.equal(fixture.replica.paths().includes("Memos"), false);
});

test("历史 Monthly 发现只纳入带 marker 的文件", async () => {
	const fixture = createFixture({
		"Memos/2026-06.md": `${LEGACY_MONTHLY_MARKER}\n\n# 2026-06\n`,
		"Memos/2026-07.md": "# User file\n",
	});

	assert.deepEqual(await fixture.inputBuilder.listOwnedMonthlyPeriods(), ["2026-06"]);
});

test("同路径文件没有 marker 时静默保留原字节且不构建 Daily 输入", async () => {
	const userContent = "# My monthly notes\nkeep this file\n";
	const fixture = createFixture({
		"Daily/2026-08-01.md": DAILY_A,
		[MONTHLY_PATH]: userContent,
	});
	let buildCount = 0;
	const originalBuild = fixture.inputBuilder.build.bind(fixture.inputBuilder);
	fixture.inputBuilder.build = async (period) => {
		buildCount += 1;
		return originalBuild(period);
	};

	assert.deepEqual(await fixture.coordinator.rebuildPeriod("2026-08"), { projected: 1, failed: 0 });
	assert.equal(buildCount, 0);
	assert.equal(fixture.replica.read(MONTHLY_PATH), userContent);
	assert.equal(fixture.coordinator.getProjectionState(), "ready");
});

test("带旧 marker 的 1.2.9 Monthly 原样保留 marker 并继续维护正文", async () => {
	const fixture = createFixture({
		"Daily/2026-08-01.md": DAILY_A,
		[MONTHLY_PATH]: `${LEGACY_MONTHLY_MARKER}\n\n# 2026-08\n\nold body\n`,
	});

	await fixture.coordinator.rebuildPeriod("2026-08");
	const monthly = fixture.replica.read(MONTHLY_PATH) ?? "";
	assert.equal(monthly.startsWith(`${LEGACY_MONTHLY_MARKER}\n\n# 2026-08`), true);
	assert.match(monthly, /unresolved memo/u);
	assert.equal(monthly.includes("<small>"), false);
});

test("已有合法 Monthly 在当月无 memo 时保留文件", async () => {
	const fixture = createFixture({
		"Daily/2026-08-01.md": "# Journal\nordinary note\n",
		[MONTHLY_PATH]: "<!-- knomo:monthly-archive -->\n\n<small>old notice</small>\n\n# 2026-08\n\nold body\n",
	});

	assert.deepEqual(await fixture.coordinator.rebuildPeriod("2026-08"), { projected: 1, failed: 0 });
	const monthly = fixture.replica.read(MONTHLY_PATH);
	assert.ok(monthly !== null);
	assert.equal(monthly.startsWith("<!-- knomo:monthly-archive -->\n\n<small>"), true);
	assert.equal(monthly.includes("old body"), false);
});

test("写入标题变化不使 Monthly 全量失效，locale 或渲染设置变化才重投所有月份", async () => {
	const fixture = createFixture({
		"Daily/2026-07-01.md": "- 09:00 July\n",
		"Daily/2026-08-01.md": "- 09:00 August\n",
	}, () => true, { currentPeriod: () => "2026-08" });
	await fixture.coordinator.initialize();
	await fixture.coordinator.run(true);

	await fixture.coordinator.handleConfigurationChanged();
	assert.deepEqual(await fixture.coordinator.run(true), { projected: 0, failed: 0 });

	fixture.settings.monthlyDateHeadingFormat = "## D MMMM YYYY";
	await fixture.coordinator.handleConfigurationChanged();
	assert.deepEqual(await fixture.coordinator.run(true), { projected: 2, failed: 0 });
});

test("配置全量重投影优先使用 Catalog 中实际有 memo 的月份", async () => {
	const fixture = createFixture({
		"Daily/2026-07-01.md": "# Journal\nordinary note\n",
		"Daily/2026-08-01.md": DAILY_A,
	}, () => true, {
		currentPeriod: () => "2026-08",
		listCatalogPeriods: async () => ["2026-08"],
	});
	await fixture.coordinator.initialize();
	await fixture.coordinator.run(true);
	const projectedPeriods: string[] = [];
	const originalBuild = fixture.inputBuilder.build.bind(fixture.inputBuilder);
	fixture.inputBuilder.build = async (period) => {
		projectedPeriods.push(period);
		return originalBuild(period);
	};

	fixture.settings.monthlyDateHeadingFormat = "## D MMMM YYYY";
	await fixture.coordinator.handleConfigurationChanged();
	assert.deepEqual(await fixture.coordinator.run(true), { projected: 1, failed: 0 });
	assert.deepEqual(projectedPeriods, ["2026-08"]);
	assert.equal(fixture.replica.read("Memos/2026-07.md"), null);
});

test("Catalog 尚未 complete 时保留发现任务，settle 后以 Daily 低优先级兜底并收敛", async () => {
	const fixture = createFixture({
		"Daily/2026-07-01.md": "- 09:00 July\n",
		"Daily/2026-08-01.md": "- 09:00 August\n",
	}, () => true, {
		currentPeriod: () => "2026-08",
		listCatalogPeriods: async () => { throw new Error("Catalog coverage is partial"); },
	});
	await fixture.coordinator.initialize();
	await fixture.coordinator.run(true);

	fixture.settings.monthlyDateHeadingFormat = "## D MMMM YYYY";
	await fixture.coordinator.handleConfigurationChanged();
	assert.deepEqual(await fixture.coordinator.run(true), { projected: 1, failed: 0 });
	await fixture.coordinator.handleCatalogSettled();
	assert.deepEqual(await fixture.coordinator.run(true), { projected: 2, failed: 0 });
	assert.match(fixture.replica.read("Memos/2026-07.md") ?? "", /July/u);
});

test("未完成的 Monthly 月份写入 Catalog 本地 checkpoint，重启后继续处理", async () => {
	const checkpointStore = new InMemoryMemoCatalogStore();
	const first = createFixture({
		"Daily/2026-07-01.md": "- 09:00 July\n",
		"Daily/2026-08-01.md": "- 09:00 August\n",
	}, () => true, { currentPeriod: () => "2026-08", checkpointStore });
	await first.coordinator.initialize();
	await first.coordinator.run(true);
	await first.coordinator.invalidatePeriods(["2026-07"]);
	const saved = await checkpointStore.getMeta<{ pending: Array<{ period: string }> }>(
		MONTHLY_PROJECTION_CHECKPOINT_META_KEY,
	);
	assert.deepEqual(saved?.pending.map((item) => item.period), ["2026-07"]);

	const second = createFixture({
		"Daily/2026-07-01.md": "- 09:00 July\n",
		"Daily/2026-08-01.md": "- 09:00 August\n",
	}, () => true, { currentPeriod: () => "2026-08", checkpointStore });
	await second.coordinator.initialize();
	assert.deepEqual(await second.coordinator.run(true), { projected: 2, failed: 0 });
	assert.match(second.replica.read("Memos/2026-07.md") ?? "", /July/u);
	const completed = await checkpointStore.getMeta<{ pending: unknown[] }>(MONTHLY_PROJECTION_CHECKPOINT_META_KEY);
	assert.deepEqual(completed?.pending, []);
});

test("停止时不再创建 Monthly，checkpoint 保留未完成月份", async () => {
	const checkpointStore = new InMemoryMemoCatalogStore();
	const fixture = createFixture({ "Daily/2026-08-01.md": DAILY_A }, () => true, {
		currentPeriod: () => "2026-08",
		checkpointStore,
	});
	const buildGate: { release?: () => void } = {};
	const buildStarted = new Promise<void>((resolveStarted) => {
		const originalBuild = fixture.inputBuilder.build.bind(fixture.inputBuilder);
		fixture.inputBuilder.build = async (period) => {
			resolveStarted();
			await new Promise<void>((resolve) => { buildGate.release = resolve; });
			return originalBuild(period);
		};
	});
	await fixture.coordinator.initialize();
	const running = fixture.coordinator.run(true);
	await buildStarted;
	(fixture.coordinator as unknown as { stop(): void }).stop();
	assert.ok(buildGate.release !== undefined);
	buildGate.release();

	assert.deepEqual(await running, { projected: 0, failed: 0 });
	assert.equal(fixture.replica.read(MONTHLY_PATH), null);
	const saved = await checkpointStore.getMeta<{ pending: Array<{ period: string }> }>(
		MONTHLY_PROJECTION_CHECKPOINT_META_KEY,
	);
	assert.deepEqual(saved?.pending.map((item) => item.period), ["2026-08"]);
});

test("统一队列停止后 active Monthly 构建结果不得写入 Vault", async () => {
	const workQueue = new LowPriorityWorkQueue(() => ({
		setTimeout: (callback, delay) => globalThis.setTimeout(callback, delay) as unknown as number,
		clearTimeout: (timer) => globalThis.clearTimeout(timer as unknown as NodeJS.Timeout),
	}));
	const fixture = createFixture({ "Daily/2026-08-01.md": DAILY_A }, () => true, {
		currentPeriod: () => "2026-08",
		workQueue,
	});
	let releaseBuild = (): void => undefined;
	const buildGate = new Promise<void>((resolve) => { releaseBuild = resolve; });
	let markBuildStarted = (): void => undefined;
	const buildStarted = new Promise<void>((resolve) => { markBuildStarted = resolve; });
	const originalBuild = fixture.inputBuilder.build.bind(fixture.inputBuilder);
	fixture.inputBuilder.build = async (period) => {
		markBuildStarted();
		await buildGate;
		return originalBuild(period);
	};
	await fixture.coordinator.initialize();
	const running = fixture.coordinator.run(true);
	await buildStarted;

	workQueue.stop();
	releaseBuild();

	assert.deepEqual(await running, { projected: 0, failed: 0 });
	assert.equal(fixture.replica.read(MONTHLY_PATH), null);
});

test("当前月和实际变更月份优先，并在每个月份完成后让出事件循环", async () => {
	let yieldCount = 0;
	const priorities: number[] = [];
	const fixture = createFixture({
		"Daily/2026-07-01.md": "- 09:00 July\n",
		"Daily/2026-08-01.md": "- 09:00 August\n",
	}, () => true, {
		currentPeriod: () => "2026-08",
		yieldControl: async () => { yieldCount += 1; },
		workQueue: {
			signal: new AbortController().signal,
			run: async <T>(priority: number, action: () => Promise<T>): Promise<T> => {
				priorities.push(priority);
				return action();
			},
		},
	});
	await fixture.coordinator.initialize();
	await fixture.coordinator.run(true);
	yieldCount = 0;
	priorities.length = 0;
	const projectedOrder: string[] = [];
	const originalBuild = fixture.inputBuilder.build.bind(fixture.inputBuilder);
	fixture.inputBuilder.build = async (period) => {
		projectedOrder.push(period);
		return originalBuild(period);
	};

	await fixture.coordinator.invalidateChangedPeriods(["2026-07", "2026-08"]);
	assert.deepEqual(await fixture.coordinator.run(true), { projected: 2, failed: 0 });
	assert.deepEqual(projectedOrder, ["2026-08", "2026-07"]);
	assert.equal(yieldCount, 2);
	assert.equal(priorities.length, 2);
});

test("大月份在 Daily 解析和投影构建期间按预算多次让出事件循环", async () => {
	let yieldCount = 0;
	const dailyContent = Array.from({ length: 600 }, (_, index) => (
		`- 09:00 memo ${index}`
	)).join("\n");
	const fixture = createFixture({
		"Daily/2026-08-01.md": `${dailyContent}\n`,
	}, () => true, {
		currentPeriod: () => "2026-08",
		yieldControl: async () => { yieldCount += 1; },
		sliceBudgetMs: 60_000,
	});

	await fixture.coordinator.initialize();
	yieldCount = 0;
	assert.deepEqual(await fixture.coordinator.run(true), { projected: 1, failed: 0 });

	assert.ok(yieldCount > 1);
	assert.match(fixture.replica.read(MONTHLY_PATH) ?? "", /memo 599/u);
});

test("删除或损坏 Monthly 后可从 Daily 恢复，且绝不反向修改 Daily", async () => {
	const fixture = createFixture({ "Daily/2026-08-01.md": DAILY_A });
	const dailyBefore = fixture.replica.read("Daily/2026-08-01.md");
	await fixture.coordinator.rebuildPeriod("2026-08");
	const expected = fixture.replica.read(MONTHLY_PATH);
	const monthlyFile = fixture.replica.app.vault.getAbstractFileByPath(MONTHLY_PATH);
	assert.ok(monthlyFile instanceof TFile);

	fixture.replica.remove(MONTHLY_PATH);
	await invokeDeleted(fixture.coordinator, monthlyFile);
	assert.deepEqual(await fixture.coordinator.run(true), { projected: 1, failed: 0 });
	assert.equal(fixture.replica.read(MONTHLY_PATH), expected);

	fixture.replica.replace(MONTHLY_PATH, "<!-- knomo:monthly-archive -->\n\nbroken monthly\n");
	const corruptedFile = fixture.replica.app.vault.getAbstractFileByPath(MONTHLY_PATH);
	assert.ok(corruptedFile instanceof TFile);
	await invokeChanged(fixture.coordinator, corruptedFile);
	assert.deepEqual(await fixture.coordinator.run(true), { projected: 1, failed: 0 });
	assert.equal(fixture.replica.read(MONTHLY_PATH), expected);
	assert.equal(fixture.replica.read("Daily/2026-08-01.md"), dailyBefore);
});

test("相同输出 no-op，Monthly 自写事件不会形成再次投影", async () => {
	const fixture = createFixture({ "Daily/2026-08-01.md": DAILY_A });
	let processCount = 0;
	let createCount = 0;
	const vault = fixture.replica.app.vault as unknown as {
		process(file: TFile, update: (content: string) => string): Promise<string>;
		create(path: string, content: string): Promise<TFile>;
	};
	const originalProcess = vault.process.bind(vault);
	const originalCreate = vault.create.bind(vault);
	vault.process = async (file, update) => {
		processCount += 1;
		return originalProcess(file, update);
	};
	vault.create = async (path, content) => {
		createCount += 1;
		return originalCreate(path, content);
	};

	await fixture.coordinator.rebuildPeriod("2026-08");
	assert.equal(createCount, 1);
	assert.equal(processCount, 0);
	const monthlyFile = fixture.replica.app.vault.getAbstractFileByPath(MONTHLY_PATH);
	assert.ok(monthlyFile instanceof TFile);
	await invokeChanged(fixture.coordinator, monthlyFile);
	assert.deepEqual(await fixture.coordinator.run(true), { projected: 0, failed: 0 });
	await fixture.coordinator.rebuildPeriod("2026-08");
	assert.equal(createCount, 1);
	assert.equal(processCount, 0);
	assert.deepEqual(fixture.coordinator.getProjectionMetadata("2026-08"), {
		sourceDigest: assertString(fixture.coordinator.getProjectionMetadata("2026-08")?.sourceDigest),
		outputHash: assertString(fixture.coordinator.getProjectionMetadata("2026-08")?.outputHash),
	});
});

test("Daily 事件直接失效 Monthly，不经过 Catalog 扫描或 coverage", async () => {
	const fixture = createFixture({ "Daily/2026-08-01.md": DAILY_A });
	await fixture.coordinator.rebuildPeriod("2026-08");
	fixture.replica.replace("Daily/2026-08-01.md", "## Memos\n- 09:00 changed directly\n");
	const dailyFile = fixture.replica.app.vault.getAbstractFileByPath("Daily/2026-08-01.md");
	assert.ok(dailyFile instanceof TFile);
	await invokeVaultChanged(fixture.coordinator, dailyFile);
	assert.equal(fixture.coordinator.getProjectionState(), "stale");

	assert.deepEqual(await fixture.coordinator.run(true), { projected: 1, failed: 0 });
	assert.equal(fixture.coordinator.getProjectionState(), "ready");
	assert.match(fixture.replica.read(MONTHLY_PATH) ?? "", /changed directly/u);
});

test("Monthly 写入失败只留下 stale projection，Daily 与其他运行时不受影响", async () => {
	const fixture = createFixture({ "Daily/2026-08-01.md": DAILY_A });
	const dailyBefore = fixture.replica.read("Daily/2026-08-01.md");
	const vault = fixture.replica.app.vault as unknown as {
		create(path: string, content: string): Promise<TFile>;
	};
	const originalCreate = vault.create.bind(vault);
	let fail = true;
	vault.create = async (path, content) => {
		if (fail) throw new Error("injected monthly write failure");
		return originalCreate(path, content);
	};

	assert.deepEqual(await fixture.coordinator.rebuildPeriod("2026-08"), { projected: 0, failed: 1 });
	assert.deepEqual(fixture.coordinator.getFailedPeriods(), ["2026-08"]);
	assert.equal(fixture.coordinator.getProjectionState(), "failed");
	assert.equal(fixture.replica.read("Daily/2026-08-01.md"), dailyBefore);

	fail = false;
	assert.deepEqual(await fixture.coordinator.rebuildPeriod("2026-08"), { projected: 1, failed: 0 });
	assert.deepEqual(fixture.coordinator.getFailedPeriods(), []);
	assert.equal(fixture.coordinator.getProjectionState(), "ready");
	assert.match(fixture.replica.read(MONTHLY_PATH) ?? "", /unresolved memo/u);
	assert.equal(fixture.replica.read("Daily/2026-08-01.md"), dailyBefore);
});

test("配置冲突暂停 Monthly，显式解决后才允许覆盖", async () => {
	let projectionAllowed = false;
	const fixture = createFixture({ "Daily/2026-08-01.md": DAILY_A }, () => projectionAllowed);
	const dailyBefore = fixture.replica.read("Daily/2026-08-01.md");

	assert.deepEqual(await fixture.coordinator.rebuildPeriod("2026-08"), { projected: 0, failed: 0 });
	assert.equal(fixture.coordinator.getProjectionState(), "stale");
	assert.equal(fixture.replica.read(MONTHLY_PATH), null);
	assert.equal(fixture.replica.read("Daily/2026-08-01.md"), dailyBefore);

	projectionAllowed = true;
	await fixture.coordinator.handleConfigurationChanged();
	assert.deepEqual(await fixture.coordinator.run(true), { projected: 1, failed: 0 });
	assert.equal(fixture.coordinator.getProjectionState(), "ready");
	assert.match(fixture.replica.read(MONTHLY_PATH) ?? "", /unresolved memo/u);
});

test("投影进行中再次失效不会丢失更新", async () => {
	const fixture = createFixture({ "Daily/2026-08-01.md": DAILY_A });
	const vault = fixture.replica.app.vault as unknown as {
		create(path: string, content: string): Promise<TFile>;
	};
	const originalCreate = vault.create.bind(vault);
	let invalidatedDuringWrite = false;
	vault.create = async (path, content) => {
		if (!invalidatedDuringWrite) {
			invalidatedDuringWrite = true;
			fixture.replica.replace("Daily/2026-08-01.md", "## Memos\n- 09:00 updated while projecting\n");
			await fixture.coordinator.invalidatePeriods(["2026-08"]);
		}
		return originalCreate(path, content);
	};

	assert.deepEqual(await fixture.coordinator.rebuildPeriod("2026-08"), { projected: 1, failed: 0 });
	assert.match(fixture.replica.read(MONTHLY_PATH) ?? "", /unresolved memo/u);
	assert.deepEqual(await fixture.coordinator.run(true), { projected: 1, failed: 0 });
	assert.match(fixture.replica.read(MONTHLY_PATH) ?? "", /updated while projecting/u);
});

test("不同设备对相同 Daily 与 settings 生成 byte-identical Monthly", async () => {
	const left = createFixture({
		"Daily/2026-08-02.md": DAILY_B,
		"Daily/2026-08-01.md": DAILY_A,
	});
	const right = createFixture({
		"Daily/2026-08-01.md": DAILY_A,
		"Daily/2026-08-02.md": DAILY_B,
	});

	await left.coordinator.rebuildPeriod("2026-08");
	await right.coordinator.rebuildPeriod("2026-08");
	assert.equal(left.replica.read(MONTHLY_PATH), right.replica.read(MONTHLY_PATH));
	assert.deepEqual(left.coordinator.getProjectionMetadata("2026-08"), right.coordinator.getProjectionMetadata("2026-08"));

	left.replica.remove(MONTHLY_PATH);
	right.replica.remove(MONTHLY_PATH);
	await left.coordinator.rebuildPeriod("2026-08");
	await right.coordinator.rebuildPeriod("2026-08");
	assert.equal(left.replica.read(MONTHLY_PATH), right.replica.read(MONTHLY_PATH));
});

test("Monthly 与 Daily 乱序到达和同步突发只造成暂时 stale，最终按 Daily 收敛", async () => {
	const dailyPath = "Daily/2026-08-01.md";
	const left = createFixture({ [dailyPath]: DAILY_A });
	const right = createFixture({ [dailyPath]: DAILY_A });
	await left.coordinator.rebuildPeriod("2026-08");
	await right.coordinator.rebuildPeriod("2026-08");

	const burst = [
		"## Memos\n- 09:00 first burst\n",
		"## Memos\n- 09:00 second burst @2026-08-03\n",
		"## Memos\n- 09:00 final burst @2026-08-04\n- [ ] 10:00 final task\n",
	];
	for (const content of burst) {
		left.replica.replace(dailyPath, content);
		const dailyFile = left.replica.app.vault.getAbstractFileByPath(dailyPath);
		assert.ok(dailyFile instanceof TFile);
		await invokeVaultChanged(left.coordinator, dailyFile);
	}
	assert.deepEqual(await left.coordinator.run(true), { projected: 1, failed: 0 });
	const finalMonthly = left.replica.read(MONTHLY_PATH);
	assert.ok(finalMonthly !== null);

	// 新 Monthly 先到、Daily 仍旧时允许短暂回退，但不得反向修改 Daily。
	right.replica.replace(MONTHLY_PATH, finalMonthly);
	const monthlyFile = right.replica.app.vault.getAbstractFileByPath(MONTHLY_PATH);
	assert.ok(monthlyFile instanceof TFile);
	await invokeChanged(right.coordinator, monthlyFile);
	assert.deepEqual(await right.coordinator.run(true), { projected: 1, failed: 0 });
	assert.equal(right.replica.read(dailyPath), DAILY_A);
	assert.notEqual(right.replica.read(MONTHLY_PATH), finalMonthly);

	// 最终 Daily 到达后，投影自然收敛到相同字节。
	right.replica.replace(dailyPath, burst[burst.length - 1] ?? "");
	const syncedDailyFile = right.replica.app.vault.getAbstractFileByPath(dailyPath);
	assert.ok(syncedDailyFile instanceof TFile);
	await invokeVaultChanged(right.coordinator, syncedDailyFile);
	assert.deepEqual(await right.coordinator.run(true), { projected: 1, failed: 0 });
	assert.equal(right.replica.read(MONTHLY_PATH), finalMonthly);
	assert.equal(right.replica.read(dailyPath), burst[burst.length - 1]);
});

function createFixture(
	initialFiles: Readonly<Record<string, string>>,
	isProjectionAllowed: () => boolean = () => true,
	options: {
		currentPeriod?: () => string;
		sliceBudgetMs?: number;
		yieldControl?: () => Promise<void>;
		workQueue?: LowPriorityWorkRunner;
		checkpointStore?: InMemoryMemoCatalogStore;
		listCatalogPeriods?: () => Promise<string[]>;
	} = {},
) {
	const replica = new InMemoryVault(initialFiles);
	(replica.app as unknown as { workspace: unknown }).workspace = {
		containerEl: {
			win: { setTimeout: () => 1, clearTimeout: () => undefined },
		},
	};
	const parser = new DiaryMemoParser(async (bytes) => createHash("sha256").update(bytes).digest("hex"));
	const settings: MonthlyProjectionSettings = {
		monthlyMemoFolder: "Memos",
		monthlyMemoFileFormat: "YYYY-MM.md",
		monthlyDateHeadingFormat: "## YYYY-MM-DD",
		monthlyDateOrder: "asc",
		locale: "en",
	};
	const inputBuilder = new MonthlyProjectionInputBuilder(replica.app, parser, {
		getDailyConfig: () => ({ folder: "Daily", format: "YYYY-MM-DD" }),
		getSettings: () => settings,
	});
	const coordinator = new MonthlyProjectionCoordinator(replica.app, {
		inputBuilder,
		selfWriteTracker: new SelfWriteTracker(),
		checkpointStore: options.checkpointStore,
		listCatalogPeriods: options.listCatalogPeriods,
		isProjectionAllowed,
		debounceMs: 0,
		cooldownMs: 0,
		currentPeriod: options.currentPeriod,
		sliceBudgetMs: options.sliceBudgetMs,
		yieldControl: options.yieldControl ?? (() => Promise.resolve()),
		workQueue: options.workQueue,
	});
	return { replica, inputBuilder, coordinator, settings };
}

async function invokeChanged(coordinator: MonthlyProjectionCoordinator, file: TFile): Promise<void> {
	await (coordinator as unknown as { handleMonthlyFileChanged(value: unknown): Promise<void> })
		.handleMonthlyFileChanged(file);
}

async function invokeVaultChanged(coordinator: MonthlyProjectionCoordinator, file: TFile): Promise<void> {
	await (coordinator as unknown as { handleFileChanged(value: unknown): Promise<void> })
		.handleFileChanged(file);
}

async function invokeDeleted(coordinator: MonthlyProjectionCoordinator, file: TFile): Promise<void> {
	(coordinator as unknown as { handleMonthlyFileDeleted(value: unknown): void })
		.handleMonthlyFileDeleted(file);
}

function assertString(value: string | undefined): string {
	assert.equal(typeof value, "string");
	return value ?? "";
}
