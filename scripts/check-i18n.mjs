import fs from "node:fs";
import path from "node:path";
import ts from "typescript";

const SRC_DIR = path.resolve("src");
const ALLOWED_FILES = new Set([
	"src/i18n/zh-CN.ts",
	"src/utils/dailyNotes.ts",
	// Compatibility tags for random revisit filtering are data rules, not UI text.
	"src/utils/randomReunion.ts",
]);
const HAN_TEXT = /[\u3400-\u9FFF\uF900-\uFAFF]/u;

const problems = [];

for (const filePath of listTsFiles(SRC_DIR)) {
	const relativePath = toPosix(path.relative(process.cwd(), filePath));
	if (ALLOWED_FILES.has(relativePath)) {
		continue;
	}
	checkFile(filePath, relativePath);
}

if (problems.length > 0) {
	console.error("Chinese hardcoded text was found outside the i18n allowlist:");
	for (const problem of problems) {
		console.error(`- ${problem.file}:${problem.line}:${problem.character} ${problem.text}`);
	}
	process.exitCode = 1;
}

function checkFile(filePath, relativePath) {
	const sourceText = fs.readFileSync(filePath, "utf8");
	const sourceFile = ts.createSourceFile(filePath, sourceText, ts.ScriptTarget.Latest, true);
	const visit = (node) => {
		if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
			reportIfChinese(sourceFile, relativePath, node, node.text);
		} else if (ts.isTemplateExpression(node)) {
			reportIfChinese(sourceFile, relativePath, node.head, node.head.text);
			for (const span of node.templateSpans) {
				reportIfChinese(sourceFile, relativePath, span.literal, span.literal.text);
			}
		}
		ts.forEachChild(node, visit);
	};
	visit(sourceFile);
}

function reportIfChinese(sourceFile, relativePath, node, text) {
	if (!HAN_TEXT.test(text)) {
		return;
	}
	const position = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
	problems.push({
		file: relativePath,
		line: position.line + 1,
		character: position.character + 1,
		text: text.replace(/\s+/g, " ").slice(0, 120),
	});
}

function listTsFiles(dirPath) {
	const entries = fs.readdirSync(dirPath, { withFileTypes: true });
	const files = [];
	for (const entry of entries) {
		const entryPath = path.join(dirPath, entry.name);
		if (entry.isDirectory()) {
			files.push(...listTsFiles(entryPath));
		} else if (entry.isFile() && entry.name.endsWith(".ts")) {
			files.push(entryPath);
		}
	}
	return files;
}

function toPosix(value) {
	return value.split(path.sep).join("/");
}
