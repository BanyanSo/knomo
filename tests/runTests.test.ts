import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";

import {
	getCompiledTestFilesForSources,
	getMissingFiles,
	getNodeTestArgs,
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
