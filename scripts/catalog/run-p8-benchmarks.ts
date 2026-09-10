import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { performance } from "node:perf_hooks";
import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import type { App, Component, TFile } from "obsidian";
import { ensureObsidianStub } from "../../tests/helpers/obsidianStub";
import { generateCatalogBenchmarkVault } from "./generate-benchmark-vault";

// Node 测量真实服务链路；文件系统和 IDB 模拟不代表 Obsidian 或移动设备性能。
export async function runP8Benchmark(count: number, root: string) {
	assert.ok(Number.isInteger(count) && count > 0 && count % 20 === 0);
	await ensureObsidianStub();
	const { TFile } = await import("obsidian");
	const { CatalogIndexCoordinator } = await import("../../src/services/CatalogIndexCoordinator");
	const { DiaryMemoParser } = await import("../../src/services/DiaryMemoParser");
	const { MemoCatalogService } = await import("../../src/services/MemoCatalogService");
	const { IndexedDbMemoCatalogStore } = await import("../../src/services/IndexedDbMemoCatalogStore");
	const { CatalogReadService } = await import("../../src/services/CatalogReadService");
	const { CatalogReferenceService } = await import("../../src/services/CatalogReferenceService");
	const { MonthlyProjectionInputBuilder } = await import("../../src/services/MonthlyProjectionInputBuilder");
	const { buildMonthlyProjection } = await import("../../src/services/MonthlyProjection");
	const manifest = generateCatalogBenchmarkVault({ rootDir: root, dailyCount: count / 20 });
	const files = new Map(manifest.files.map((entry) => {
		const file = Object.assign(new TFile(), { path: entry.path, extension: "md",
			stat: { mtime: 1, ctime: 1, size: entry.size } });
		return [entry.path, file] as const;
	}));
	const absolute = (file: TFile) => path.join(root, "vault", ...file.path.split("/"));
	let reads = 0;
	let metadataInventories = 0;
	const app = {
		vault: {
			on: () => ({}),
			getMarkdownFiles: () => { metadataInventories++; return [...files.values()]; },
			getAbstractFileByPath: (key: string) => files.get(key) ?? null,
			readBinary: async (file: TFile) => {
				reads++;
				const bytes = await fs.promises.readFile(absolute(file));
				return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
			},
		},
		metadataCache: {
			getFirstLinkpathDest: (target: string) => files.get(target) ?? files.get(`${target}.md`) ?? null,
			getFileCache: () => null,
		},
		workspace: { on: () => ({}), activeLeaf: null, containerEl: { doc: { visibilityState: "visible" }, win: {
			setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout,
		} } },
	} as unknown as App;
	const factory = new IDBFactory();
	const databaseName = `p8-${count}`;
	const store = new IndexedDbMemoCatalogStore(databaseName, { factory, keyRange: IDBKeyRange });
	const catalog = new MemoCatalogService(store);
	const parser = new DiaryMemoParser();
	const config = async () => ({ folder: manifest.dailyFolder, format: manifest.dailyFormat });
	let stopCoordinator = () => {};
	const makeCoordinator = () => {
		const instance = new CatalogIndexCoordinator(app, catalog, parser, config);
		instance.start({ registerEvent: () => {}, registerDomEvent: () => {},
			register: (cleanup: () => void) => { stopCoordinator = cleanup; } } as unknown as Component);
		return instance;
	};
	let coordinator = makeCoordinator();
	const read = new CatalogReadService({ catalog, references: new CatalogReferenceService(app, catalog),
		now: () => new Date(2040, 0, 1), random: () => 0.42 });
	const metrics: Record<string, { ms: number; bodyReads: number; heapMiB: number; rssMiB: number;
		maxEventLoopGapMs: number; gapsOver50Ms: number }> = {};
	let phase = "";
	let previousTick = performance.now();
	let maxGap = 0;
	let longGaps = 0;
	let peakHeap = 0;
	let peakRss = 0;
	const sample = () => {
		const now = performance.now();
		const gap = now - previousTick;
		previousTick = now;
		if (phase) { maxGap = Math.max(maxGap, gap); if (gap > 50) longGaps++; }
		const memory = process.memoryUsage();
		peakHeap = Math.max(peakHeap, memory.heapUsed);
		peakRss = Math.max(peakRss, memory.rss);
	};
	const timer = setInterval(sample, 10);
	async function measure<T>(name: string, action: () => Promise<T>): Promise<T> {
		phase = name; previousTick = performance.now(); maxGap = 0; longGaps = 0;
		const start = performance.now(); const beforeReads = reads;
		try {
			const result = await action();
			sample();
			const memory = process.memoryUsage();
			metrics[name] = { ms: performance.now() - start, bodyReads: reads - beforeReads,
				heapMiB: memory.heapUsed / 1048576, rssMiB: memory.rss / 1048576,
				maxEventLoopGapMs: maxGap, gapsOver50Ms: longGaps };
			console.error(JSON.stringify({ count, phase: name, ...metrics[name] }));
			return result;
		} finally { phase = ""; }
	}
	try {
		await measure("coldRebuild", async () => { await coordinator.initialize(); await coordinator.waitForIdle(); });
		assert.equal((await read.getLibrarySummary()).value?.memoCount, count);
		assert.equal(reads, manifest.dailyCount);
		stopCoordinator();
		coordinator = makeCoordinator();
		await measure("warmStart", async () => { await coordinator.initialize(); await coordinator.waitForIdle(); });
		assert.equal(metrics.warmStart!.bodyReads, 0);
		for (let i = 0; i < 3; i++) {
			assert.equal((await measure(`firstPage.${i}`, () => read.query({ limit: 50 }))).items.length, Math.min(50, count));
			await measure(`search.${i}`, () => read.query({ limit: 50, text: i === 0 ? "benchmark" : i === 1 ? "中文" : "not-present" }));
			await measure(`tag.${i}`, () => read.query({ limit: 50, tags: ["project-1"] }));
		}
		await measure("backlinks", () => read.queryBacklinks(manifest.files[0]!.path, null, { limit: 50 }));
		await measure("stats", () => read.getLibrarySummary());
		assert.equal((await measure("reunionFirst", () => read.getRandomReunionItems(10))).length, 10);
		await measure("reunionWarm", () => read.getRandomReunionItems(10));
		const changed = files.get(manifest.files[0]!.path)!;
		await fs.promises.appendFile(absolute(changed), "\n- 23:59:59 P8 delta #p8\n");
		changed.stat.mtime++;
		changed.stat.size = (await fs.promises.stat(absolute(changed))).size;
		await measure("singleDailyDelta", () => coordinator.refreshPaths([changed.path]));
		assert.equal(metrics.singleDailyDelta!.bodyReads, 1);
		assert.equal((await read.getLibrarySummary()).value?.memoCount, count + 1);
		const builder = new MonthlyProjectionInputBuilder(app, parser, { getDailyConfig: config, getSettings: () => ({
			monthlyMemoFolder: "Monthly", monthlyMemoFileFormat: "YYYY-MM", monthlyDateHeadingFormat: "YYYY-MM-DD",
			monthlyDateOrder: "asc", locale: "en",
		}) });
		const runtime = { yieldControl: () => new Promise<void>((resolve) => setTimeout(resolve, 0)) };
		await measure("monthlyInputAndRender", async () => {
			const input = await builder.build(manifest.files[0]!.logicalDate.slice(0, 7), runtime);
			assert.equal(input.status, "complete");
			if (input.status !== "complete") throw new Error("Monthly incomplete");
			const result = await buildMonthlyProjection(input, undefined, runtime);
			assert.equal(result.observationCount, input.observations.length);
		});
		stopCoordinator();
		await measure("deleteIndexedDbAndRebuild", async () => {
			await new Promise<void>((resolve, reject) => {
				const request = factory.deleteDatabase(databaseName);
				request.onsuccess = () => resolve(); request.onerror = () => reject(request.error);
				request.onblocked = () => reject(new Error("IDB deletion blocked"));
			});
			coordinator = makeCoordinator(); await coordinator.initialize(); await coordinator.waitForIdle();
		});
		assert.equal((await read.getLibrarySummary()).value?.memoCount, count + 1);
		assert.equal(metrics.deleteIndexedDbAndRebuild!.bodyReads, manifest.dailyCount);
		return { count, dailyCount: manifest.dailyCount, environment: { node: process.version, platform: process.platform,
			cpu: os.cpus()[0]?.model, memoryGiB: os.totalmem() / 1073741824, backend: "fake-indexeddb + filesystem + Obsidian stubs" },
			metrics, metadataInventories, peakHeapMiB: peakHeap / 1048576, peakRssMiB: peakRss / 1048576,
			limitations: "Single process/sample per phase except queries. Event-loop gaps are a Node proxy, not browser Long Tasks. Monthly measures input/render, not Obsidian commit. Metadata resolution is stubbed; device/sync acceptance is separate." };
	} finally { clearInterval(timer); stopCoordinator(); }
}

if (require.main === module) {
	const count = Number(process.argv.find((arg) => arg.startsWith("--count="))?.slice(8) ?? 10000);
	const root = path.resolve(".tmp", "p8", String(count));
	void runP8Benchmark(count, root).then((result) => {
		fs.writeFileSync(path.join(root, "result.json"), `${JSON.stringify(result, null, 2)}\n`);
	}).catch((error: unknown) => { console.error(error); process.exitCode = 1; });
}
