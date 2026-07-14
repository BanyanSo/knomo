import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

interface VerifyCheck {
	name: string;
	run: () => number;
}

interface VerifyCore {
	FORBIDDEN_SOURCE_PATTERN: RegExp;
	runChecks: (checks: readonly VerifyCheck[]) => number;
	scanFiles: (pathsToScan: readonly string[], pattern: RegExp) => number;
	shouldScanFile: (filePath: string) => boolean;
	toPosix: (filePath: string) => string;
}

async function loadVerifyCore(): Promise<VerifyCore> {
	const importModule = new Function("specifier", "return import(specifier)") as (specifier: string) => Promise<unknown>;
	return await importModule(pathToFileURL(path.resolve("scripts/verify-core.mjs")).href) as VerifyCore;
}

function withCapturedConsoleError(callback: () => void): string[] {
	const originalError = console.error;
	const messages: string[] = [];
	console.error = (...args: unknown[]) => {
		messages.push(args.map(String).join(" "));
	};
	try {
		callback();
	} finally {
		console.error = originalError;
	}
	return messages;
}

function withCapturedConsoleLog(callback: () => void): string[] {
	const originalLog = console.log;
	const messages: string[] = [];
	console.log = (...args: unknown[]) => {
		messages.push(args.map(String).join(" "));
	};
	try {
		callback();
	} finally {
		console.log = originalLog;
	}
	return messages;
}

test("verify core scans only supported source file extensions", async () => {
	const verifyCore = await loadVerifyCore();

	assert.equal(verifyCore.shouldScanFile("source.ts"), true);
	assert.equal(verifyCore.shouldScanFile("script.mjs"), true);
	assert.equal(verifyCore.shouldScanFile("style.css"), true);
	assert.equal(verifyCore.shouldScanFile("notes.md"), true);
	assert.equal(verifyCore.shouldScanFile("data.json"), true);
	assert.equal(verifyCore.shouldScanFile("image.png"), false);
	assert.equal(verifyCore.shouldScanFile("compiled.js"), false);
});

test("verify core reports forbidden source pattern matches with file and line", async () => {
	const verifyCore = await loadVerifyCore();
	const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "knomo-verify-"));
	const sourceDir = path.join(tempDir, "src");
	fs.mkdirSync(sourceDir);
	fs.writeFileSync(path.join(sourceDir, "bad.ts"), "const ok = true;\ninput.style.color = 'red';\n", "utf8");
	fs.writeFileSync(path.join(sourceDir, "ignored.txt"), "input.style.color = 'red';\n", "utf8");

	const previousCwd = process.cwd();
	process.chdir(tempDir);
	try {
		const messages = withCapturedConsoleError(() => {
			assert.equal(verifyCore.scanFiles(["src"], verifyCore.FORBIDDEN_SOURCE_PATTERN), 1);
		});
		assert.deepEqual(messages, ["src/bad.ts:2: input.style.color = 'red';"]);
	} finally {
		process.chdir(previousCwd);
		fs.rmSync(tempDir, { recursive: true, force: true });
	}
});

test("verify core covers project-specific Obsidian source constraints", async () => {
	const verifyCore = await loadVerifyCore();
	const forbiddenSources = [
		"await this.app.vault.trash(file);",
		"await this.app.vault.delete(file);",
		"input.style.color = 'red';",
		"input.style.setProperty('--knomo-color', value);",
		"input.setAttribute('style', 'color: red');",
		"containerEl.createEl('style');",
		"createEl('link');",
	];
	const allowedSources = [
		"await this.app.fileManager.trashFile(file);",
		"myvault.deleteCache();",
		"previousVault.trashState;",
		"const color = input.style.color;",
		"input.setCssProps({ '--knomo-color': value });",
		"file instanceof TFile;",
		"event instanceof win.InputEvent;",
	];

	for (const source of forbiddenSources) {
		assert.match(source, verifyCore.FORBIDDEN_SOURCE_PATTERN);
	}
	for (const source of allowedSources) {
		assert.doesNotMatch(source, verifyCore.FORBIDDEN_SOURCE_PATTERN);
	}
});

test("verify core stops checks after the first failure", async () => {
	const verifyCore = await loadVerifyCore();
	const visited: string[] = [];

	const messages = withCapturedConsoleLog(() => {
		const exitCode = verifyCore.runChecks([
			{
				name: "first",
				run: () => {
					visited.push("first");
					return 0;
				},
			},
			{
				name: "second",
				run: () => {
					visited.push("second");
					return 7;
				},
			},
			{
				name: "third",
				run: () => {
					visited.push("third");
					return 0;
				},
			},
		]);

		assert.equal(exitCode, 7);
	});

	assert.deepEqual(visited, ["first", "second"]);
	assert.deepEqual(messages, ["\n==> first", "\n==> second"]);
});
