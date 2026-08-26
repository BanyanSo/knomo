import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { IDBFactory, IDBKeyRange } from "fake-indexeddb";

import type { CatalogCursor, CatalogQuery } from "../../src/types/catalog";
import type { IdentityLedgerClaimEvent, IdentityLedgerEventEnvelope } from "../../src/types/identityLedger";
import type { CatalogPartitionInput } from "../../src/services/MemoCatalogService";
import {
	DEFAULT_BENCHMARK_ROOT,
} from "./generate-benchmark-vault";
import type { CatalogBenchmarkManifest } from "./generate-benchmark-vault";

interface MetricSummary {
	samples: number[];
	p50: number;
	p95: number;
	max: number;
}

interface CatalogNodeBenchmarkResult {
	schemaVersion: 1;
	seed: string;
	activeObservations: number;
	environment: { node: string; platform: string; arch: string; cpus: number };
	metrics: Record<string, MetricSummary>;
	queryReads: { cursorReads: number; observationsRead: number; returned: number };
	assertions: {
		dailyShaUnchanged: boolean;
		parsedObservationCount: number;
		paginationPages: number;
		cursorInvalidations: number;
		incrementalPartitionUpdateCount: number;
		incrementalUpdatedObservationCount: number;
		aggregateMemoCount: number;
		checkpointRoundTrip: boolean;
		identityReducerMemoCount: number;
		identityReducerEventCount: number;
	};
}

export interface IdentityLedgerReducerBenchmarkResult {
	memoCount: number;
	eventCount: number;
	materializeMs: number;
}

const SEARCH_QUERIES = [
	"benchmark", "中文", "project-1", "shared-month-2023-01", "topic", "example", "task", "continuation",
	"image-1", "memo 42", "benchmark memo", "project-5", "shared-month-2024-01", "中文搜索", "item",
	"not-present-a", "not-present-b", "project-11", "assets", "fenced fake memo",
] as const;

export async function runCatalogNodeBenchmarks(): Promise<CatalogNodeBenchmarkResult> {
	await ensureBenchmarkObsidianStub();
	const [
		{ DiaryMemoParser },
		{ IndexedDbMemoCatalogStore },
		{ MemoCatalogService },
	] = await Promise.all([
		import("../../src/services/DiaryMemoParser"),
		import("../../src/services/IndexedDbMemoCatalogStore"),
		import("../../src/services/MemoCatalogService"),
	]);
	const rootDir = readStringArg(process.argv.slice(2), "--root") ?? DEFAULT_BENCHMARK_ROOT;
	const manifestPath = path.join(rootDir, "manifest.json");
	const vaultDir = path.join(rootDir, "vault");
	const manifest = readManifest(manifestPath);
	const maxFiles = readMaxFilesArg(process.argv.slice(2));
	assertManifest(manifest, maxFiles === null);
	const benchmarkFiles = maxFiles === null ? manifest.files : manifest.files.slice(0, maxFiles);
	const factory = new IDBFactory();
	const databaseName = `knomo-catalog-benchmark-${Date.now()}`;
	const store = new IndexedDbMemoCatalogStore(databaseName, { factory, keyRange: IDBKeyRange });
	const catalog = new MemoCatalogService(store);
	const parser = new DiaryMemoParser();
	await catalog.open();

	const metrics = new Map<string, number[]>();
	let parsedObservationCount = 0;
	let dailyShaUnchanged = true;
	let pendingPartitions: CatalogPartitionInput[] = [];
	const buildStartedAt = performance.now();
	for (let fileIndex = 0; fileIndex < benchmarkFiles.length; fileIndex += 1) {
		const file = benchmarkFiles[fileIndex];
		const absolutePath = path.join(vaultDir, ...file.path.split("/"));
		const before = fs.readFileSync(absolutePath);
		const parseStartedAt = performance.now();
		const parsed = await parser.parse({
			sourcePath: file.path,
			logicalDate: file.logicalDate,
			headings: [manifest.heading],
			bytes: before,
		});
		pushMetric(metrics, "parser.fileMs", performance.now() - parseStartedAt);
		parsedObservationCount += parsed.observations.length;
		pendingPartitions.push({
			inventory: { sourcePath: file.path, logicalDate: file.logicalDate, mtime: fileIndex, size: before.byteLength },
			sourceRevision: parsed.sourceRevision,
			observations: parsed.observations,
			parserVersion: 1,
			settingsFingerprint: "benchmark-v1",
			auditedAt: fileIndex,
		});
		if (pendingPartitions.length === 25 || fileIndex === benchmarkFiles.length - 1) {
			const writeStartedAt = performance.now();
			await catalog.replaceFiles(pendingPartitions);
			pushMetric(metrics, "index.partitionBatchMs", performance.now() - writeStartedAt);
			pendingPartitions = [];
		}
		dailyShaUnchanged = dailyShaUnchanged && sha256(before) === file.sha256 && sha256(fs.readFileSync(absolutePath)) === file.sha256;
		if ((fileIndex + 1) % 100 === 0 || fileIndex === benchmarkFiles.length - 1) {
			console.error(JSON.stringify({
				phase: "build",
				files: fileIndex + 1,
				observations: parsedObservationCount,
				elapsedMs: performance.now() - buildStartedAt,
			}));
		}
	}
	pushMetric(metrics, "catalog.fullBuildMs", performance.now() - buildStartedAt);
	console.error(JSON.stringify({ phase: "build-complete", elapsedMs: performance.now() - buildStartedAt }));
	await store.setCoverage({
		kind: "complete",
		coveredFromDate: manifest.files[0]?.logicalDate ?? null,
		pendingFileCount: 0,
		coveredFileCount: benchmarkFiles.length,
		totalFileCount: benchmarkFiles.length,
	});

	for (let warmup = 0; warmup < 5; warmup += 1) {
		await catalog.query({ limit: manifest.pageSize });
	}
	let queryCursorReads = 0;
	let queryObservationsRead = 0;
	let queryReturned = 0;
	for (let sample = 0; sample < 30; sample += 1) {
		const startedAt = performance.now();
		const page = await catalog.query({ limit: manifest.pageSize });
		pushMetric(metrics, "query.recentFirstPageMs", performance.now() - startedAt);
		queryCursorReads += page.metrics.cursorReads;
		queryObservationsRead += page.metrics.observationsRead;
		queryReturned += page.metrics.returned;
	}
	console.error(JSON.stringify({ phase: "recent-query-complete" }));
	for (const query of SEARCH_QUERIES) {
		const queryStartedAt = performance.now();
		for (let repeat = 0; repeat < 5; repeat += 1) {
			const startedAt = performance.now();
			const page = await catalog.query({ limit: manifest.pageSize, text: query });
			pushMetric(metrics, "search.firstBatchMs", performance.now() - startedAt);
			queryCursorReads += page.metrics.cursorReads;
			queryObservationsRead += page.metrics.observationsRead;
			queryReturned += page.metrics.returned;
		}
		console.error(JSON.stringify({ phase: "search-query", query, elapsedMs: performance.now() - queryStartedAt }));
	}
	console.error(JSON.stringify({ phase: "search-complete" }));

	let cursor: CatalogCursor | null = null;
	let paginationPages = 0;
	let cursorInvalidations = 0;
	let incrementalPartitionUpdateCount = 0;
	let incrementalUpdatedObservationCount = 0;
	for (let pageIndex = 0; pageIndex < 50; pageIndex += 1) {
		const request: CatalogQuery = { limit: manifest.pageSize, cursor };
		const startedAt = performance.now();
		let page = await catalog.query(request);
		pushMetric(metrics, "query.nextPageMs", performance.now() - startedAt);
		if (page.invalidated) {
			cursorInvalidations += 1;
			page = await catalog.query({ limit: manifest.pageSize });
		}
		paginationPages += 1;
		cursor = page.nextCursor;
		if (pageIndex === 24) {
			const file = benchmarkFiles[0];
			if (file !== undefined) {
				const originalBytes = fs.readFileSync(path.join(vaultDir, ...file.path.split("/")));
				const originalText = new TextDecoder().decode(originalBytes);
				const updatedText = originalText.replace("benchmark memo", "benchmark incremental memo");
				if (updatedText === originalText) throw new Error("Incremental benchmark fixture has no mutable memo.");
				const bytes = new TextEncoder().encode(updatedText);
				const parsed = await parser.parse({ sourcePath: file.path, logicalDate: file.logicalDate, headings: [manifest.heading], bytes });
				const incrementalStartedAt = performance.now();
				await catalog.replaceFile({
					inventory: { sourcePath: file.path, logicalDate: file.logicalDate, mtime: 999_999, size: bytes.byteLength },
					sourceRevision: parsed.sourceRevision,
					observations: parsed.observations,
					parserVersion: 1,
					settingsFingerprint: "benchmark-v1",
					auditedAt: 999_999,
				});
				pushMetric(metrics, "catalog.incrementalPartitionMs", performance.now() - incrementalStartedAt);
				incrementalPartitionUpdateCount += 1;
				const updatedBatch = await catalog.getFileRevisionBatch(file.path);
				incrementalUpdatedObservationCount = updatedBatch?.observations.filter((observation) =>
					observation.content.includes("benchmark incremental memo")).length ?? 0;
			}
		}
		if (cursor === null) {
			break;
		}
	}
	if (cursor !== null) {
		const invalidationProbe = await catalog.query({ limit: manifest.pageSize, cursor });
		if (invalidationProbe.invalidated) {
			cursorInvalidations += 1;
		}
	}
	console.error(JSON.stringify({ phase: "pagination-complete", paginationPages, cursorInvalidations }));

	const aggregateStartedAt = performance.now();
	const aggregates = await catalog.listDailyAggregates();
	pushMetric(metrics, "aggregate.firstViewMs", performance.now() - aggregateStartedAt);
	const aggregateMemoCount = aggregates.reduce((total, aggregate) => total + aggregate.memoCount, 0);
	const checkpoint = { pendingPaths: benchmarkFiles.slice(0, 50).map((file) => file.path), updatedAt: 123 };
	const checkpointStartedAt = performance.now();
	await store.setMeta("benchmarkCheckpoint", checkpoint);
	const restoredCheckpoint = await store.getMeta<typeof checkpoint>("benchmarkCheckpoint");
	pushMetric(metrics, "checkpoint.roundTripMs", performance.now() - checkpointStartedAt);
	const identityReducer = await runIdentityLedgerReducerBenchmark(30_000);
	pushMetric(metrics, "identity.reducerMaterializeMs", identityReducer.materializeMs);

	const result: CatalogNodeBenchmarkResult = {
		schemaVersion: 1,
		seed: manifest.seed,
		activeObservations: benchmarkFiles.length * manifest.memosPerDaily,
		environment: { node: process.version, platform: process.platform, arch: process.arch, cpus: os.cpus().length },
		metrics: Object.fromEntries([...metrics.entries()].map(([name, samples]) => [name, summarize(samples)])),
		queryReads: { cursorReads: queryCursorReads, observationsRead: queryObservationsRead, returned: queryReturned },
		assertions: {
			dailyShaUnchanged,
			parsedObservationCount,
			paginationPages,
			cursorInvalidations,
			incrementalPartitionUpdateCount,
			incrementalUpdatedObservationCount,
			aggregateMemoCount,
			checkpointRoundTrip: JSON.stringify(restoredCheckpoint) === JSON.stringify(checkpoint),
			identityReducerMemoCount: identityReducer.memoCount,
			identityReducerEventCount: identityReducer.eventCount,
		},
	};
	const resultsDir = path.join(rootDir, "results");
	fs.mkdirSync(resultsDir, { recursive: true });
	const resultPath = path.join(resultsDir, maxFiles === null ? "node-latest.json" : `node-diagnostic-${benchmarkFiles.length}.json`);
	fs.writeFileSync(resultPath, `${JSON.stringify(result, null, 2)}\n`, "utf8");
	console.error(JSON.stringify({ phase: "result-written", resultPath }));
	return result;
}

export async function runIdentityLedgerReducerBenchmark(
	memoCount: number,
): Promise<IdentityLedgerReducerBenchmarkResult> {
	await ensureBenchmarkObsidianStub();
	const { materializeIdentityLedger } = await import("../../src/services/IdentityLedgerService");
	const envelopes: IdentityLedgerEventEnvelope[] = [];
	for (let index = 0; index < memoCount; index += 1) {
		const ordinal = index + 1;
		const eventId = `e_${ordinal.toString(16).padStart(32, "0")}`;
		const memoId = `01991f40-7c00-7000-8000-${ordinal.toString(16).padStart(12, "0")}`;
		const hashSuffix = ordinal.toString(16).padStart(8, "0").slice(-8);
		const event: IdentityLedgerClaimEvent = {
			eventId,
			writerId: "w_11111111111111111111111111111111",
			memoId,
			type: "claim",
			baseBindingId: null,
			occurredAt: "2026-08-22T00:00:00.000Z",
			evidence: {
				observation: {
					sourcePath: `Daily/${String(ordinal).padStart(5, "0")}.md`,
					sourceRevision: ordinal.toString(16).padStart(64, "0"),
					rawBlockHash: `fnv1a-${hashSuffix}`,
					logicalDate: "2026-08-22",
					section: "## Memos",
					startLine: 1,
					endLine: 1,
					time: "09:00",
					contentHash: `fnv1a-${hashSuffix}`,
				},
				createIntentEventId: null,
			},
		};
		envelopes.push({
			event,
			digest: ordinal.toString(16).padStart(64, "0"),
			sourcePath: `identity/segment-${eventId}.jsonl`,
		});
	}
	const startedAt = performance.now();
	const snapshot = await materializeIdentityLedger(envelopes);
	const materializeMs = performance.now() - startedAt;
	return {
		memoCount: Object.keys(snapshot.memos).length,
		eventCount: snapshot.eventCount,
		materializeMs,
	};
}

function readManifest(manifestPath: string): CatalogBenchmarkManifest {
	return JSON.parse(fs.readFileSync(manifestPath, "utf8")) as CatalogBenchmarkManifest;
}

function assertManifest(manifest: CatalogBenchmarkManifest, requireFrozenSize: boolean): void {
	if (manifest.seed !== "knomo-catalog-30k-v1"
		|| manifest.memosPerDaily !== 20
		|| (requireFrozenSize && (manifest.dailyCount !== 1500 || manifest.activeObservations !== 30000))) {
		throw new Error("Generate the frozen PERF-30K fixture before running the benchmark.");
	}
}

function readMaxFilesArg(args: readonly string[]): number | null {
	const value = args.find((arg) => arg.startsWith("--max-files="))?.slice("--max-files=".length);
	if (value === undefined) {
		return null;
	}
	const parsed = Number(value);
	if (!Number.isInteger(parsed) || parsed <= 0) {
		throw new Error("--max-files must be a positive integer.");
	}
	return parsed;
}

function readStringArg(args: readonly string[], name: string): string | null {
	const prefix = `${name}=`;
	const value = args.find((arg) => arg.startsWith(prefix))?.slice(prefix.length).trim();
	return value === undefined || value.length === 0 ? null : value;
}

function pushMetric(metrics: Map<string, number[]>, name: string, value: number): void {
	const samples = metrics.get(name) ?? [];
	samples.push(value);
	metrics.set(name, samples);
}

function summarize(samples: number[]): MetricSummary {
	const sorted = [...samples].sort((left, right) => left - right);
	return {
		samples,
		p50: nearestRank(sorted, 0.5),
		p95: nearestRank(sorted, 0.95),
		max: sorted[sorted.length - 1] ?? 0,
	};
}

function nearestRank(sorted: readonly number[], percentile: number): number {
	if (sorted.length === 0) {
		return 0;
	}
	return sorted[Math.max(0, Math.ceil(sorted.length * percentile) - 1)] ?? 0;
}

function sha256(bytes: Uint8Array): string {
	return require("node:crypto").createHash("sha256").update(bytes).digest("hex") as string;
}

async function ensureBenchmarkObsidianStub(): Promise<void> {
	const modulePath = path.resolve(__dirname, "../../node_modules/obsidian/index.js");
	await fs.promises.mkdir(path.dirname(modulePath), { recursive: true });
	await fs.promises.writeFile(modulePath, [
		'"use strict";',
		"exports.normalizePath = (value) => String(value)",
		"	.replace(/\\\\/g, '/')",
		"	.replace(/\\/+/g, '/')",
		"	.replace(/^\\.\\//, '')",
		"	.replace(/^\\/+/, '')",
		"	.replace(/\\/\\.\\//g, '/')",
		"	.replace(/\\/$/, '');",
		"",
	].join("\n"), "utf8");
}

if (require.main === module) {
	void runCatalogNodeBenchmarks().then((result) => {
		const output = JSON.stringify({
			activeObservations: result.activeObservations,
			queryP95: result.metrics["query.recentFirstPageMs"]?.p95,
			searchP95: result.metrics["search.firstBatchMs"]?.p95,
			pageP95: result.metrics["query.nextPageMs"]?.p95,
			assertions: result.assertions,
		});
		process.stdout.write(`${output}\n`, () => process.exit(0));
	}).catch((error: unknown) => {
		console.error(error);
		process.exit(1);
	});
}
