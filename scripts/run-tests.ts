import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const TESTS_DIR = "tests";
const COMPILED_TESTS_DIR = path.join(".tmp", "knomo-tests", "tests");
const TEST_FILES_MARKER = "--files";

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

export function getNodeTestArgs(compiledTestFiles: readonly string[], extraNodeTestArgs: readonly string[] = []): string[] {
	return [
		"--test",
		"--test-concurrency=1",
		...extraNodeTestArgs,
		...compiledTestFiles,
	];
}

export function getRunTestSelection(sourceFileNames: readonly string[], args: readonly string[]): RunTestSelection {
	const markerIndex = args.indexOf(TEST_FILES_MARKER);
	if (markerIndex === -1) {
		return {
			sourceFileNames: [...sourceFileNames],
			extraNodeTestArgs: [...args],
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

export function runTests(args: readonly string[] = []): number {
	let selection: RunTestSelection;
	try {
		selection = getRunTestSelection(fs.readdirSync(TESTS_DIR), args);
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		return 1;
	}

	const compiledTestFiles = getCompiledTestFilesForSources(selection.sourceFileNames);

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

	const result = spawnSync(process.execPath, getNodeTestArgs(compiledTestFiles, selection.extraNodeTestArgs), {
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
