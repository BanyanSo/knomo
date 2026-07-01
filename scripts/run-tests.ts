import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const TESTS_DIR = "tests";
const COMPILED_TESTS_DIR = path.join(".tmp", "knomo-tests", "tests");

export function getCompiledTestFilesForSources(sourceFileNames: readonly string[], compiledTestsDir = COMPILED_TESTS_DIR): string[] {
	return sourceFileNames
		.filter((fileName) => fileName.endsWith(".test.ts"))
		.sort()
		.map((fileName) => path.join(compiledTestsDir, fileName.replace(/\.ts$/u, ".js")));
}

export function getMissingFiles(filePaths: readonly string[], existsSync: (filePath: string) => boolean = fs.existsSync): string[] {
	return filePaths.filter((filePath) => !existsSync(filePath));
}

export function getNodeTestArgs(compiledTestFiles: readonly string[], extraNodeTestArgs: readonly string[] = []): string[] {
	return [
		"--test",
		"--test-concurrency=1",
		...extraNodeTestArgs,
		...compiledTestFiles,
	];
}

export function runTests(extraNodeTestArgs: readonly string[] = []): number {
	const compiledTestFiles = getCompiledTestFilesForSources(fs.readdirSync(TESTS_DIR));

	if (compiledTestFiles.length === 0) {
		console.error("No test source files found.");
		return 1;
	}

	const missingCompiledTests = getMissingFiles(compiledTestFiles);

	if (missingCompiledTests.length > 0) {
		console.error("Compiled test files are missing. Run `tsc -p tsconfig.test.json` first:");
		for (const filePath of missingCompiledTests) {
			console.error(`- ${filePath}`);
		}
		return 1;
	}

	const result = spawnSync(process.execPath, getNodeTestArgs(compiledTestFiles, extraNodeTestArgs), {
		stdio: "inherit",
	});

	if (result.error !== undefined) {
		console.error(result.error.message);
		return 1;
	}

	return result.status ?? 1;
}

if (require.main === module) {
	process.exit(runTests(process.argv.slice(2)));
}
