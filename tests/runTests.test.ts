import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { spawnSync } from "node:child_process";

import {
	getCompiledTestFilesForSources,
	getMissingFiles,
	getNodeTestArgs,
	getRunTestSelection,
	getTestRuns,
	prepareTestEnvironment,
} from "../scripts/run-tests";

test("stress suite selects scale checks while all retains every source", () => {
	const sources = ["MemoRelationsUi.test.ts", "Other.test.ts", "runTests.test.ts"];
	assert.deepEqual(getRunTestSelection(sources, ["--suite=stress"]), {
		sourceFileNames: ["MemoRelationsUi.test.ts"], extraNodeTestArgs: ["--test-name-pattern=规模边界"],
	});
	assert.deepEqual(getRunTestSelection(sources, ["--suite=all"]).sourceFileNames, sources);
});

test("Node 与浏览器集合互斥，全量按顺序覆盖两者，显式文件入口保持原选择", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "knomo-browser-selection-"));
	const previousCwd = process.cwd();
	try {
		fs.mkdirSync(path.join(root, "tests"));
		fs.writeFileSync(path.join(root, "tests", "Future.test.ts"), ["test('browser', { skip:", "!process.env.KNOMO_LAYOUT_PLAYWRIGHT }, () => {});"].join(" "));
		fs.writeFileSync(path.join(root, "tests", "Plain.test.ts"), "test('node', () => {});");
		process.chdir(root);
		const sources = ["Plain.test.ts", "Future.test.ts"];
		const node = { sourceFileNames: ["Plain.test.ts"], browser: false };
		const browser = { sourceFileNames: ["Future.test.ts"], browser: true };
		assert.deepEqual(getTestRuns(sources, ["--suite=node"]), [node]);
		assert.deepEqual(getTestRuns(sources, ["--suite=browser"]), [browser]);
		assert.deepEqual(getTestRuns(sources, ["--suite=all"]), [node, browser]);
		assert.deepEqual(getTestRuns(sources, ["--files", ...sources]), [{ sourceFileNames: sources, browser: false }]);
	} finally { process.chdir(previousCwd); fs.rmSync(root, { recursive: true, force: true }); }
});

test("全量只执行各文件一次，Node 失败停止，浏览器失败传回退出状态", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "knomo-test-phases-"));
	try {
		const compiled = path.join(root, ".tmp", "knomo-tests");
		for (const directory of ["src/assets", "tests", ".tmp/knomo-tests/scripts", ".tmp/knomo-tests/tests/helpers"]) {
			fs.mkdirSync(path.join(root, directory), { recursive: true });
		}
		fs.copyFileSync(path.resolve(".tmp/knomo-tests/scripts/run-tests.js"), path.join(compiled, "scripts/run-tests.js"));
		fs.copyFileSync(path.join(__dirname, "helpers/obsidianStub.js"), path.join(compiled, "tests/helpers/obsidianStub.js"));
		for (const name of ["Banyan-WeChat-Reward.png", "buymeacoffe-code.png", "share-reflection-cover.webp"]) {
			fs.writeFileSync(path.join(root, "src/assets", name), "");
		}
		const playwright = path.join(root, "playwright.cjs");
		fs.writeFileSync(playwright, "exports.chromium = { async launch() { return { async close() {} }; } };");
		for (const [name, browser] of [["Node", false], ["Browser", true]] as const) {
			const marker = browser ? ["skip:", "!process.env.KNOMO_LAYOUT_PLAYWRIGHT"].join(" ") : "";
			fs.writeFileSync(path.join(root, "tests", name + ".test.ts"), marker);
			fs.writeFileSync(path.join(compiled, "tests", name + ".test.js"), [
				"const assert = require('node:assert/strict');",
				"require('node:test')('phase fixture', () => {",
				"require('node:fs').appendFileSync('phase-log.txt', '" + name + "\\n');",
				"assert.equal(Boolean(process.env.KNOMO_LAYOUT_PLAYWRIGHT), " + browser + ");",
				"assert.equal(process.env.KNOMO_TEST_SCALE, 'stress');",
				"assert.notEqual(process.env.KNOMO_FAIL_PHASE, '" + name + "');",
				"});",
			].join("\n"));
		}
		for (const [failure, expected] of [["", ["Node", "Browser"]], ["Node", ["Node"]], ["Browser", ["Node", "Browser"]]] as const) {
			const trace = path.join(root, "phase-log.txt");
			fs.writeFileSync(trace, "");
			const env: NodeJS.ProcessEnv = { ...process.env, KNOMO_LAYOUT_PLAYWRIGHT: playwright, KNOMO_FAIL_PHASE: failure };
			delete env.NODE_TEST_CONTEXT;
			const result = spawnSync(process.execPath, [path.join(compiled, "scripts/run-tests.js"), "--suite=all", "--test-reporter=spec"], {
				cwd: root, encoding: "utf8", env,
			});
			assert.equal(result.status, failure ? 1 : 0, result.stderr || result.stdout);
			assert.deepEqual(fs.readFileSync(trace, "utf8").trim().split("\n"), expected);
		}
	} finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("node 集合显式关闭浏览器，局部测试仍保留调用者的环境", async () => {
	const env = { KNOMO_LAYOUT_PLAYWRIGHT: "custom-playwright", KNOMO_LAYOUT_BROWSER: "custom-browser" };
	assert.equal((await prepareTestEnvironment(["--suite=node"], env)).KNOMO_LAYOUT_PLAYWRIGHT, undefined);
	assert.deepEqual(await prepareTestEnvironment(["--files", "Example.test.ts"], env), env);
	assert.equal(env.KNOMO_LAYOUT_PLAYWRIGHT, "custom-playwright");
});

test("all 和 browser 缺少浏览器依赖时返回失败并说明安装方法", () => {
	for (const suite of ["all", "browser"]) {
		const result = spawnSync(process.execPath, [path.resolve(".tmp/knomo-tests/scripts/run-tests.js"), `--suite=${suite}`], {
			encoding: "utf8", env: { ...process.env, KNOMO_LAYOUT_PLAYWRIGHT: path.join(os.tmpdir(), "knomo-no-playwright-installed.cjs") },
		});
		assert.equal(result.status, 1, result.stderr);
		assert.match(result.stderr, /Browser tests are required/u);
		assert.match(result.stderr, /npm run test:browser:install/u);
		assert.doesNotMatch(result.stdout, /# SKIP|ℹ pass/u);
	}
});

test("安装了 Playwright 但缺少 Chromium 时仍拒绝全量验证", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "knomo-no-browser-"));
	try {
		const result = spawnSync(process.execPath, [path.resolve(".tmp/knomo-tests/scripts/run-tests.js"), "--suite=all"], {
			encoding: "utf8", env: { ...process.env, KNOMO_LAYOUT_PLAYWRIGHT: require.resolve("playwright"), KNOMO_LAYOUT_BROWSER: "chromium", PLAYWRIGHT_BROWSERS_PATH: root },
		});
		assert.equal(result.status, 1, result.stderr);
		assert.match(result.stderr, /Browser tests are required/u);
		assert.match(result.stderr, /Executable doesn't exist/u);
	} finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("run-tests maps only current test sources to compiled test files", () => {
	assert.deepEqual(
		getCompiledTestFilesForSources([
			"stale.test.js",
			"zeta.test.ts",
			"helper.ts",
			"alpha.test.ts",
		], path.join(".tmp", "compiled", "tests")),
		[
			path.join(".tmp", "compiled", "tests", "alpha.test.js"),
			path.join(".tmp", "compiled", "tests", "zeta.test.js"),
		],
	);
});

test("run-tests reports missing compiled files from the mapped source list", () => {
	const missing = getMissingFiles([
		"alpha.test.js",
		"stale.test.js",
		"zeta.test.js",
	], (filePath) => filePath !== "stale.test.js");

	assert.deepEqual(missing, ["stale.test.js"]);
});

test("run-tests passes explicit files to node test", () => {
	assert.deepEqual(
		getNodeTestArgs(["alpha.test.js", "zeta.test.js"]),
		[
			"--test",
			"--test-concurrency=2",
			"alpha.test.js",
			"zeta.test.js",
		],
	);
});

test("run-tests forwards extra node test arguments before test files", () => {
	assert.deepEqual(
		getNodeTestArgs(["alpha.test.js", "zeta.test.js"], ["--test-name-pattern=WikiLink"]),
		[
			"--test",
			"--test-concurrency=2",
			"--test-name-pattern=WikiLink",
			"alpha.test.js",
			"zeta.test.js",
		],
	);
});

test("run-tests keeps product test sources when no file selection is provided", () => {
	assert.deepEqual(
		getRunTestSelection(
			["zeta.test.ts", "helper.ts", "alpha.test.ts"],
			["--test-reporter=dot"],
		),
		{
			sourceFileNames: ["zeta.test.ts", "helper.ts", "alpha.test.ts"],
			extraNodeTestArgs: ["--test-reporter=dot"],
		},
	);
});

test("product and tooling partition every current test source exactly once", () => {
	const sources = fs.readdirSync("tests").filter((file) => file.endsWith(".test.ts")).sort();
	const product = getRunTestSelection(sources, []).sourceFileNames;
	const tooling = getRunTestSelection(sources, ["--suite=tooling"]).sourceFileNames;
	const all = getRunTestSelection(sources, ["--suite=all"]).sourceFileNames;
	assert.deepEqual(tooling, ["ReleaseCheck.test.ts", "ReleaseVersion.test.ts", "VerifyCore.test.ts", "runTests.test.ts"]);
	assert.deepEqual(all, sources);
	assert.deepEqual([...product, ...tooling].sort(), sources);
	assert.equal(new Set([...product, ...tooling]).size, sources.length);
	const [nodeRun, browserRun] = getTestRuns(sources, ["--suite=all"]);
	assert.deepEqual([...nodeRun.sourceFileNames, ...browserRun.sourceFileNames].sort(), sources);
	assert.ok(nodeRun.sourceFileNames.includes("MemoRelationsUi.test.ts"));
	assert.ok(browserRun.sourceFileNames.includes("MemoRelationsUi.browser.test.ts"));
	for (const file of ["CatalogArchitectureGuard.test.ts", "P8SyncAcceptance.test.ts",
		"DiaryMemoParser.test.ts", "IndependentTrashService.test.ts", "MarkdownMutationService.test.ts",
		"MonthlyProjectionCoordinator.test.ts"]) {
		assert.ok(product.includes(file), `${file} must remain in the product gate.`);
	}
	assert.deepEqual(getRunTestSelection(sources, ["--suite=product"]).sourceFileNames, product);
});

test("new test names default to product and suite options do not reach Node", () => {
	const sources = ["FutureIdentityGuardBenchmarkP8.test.ts", "runTests.test.ts"];
	assert.deepEqual(getRunTestSelection(sources, ["--test-reporter=dot"]), {
		sourceFileNames: [sources[0]], extraNodeTestArgs: ["--test-reporter=dot"],
	});
	assert.deepEqual(getRunTestSelection(sources, ["--suite=tooling", "--test-reporter=dot"]), {
		sourceFileNames: [sources[1]], extraNodeTestArgs: ["--test-reporter=dot"],
	});
	assert.deepEqual(getRunTestSelection(sources, ["--files", "tests/runTests.test.ts"]).sourceFileNames, [sources[1]]);
});

test("run-tests rejects invalid or conflicting suite selections", () => {
	for (const args of [["--suite=unknown"], ["--suite=all", "--suite=product"],
		["--suite=tooling", "--files", "runTests.test.ts"]]) {
		assert.throws(() => getRunTestSelection(["runTests.test.ts"], args), /suite/u);
	}
});

test("run-tests selects requested source files after the files marker", () => {
	assert.deepEqual(
		getRunTestSelection(
			["zeta.test.ts", "helper.ts", "alpha.test.ts"],
			[
				"--test-reporter=dot",
				"--files",
				"tests\\zeta.test.ts",
				"tests/alpha.test.ts",
				"tests/zeta.test.ts",
			],
		),
		{
			sourceFileNames: ["alpha.test.ts", "zeta.test.ts"],
			extraNodeTestArgs: ["--test-reporter=dot"],
		},
	);
});

test("run-tests rejects an empty file selection", () => {
	assert.throws(
		() => getRunTestSelection(["alpha.test.ts"], ["--files"]),
		/Pass at least one tests\/.*\.test\.ts file after --files\./u,
	);
});

test("run-tests rejects unavailable test source files", () => {
	assert.throws(
		() => getRunTestSelection(["alpha.test.ts"], ["--files", "tests/missing.test.ts"]),
		/Unknown test source files: missing\.test\.ts/u,
	);
});
