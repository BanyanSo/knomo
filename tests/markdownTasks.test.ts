import test from "node:test";
import assert from "node:assert/strict";

import {
	getMarkdownTaskLines,
	replaceMarkdownTaskMarkerByIndex,
	toggleMarkdownTaskMarkerByIndex,
} from "../src/utils/markdownTasks";

test("indexes Markdown task lines outside fenced code blocks", () => {
	const content = [
		"- [ ] first",
		"```",
		"- [ ] code",
		"```",
		"  - [-] nested",
		"1. [X] ordered",
	].join("\n");

	const tasks = getMarkdownTaskLines(content);

	assert.deepEqual(tasks.map((task) => ({
		index: task.index,
		lineIndex: task.lineIndex,
		listMarker: task.listMarker,
		marker: task.marker,
		body: task.body,
	})), [
		{ index: 0, lineIndex: 0, listMarker: "-", marker: " ", body: "first" },
		{ index: 1, lineIndex: 4, listMarker: "-", marker: "-", body: "nested" },
		{ index: 2, lineIndex: 5, listMarker: "1.", marker: "X", body: "ordered" },
	]);
});

test("toggles only the requested task by task index", () => {
	const content = "- [ ] first\n- [ ] second\n- [x] third";

	const result = toggleMarkdownTaskMarkerByIndex(content, 1);

	assert.equal(result?.content, "- [ ] first\n- [x] second\n- [x] third");
	assert.equal(result?.marker, "x");
});

test("toggles completed and cancelled tasks back to unchecked", () => {
	assert.equal(toggleMarkdownTaskMarkerByIndex("- [x] done", 0)?.content, "- [ ] done");
	assert.equal(toggleMarkdownTaskMarkerByIndex("- [X] done", 0)?.content, "- [ ] done");
	assert.equal(toggleMarkdownTaskMarkerByIndex("- [-] cancelled", 0)?.content, "- [ ] cancelled");
});

test("preserves indentation, list marker, task body, and other Markdown", () => {
	const content = "\t1) [ ] keep **format** #tag";

	const result = replaceMarkdownTaskMarkerByIndex(content, 0, "x");

	assert.equal(result, "\t1) [x] keep **format** #tag");
});

test("does not rewrite task-like text inside fenced code blocks", () => {
	const content = [
		"```markdown",
		"- [ ] code",
		"```",
		"- [ ] real",
	].join("\n");

	const result = toggleMarkdownTaskMarkerByIndex(content, 0);

	assert.equal(result?.content, "```markdown\n- [ ] code\n```\n- [x] real");
	assert.equal(toggleMarkdownTaskMarkerByIndex(content, 1), null);
});
