import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { TFile } from "obsidian";

import { MonthlyProjectionCoordinator } from "../src/services/MonthlyProjectionCoordinator";
import { MonthlyProjectionInputBuilder } from "../src/services/MonthlyProjectionInputBuilder";
import { DiaryMemoParser } from "../src/services/DiaryMemoParser";
import { SelfWriteTracker } from "../src/services/SelfWriteTracker";
import { InMemoryVault } from "./helpers/InMemoryVault";

const MONTHLY_PATH = "Memos/2026-08.md";
const DAILY_A = "## Memos\n- 09:00 unresolved memo\n";
const DAILY_B = "## Memos\n- 10:00 ambiguous memo\n";

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

	fixture.replica.replace(MONTHLY_PATH, "broken monthly\n");
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
	const vault = fixture.replica.app.vault as unknown as {
		process(file: TFile, update: (content: string) => string): Promise<string>;
	};
	const originalProcess = vault.process.bind(vault);
	vault.process = async (file, update) => {
		processCount += 1;
		return originalProcess(file, update);
	};

	await fixture.coordinator.rebuildPeriod("2026-08");
	assert.equal(processCount, 1);
	const monthlyFile = fixture.replica.app.vault.getAbstractFileByPath(MONTHLY_PATH);
	assert.ok(monthlyFile instanceof TFile);
	await invokeChanged(fixture.coordinator, monthlyFile);
	assert.deepEqual(await fixture.coordinator.run(true), { projected: 0, failed: 0 });
	await fixture.coordinator.rebuildPeriod("2026-08");
	assert.equal(processCount, 1);
	assert.deepEqual(fixture.coordinator.getProjectionMetadata("2026-08"), {
		rendererVersion: 1,
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
		process(file: TFile, update: (content: string) => string): Promise<string>;
	};
	const originalProcess = vault.process.bind(vault);
	let fail = true;
	vault.process = async (file, update) => {
		if (fail) throw new Error("injected monthly write failure");
		return originalProcess(file, update);
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
		process(file: TFile, update: (content: string) => string): Promise<string>;
	};
	const originalProcess = vault.process.bind(vault);
	let invalidatedDuringWrite = false;
	vault.process = async (file, update) => {
		if (!invalidatedDuringWrite) {
			invalidatedDuringWrite = true;
			fixture.replica.replace("Daily/2026-08-01.md", "## Memos\n- 09:00 updated while projecting\n");
			await fixture.coordinator.invalidatePeriods(["2026-08"]);
		}
		return originalProcess(file, update);
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
) {
	const replica = new InMemoryVault(initialFiles);
	(replica.app as unknown as { workspace: unknown }).workspace = {
		containerEl: {
			win: { setTimeout: () => 1, clearTimeout: () => undefined },
		},
	};
	const parser = new DiaryMemoParser(async (bytes) => createHash("sha256").update(bytes).digest("hex"));
	const inputBuilder = new MonthlyProjectionInputBuilder(replica.app, parser, {
		getDailyConfig: () => ({ folder: "Daily", format: "YYYY-MM-DD" }),
		getHeadings: () => ["## Memos"],
		getSettings: () => ({
			monthlyMemoFolder: "Memos",
			monthlyMemoFileFormat: "YYYY-MM.md",
			monthlyDateHeadingFormat: "## YYYY-MM-DD",
			monthlyDateOrder: "asc",
		}),
	});
	const coordinator = new MonthlyProjectionCoordinator(replica.app, {
		inputBuilder,
		selfWriteTracker: new SelfWriteTracker(),
		isProjectionAllowed,
		debounceMs: 0,
		cooldownMs: 0,
	});
	return { replica, inputBuilder, coordinator };
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
