import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { DiaryMemoParser } from "../src/services/DiaryMemoParser";
import {
	CATALOG_BENCHMARK_SEED,
	generateCatalogBenchmarkVault,
} from "../scripts/catalog-v2/generate-benchmark-vault";
import { summarizeDeviceTraces, validateDeviceTraces } from "../scripts/catalog-v2/summarize-device-traces";
import { runIdentityLedgerReducerBenchmark } from "../scripts/catalog-v2/run-node-benchmarks";

test("PERF-30K generator 使用冻结 seed、路径、20 memos/Daily 和确定性 SHA", async () => {
	const rootDir = path.join(".tmp", "catalog-v2-benchmark-test");
	const first = generateCatalogBenchmarkVault({ rootDir, dailyCount: 3, memosPerDaily: 20 });
	const firstManifest = fs.readFileSync(path.join(rootDir, "manifest.json"), "utf8");
	const second = generateCatalogBenchmarkVault({ rootDir, dailyCount: 3, memosPerDaily: 20 });
	const secondManifest = fs.readFileSync(path.join(rootDir, "manifest.json"), "utf8");

	assert.equal(first.seed, CATALOG_BENCHMARK_SEED);
	assert.equal(first.dailyFolder, "Journal/Daily");
	assert.equal(first.dailyFormat, "YYYY/MM/YYYY-MM-DD");
	assert.equal(first.pageSize, 50);
	assert.equal(first.activeObservations, 60);
	assert.equal(firstManifest, secondManifest);
	assert.deepEqual(first.files, second.files);

	const file = first.files[0];
	assert.notEqual(file, undefined);
	if (file === undefined) {
		throw new Error("Generated benchmark file is missing.");
	}
	const absolutePath = path.join(rootDir, "vault", ...file.path.split("/"));
	const bytes = fs.readFileSync(absolutePath);
	const before = sha256(bytes);
	const parsed = await new DiaryMemoParser(async (value) => sha256(value)).parse({
		sourcePath: file.path,
		logicalDate: file.logicalDate,
		headings: [first.heading],
		bytes,
	});
	assert.equal(parsed.observations.length, 20);
	assert.equal(sha256(fs.readFileSync(absolutePath)), before);
	assert.equal(before, file.sha256);
	assert.equal(parsed.observations[0].time, parsed.observations[1].time);
	assert.equal(parsed.observations[0].content, parsed.observations[1].content);

	const secondDay = await parseGeneratedFile(first.files[1], rootDir, first.heading);
	const thirdDay = await parseGeneratedFile(first.files[2], rootDir, first.heading);
	assert.equal(secondDay.observations[0].content, thirdDay.observations[0].content);
	assert.notEqual(secondDay.observations[0].time, thirdDay.observations[0].time);
});

test("device trace summarizer 使用 nearest-rank 汇总平台样本", () => {
	const traceDir = path.join(".tmp", "catalog-v2-device-trace-test");
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
	const traceDir = path.join(".tmp", `catalog-v2-device-trace-missing-${process.pid}`);
	assert.equal(fs.existsSync(traceDir), false);
	assert.throws(() => validateDeviceTraces(traceDir), /Device trace directory does not exist/u);
});

test("phase 6 device trace gate enforces frozen samples, fixture and platform thresholds", () => {
	const traceDir = path.join(".tmp", `catalog-v2-device-validation-${process.pid}`);
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
	assert.equal(validation.commit, "worktree-catalog-v2-rebuild");
	assert.equal(validation.fixtureSeed, CATALOG_BENCHMARK_SEED);
	assert.equal(validation.summary.android?.pageMs?.samples, 30);
});

test("V3 Identity Ledger reducer materializes 30k immutable events without quadratic memo scans", async () => {
	const result = await runIdentityLedgerReducerBenchmark(30_000);
	assert.equal(result.memoCount, 30_000);
	assert.equal(result.eventCount, 30_000);
	assert.equal(result.materializeMs < 10_000, true);
});

function sha256(bytes: Uint8Array): string {
	return createHash("sha256").update(bytes).digest("hex");
}

async function parseGeneratedFile(
	file: { path: string; logicalDate: string } | undefined,
	rootDir: string,
	heading: string,
) {
	if (file === undefined) {
		throw new Error("Generated benchmark file is missing.");
	}
	const bytes = fs.readFileSync(path.join(rootDir, "vault", ...file.path.split("/")));
	return new DiaryMemoParser(async (value) => sha256(value)).parse({
		sourcePath: file.path,
		logicalDate: file.logicalDate,
		headings: [heading],
		bytes,
	});
}

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
		commit: "worktree-catalog-v2-rebuild",
		fixtureSeed: CATALOG_BENCHMARK_SEED,
		backgroundInterruptions,
		forceKills,
		metrics,
	}), "utf8");
}
