import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export const FORBIDDEN_SOURCE_PATTERN = /initEvent|execCommand|vault\.delete|Vault\.delete|globalThis| as TFile|instanceof .*HTMLElement|\.style\./u;
export const TRAILING_WHITESPACE_PATTERN = /[ \t]+$/u;

export const checks = [
	{
		name: "typecheck",
		run: () => runCommand("npm", ["run", "typecheck"]),
	},
	{
		name: "test",
		run: () => runCommand("npm", ["test"]),
	},
	{
		name: "build",
		run: () => runCommand("npm", ["run", "build"]),
	},
	{
		name: "i18n",
		run: () => runCommand("npm", ["run", "check:i18n"]),
	},
	{
		name: "diff whitespace",
		run: () => runCommand("git", ["diff", "--check"]),
	},
	{
		name: "forbidden source patterns",
		run: () => scanFiles(["src"], FORBIDDEN_SOURCE_PATTERN),
	},
	{
		name: "trailing whitespace",
		run: () => scanFiles([
			"README.md",
			"README.zh-CN.md",
			"docs",
			path.join("src", "ui"),
			"tests",
			"scripts",
			"package.json",
			"tsconfig.test.json",
		], TRAILING_WHITESPACE_PATTERN),
	},
];

export function runChecks(checksToRun) {
	for (const check of checksToRun) {
		console.log(`\n==> ${check.name}`);
		const exitCode = check.run();
		if (exitCode !== 0) {
			return exitCode;
		}
	}
	return 0;
}

export function runCommand(command, args) {
	const result = spawnSync(command, args, {
		stdio: "inherit",
	});
	if (result.error !== undefined) {
		console.error(result.error.message);
		return 1;
	}
	return result.status ?? 1;
}

export function scanFiles(pathsToScan, pattern) {
	const matches = [];
	for (const targetPath of pathsToScan) {
		if (!fs.existsSync(targetPath)) {
			continue;
		}
		collectMatches(targetPath, pattern, matches);
	}
	if (matches.length === 0) {
		return 0;
	}
	for (const match of matches) {
		console.error(`${match.file}:${match.line}: ${match.text}`);
	}
	return 1;
}

function collectMatches(targetPath, pattern, matches) {
	const stat = fs.statSync(targetPath);
	if (stat.isDirectory()) {
		for (const entryName of fs.readdirSync(targetPath).sort()) {
			collectMatches(path.join(targetPath, entryName), pattern, matches);
		}
		return;
	}
	if (!stat.isFile() || !shouldScanFile(targetPath)) {
		return;
	}
	const lines = fs.readFileSync(targetPath, "utf8").split(/\r?\n/u);
	for (let index = 0; index < lines.length; index += 1) {
		const line = lines[index];
		if (pattern.test(line)) {
			matches.push({
				file: toPosix(targetPath),
				line: index + 1,
				text: line,
			});
		}
	}
}

export function shouldScanFile(filePath) {
	return [".css", ".json", ".md", ".mjs", ".ts"].includes(path.extname(filePath));
}

export function toPosix(filePath) {
	return filePath.split(path.sep).join("/");
}
