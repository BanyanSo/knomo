import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const root = fileURLToPath(new URL("../", import.meta.url));
const configPath = path.join(root, "tsconfig.test.json");

function runNode(args) {
	const result = spawnSync(process.execPath, args, { cwd: root, stdio: "inherit" });
	if (result.error) throw result.error;
	return result.status ?? 1;
}

function runTests() {
	const cacheId = process.env.KNOMO_TEST_CACHE_ID;
	if (cacheId && !/^[A-Za-z0-9_-]+$/u.test(cacheId)) {
		throw new Error("KNOMO_TEST_CACHE_ID may only contain letters, digits, hyphens and underscores.");
	}

	const { outDir } = require(configPath).compilerOptions;
	const output = path.resolve(root, cacheId ? `${outDir}-${cacheId}` : outDir);
	mkdirSync(output, { recursive: true });

	const status = runNode([
		require.resolve("typescript/bin/tsc"), "-p", configPath, "--outDir", output,
		"--tsBuildInfoFile", path.join(output, "tsconfig.test.tsbuildinfo"),
	]);
	if (status !== 0) return status;

	return runNode([path.join(output, "scripts/run-tests.js"), ...process.argv.slice(2)]);
}

try {
	process.exitCode = runTests();
} catch (error) {
	console.error(error.message);
	if (error.code === "EPERM" || error.code === "EACCES") {
		console.error("Set KNOMO_TEST_CACHE_ID to a new name and rerun the test command.");
	}
	process.exitCode = 1;
}
