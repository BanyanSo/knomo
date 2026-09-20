import test from "node:test";
import assert from "node:assert/strict";
import { runComposerCommand, type ComposerCommand, type ComposerEdit } from "../src/utils/composerCommands";
import { scanComposerSyntax, revealComposerRange } from "../src/utils/composerSyntax";
import { normalizeComposerToolbar, COMPOSER_ACTIONS } from "../src/settings/composerToolbar";

function apply(value: string, from: number, to: number, command: ComposerCommand): ComposerEdit {
	const result = runComposerCommand(value, from, to, command);
	assert.equal(result.type, "changed");
	if (result.type !== "changed") throw new Error("Expected change");
	return result.edit;
}

test("inline commands retain body selection for consecutive formatting and exact toggle", () => {
	const bold = apply("hello", 0, 5, "bold");
	assert.deepEqual(bold, { value: "**hello**", anchor: 2, head: 7 });
	assert.deepEqual(apply(bold.value, bold.anchor, bold.head, "bold"), { value: "hello", anchor: 0, head: 5 });
	assert.deepEqual(apply(bold.value, 0, 9, "bold"), { value: "hello", anchor: 0, head: 5 });
	assert.deepEqual(apply(bold.value, bold.anchor, bold.head, "highlight"), { value: "**==hello==**", anchor: 4, head: 9 });
	assert.deepEqual(apply("hello", 5, 0, "bold"), { value: "**hello**", anchor: 7, head: 2 });
});

test("empty insertion and repeated or partial formatting do not create additional text", () => {
	const edit = apply("hello", 5, 5, "bold");
	assert.deepEqual(edit, { value: "hello****", anchor: 7, head: 7 });
	assert.equal(runComposerCommand(edit.value, 7, 7, "bold").type, "unchanged");
	assert.equal(runComposerCommand("**hello**", 3, 3, "bold").type, "unchanged");
	assert.equal(runComposerCommand("**hello**", 3, 6, "bold").type, "unavailable");
	assert.equal(runComposerCommand("**hello** world", 3, 15, "bold").type, "unavailable");
});

test("bold and highlight reject crossing each other's boundaries but retain legal nesting", () => {
	for (const [marker, command] of [["**", "highlight"], ["==", "bold"]] as const) {
		const value = `${marker}ab${marker} cd`;
		for (const [from, to] of [[2, 9], [9, 2], [1, 4], [2, 5]]) {
			assert.equal(runComposerCommand(value, from, to, command).type, "unavailable");
		}
		assert.equal(runComposerCommand(`cd ${marker}ab${marker}`, 0, 7, command).type, "unavailable");
		const inserted = command === "bold" ? "**" : "==";
		assert.equal(apply(value, 2, 4, command).value, `${marker}${inserted}ab${inserted}${marker} cd`);
		assert.equal(apply(value, 0, 9, command).value, `${inserted}${value}${inserted}`);
		assert.equal(runComposerCommand(`plain\n${value}`, 0, 11, command).type, "unavailable");
	}
});

test("multiline formatting preserves list structure, indentation, empty lines and whitespace", () => {
	const value = "  - [x] one  \n\n  2) **two**\nplain";
	const result = apply(value, 0, value.indexOf("plain"), "bold");
	assert.equal(result.value, "  - [x] **one**  \n\n  2) **two**\nplain");
	const end = result.value.indexOf("plain");
	assert.equal(apply(result.value, 0, end, "bold").value, "  - [x] one  \n\n  2) two\nplain");
});

test("link command preserves whitespace and rejects existing, advanced, embedded and multiline links", () => {
	assert.deepEqual(apply("", 0, 0, "link"), { value: "[[]]", anchor: 2, head: 2 });
	assert.deepEqual(apply("  Note  ", 0, 8, "link"), { value: "  [[Note]]  ", anchor: 4, head: 8 });
	for (const value of ["![[image.png]]", "[[Note|alias]]", "Note#heading", "a\nb", "   "]) {
		assert.notEqual(runComposerCommand(value, 0, value.length, "link").type, "changed", value);
	}
	assert.equal(runComposerCommand("[[Note]]", 3, 3, "link").type, "unchanged");
});

test("line conversions preserve task status or remove checkbox intentionally and retain selection", () => {
	const value = "  - [x] done\n2) text\n\nlast";
	const to = value.indexOf("last");
	const task = apply(value, 0, to, "task");
	assert.equal(task.value, "  - [x] done\n- [ ] text\n\nlast");
	assert.equal(runComposerCommand(task.value, 0, task.value.indexOf("last"), "task").type, "unchanged");
	assert.equal(apply("- [x] done", 6, 10, "bullet").value, "- done");
	assert.deepEqual(apply("- [x] done", 10, 10, "ordered"), { value: "1. done", anchor: 7, head: 7 });
	assert.equal(runComposerCommand("- [/] pending", 0, 13, "task").type, "unavailable");
	assert.equal(apply("a\nb", 0, 2, "bullet").value, "- a\nb");
	assert.equal(apply("", 0, 0, "task").value, "- [ ] ");
});

test("syntax scope isolates code, embeds and custom tasks while allowing parser-confirmed emphasis", () => {
	const value = "- [x] **yes** ==hi== [[Note]]\n- [/] other\n`**code** ==no== [[no]]`\n```md\n- [ ] no\n**no**\n```\n\\**escape** ![[image]] *italic*";
	assert.deepEqual(scanComposerSyntax(value).ranges.map(range => range.kind).sort(), ["bold", "highlight", "link", "task", "italic", "italic"].sort());
	assert.equal(runComposerCommand("`code`", 1, 5, "bold").type, "unavailable");
	assert.deepEqual(scanComposerSyntax("* * *\n===ambiguous===\n1234567890. not a list").ranges, []);
});

test("nested inline reveal includes outer syntax but not unrelated siblings", () => {
	const value = "**outer ==inside==** and **other**";
	const ranges = scanComposerSyntax(value).ranges;
	const selected = [{ from: 12, to: 12 }];
	const revealed = ranges.filter(range => revealComposerRange(range, selected));
	assert.deepEqual(revealed.map(range => value.slice(range.from, range.to)).sort(), ["**outer ==inside==**", "==inside=="].sort());
});

test("toolbar normalization keeps hidden positions and fills missing actions without duplicates", () => {
	const defaults = normalizeComposerToolbar(undefined);
	assert.deepEqual(defaults.order, [...COMPOSER_ACTIONS]);
	assert.deepEqual(defaults.hidden, ["bold", "highlight", "link", "numbered-list"]);
	const saved = normalizeComposerToolbar({ order: ["bold", "tag", "bold", "bad"], hidden: [] });
	assert.equal(saved.order[0], "bold");
	assert.equal(saved.order.length, 9);
	assert.deepEqual(saved.hidden, []);
	const hidden = normalizeComposerToolbar({ ...saved, hidden: ["bold"] });
	assert.deepEqual(hidden.order, saved.order);
	assert.deepEqual(normalizeComposerToolbar({ ...hidden, hidden: [] }), saved);
});

test("Bold toggles original underscore delimiters without rewriting other formatted parts", () => {
	assert.deepEqual(apply("__bold__", 2, 6, "bold"), { value: "bold", anchor: 0, head: 4 });
	assert.deepEqual(apply("__bold__", 8, 0, "bold"), { value: "bold", anchor: 4, head: 0 });
	assert.equal(runComposerCommand("__bold__", 4, 4, "bold").type, "unchanged");
	assert.equal(apply("__one__\ntwo", 0, 11, "bold").value, "__one__\n**two**");
});

test("format commands protect new inline boundaries, link targets and source-first parents", () => {
	for (const text of ["*italic* tail", "_italic_ tail", "~~strike~~ tail"]) {
		for (const command of ["bold", "highlight"] as const) {
			assert.equal(runComposerCommand(text, 3, text.length, command).type, "unavailable");
			assert.equal(runComposerCommand(text, text.length, 3, command).type, "unavailable");
			assert.equal(runComposerCommand(text, 3, 5, command).type, "changed");
		}
	}
	for (const text of ["[[Note]]", "[[Note|Alias]]", "[[Note#Heading]]", "[text](url)", "`code`", "# **heading**", "> ==quote==", "- [-] **custom**", "$$x$$", "https://x/#tag"]) {
		for (const command of ["bold", "highlight"] as const) assert.equal(runComposerCommand(text, 0, text.length, command).type, "unavailable", text);
	}
});

test("link command rejects crossing newly supported inline markers in either direction", () => {
	for (const value of ["_italic_ tail", "__bold__ tail", "~~strike~~ tail"]) {
		assert.equal(runComposerCommand(value, 3, value.length, "link").type, "unavailable");
		assert.equal(runComposerCommand(value, value.length, 3, "link").type, "unavailable");
		assert.equal(runComposerCommand(value, 3, 5, "link").type, "changed");
	}
	assert.equal(runComposerCommand("__bold__", 1, 1, "link").type, "unavailable");
});

test("empty list conversions replace the parsed marker and remain idempotent", () => {
	for (const value of ["-", "+", "*", "1.", "3)", "  12.", "- [ ]", "+ [X]"]) {
		const syntax = scanComposerSyntax(value).ranges.find(r => r.list);
		assert.ok(syntax);
		const indent = value.slice(0, syntax.from);
		for (const [command, marker] of [["task", "- [ ] "], ["bullet", "- "], ["ordered", "1. "]] as const) {
			const result = runComposerCommand(value, value.length, value.length, command);
			if (command === "task" && syntax.task) { assert.equal(result.type, "unchanged"); continue; }
			assert.equal(result.type, "changed");
			if (result.type !== "changed") continue;
			assert.equal(result.edit.value, indent + marker);
			assert.equal(runComposerCommand(result.edit.value, result.edit.head, result.edit.head, command).type, "unchanged");
		}
	}
});
