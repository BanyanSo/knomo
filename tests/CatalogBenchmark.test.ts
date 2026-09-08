import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { DiaryMemoParser } from "../src/services/DiaryMemoParser";
import {
	CATALOG_BENCHMARK_SEED,
	generateCatalogBenchmarkVault,
} from "../scripts/catalog/generate-benchmark-vault";

test("PERF-30K generator 使用冻结 seed、路径、20 memos/Daily 和确定性 SHA", async () => {
	const rootDir = path.join(".tmp", "catalog-benchmark-test");
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
		bytes,
	});
	assert.equal(parsed.observations.length, 20);
	assert.equal(sha256(fs.readFileSync(absolutePath)), before);
	assert.equal(before, file.sha256);
	assert.equal(parsed.observations[0].time, parsed.observations[1].time);
	assert.equal(parsed.observations[0].content, parsed.observations[1].content);

	const secondDay = await parseGeneratedFile(first.files[1], rootDir);
	const thirdDay = await parseGeneratedFile(first.files[2], rootDir);
	assert.equal(secondDay.observations[0].content, thirdDay.observations[0].content);
	assert.notEqual(secondDay.observations[0].time, thirdDay.observations[0].time);
});

function sha256(bytes: Uint8Array): string {
	return createHash("sha256").update(bytes).digest("hex");
}

async function parseGeneratedFile(
	file: { path: string; logicalDate: string } | undefined,
	rootDir: string,
) {
	if (file === undefined) {
		throw new Error("Generated benchmark file is missing.");
	}
	const bytes = fs.readFileSync(path.join(rootDir, "vault", ...file.path.split("/")));
	return new DiaryMemoParser(async (value) => sha256(value)).parse({
		sourcePath: file.path,
		logicalDate: file.logicalDate,
		bytes,
	});
}
