import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs";

import {
	getCompiledTestFilesForSources,
	getMissingFiles,
	getNodeTestArgs,
	getRunTestSelection,
} from "../scripts/run-tests";

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
			"--test-concurrency=1",
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
			"--test-concurrency=1",
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
	assert.deepEqual(tooling, ["CatalogBenchmarkTooling.test.ts", "VerifyCore.test.ts", "runTests.test.ts"]);
	assert.deepEqual(all, sources);
	assert.deepEqual([...product, ...tooling].sort(), sources);
	assert.equal(new Set([...product, ...tooling]).size, sources.length);
	for (const file of ["CatalogBenchmark.test.ts", "CatalogArchitectureGuard.test.ts", "P8SyncAcceptance.test.ts",
		"DiaryMemoParser.test.ts", "IndependentTrashService.test.ts", "MarkdownMutationService.test.ts",
		"LegacyTrashMigrationService.test.ts", "MonthlyProjectionCoordinator.test.ts"]) {
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
