import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const CATALOG_BENCHMARK_SEED = "knomo-catalog-v2-30k-v1";
export const DEFAULT_BENCHMARK_ROOT = path.join(".tmp", "catalog-v2-benchmark");
export const DEFAULT_BENCHMARK_VAULT = path.join(DEFAULT_BENCHMARK_ROOT, "vault");
export const DEFAULT_BENCHMARK_MANIFEST = path.join(DEFAULT_BENCHMARK_ROOT, "manifest.json");

export interface CatalogBenchmarkFileManifest {
	path: string;
	logicalDate: string;
	sha256: string;
	size: number;
	lineEnding: "LF" | "CRLF";
	observationCount: number;
}

export interface CatalogBenchmarkManifest {
	schemaVersion: 1;
	seed: string;
	dailyCount: number;
	memosPerDaily: number;
	activeObservations: number;
	dailyFolder: "Journal/Daily";
	dailyFormat: "YYYY/MM/YYYY-MM-DD";
	heading: "## Memos";
	pageSize: 50;
	files: CatalogBenchmarkFileManifest[];
}

export interface GenerateCatalogBenchmarkOptions {
	rootDir?: string;
	dailyCount?: number;
	memosPerDaily?: number;
}

export function generateCatalogBenchmarkVault(options: GenerateCatalogBenchmarkOptions = {}): CatalogBenchmarkManifest {
	const rootDir = options.rootDir ?? DEFAULT_BENCHMARK_ROOT;
	const vaultDir = path.join(rootDir, "vault");
	const manifestPath = path.join(rootDir, "manifest.json");
	const dailyCount = options.dailyCount ?? 1500;
	const memosPerDaily = options.memosPerDaily ?? 20;
	const files: CatalogBenchmarkFileManifest[] = [];
	fs.mkdirSync(vaultDir, { recursive: true });

	for (let dailyIndex = 0; dailyIndex < dailyCount; dailyIndex += 1) {
		const date = addDays(new Date(2022, 6, 1), dailyIndex);
		const logicalDate = formatDate(date);
		const relativePath = path.posix.join(
			"Journal",
			"Daily",
			String(date.getFullYear()),
			String(date.getMonth() + 1).padStart(2, "0"),
			`${logicalDate}.md`,
		);
		const lineEnding = dailyIndex % 10 === 0 ? "CRLF" : "LF";
		const content = buildDailyContent(dailyIndex, logicalDate, memosPerDaily)
			.replace(/\n/gu, lineEnding === "CRLF" ? "\r\n" : "\n");
		const bytes = Buffer.from(content, "utf8");
		const absolutePath = path.join(vaultDir, ...relativePath.split("/"));
		fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
		fs.writeFileSync(absolutePath, bytes);
		files.push({
			path: relativePath,
			logicalDate,
			sha256: sha256(bytes),
			size: bytes.byteLength,
			lineEnding,
			observationCount: memosPerDaily,
		});
	}

	const manifest: CatalogBenchmarkManifest = {
		schemaVersion: 1,
		seed: CATALOG_BENCHMARK_SEED,
		dailyCount,
		memosPerDaily,
		activeObservations: dailyCount * memosPerDaily,
		dailyFolder: "Journal/Daily",
		dailyFormat: "YYYY/MM/YYYY-MM-DD",
		heading: "## Memos",
		pageSize: 50,
		files,
	};
	fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
	fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
	return manifest;
}

function buildDailyContent(dailyIndex: number, logicalDate: string, memosPerDaily: number): string {
	const rootMemo = buildMemoBlock(dailyIndex, 0, logicalDate);
	const headingMemos: string[] = [];
	for (let memoIndex = 1; memoIndex < memosPerDaily; memoIndex += 1) {
		headingMemos.push(buildMemoBlock(dailyIndex, memoIndex, logicalDate));
	}
	return `${rootMemo}\n\n## Memos\n${headingMemos.join("\n")}\n`;
}

function buildMemoBlock(dailyIndex: number, memoIndex: number, logicalDate: string): string {
	const ordinal = dailyIndex * 20 + memoIndex;
	const month = logicalDate.slice(0, 7);
	const day = logicalDate.slice(-2);
	if (day === "01" && memoIndex < 10) {
		const group = Math.floor(memoIndex / 2);
		return `- 06:${String(group).padStart(2, "0")} monthly same time content ${month} group ${group}`;
	}
	if ((day === "02" || day === "03") && memoIndex < 10) {
		return `- ${buildTime(dailyIndex, memoIndex)} monthly same content different time ${month} group ${memoIndex}`;
	}
	const time = buildTime(dailyIndex, memoIndex);
	const parts = [
		`benchmark memo ${ordinal}`,
		ordinal % 7 === 0 ? `shared-month-${logicalDate.slice(0, 7)}` : "",
		isFeature(ordinal, 35, 11) ? `#project-${ordinal % 12}` : "",
		isFeature(ordinal, 25, 23) ? `[[Topic ${ordinal % 40}]] https://example.com/item/${ordinal}` : "",
		isFeature(ordinal, 10, 37) ? `![[assets/image-${ordinal % 30}.png]]` : "",
		isFeature(ordinal, 8, 41) ? `@${logicalDate}` : "",
		ordinal % 13 === 0 ? "中文搜索" : "",
	].filter(Boolean);
	const lines = [`- ${time} ${parts.join(" ")}`];
	if (isFeature(ordinal, 20, 53)) {
		lines.push(`  continuation ${ordinal}`);
		lines.push(`    nested item ${ordinal % 9}`);
	}
	if (isFeature(ordinal, 15, 67)) {
		lines.push(`  - [${ordinal % 2 === 0 ? " " : "x"}] task ${ordinal}`);
	}
	if (isFeature(ordinal, 5, 79)) {
		lines.push("  ```md");
		lines.push("  - 23:59 fenced fake memo");
		lines.push("  - [ ] fenced task [[False Link]] ![[false.png]] @2020-01-01");
		lines.push("  ```");
	}
	if (isFeature(ordinal, 5, 97)) {
		lines[lines.length - 1] = `${lines[lines.length - 1]} ^bench-${ordinal}`;
	}
	return lines.join("\n");
}

function buildTime(dailyIndex: number, memoIndex: number): string {
	const pairedMemoIndex = memoIndex < 4 ? Math.floor(memoIndex / 2) * 2 : memoIndex;
	const totalMinutes = (dailyIndex * 17 + pairedMemoIndex * 37) % (24 * 60);
	const hours = Math.floor(totalMinutes / 60).toString().padStart(2, "0");
	const minutes = (totalMinutes % 60).toString().padStart(2, "0");
	return `${hours}:${minutes}`;
}

function isFeature(ordinal: number, percentage: number, salt: number): boolean {
	return stableBucket(ordinal, salt) < percentage;
}

function stableBucket(ordinal: number, salt: number): number {
	let value = (ordinal + 1) * 0x45d9f3b ^ salt * 0x119de1f3;
	value = Math.imul(value ^ (value >>> 16), 0x45d9f3b);
	value = Math.imul(value ^ (value >>> 16), 0x45d9f3b);
	return ((value ^ (value >>> 16)) >>> 0) % 100;
}

function addDays(date: Date, days: number): Date {
	const result = new Date(date);
	result.setDate(result.getDate() + days);
	return result;
}

function formatDate(date: Date): string {
	return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function sha256(bytes: Uint8Array): string {
	return createHash("sha256").update(bytes).digest("hex");
}

if (require.main === module) {
	const args = process.argv.slice(2);
	const rootDir = readStringArg(args, "--output") ?? DEFAULT_BENCHMARK_ROOT;
	const dailyCount = readPositiveIntegerArg(args, "--daily-count");
	const memosPerDaily = readPositiveIntegerArg(args, "--memos-per-daily");
	const manifest = generateCatalogBenchmarkVault({
		rootDir,
		...(dailyCount === null ? {} : { dailyCount }),
		...(memosPerDaily === null ? {} : { memosPerDaily }),
	});
	console.log(JSON.stringify({
		seed: manifest.seed,
		dailyCount: manifest.dailyCount,
		activeObservations: manifest.activeObservations,
		manifest: path.join(rootDir, "manifest.json"),
	}));
}

function readStringArg(args: readonly string[], name: string): string | null {
	const prefix = `${name}=`;
	const value = args.find((arg) => arg.startsWith(prefix))?.slice(prefix.length).trim();
	return value === undefined || value.length === 0 ? null : value;
}

function readPositiveIntegerArg(args: readonly string[], name: string): number | null {
	const value = readStringArg(args, name);
	if (value === null) return null;
	const parsed = Number(value);
	if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`${name} must be a positive integer.`);
	return parsed;
}
