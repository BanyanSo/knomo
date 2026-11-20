import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { prepareObsidianStub } from "../tests/helpers/obsidianStub";

const TESTS_DIR = "tests";
const COMPILED_TESTS_DIR = path.resolve(__dirname, "../tests");
const TEST_FILES_MARKER = "--files";
const TOOLING_TEST_FILES = new Set([
	"ReleaseCheck.test.ts",
	"ReleaseVersion.test.ts",
	"runTests.test.ts",
	"VerifyCore.test.ts",
]);

export interface RunTestSelection {
	sourceFileNames: string[];
	extraNodeTestArgs: string[];
}

export function getCompiledTestFilesForSources(sourceFileNames: readonly string[], compiledTestsDir = COMPILED_TESTS_DIR): string[] {
	return sourceFileNames
		.filter((fileName) => fileName.endsWith(".test.ts"))
		.sort()
		.map((fileName) => path.join(compiledTestsDir, fileName.replace(/\.ts$/u, ".js")));
}

export function getMissingFiles(filePaths: readonly string[], existsSync: (filePath: string) => boolean = fs.existsSync): string[] {
	return filePaths.filter((filePath) => !existsSync(filePath));
}

export function getNodeTestArgs(compiledTestFiles: readonly string[], extraNodeTestArgs: readonly string[] = [], concurrency = 2): string[] {
	return [
		"--test",
		"--test-concurrency=" + concurrency,
		...extraNodeTestArgs,
		...compiledTestFiles,
	];
}

export function getRunTestSelection(sourceFileNames: readonly string[], args: readonly string[]): RunTestSelection {
	const markerIndex = args.indexOf(TEST_FILES_MARKER);
	const runnerArgs = markerIndex === -1 ? args : args.slice(0, markerIndex);
	const suiteArgs = runnerArgs.filter((arg) => arg.startsWith("--suite="));
	const suite = suiteArgs[0]?.slice("--suite=".length) ?? "product";
	if (suiteArgs.length > 1 || !["product", "tooling", "stress", "node", "browser", "all"].includes(suite)) {
		throw new Error("Pass one --suite=product, --suite=tooling, --suite=stress, --suite=node, --suite=browser or --suite=all.");
	}
	if (markerIndex !== -1 && suiteArgs.length > 0) {
		throw new Error("Use either --suite or --files, not both.");
	}
	if (markerIndex === -1) {
		if (suite === "stress") return {
			sourceFileNames: sourceFileNames.filter(file => file === "MemoRelationsUi.test.ts"),
			extraNodeTestArgs: ["--test-name-pattern=规模边界", ...runnerArgs.filter(arg => !arg.startsWith("--suite="))],
		};
		return {
			sourceFileNames: sourceFileNames.filter((fileName) => ["all", "node", "browser"].includes(suite)
				|| TOOLING_TEST_FILES.has(fileName) === (suite === "tooling")),
			extraNodeTestArgs: runnerArgs.filter((arg) => !arg.startsWith("--suite=")),
		};
	}

	const requestedSourceFileNames = args.slice(markerIndex + 1)
		.map((fileName) => path.posix.basename(fileName.replace(/\\/gu, "/")));
	if (requestedSourceFileNames.length === 0) {
		throw new Error("Pass at least one tests/*.test.ts file after --files.");
	}

	const availableSourceFileNames = new Set(sourceFileNames.filter((fileName) => fileName.endsWith(".test.ts")));
	const unknownSourceFileNames = [...new Set(requestedSourceFileNames
		.filter((fileName) => !availableSourceFileNames.has(fileName)))].sort();
	if (unknownSourceFileNames.length > 0) {
		throw new Error(`Unknown test source files: ${unknownSourceFileNames.join(", ")}`);
	}

	return {
		sourceFileNames: [...new Set(requestedSourceFileNames)].sort(),
		extraNodeTestArgs: args.slice(0, markerIndex),
	};
}

export function getBrowserTestSources(sourceFileNames: readonly string[]): string[] {
	// 与现有浏览器用例的显式跳过条件一致，不依赖文件命名或本地设计资料。
	return sourceFileNames.filter(file => file.endsWith(".test.ts")
		&& /skip:\s*!process\.env\.KNOMO_LAYOUT_PLAYWRIGHT/u.test(fs.readFileSync(path.join(TESTS_DIR, file), "utf8")));
}

export function getTestRuns(sourceFileNames: readonly string[], args: readonly string[]) {
	const all = args.includes("--suite=all");
	const node = args.includes("--suite=node");
	const browser = args.includes("--suite=browser");
	if (!all && !node && !browser) return [{ sourceFileNames, browser: false }];

	const browserSources = getBrowserTestSources(sourceFileNames);
	const browserSet = new Set(browserSources);
	const runs = [];
	if (all || node) runs.push({ sourceFileNames: sourceFileNames.filter(file => !browserSet.has(file)), browser: false });
	if (all || browser) runs.push({ sourceFileNames: browserSources, browser: true });
	return runs;
}

export async function prepareTestEnvironment(args: readonly string[], environment: NodeJS.ProcessEnv = process.env): Promise<NodeJS.ProcessEnv> {
	const env = { ...environment };
	if (args.includes("--suite=node")) {
		delete env.KNOMO_LAYOUT_PLAYWRIGHT;
		return env;
	}
	if (!args.includes("--suite=all") && !args.includes("--suite=browser")) return env;
	try {
		const modulePath = require.resolve(env.KNOMO_LAYOUT_PLAYWRIGHT || "playwright");
		const { chromium } = require(modulePath) as typeof import("playwright");
		const channel = env.KNOMO_LAYOUT_BROWSER || "chromium";
		// 先确认浏览器可启动，缺少安装或系统依赖时不运行其余测试并报告全量成功。
		const browser = await chromium.launch({ channel, headless: true });
		await browser.close();
		return { ...env, KNOMO_LAYOUT_PLAYWRIGHT: modulePath, KNOMO_LAYOUT_BROWSER: channel };
	} catch (error) {
		throw new Error(`Browser tests are required. Run npm ci and npm run test:browser:install (Linux CI: npx playwright install --with-deps chromium).\n${error instanceof Error ? error.message : String(error)}`);
	}
}

export async function runTests(args: readonly string[] = []): Promise<number> {
	let selection: RunTestSelection;
	let runs: ReturnType<typeof getTestRuns>;
	try {
		selection = getRunTestSelection(fs.readdirSync(TESTS_DIR), args);
		runs = getTestRuns(selection.sourceFileNames, args);
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		return 1;
	}

	const compiledRuns = runs.map(run => ({ browser: run.browser, files: getCompiledTestFilesForSources(run.sourceFileNames) }));

	if (compiledRuns.some(run => run.files.length === 0)) {
		console.error("No test source files found for a requested suite.");
		return 1;
	}

	const missingCompiledTests = getMissingFiles(compiledRuns.flatMap(run => run.files));

	if (missingCompiledTests.length > 0) {
		console.error("Compiled test files are missing. Rerun the npm test command to compile them:");
		for (const filePath of missingCompiledTests) {
			console.error(`- ${filePath}`);
		}
		return 1;
	}

	let environment: NodeJS.ProcessEnv;
	try { environment = await prepareTestEnvironment(args); }
	catch (error) { console.error(error instanceof Error ? error.message : String(error)); return 1; }
	if (args.includes("--suite=node")) {
		console.warn("Node suite: run npm run test:browser or npm run test:all for real browser coverage.");
	} else if (!environment.KNOMO_LAYOUT_PLAYWRIGHT && getBrowserTestSources(selection.sourceFileNames).length > 0) {
		console.warn("Node-only run: real browser checks will be skipped. Run npm run test:browser or npm run test:all for browser coverage.");
	}
	await prepareObsidianStub();
	const scale = ["--suite=stress", "--suite=node", "--suite=all"].some(arg => args.includes(arg)) ? "stress" : "normal";
	for (const run of compiledRuns) {
		const env: NodeJS.ProcessEnv = { ...environment, KNOMO_TEST_PREPARED: "1", KNOMO_TEST_SCALE: scale };
		if (args.includes("--suite=all")) {
			console.log(run.browser ? "\n==> Browser tests" : "\n==> Node tests");
			if (!run.browser) delete env.KNOMO_LAYOUT_PLAYWRIGHT;
		}
		const result = spawnSync(process.execPath, getNodeTestArgs(run.files, selection.extraNodeTestArgs, run.browser ? 1 : 2), {
			stdio: "inherit",
			env,
		});

		if (result.error !== undefined) {
			console.error(result.error.message);
			return 1;
		}
		if (result.status !== 0) return result.status ?? 1;
	}

	return 0;
}

if (require.main === module) {
	runTests(process.argv.slice(2)).then(code => { process.exitCode = code; }).catch(error => {
		console.error(error);
		process.exitCode = 1;
	});
}
