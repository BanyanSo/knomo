import assert from "node:assert/strict";
import test from "node:test";
import { parseMarkdownReferences } from "../src/utils/markdownReferences";
import { stripTrailingWikiLink } from "../src/utils/references";

test("Markdown 引用保留编码、括号、标题和错误原文，跳过代码、注释与图片", () => {
	const content = '`[[skip#^id]]` <!-- [[skip#^id]] -->\n```md\n[[skip#^id]]\n```\n'
		+ '![image](image.png) ![[image.png]] [alias](../A%20B\\(1\\).md#%5Ex "title") [[Page#Heading|custom]] [broken](bad';
	const links = parseMarkdownReferences(content);
	assert.deepEqual(links.map((link) => [link.target, link.valid]), [
		["../A%20B(1).md#%5Ex", true], ["Page#Heading", true], ["bad", false],
	]);
	for (const link of links) assert.equal(content.slice(link.startOffset, link.startOffset! + link.raw.length), link.raw);
});

test("来源卡片只移走展示的正文链接，不移走代码、引用或其他链接", () => {
	const raw = "[[Daily#^id|custom]]";
	assert.equal(stripTrailingWikiLink(`\`${raw}\`\n> ${raw}\nsource ${raw} [[Other#^id]]`),
		`\`${raw}\`\n> ${raw}\nsource [[Other#^id]]`);
});
