import test from "node:test";
import assert from "node:assert/strict";
import { scanComposerSyntax, revealComposerRange } from "../src/utils/composerSyntax";
import { composerMarkdownFixtures } from "./fixtures/composerMarkdown";
import { parseMemoTags } from "../src/utils/markdown";
import { TreeFragment } from "@lezer/common";

for (const fixture of composerMarkdownFixtures) test(`Markdown scope: ${fixture.name}`, () => {
	const syntax = scanComposerSyntax(fixture.text);
	assert.deepEqual(syntax.ranges.map(r => r.kind), fixture.kinds);
	for (const range of syntax.ranges) {
		assert.ok(range.from >= 0 && range.to <= fixture.text.length);
		assert.ok(range.contentFrom >= range.from && range.contentTo <= range.to);
	}
});

test("block markers use exact numeric UTF-16 positions, separator and all selection ranges", () => {
	for (const value of ["- 内容", "12) 内容", "  - [X] 内容", "1.\t[ ]\t内容"]) {
		const range = scanComposerSyntax(value).ranges[0];
		for (let pos = 0; pos <= value.length; pos++) {
			assert.equal(revealComposerRange(range, [{ from: pos, to: pos }]), range.markers.some(m => m.from < pos && m.to >= pos), `${value}: ${pos}`);
		}
		for (const marker of range.markers) {
			assert.equal(revealComposerRange(range, [{ from: marker.to, to: marker.to + 1 }]), false);
			assert.equal(revealComposerRange(range, [{ from: marker.from, to: marker.to }]), true);
			assert.equal(revealComposerRange(range, [{ from: value.length, to: value.length }, marker]), true);
		}
	}
});

test("numbering follows actual containers including loose, nested, tab, wide and empty items", () => {
	for (const [text, numbers] of [
		["1. a\n1. b\n1. c", [1, 2, 3]],
		["3. a\n9. b\n2. c", [3, 4, 5]],
		["1. a\n\n1. b\n\n1. c", [1, 2, 3]],
		["12. a\n    3. child\n    9. child\n1. parent", [12, 3, 4, 13]],
		["1. a\n\t1. child\n\t1. child\n1. parent", [1, 1, 2, 2]],
		["3. a\n   continuation\nlazy\n1.\n1. c", [3, 4, 5]],
		["1. a\n1) b\n1) c", [1, 1, 2]],
		["a paragraph\n3. not a list", []],
	] as const) assert.deepEqual(scanComposerSyntax(text).ranges.filter(r => r.list).map(r => r.list!.display), numbers, text);
});

test("inline reveal includes whole nodes and ancestors but preserves unrelated siblings", () => {
	const text = "**outer ==inside==** and *other*";
	const ranges = scanComposerSyntax(text).ranges;
	assert.deepEqual(ranges.filter(r => revealComposerRange(r, [{ from: 12, to: 12 }])).map(r => r.kind), ["bold", "highlight"]);
	for (const range of ranges) {
		assert.equal(revealComposerRange(range, [{ from: range.from, to: range.from }]), true);
		assert.equal(revealComposerRange(range, [{ from: range.to, to: range.to }]), true);
		assert.equal(revealComposerRange(range, [{ from: range.to, to: range.to + 1 }]), false);
	}
});

test("link labels are literal and targets do not acquire URL/tag/format decorations", () => {
	for (const [text, label] of [["[[path/Note#Heading]]", "path/Note#Heading"], ["[[Note#^id|**literal**]]", "**literal**"], ["[label](https://x/a_(b)#tag)", "label"]]) {
		const ranges = scanComposerSyntax(text).ranges;
		assert.equal(ranges.length, 1);
		assert.equal(text.slice(ranges[0].contentFrom, ranges[0].contentTo), label);
	}
	const text = "https://x/a_(b)). #中文/标签 #123 #tail,";
	const ranges = scanComposerSyntax(text).ranges;
	assert.equal(text.slice(ranges[0].from, ranges[0].to), "https://x/a_(b)");
	assert.deepEqual(ranges.filter(r => r.kind === "tag").map(r => text.slice(r.from + 1, r.to)), parseMemoTags(text));
});

test("source-first overlap removes outer formatting without suppressing unrelated prose", () => {
	for (const source of ["$x$", "![[image]]", "%%comment%%", "<span>"]) {
		const text = `**before ${source} after**\n\n**sibling**`;
		assert.deepEqual(scanComposerSyntax(text).ranges.map(r => text.slice(r.from, r.to)), ["**sibling**"], source);
	}
});

test("CJK candidates exclude list continuations, code, URL and unsupported mixed lines", () => {
	const text = "普通中文正文\n**粗体正文**\n\n- 列表\n  续行\n\n混合 `code`\nhttps://x\n\n> 中文引用";
	assert.deepEqual(scanComposerSyntax(text).proseLines.map(r => text.slice(r.from, r.to)), ["普通中文正文", "**粗体正文**"]);
});

test("incremental parser agrees with fresh parsing across marker, fence and link boundary edits", () => {
	for (const fixture of composerMarkdownFixtures) {
		let text: string = fixture.text;
		let syntax = scanComposerSyntax(text);
		for (const insert of ["```\n", "[", "**", "你😀", "\n\n", "%%", "]]", "\n~~~"]) {
			const from = Math.floor(text.length / 3), to = Math.min(text.length, from + 3);
			const fragments = TreeFragment.applyChanges(TreeFragment.addTree(syntax.tree), [{ fromA: from, toA: to, fromB: from, toB: from + insert.length }]);
			text = text.slice(0, from) + insert + text.slice(to);
			syntax = scanComposerSyntax(text, fragments);
			const fresh = scanComposerSyntax(text);
			assert.deepEqual(syntax.ranges, fresh.ranges, fixture.name);
			assert.deepEqual(syntax.sourceRanges, fresh.sourceRanges, fixture.name);
			assert.deepEqual(syntax.proseLines, fresh.proseLines, fixture.name);
		}
	}
});
