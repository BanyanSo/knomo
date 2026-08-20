import fs from "node:fs";
import path from "node:path";

export interface DeviceTrace {
	schemaVersion?: 1;
	device: string;
	platform: "desktop" | "ios" | "android";
	commit: string;
	fixtureSeed?: string;
	backgroundInterruptions?: number;
	forceKills?: number;
	metrics: Record<string, number[]>;
}

interface TraceMetricSummary {
	samples: number;
	p50: number;
	p95: number;
	max: number;
}

const DEFAULT_TRACE_DIR = path.join(".tmp", "catalog-v2-benchmark", "device-traces");
const DEFAULT_SUMMARY_PATH = path.join(".tmp", "catalog-v2-benchmark", "results", "device-summary.json");

export function summarizeDeviceTraces(traceDir = DEFAULT_TRACE_DIR): Record<string, Record<string, TraceMetricSummary>> {
	if (!fs.existsSync(traceDir)) {
		throw new Error(`Device trace directory does not exist: ${traceDir}`);
	}
	const traces = readDeviceTraces(traceDir);
	const samplesByPlatform = new Map<string, Map<string, number[]>>();
	for (const trace of traces) {
		const metrics = samplesByPlatform.get(trace.platform) ?? new Map<string, number[]>();
		for (const [name, samples] of Object.entries(trace.metrics)) {
			metrics.set(name, [...(metrics.get(name) ?? []), ...samples]);
		}
		samplesByPlatform.set(trace.platform, metrics);
	}
	return Object.fromEntries([...samplesByPlatform.entries()].map(([platform, metrics]) => [
		platform,
		Object.fromEntries([...metrics.entries()].map(([name, samples]) => [name, summarize(samples)])),
	]));
}

export function validateDeviceTraces(traceDir = DEFAULT_TRACE_DIR): {
	commit: string;
	fixtureSeed: string;
	summary: Record<string, Record<string, TraceMetricSummary>>;
} {
	const traces = readDeviceTraces(traceDir);
	if (traces.length === 0) throw new Error("No device traces were found.");
	const commits = new Set(traces.map((trace) => trace.commit));
	const seeds = new Set(traces.map((trace) => trace.fixtureSeed));
	if (commits.size !== 1 || [...commits][0]?.trim().length === 0) throw new Error("Device traces must use one non-empty worktree identifier.");
	if (seeds.size !== 1 || [...seeds][0] !== "knomo-catalog-v2-30k-v1") throw new Error("Device traces must use the frozen PERF-30K fixture.");
	for (const platform of ["desktop", "ios", "android"] as const) {
		const platformTraces = traces.filter((trace) => trace.platform === platform);
		if (platformTraces.length === 0) throw new Error(`Missing ${platform} device trace.`);
		const required = platform === "desktop"
			? { warmOpenMs: 30, coldOpenMs: 20, saveMs: 50, searchMs: 100, pageMs: 50 }
			: { warmOpenMs: 20, coldOpenMs: 10, saveMs: 30, searchMs: 50, pageMs: 30 };
		for (const [metric, minimum] of Object.entries(required)) {
			const count = platformTraces.reduce((total, trace) => total + (trace.metrics[metric]?.length ?? 0), 0);
			if (count < minimum) throw new Error(`${platform}.${metric} requires ${minimum} samples; found ${count}.`);
		}
		if (platform !== "desktop") {
			const background = platformTraces.reduce((total, trace) => total + (trace.backgroundInterruptions ?? 0), 0);
			const forceKills = platformTraces.reduce((total, trace) => total + (trace.forceKills ?? 0), 0);
			if (background < 5 || forceKills < 3) throw new Error(`${platform} interruption coverage is incomplete.`);
		}
	}
	const summary = summarizeDeviceTraces(traceDir);
	assertThreshold(summary, "desktop", "warmOpenMs", 500);
	assertThreshold(summary, "desktop", "coldOpenMs", 1_000);
	assertThreshold(summary, "desktop", "searchMs", 200);
	assertThreshold(summary, "desktop", "pageMs", 100);
	for (const platform of ["ios", "android"] as const) {
		assertThreshold(summary, platform, "warmOpenMs", 800);
		assertThreshold(summary, platform, "coldOpenMs", 1_500);
		assertThreshold(summary, platform, "searchMs", 300);
		assertThreshold(summary, platform, "pageMs", 150);
	}
	for (const [platform, metrics] of Object.entries(summary)) {
		const longTask = metrics.longTaskMs;
		if (longTask !== undefined && longTask.max > 50) throw new Error(`${platform}.longTaskMs exceeded 50 ms.`);
	}
	return {
		commit: [...commits][0] as string,
		fixtureSeed: [...seeds][0] as string,
		summary,
	};
}

function readDeviceTraces(traceDir: string): DeviceTrace[] {
	return fs.readdirSync(traceDir)
		.filter((name) => name.endsWith(".json"))
		.sort()
		.map((name) => JSON.parse(fs.readFileSync(path.join(traceDir, name), "utf8")) as DeviceTrace);
}

function assertThreshold(
	summary: Record<string, Record<string, TraceMetricSummary>>,
	platform: string,
	metric: string,
	maximumP95: number,
): void {
	const value = summary[platform]?.[metric];
	if (value === undefined) throw new Error(`Missing ${platform}.${metric}.`);
	if (value.p95 >= maximumP95) throw new Error(`${platform}.${metric} P95 must be below ${maximumP95} ms; found ${value.p95}.`);
}

function summarize(samples: number[]): TraceMetricSummary {
	const sorted = [...samples].sort((left, right) => left - right);
	return {
		samples: sorted.length,
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

if (require.main === module) {
	try {
		const validation = validateDeviceTraces(process.argv[2] ?? DEFAULT_TRACE_DIR);
		fs.mkdirSync(path.dirname(DEFAULT_SUMMARY_PATH), { recursive: true });
		fs.writeFileSync(DEFAULT_SUMMARY_PATH, `${JSON.stringify(validation, null, 2)}\n`, "utf8");
		console.log(JSON.stringify({ summary: DEFAULT_SUMMARY_PATH, platforms: Object.keys(validation.summary) }));
	} catch (error) {
		console.error(error);
		process.exitCode = 1;
	}
}
