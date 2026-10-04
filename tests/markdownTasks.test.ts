import test from "node:test";
import assert from "node:assert/strict";

import {
	getMarkdownTaskLines,
} from "../src/utils/markdownTasks";

test("Things 使用 Markdown 结构排除代码与 HTML，并保留引用任务位置", () => {
	const valid = ["- [ ]", "* [x] yes", "+ [X] yes", "1. [-] stop", "1) [ ] yes", "> - [ ] quote", "> [!note]\n> - [x] callout", "- parent\n  - [-] nested"];
	for (const text of valid) assert.equal(getMarkdownTaskLines(text).length, 1, text);
	const excluded = ["[ ]", "text [ ]", "- \\[ ] escaped", "`- [ ] code`", "`span\n    - [ ] code\nend`", "    - [ ] code", "\t- [ ] code", "```md\n- [ ] code\n```", "~~~\n- [ ] code", "> ```\n> - [ ] code\n> ```", "- parent\n  ```\n  - [ ] code\n  ```", "<!--\n- [ ] comment\n-->", "<div>\n- [ ] html\n</div>", "<input type='checkbox'>", "- [ ]body", "- [?] unsupported", "- [/] unsupported", "- [ ](link)"];
	for (const text of excluded) assert.deepEqual(getMarkdownTaskLines(text), [], text);
	const mixed = "<!--\n- [ ] fake\n-->\n\n> - [ ] real\n>   - [X] nested";
	const tasks = getMarkdownTaskLines(mixed);
	assert.deepEqual(tasks.map(task => [task.lineIndex, task.markerStart, task.marker]), [[4, 4, " "], [5, 6, "X"]]);
});

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
