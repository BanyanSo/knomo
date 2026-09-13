import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { CATALOG_BENCHMARK_SEED } from "../scripts/catalog/generate-benchmark-vault";
import { summarizeDeviceTraces, validateDeviceTraces } from "../scripts/catalog/summarize-device-traces";

test("device trace summarizer 使用 nearest-rank 汇总平台样本", () => {
	const traceDir = path.join(".tmp", "catalog-device-trace-test");
	fs.mkdirSync(traceDir, { recursive: true });
	fs.writeFileSync(path.join(traceDir, "desktop.json"), JSON.stringify({
		device: "test",
		platform: "desktop",
		commit: "test",
		metrics: { "query.nextPageMs": [10, 20, 30, 40] },
	}), "utf8");
	const summary = summarizeDeviceTraces(traceDir);
	assert.deepEqual(summary.desktop?.["query.nextPageMs"], { samples: 4, p50: 20, p95: 40, max: 40 });
});

test("P2 第 8 步：真实设备 trace 缺失时发布门禁必须失败而非跳过", () => {
	const traceDir = path.join(".tmp", `catalog-device-trace-missing-${process.pid}`);
	assert.equal(fs.existsSync(traceDir), false);
	assert.throws(() => validateDeviceTraces(traceDir), /Device trace directory does not exist/u);
});

test("phase 6 device trace gate enforces frozen samples, fixture and platform thresholds", () => {
	const traceDir = path.join(".tmp", `catalog-device-validation-${process.pid}`);
	fs.mkdirSync(traceDir, { recursive: true });
	writeDeviceTrace(traceDir, "desktop", {
		warmOpenMs: samples(30, 100),
		coldOpenMs: samples(20, 200),
		saveMs: samples(50, 20),
		searchMs: samples(100, 50),
		pageMs: samples(50, 25),
		longTaskMs: [40],
	});
	for (const platform of ["ios", "android"] as const) {
		writeDeviceTrace(traceDir, platform, {
			warmOpenMs: samples(20, 200),
			coldOpenMs: samples(10, 400),
			saveMs: samples(30, 30),
			searchMs: samples(50, 80),
			pageMs: samples(30, 40),
			longTaskMs: [45],
		}, 5, 3);
	}

	const validation = validateDeviceTraces(traceDir);
	assert.equal(validation.commit, "worktree-catalog-rebuild");
	assert.equal(validation.fixtureSeed, CATALOG_BENCHMARK_SEED);
	assert.equal(validation.summary.android?.pageMs?.samples, 30);
});

function samples(count: number, value: number): number[] {
	return Array.from({ length: count }, () => value);
}

function writeDeviceTrace(
	traceDir: string,
	platform: "desktop" | "ios" | "android",
	metrics: Record<string, number[]>,
	backgroundInterruptions = 0,
	forceKills = 0,
): void {
	fs.writeFileSync(path.join(traceDir, `${platform}.json`), JSON.stringify({
		schemaVersion: 1,
		device: `${platform}-test`,
		platform,
		commit: "worktree-catalog-rebuild",
		fixtureSeed: CATALOG_BENCHMARK_SEED,
		backgroundInterruptions,
		forceKills,
		metrics,
	}), "utf8");
}
