import test from "node:test";
import assert from "node:assert/strict";

import { MarkdownBlockService } from "../src/services/MarkdownBlockService";
import type { MemoRecord } from "./helpers/memoViewFixture";
import { matchesDailyNotePath, parseDailyNoteDateFromPath } from "../src/utils/dailyNotes";
import { hashMemoContent, hashText } from "../src/utils/hash";
import { isSupportedMemoImage } from "../src/utils/markdown";
import {
	buildQuoteCreatedMemoContent,
	formatCreatedAtAlias,
	formatMemoIdAlias,
	stripTrailingWikiLink,
	withCreatedAtAlias,
	withMemoIdAlias,
} from "../src/utils/references";
import { ensureObsidianStub } from "./helpers/obsidianStub";

const service = new MarkdownBlockService();

test("builds a single-line memo block", () => {
	assert.equal(service.buildMemoBlock("第一行", "12:00:00"), "- 12:00:00 第一行");
});

test("builds a three-line memo block and preserves hard line breaks", () => {
	assert.equal(
		service.buildMemoBlock("第一行\n第二行\n第三行", "12:00:00"),
		"- 12:00:00 第一行\n\t第二行\n\t第三行",
	);
});

test("builds list-leading memo content as a nested Markdown block", () => {
	assert.equal(
		service.buildMemoBlock("- 第一项\n- 第二项", "12:00:00"),
		"- 12:00:00\n\t- 第一项\n\t- 第二项",
	);
	assert.equal(
		service.buildMemoBlock("1. 第一项\n2. 第二项", "12:00:00"),
		"- 12:00:00\n\t1. 第一项\n\t2. 第二项",
	);
});

test("builds task-list-leading memo content as nested memo content", () => {
	assert.equal(
		service.buildMemoBlock("- [ ] 第一项\n- [x] 第二项\n- [-] 第三项", "12:00:00"),
		"- 12:00:00\n\t- [ ] 第一项\n\t- [x] 第二项\n\t- [-] 第三项",
	);
});

test("parses list-leading memo content from a detached timestamp line", () => {
	const parsed = service.parseMemoBlock([
		"- 12:00:00",
		"  - 第一项",
		"  - 第二项 ^abc123",
	], 0);

	assert.ok(parsed);
	assert.equal(parsed.blockId, "abc123");
	assert.equal(parsed.content, "- 第一项\n- 第二项");
});

test("parses tab-indented memo continuation lines", () => {
	const parsed = service.parseMemoBlock([
		"- 12:00:00 第一行",
		"\t- 子项",
		"\t\t- 嵌套子项 ^abc123",
	], 0);

	assert.ok(parsed);
	assert.equal(parsed.blockId, "abc123");
	assert.equal(parsed.content, "第一行\n- 子项\n\t- 嵌套子项");
});

test("does not parse an empty detached timestamp line as a memo", () => {
	assert.equal(service.parseMemoBlock(["- 12:00:00"], 0), null);
});

test("parses a three-line memo block with tags and links", () => {
	const parsed = service.parseMemoBlock(
		[
			"- 12:00:00 第一行",
			"  第二行包含 #tag",
			"  第三行包含 [[链接]]",
		],
		0,
	);

	assert.ok(parsed);
	assert.equal(parsed.time, "12:00:00");
	assert.equal(parsed.content, "第一行\n第二行包含 #tag\n第三行包含 [[链接]]");
	assert.deepEqual(parsed.tags, ["tag"]);
	assert.deepEqual(parsed.links, [
		{
			target: "链接",
			displayText: null,
			syntax: "wiki_link",
		},
	]);
});

test("parses bare web URLs without duplicating wrapped links", () => {
	const metadata = service.parseMemoMetadata(
		"裸链接 https://example.com/docs?q=1，括号 (http://example.org/a_(b)). "
		+ "Markdown [官网](https://knomo.app) 图片 ![封面](https://example.com/a.png) www.example.com",
	);

	assert.deepEqual(metadata.links, [
		{
			target: "https://knomo.app",
			displayText: "官网",
			syntax: "markdown_link",
		},
		{
			target: "https://example.com/docs?q=1",
			displayText: null,
			syntax: "url",
		},
		{
			target: "http://example.org/a_(b)",
			displayText: null,
			syntax: "url",
		},
	]);
});

test("parses memo time in HH:mm format", () => {
	const parsed = service.parseMemoBlock(["- 18:30 内容"], 0);

	assert.ok(parsed);
	assert.equal(parsed.time, "18:30");
	assert.equal(parsed.content, "内容");
});

test("parses memo time in HH:mm:ss format", () => {
	const parsed = service.parseMemoBlock(["- 18:30:12 内容"], 0);

	assert.ok(parsed);
	assert.equal(parsed.time, "18:30:12");
	assert.equal(parsed.content, "内容");
});

test("parses multiple memos in the same minute and second", () => {
	const blocks = service.parseMemoBlocks([
		"- 18:30 同一分钟第一条",
		"- 18:30 同一分钟第二条",
		"- 18:30:12 同一秒第一条",
		"- 18:30:12 同一秒第二条",
	].join("\n"));

	assert.deepEqual(blocks.map((block) => block.content), [
		"同一分钟第一条",
		"同一分钟第二条",
		"同一秒第一条",
		"同一秒第二条",
	]);
});

test("parses Obsidian image embeds", () => {
	const parsed = service.parseMemoBlock(["- 12:00:00 第一行", "  第二行 ![[Assets/a.png]]"], 0);

	assert.ok(parsed);
	assert.deepEqual(parsed.images, [
		{
			path: "Assets/a.png",
			altText: "",
			syntax: "obsidian_embed",
		},
	]);
	assert.deepEqual(parsed.links, []);
});

test("decodes percent-encoded Obsidian image embed paths", () => {
	const parsed = service.parseMemoBlock(["- 12:00:00 图片 ![[Assets/a%20b%20c.jpg|300]]"], 0);

	assert.ok(parsed);
	assert.deepEqual(parsed.images, [
		{
			path: "Assets/a b c.jpg",
			altText: "",
			syntax: "obsidian_embed",
		},
	]);
});

test("parses supported Obsidian image embeds", () => {
	const parsed = service.parseMemoBlock([
		"- 12:00:00 图片 ![[Assets/a.avif]] ![[Assets/a.bmp]] ![[Assets/a.gif]] ![[Assets/a.jpeg]]",
		"  ![[Assets/a.jpg]] ![[Assets/a.png]] ![[Assets/a.svg]] ![[Assets/a.webp]] ![[Assets/a.WEBP|300]]",
	], 0);

	assert.ok(parsed);
	assert.deepEqual(parsed.images.map((image) => image.path), [
		"Assets/a.avif",
		"Assets/a.bmp",
		"Assets/a.gif",
		"Assets/a.jpeg",
		"Assets/a.jpg",
		"Assets/a.png",
		"Assets/a.svg",
		"Assets/a.webp",
		"Assets/a.WEBP",
	]);
});

test("does not treat Obsidian block embeds as images", () => {
	const parsed = service.parseMemoBlock(["- 12:00:00 引用 ![[2026-05-18#^5i3h99]]"], 0);

	assert.ok(parsed);
	assert.deepEqual(parsed.images, []);
});

test("rejects stale Obsidian block embed image metadata", () => {
	assert.equal(isSupportedMemoImage({
		path: "2026-05-18#^5i3h99",
		altText: "",
		syntax: "obsidian_embed",
	}), false);
	assert.equal(isSupportedMemoImage({
		path: "Assets/a.WEBP|300",
		altText: "",
		syntax: "obsidian_embed",
	}), true);
});

test("parses Markdown images", () => {
	const parsed = service.parseMemoBlock(["- 12:00:00 第一行", "  第二行 ![alt](Assets/a.png)"], 0);

	assert.ok(parsed);
	assert.deepEqual(parsed.images, [
		{
			path: "Assets/a.png",
			altText: "alt",
			syntax: "markdown_image",
		},
	]);
});

test("decodes percent-encoded local Markdown image paths", () => {
	const parsed = service.parseMemoBlock(["- 12:00:00 图片 ![](Pasted%20image%2020260606110900.png)"], 0);

	assert.ok(parsed);
	assert.deepEqual(parsed.images, [
		{
			path: "Pasted image 20260606110900.png",
			altText: "",
			syntax: "markdown_image",
		},
	]);
});

test("keeps remote Markdown image URLs percent-encoded", () => {
	const metadata = service.parseMemoMetadata("![remote](https://example.com/Pasted%20image%2020260606110900.png)");

	assert.deepEqual(metadata.images, [
		{
			path: "https://example.com/Pasted%20image%2020260606110900.png",
			altText: "remote",
			syntax: "markdown_image",
		},
	]);
});

test("treats numeric-only Markdown image labels as sizes for local and remote images", () => {
	const metadata = service.parseMemoMetadata([
		"![200](Assets/local.png)",
		"![ 320 ](https://example.com/remote.png)",
		"![图 200](Assets/labeled.png)",
	].join(" "));

	assert.deepEqual(metadata.images, [
		{
			path: "Assets/local.png",
			altText: "",
			syntax: "markdown_image",
		},
		{
			path: "https://example.com/remote.png",
			altText: "",
			syntax: "markdown_image",
		},
		{
			path: "Assets/labeled.png",
			altText: "图 200",
			syntax: "markdown_image",
		},
	]);
});

test("ignores blockId on the first line", () => {
	const parsed = service.parseMemoBlock(["- 12:00:00 第一行 ^abc123", "  第二行"], 0);

	assert.ok(parsed);
	assert.equal(parsed.blockId, "abc123");
	assert.equal(parsed.content, "第一行\n第二行");
});

test("ignores blockId on the last effective content line", () => {
	const parsed = service.parseMemoBlock(["- 12:00:00 第一行", "  第二行 ^abc123"], 0);

	assert.ok(parsed);
	assert.equal(parsed.blockId, "abc123");
	assert.equal(parsed.content, "第一行\n第二行");
});

test("contentSnapshot has no time prefix or blockId", () => {
	const parsed = service.parseMemoBlock(["- 12:00:00 第一行 ^abc123"], 0);

	assert.ok(parsed);
	assert.equal(parsed.content, "第一行");
});

test("hash ignores blockId", () => {
	assert.equal(hashMemoContent("第一行"), hashMemoContent("第一行 ^abc123"));
});

test("unindented paragraphs do not belong to the previous memo", () => {
	const parsed = service.parseMemoBlock(["- 12:00:00 第一行", "普通段落", "  不是 continuation"], 0);

	assert.ok(parsed);
	assert.equal(parsed.endLine, 0);
	assert.equal(parsed.content, "第一行");
});

test("a new Markdown heading stops memo parsing", () => {
	const parsed = service.parseMemoBlock(["- 12:00:00 第一行", "  第二行", "## Next", "  不是 continuation"], 0);

	assert.ok(parsed);
	assert.equal(parsed.endLine, 1);
	assert.equal(parsed.content, "第一行\n第二行");
});

test("inserts memo under an existing heading at the top", () => {
	const content = "# 2026-05-14\n\n## Knomo\n\n- 11:00:00 旧 memo\n\n## Next";
	const block = service.buildMemoBlock("新 memo", "12:00:00");

	assert.equal(
		service.insertMemoBlock(content, {
			heading: "## Knomo",
			block,
			position: "top",
			createHeadingIfMissing: false,
		}),
		"# 2026-05-14\n\n## Knomo\n\n- 12:00:00 新 memo\n- 11:00:00 旧 memo\n\n## Next",
	);
});

test("inserts memo under an existing heading at the bottom", () => {
	const content = "# 2026-05-14\n\n## Knomo\n\n- 11:00:00 旧 memo\n\n## Next";
	const block = service.buildMemoBlock("新 memo", "12:00:00");

	assert.equal(
		service.insertMemoBlock(content, {
			heading: "## Knomo",
			block,
			position: "bottom",
			createHeadingIfMissing: false,
		}),
		"# 2026-05-14\n\n## Knomo\n\n- 11:00:00 旧 memo\n- 12:00:00 新 memo\n\n## Next",
	);
});

test("inserts memo at the bottom before preserving multiple trailing heading blank lines", () => {
	const content = "# 2026-05-14\n\n## Knomo\n\n- 11:00:00 旧 memo\n\n\n## Next";
	const block = service.buildMemoBlock("新 memo", "12:00:00");

	assert.equal(
		service.insertMemoBlock(content, {
			heading: "## Knomo",
			block,
			position: "bottom",
			createHeadingIfMissing: false,
		}),
		"# 2026-05-14\n\n## Knomo\n\n- 11:00:00 旧 memo\n- 12:00:00 新 memo\n\n\n## Next",
	);
});

test("inserts memo into an empty heading before preserving existing blank lines", () => {
	const content = "# 2026-05-14\n\n## Knomo\n\n\n## Next";
	const block = service.buildMemoBlock("新 memo", "12:00:00");

	assert.equal(
		service.insertMemoBlock(content, {
			heading: "## Knomo",
			block,
			position: "bottom",
			createHeadingIfMissing: false,
		}),
		"# 2026-05-14\n\n## Knomo\n- 12:00:00 新 memo\n\n\n## Next",
	);
});

test("inserts memo between adjacent headings", () => {
	const content = "# 2026-05-14\n\n## Knomo\n## Next";
	const block = service.buildMemoBlock("新 memo", "12:00:00");

	assert.equal(
		service.insertMemoBlock(content, {
			heading: "## Knomo",
			block,
			position: "bottom",
			createHeadingIfMissing: false,
		}),
		"# 2026-05-14\n\n## Knomo\n- 12:00:00 新 memo\n## Next",
	);
});

test("creates heading when missing and allowed", () => {
	const block = service.buildMemoBlock("新 memo", "12:00:00");

	assert.equal(
		service.insertMemoBlock("# 2026-05-14", {
			heading: "## Knomo",
			block,
			position: "bottom",
			createHeadingIfMissing: true,
		}),
		"# 2026-05-14\n\n## Knomo\n- 12:00:00 新 memo",
	);
});

test("throws when heading is missing and creation is disabled", () => {
	const block = service.buildMemoBlock("新 memo", "12:00:00");

	assert.throws(() => {
		service.insertMemoBlock("# 2026-05-14", {
			heading: "## Knomo",
			block,
			position: "bottom",
			createHeadingIfMissing: false,
		});
	}, /Heading not found/);
});

test("daily note creation uses Daily Notes interface template when missing", async () => {
	const { DailyNoteService } = await loadDailyNoteService();
	const { TFile } = await import("obsidian");
	const files = new Map<string, InstanceType<typeof TFile>>();
	const contents = new Map<string, string>();
	const app = {
		vault: {
			getAbstractFileByPath: (path: string) => files.get(path) ?? null,
		},
	};
	let interfaceCalls = 0;
	const restoreWindow = setTestWindow({
		__knomoCreateDailyNote: async (date: { format: (format: string) => string }) => {
			interfaceCalls += 1;
			const filename = date.format("YYYY-MM-DD");
			const path = `Daily/${filename}.md`;
			const file = files.get(path) ?? Object.assign(new TFile(), {
				path,
				basename: filename,
				extension: "md",
			});
			files.set(path, file);
			contents.set(path, `# ${filename}\n${filename}`);
			return file;
		},
	});
	try {
		const dailyNoteService = new DailyNoteService(
			app as never,
			{
				getConfig: () => ({ folder: "Daily", format: "YYYY-MM-DD" }),
				loadConfig: async () => ({ folder: "Daily", format: "YYYY-MM-DD" }),
			},
		);

		const file = await dailyNoteService.getOrCreateDailyNoteForDate(new Date("2026-05-14T10:00:00"));

		assert.equal(file.path, "Daily/2026-05-14.md");
		assert.equal(interfaceCalls, 1);
		assert.equal(contents.get("Daily/2026-05-14.md"), "# 2026-05-14\n2026-05-14");
	} finally {
		restoreWindow();
	}
});

test("daily note creation returns existing file without applying template", async () => {
	const { DailyNoteService } = await loadDailyNoteService();
	const { TFile } = await import("obsidian");
	const existingFile = Object.assign(new TFile(), {
		path: "Daily/2026-05-14.md",
		basename: "2026-05-14",
		extension: "md",
	});
	let createCalls = 0;
	const dailyNoteService = new DailyNoteService(
		{
			vault: {
				getAbstractFileByPath: (path: string) => path === existingFile.path ? existingFile : null,
				create: async () => {
					createCalls += 1;
					throw new Error("should not create");
				},
			},
		} as never,
		{
			getConfig: () => ({ folder: "Daily", format: "YYYY-MM-DD" }),
			loadConfig: async () => ({ folder: "Daily", format: "YYYY-MM-DD" }),
		},
	);

	const file = await dailyNoteService.getOrCreateDailyNoteForDate(new Date("2026-05-14T10:00:00"));

	assert.equal(file, existingFile);
	assert.equal(createCalls, 0);
});

test("daily note creation falls back when Daily Notes interface fails", async () => {
	const { DailyNoteService } = await loadDailyNoteService();
	const { TFile } = await import("obsidian");
	const files = new Map<string, InstanceType<typeof TFile>>();
	const restoreWindow = setTestWindow(undefined);
	try {
		const dailyNoteService = new DailyNoteService(
			{
				vault: {
					getAbstractFileByPath: (path: string) => files.get(path) ?? null,
					createFolder: async () => undefined,
					create: async (path: string) => {
						const file = Object.assign(new TFile(), {
							path,
							basename: path.split("/").pop()?.replace(/\.md$/, "") ?? path,
							extension: "md",
						});
						files.set(path, file);
						return file;
					},
				},
			} as never,
			{
				getConfig: () => ({ folder: "Daily", format: "YYYY-MM-DD" }),
				loadConfig: async () => ({ folder: "Daily", format: "YYYY-MM-DD" }),
			},
		);

		const file = await dailyNoteService.getOrCreateDailyNoteForDate(new Date("2026-05-14T10:00:00"));

		assert.equal(file.path, "Daily/2026-05-14.md");
	} finally {
		restoreWindow();
	}
});

test("daily note creation still errors when Daily Notes core plugin is disabled", async () => {
	const { DailyNoteService } = await loadDailyNoteService();
	const dailyNoteService = new DailyNoteService(
		{
			vault: {
				create: async () => {
					throw new Error("should not create");
				},
			},
		} as never,
		{
			getConfig: () => null,
			loadConfig: async () => null,
		},
	);

	await assert.rejects(
		() => dailyNoteService.getOrCreateDailyNoteForDate(new Date("2026-05-14T10:00:00")),
		/Enable the Daily Notes core plugin in Obsidian settings/,
	);
});

test("appends blockId to a single-line memo block", () => {
	assert.equal(
		service.appendBlockIdToMemoBlock("- 12:00:00 第一行", "abc123"),
		"- 12:00:00 第一行 ^abc123",
	);
});

test("appends blockId to the last effective line of a multiline memo block", () => {
	assert.equal(
		service.appendBlockIdToMemoBlock("- 12:00:00 第一行\n  第二行\n  ", "abc123"),
		"- 12:00:00 第一行\n  第二行 ^abc123\n  ",
	);
});

test("appends blockId to list-leading memo content", () => {
	assert.equal(
		service.buildMemoBlockWithBlockId("- 第一项\n- 第二项", "12:00:00", "abc123"),
		"- 12:00:00\n\t- 第一项\n\t- 第二项 ^abc123",
	);
});

test("deletes a complete memo block without deleting the next memo", () => {
	const content = "- 12:00:00 第一行\n  第二行\n- 13:00:00 下一条";

	assert.equal(service.deleteMemoBlock(content, 0), "- 13:00:00 下一条");
});

test("parses all memo blocks in content", () => {
	const blocks = service.parseMemoBlocks("- 12:00:00 第一行\n  第二行\n普通段落\n- 13:00:00 下一条");

	assert.equal(blocks.length, 2);
	assert.equal(blocks[0].content, "第一行\n第二行");
	assert.equal(blocks[1].content, "下一条");
});

test("parses daily note dates from custom formats and folders", () => {
	const date = parseDailyNoteDateFromPath("Daily/2026/05/17.md", {
		folder: "Daily",
		format: "YYYY/MM/DD",
	});

	assert.ok(date);
	assert.equal(date.getFullYear(), 2026);
	assert.equal(date.getMonth(), 4);
	assert.equal(date.getDate(), 17);
	assert.equal(matchesDailyNotePath("Daily/2026/05/17.md", { folder: "Daily", format: "YYYY/MM/DD" }), true);
	assert.equal(matchesDailyNotePath("Memos/Memos-2026-05.md", { folder: "Daily", format: "YYYY/MM/DD" }), false);
});

test("parses daily note dates from common Moment format tokens", () => {
	const weekdayDate = parseDailyNoteDateFromPath("Daily/2026-05-17 Sunday.md", {
		folder: "Daily",
		format: "YYYY-MM-DD dddd",
	});
	const monthNameDate = parseDailyNoteDateFromPath("Daily/May 17, 2026.md", {
		folder: "Daily",
		format: "MMMM D, YYYY",
	});
	const literalDate = parseDailyNoteDateFromPath("Journal/2026/05/17.md", {
		folder: null,
		format: "[Journal]/YYYY/MM/DD",
	});

	assert.ok(weekdayDate);
	assert.equal(weekdayDate.getFullYear(), 2026);
	assert.equal(weekdayDate.getMonth(), 4);
	assert.equal(weekdayDate.getDate(), 17);
	assert.ok(monthNameDate);
	assert.equal(monthNameDate.getMonth(), 4);
	assert.ok(literalDate);
	assert.equal(literalDate.getDate(), 17);
});

test("daily notes provider uses Obsidian default format when enabled runtime options are empty", async () => {
	const { DailyNotesProvider } = await loadDailyNotesProvider();
	const provider = new DailyNotesProvider(createDailyNotesApp({
		internalPlugins: {
			getPluginById: () => ({
				enabled: true,
				instance: { options: {} },
			}),
		},
	}) as never);

	assert.deepEqual(provider.getConfig(), {
		folder: null,
		format: "YYYY-MM-DD",
	});
});

test("daily notes provider keeps configured folder when runtime format is omitted", async () => {
	const { DailyNotesProvider } = await loadDailyNotesProvider();
	const provider = new DailyNotesProvider(createDailyNotesApp({
		internalPlugins: {
			getPluginById: () => ({
				enabled: true,
				instance: { options: { folder: "Daily Notes" } },
			}),
		},
	}) as never);

	assert.deepEqual(provider.getConfig(), {
		folder: "Daily Notes",
		format: "YYYY-MM-DD",
	});
});

test("daily notes provider treats explicit disabled runtime as unavailable even when config exists", async () => {
	const { DailyNotesProvider } = await loadDailyNotesProvider();
	let readCount = 0;
	const provider = new DailyNotesProvider(createDailyNotesApp({
		internalPlugins: {
			getPluginById: () => ({ enabled: false }),
		},
		configFile: "{\"folder\":\"Daily\",\"format\":\"YYYY-MM-DD\"}",
		onRead: () => {
			readCount += 1;
		},
	}) as never);

	assert.equal(await provider.loadConfig(), null);
	assert.equal(readCount, 0);
});

test("daily notes provider can read config file fallback with Obsidian default format", async () => {
	const { DailyNotesProvider } = await loadDailyNotesProvider();
	const provider = new DailyNotesProvider(createDailyNotesApp({
		internalPlugins: {},
		configFile: "{\"folder\":\"Journal\"}",
	}) as never);

	assert.deepEqual(await provider.loadConfig(), {
		folder: "Journal",
		format: "YYYY-MM-DD",
	});
});

	test("puts new content first with wiki link on same line, blockquote next line", () => {
		assert.equal(
			buildQuoteCreatedMemoContent(
				"> 这是引用 memo 内容\n\n这是新内容 xxxxx。",
				"> 这是引用 memo 内容",
				"[[Daily/2026-05-17#^abc123|memo-1]]",
			),
			"这是新内容 xxxxx。 [[Daily/2026-05-17#^abc123|memo-1]]\n> 这是引用 memo 内容",
		);
		assert.equal(
			buildQuoteCreatedMemoContent(
				"> 这是引用 memo 内容\n\n",
				"> 这是引用 memo 内容",
				"[[Daily/2026-05-17#^abc123|memo-1]]",
			),
			"> 这是引用 memo 内容\n[[Daily/2026-05-17#^abc123|memo-1]]",
		);
	});

test("strips inline wiki link from content for card display", () => {
	assert.equal(
		stripTrailingWikiLink("还是打雷了。 [[2026-05-19#^jxcjay|2026051911211387]]"),
		"还是打雷了。",
	);
	assert.equal(
		stripTrailingWikiLink("[[Daily/2026-05-17#^abc123|memo-1]]"),
		"",
	);
	assert.equal(
		stripTrailingWikiLink("普通内容没有引用链接"),
		"普通内容没有引用链接",
	);
	assert.equal(
		stripTrailingWikiLink("内容中间的 [[普通链接]] 不动"),
		"内容中间的 [[普通链接]] 不动",
	);
});

test("formats numeric memoId alias for Obsidian block links", () => {
	assert.equal(formatMemoIdAlias("2026060514301207"), "20260605-143012");
	assert.equal(formatMemoIdAlias("memo-1"), "memo-1");
	assert.equal(
		withMemoIdAlias("[[Daily/2026-05-17#^abc123]]", "2026060514301207"),
		"[[Daily/2026-05-17#^abc123|20260605-143012]]",
	);
	assert.equal(
		withMemoIdAlias("![[Daily/2026-05-17#^abc123]]", "memo-1"),
		"[[Daily/2026-05-17#^abc123|memo-1]]",
	);
});

test("formats new reference aliases from createdAt without exposing internal memoId", () => {
	const memoId = "m_0123456789abcdef0123456789abcdef";
	const referenceText = withCreatedAtAlias(
		`[[Daily/2026-06-05#^abc123|${memoId}]]`,
		"2026-06-05T14:30:12.987+08:00",
	);

	assert.equal(referenceText, "[[Daily/2026-06-05#^abc123|20260605-143012]]");
	assert.equal(referenceText.includes(memoId), false);
	assert.match(formatCreatedAtAlias("2026-06-05T14:30:12"), /^\d{8}-\d{6}$/u);
});

test("formats createdAt aliases consistently across device timezones", () => {
	assert.equal(formatCreatedAtAlias("2026-06-05T14:30:12.987+08:00"), "20260605-143012");
	assert.equal(formatCreatedAtAlias("2026-06-05T14:30:12.987-07:00"), "20260605-143012");
});

function createDailyNotesApp(options: {
	internalPlugins: unknown;
	configFile?: string;
	onRead?: () => void;
}): unknown {
	return {
		internalPlugins: options.internalPlugins,
		vault: {
			configDir: ".obsidian",
			adapter: {
				read: async () => {
					options.onRead?.();
					if (options.configFile === undefined) throw new Error("missing config file");
					return options.configFile;
				},
			},
		},
	};
}

function setTestWindow(value: unknown): () => void {
	const globalRecord = globalThis as unknown as Record<string, unknown>;
	const hadWindow = Object.prototype.hasOwnProperty.call(globalRecord, "window");
	const previousWindow = globalRecord["window"];
	if (value === undefined) delete globalRecord["window"];
	else globalRecord["window"] = value;
	return () => {
		if (!hadWindow) {
			delete globalRecord["window"];
			return;
		}
		globalRecord["window"] = previousWindow;
	};
}

async function loadDailyNoteService(): Promise<typeof import("../src/services/DailyNoteService")> {
	await ensureObsidianStub();
	return import("../src/services/DailyNoteService");
}

async function loadDailyNotesProvider(): Promise<typeof import("../src/services/DailyNotesProvider")> {
	await ensureObsidianStub();
	return import("../src/services/DailyNotesProvider");
}
