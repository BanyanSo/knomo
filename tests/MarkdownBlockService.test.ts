import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { MarkdownBlockService } from "../src/services/MarkdownBlockService";
import type { MemoRecord } from "../src/types/memo";
import type { KnomoSettings } from "../src/types/settings";
import { matchesDailyNotePath, parseDailyNoteDateFromPath } from "../src/utils/dailyNotes";
import { hashMemoContent, hashText } from "../src/utils/hash";
import { isSupportedMemoImage } from "../src/utils/markdown";
import { buildMemoReferences, buildQuoteCreatedMemoContent, formatMemoIdAlias, stripTrailingWikiLink, withMemoIdAlias } from "../src/utils/references";

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

test("daily note writes create the heading when missing", async () => {
	const { DailyNoteService } = await loadDailyNoteService();
	const { TFile } = await import("obsidian");
	const file = Object.assign(new TFile(), {
		path: "Daily/today.md",
		basename: "today",
		extension: "md",
	});
	let dailyContent = "# Today";
	const dailyNoteService = new DailyNoteService(
		{
			vault: {
				getAbstractFileByPath: (_path: string) => file,
				process: async (_file: unknown, callback: (content: string) => string) => {
					dailyContent = callback(dailyContent);
					return dailyContent;
				},
			},
		} as never,
		service,
		{
			getConfig: () => ({ folder: null, format: "YYYY-MM-DD" }),
			loadConfig: async () => ({ folder: null, format: "YYYY-MM-DD" }),
		},
	);
	const settings = createTestSettings();

	await dailyNoteService.insertMemoBlock(settings, service.buildMemoBlock("新 memo", "12:00:00"));

	assert.equal(dailyContent, "# Today\n\n## Knomo\n- 12:00:00 新 memo");
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
			service,
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
		service,
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
	const originalConsoleError = console.error;
	let loggedFallback = false;
	console.error = (...args: unknown[]) => {
		loggedFallback = String(args[0]).includes("Daily Notes interface failed");
	};
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
			service,
			{
				getConfig: () => ({ folder: "Daily", format: "YYYY-MM-DD" }),
				loadConfig: async () => ({ folder: "Daily", format: "YYYY-MM-DD" }),
			},
		);

		const file = await dailyNoteService.getOrCreateDailyNoteForDate(new Date("2026-05-14T10:00:00"));

		assert.equal(file.path, "Daily/2026-05-14.md");
		assert.equal(loggedFallback, true);
	} finally {
		console.error = originalConsoleError;
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
		service,
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

test("updates a complete memo block without touching the next memo", () => {
	const content = "- 12:00:00 第一行\n  第二行\n- 13:00:00 下一条";

	assert.equal(
		service.updateMemoBlock(content, 0, "新的第一行\n新的第二行"),
		"- 12:00:00 新的第一行\n\t新的第二行\n- 13:00:00 下一条",
	);
});

test("keeps blockId after edit and moves it to the last effective content line", () => {
	const content = "- 12:00:00 第一行 ^abc123\n  第二行";

	assert.equal(
		service.updateMemoBlock(content, 0, "新的第一行\n新的第二行"),
		"- 12:00:00 新的第一行\n\t新的第二行 ^abc123",
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

test("updates a daily block through the change helper", () => {
	const content = "- 12:00:00 第一行\n  第二行\n- 13:00:00 下一条";

	assert.equal(
		service.updateDailyBlock(content, {
			type: "edit",
			memoId: "memo-1",
			startLine: 0,
			block: "- 12:00:00 新内容",
		}),
		"- 12:00:00 新内容\n- 13:00:00 下一条",
	);
});

test("does not locate a memo by time-only line hint", () => {
	const content = "- 12:00:00 另一条\n- 12:00:00 目标内容";
	const location = service.findMemoBlock(content, {
		lineNumberHint: 1,
		lastKnownBlock: "- 12:00:00 目标内容",
		lastKnownHash: "stale-hash",
		contentHash: hashMemoContent("目标内容"),
	}, "daily_block_missing");

	assert.equal(location.parsedBlock?.content, "目标内容");
});

test("allows explicit time match for a manual edit at the hinted line", () => {
	const content = "- 12:00:00 用户改过的内容";
	const location = service.findMemoBlock(content, {
		lineNumberHint: 1,
		lastKnownBlock: "- 12:00:00 旧内容",
		lastKnownHash: "stale-hash",
		contentHash: hashMemoContent("旧内容"),
		allowLineHintTimeMatch: true,
	}, "daily_block_missing");

	assert.equal(location.parsedBlock?.content, "用户改过的内容");
});

test("uses the nearby line hint instead of permanently marking same-second memos ambiguous", () => {
	const content = "- 12:00:00 第一条已改\n- 12:00:00 第二条";
	const location = service.findMemoBlock(content, {
		lineNumberHint: 1,
		lastKnownBlock: "- 12:00:00 旧内容",
		lastKnownHash: "stale-hash",
		contentHash: hashMemoContent("旧内容"),
		allowLineHintTimeMatch: true,
	}, "daily_block_missing");

	assert.equal(location.parsedBlock?.content, "第一条已改");
	assert.equal(location.issueType, null);
});

test("finds a memo by blockId before stale hashes", () => {
	const content = "- 12:00:00 改过的内容 ^abc123\n- 12:00:00 旧内容";
	const location = service.findMemoBlock(content, {
		lineNumberHint: null,
		lastKnownBlock: "- 12:00:00 旧内容 ^abc123",
		lastKnownHash: "stale-hash",
		contentHash: hashMemoContent("旧内容"),
	}, "daily_block_missing");

	assert.equal(location.parsedBlock?.content, "改过的内容");
	assert.equal(location.parsedBlock?.blockId, "abc123");
});

test("finds a moved memo by lastKnownHash", () => {
	const block = "- 12:00:00 目标内容";
	const content = "- 11:00:00 其他内容\n\n" + block;
	const location = service.findMemoBlock(content, {
		lineNumberHint: 1,
		lastKnownBlock: block,
		lastKnownHash: hashText(block),
		contentHash: "stale-content-hash",
	}, "daily_block_missing");

	assert.equal(location.parsedBlock?.content, "目标内容");
});

test("finds a memo by contentHash after the displayed time changes", () => {
	const content = "- 18:35 内容";
	const location = service.findMemoBlock(content, {
		lineNumberHint: 1,
		lastKnownBlock: "- 18:30 内容",
		lastKnownHash: "stale-hash",
		contentHash: hashMemoContent("内容"),
	}, "daily_block_missing");

	assert.equal(location.parsedBlock?.time, "18:35");
	assert.equal(location.parsedBlock?.content, "内容");
});

test("uses lineNumberHint to disambiguate repeated content", () => {
	const content = "- 08:00:00 重复内容\n- 08:01:00 重复内容";
	const location = service.findMemoBlock(content, {
		lineNumberHint: 2,
		lastKnownBlock: "- 08:01:00 重复内容",
		lastKnownHash: "stale-hash",
		contentHash: hashMemoContent("重复内容"),
	}, "daily_block_missing");

	assert.equal(location.parsedBlock?.time, "08:01:00");
	assert.equal(location.issueType, null);
});

test("reports ambiguity only when repeated content cannot be uniquely located", () => {
	const content = "- 08:00:00 重复内容\n- 08:01:00 重复内容";
	const location = service.findMemoBlock(content, {
		lineNumberHint: null,
		lastKnownBlock: "- 08:01:00 重复内容",
		lastKnownHash: "stale-hash",
		contentHash: hashMemoContent("重复内容"),
	}, "daily_block_missing");

	assert.equal(location.parsedBlock, null);
	assert.equal(location.issueType, "daily_block_ambiguous");
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

test("builds a lightweight reference cache for quote-created memos", () => {
	assert.deepEqual(
		buildMemoReferences("这是新内容\n\n> 引用内容", "memo-1", "[[Daily/2026-05-17#^abc123|memo-1]]"),
		[
			{
				memoId: "memo-1",
				referenceText: "[[Daily/2026-05-17#^abc123|memo-1]]",
			},
		],
	);
	assert.deepEqual(buildMemoReferences("参考 ![[Daily/2026-05-17#^abc123]]", "memo-1", null), [
		{
			memoId: "memo-1",
			referenceText: "![[Daily/2026-05-17#^abc123]]",
		},
	]);
	assert.deepEqual(buildMemoReferences("用户删掉了引用", "memo-1", null), []);
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
	assert.equal(formatMemoIdAlias("2026060514301207"), "20260605-143012-07");
	assert.equal(formatMemoIdAlias("memo-1"), "memo-1");
	assert.equal(
		withMemoIdAlias("[[Daily/2026-05-17#^abc123]]", "2026060514301207"),
		"[[Daily/2026-05-17#^abc123|20260605-143012-07]]",
	);
	assert.equal(
		withMemoIdAlias("![[Daily/2026-05-17#^abc123]]", "memo-1"),
		"[[Daily/2026-05-17#^abc123|memo-1]]",
	);
});

test("creates an embed reference from an existing Obsidian blockId without mutating the file", async () => {
	const { ReferenceService } = await loadReferenceService();
	const { TFile } = await import("obsidian");
	const file = Object.assign(new TFile(), {
		path: "Daily/2026-05-18.md",
		basename: "2026-05-18",
		extension: "md",
	});
	let processed = false;
	const app = {
		vault: {
			getAbstractFileByPath: (_path: string) => file,
			cachedRead: async () => "- 08:00:00 内容 ^abc123",
			process: async (_file: unknown, _callback: (content: string) => string) => {
				processed = true;
				return "";
			},
		},
		fileManager: {
			generateMarkdownLink: (target: { basename: string }, _sourcePath: string, subpath = "") => `[[${target.basename}${subpath}]]`,
		},
	};
	let ensured = false;
	const referenceService = new ReferenceService(app as never, service, async () => {
		ensured = true;
		return "generated";
	});

	assert.equal(await referenceService.createReferenceText(createReferenceMemo("- 08:00:00 内容 ^abc123"), "embed"), "![[2026-05-18#^abc123]]");
	assert.equal(processed, false);
	assert.equal(ensured, false);
});

test("creates a reference through the blockId generation callback when missing", async () => {
	const { ReferenceService } = await loadReferenceService();
	const { TFile } = await import("obsidian");
	const file = Object.assign(new TFile(), {
		path: "Daily/2026-05-18.md",
		basename: "2026-05-18",
		extension: "md",
	});
	let processed = false;
	const app = {
		vault: {
			getAbstractFileByPath: (_path: string) => file,
			cachedRead: async () => "- 08:00:00 内容",
			process: async (_file: unknown, _callback: (content: string) => string) => {
				processed = true;
				return "";
			},
		},
		fileManager: {
			generateMarkdownLink: (target: { basename: string }, _sourcePath: string, subpath = "") => `[[${target.basename}${subpath}]]`,
		},
	};
	const ensuredMemos: MemoRecord[] = [];
	const referenceService = new ReferenceService(app as never, service, async (memo) => {
		ensuredMemos.push(memo);
		return "abc123";
	});

	assert.equal(await referenceService.createReferenceText(createReferenceMemo("- 08:00:00 内容"), "embed"), "![[2026-05-18#^abc123]]");
	assert.equal(processed, false);
	assert.equal(ensuredMemos[0]?.id, "2026051808000000");
});

test("createMemo writes quote-create metadata through service orchestration", async () => {
	const { SyncOrchestrator } = await loadSyncOrchestrator();
	const writes: string[] = [];
	const settings: KnomoSettings = {
		settingsVersion: 2,
		dailyHeading: "## Knomo",
		dailyInsertPosition: "bottom",
		memoTimeFormat: "HH:mm:ss",
		monthlyMemoFolder: "Memos",
		monthlyMemoFileFormat: "Memos-YYYY-MM.md",
		monthlyDateHeadingFormat: "## YYYY-MM-DD",
		monthlyDateOrder: "asc",
		legacyDailyHeadings: [],
		mobileCompactMode: "auto",
		syncDebounceMs: 1000,
		desktopSidebarWidth: 248,
		desktopSidebarCollapsed: false,
		excludeMonthlyMemosFromObsidian: false,
		managedObsidianExcludeRuleOwned: false,
		pinnedTags: [],
	};
	const dailyNoteService = {
		prepareMemoBlockInsert: async () => ({
			path: "Daily/2026-05-17.md",
			beforeHash: "daily-before",
			afterHash: "daily-after",
			blockOccurrencesBefore: 0,
			ref: {
				path: "Daily/2026-05-17.md",
				heading: "## Knomo",
				lastKnownBlock: "- 12:00:00 内容",
				lastKnownHash: "daily-hash",
				lineNumberHint: 1,
				lastSyncedAt: "2026-05-17T12:00:00.000+08:00",
			},
		}),
		commitPreparedMemoBlock: async (_settings: unknown, _block: string, prepared: { ref: unknown }) => ({
			file: { path: "Daily/2026-05-17.md" },
			content: "daily-content",
			ref: prepared.ref,
			changed: true,
		}),
		getStatus: () => ({ enabled: true, folder: "Daily", format: "YYYY-MM-DD", message: "ok" }),
	};
	const monthlyArchiveService = {
		prepareMemoBlockInsert: async () => ({
			path: "Memos/Memos-2026-05.md",
			beforeHash: "monthly-before",
			afterHash: "monthly-after",
			blockOccurrencesBefore: 0,
			ref: {
				path: "Memos/Memos-2026-05.md",
				dateHeading: "## 2026-05-17",
				lastKnownBlock: "- 12:00:00 内容",
				lastKnownHash: "monthly-hash",
				lineNumberHint: 1,
				lastSyncedAt: "2026-05-17T12:00:00.000+08:00",
			},
		}),
		commitPreparedMemoBlock: async (_settings: unknown, _date: Date, _block: string, prepared: { ref: unknown }) => ({
			file: { path: "Memos/Memos-2026-05.md" },
			content: "monthly-content",
			ref: prepared.ref,
			changed: true,
		}),
	};
	const memoIndexStore = {
		findMemoByIdInPeriod: async () => null,
		addMemoWithId: async (_folder: string, memo: unknown) => memo,
	};
	const selfWriteTracker = {
		mark: (path: string) => {
			writes.push(path);
		},
	};
	const orchestrator = new SyncOrchestrator(
		{} as never,
		() => settings,
		dailyNoteService as never,
		monthlyArchiveService as never,
		memoIndexStore as never,
		selfWriteTracker as never,
		service,
	);

	const result = await orchestrator.createMemo("新内容\n\n> 来源 memo", {
		source: "quote_create",
		sourceMemoId: "source-memo",
		sourceReferenceText: "[[Daily/2026-05-17#^abc123|source-memo]]",
	});

	assert.equal(result.memo.source, "quote_create");
	assert.equal(result.memo.sourceMemoId, "source-memo");
	assert.deepEqual(result.memo.references, [
		{
			memoId: "source-memo",
			referenceText: "[[Daily/2026-05-17#^abc123|source-memo]]",
		},
	]);
	assert.ok(writes.includes("Daily/2026-05-17.md"));
	assert.ok(writes.includes("Memos/Memos-2026-05.md"));
});

test("ensureReferenceBlockId appends a missing blockId and syncs monthly archive", async () => {
	const { SyncOrchestrator } = await loadSyncOrchestrator();
	const { TFile } = await import("obsidian");
	const originalRandom = Math.random;
	Math.random = () => 0;
	try {
		const file = Object.assign(new TFile(), {
			path: "Daily/2026-05-18.md",
			basename: "2026-05-18",
			extension: "md",
		});
		let dailyContent = "- 08:00:00 内容";
		let monthlyBlock = "";
		const savedMemos: MemoRecord[] = [];
		const writes: string[] = [];
		const settings = createTestSettings();
		const orchestrator = new SyncOrchestrator(
			{
				vault: {
					getAbstractFileByPath: (_path: string) => file,
					cachedRead: async () => dailyContent,
					process: async (_file: unknown, callback: (content: string) => string) => {
						dailyContent = callback(dailyContent);
						return dailyContent;
					},
				},
			} as never,
			() => settings,
			{} as never,
			{
				upsertMemoBlock: async (_settings: KnomoSettings, _memo: MemoRecord, block: string) => {
					monthlyBlock = block;
					return {
						file: { path: "Memos/Memos-2026-05.md" },
						content: block,
						ref: {
							path: "Memos/Memos-2026-05.md",
							dateHeading: "## 2026-05-18",
							lastKnownBlock: block,
							lastKnownHash: "monthly-hash",
							lineNumberHint: 1,
							lastSyncedAt: "2026-05-18T08:00:00.000+08:00",
						},
					};
				},
			} as never,
			{
				upsertMemo: async (_folder: string, memo: MemoRecord) => {
					savedMemos.push(memo);
					return memo;
				},
			} as never,
			{
				mark: (path: string) => {
					writes.push(path);
				},
			} as never,
			service,
		);

		const blockId = await orchestrator.ensureReferenceBlockId(createReferenceMemo("- 08:00:00 内容"));

		assert.equal(blockId, "aaaaaa");
		assert.equal(dailyContent, "- 08:00:00 内容 ^aaaaaa");
		assert.equal(monthlyBlock, "- 08:00:00 内容 ^aaaaaa");
		const savedMemo = savedMemos[0];
		if (savedMemo === undefined) {
			assert.fail("memo-index was not updated");
		}
		assert.equal(savedMemo.dailyRef.lastKnownBlock, "- 08:00:00 内容 ^aaaaaa");
		assert.equal(savedMemo.monthlyRef.lastKnownBlock, "- 08:00:00 内容 ^aaaaaa");
		assert.equal(savedMemo.syncStatus, "synced");
		assert.ok(writes.includes("Daily/2026-05-18.md"));
		assert.ok(writes.includes("Memos/Memos-2026-05.md"));
	} finally {
		Math.random = originalRandom;
	}
});

test("ensureReferenceBlockId retries when a generated blockId already exists", async () => {
	const { SyncOrchestrator } = await loadSyncOrchestrator();
	const { TFile } = await import("obsidian");
	const originalRandom = Math.random;
	let randomCalls = 0;
	Math.random = () => {
		randomCalls += 1;
		return randomCalls <= 7 ? 0 : 1 / 36;
	};
	try {
		const file = Object.assign(new TFile(), {
			path: "Daily/2026-05-18.md",
			basename: "2026-05-18",
			extension: "md",
		});
		let dailyContent = "- 07:00:00 旧内容 ^aaaaaa\n- 08:00:00 内容";
		const settings = createTestSettings();
		const memo = createReferenceMemo("- 08:00:00 内容");
		memo.dailyRef.lineNumberHint = 2;
		const orchestrator = new SyncOrchestrator(
			{
				vault: {
					getAbstractFileByPath: (_path: string) => file,
					cachedRead: async () => dailyContent,
					process: async (_file: unknown, callback: (content: string) => string) => {
						dailyContent = callback(dailyContent);
						return dailyContent;
					},
				},
			} as never,
			() => settings,
			{} as never,
			{
				upsertMemoBlock: async (_settings: KnomoSettings, _memo: MemoRecord, block: string) => ({
					file: { path: "Memos/Memos-2026-05.md" },
					content: block,
					ref: {
						path: "Memos/Memos-2026-05.md",
						dateHeading: "## 2026-05-18",
						lastKnownBlock: block,
						lastKnownHash: "monthly-hash",
						lineNumberHint: 1,
						lastSyncedAt: "2026-05-18T08:00:00.000+08:00",
					},
				}),
			} as never,
			{
				upsertMemo: async (_folder: string, updatedMemo: MemoRecord) => updatedMemo,
			} as never,
			{ mark: (_path: string) => undefined } as never,
			service,
		);

		assert.equal(await orchestrator.ensureReferenceBlockId(memo), "bbbbbb");
		assert.equal(dailyContent, "- 07:00:00 旧内容 ^aaaaaa\n- 08:00:00 内容 ^bbbbbb");
	} finally {
		Math.random = originalRandom;
	}
});

test("ensureReferenceBlockId still returns the blockId when monthly sync fails", async () => {
	const { SyncOrchestrator } = await loadSyncOrchestrator();
	const { TFile } = await import("obsidian");
	const originalRandom = Math.random;
	Math.random = () => 0;
	try {
		const file = Object.assign(new TFile(), {
			path: "Daily/2026-05-18.md",
			basename: "2026-05-18",
			extension: "md",
		});
		let dailyContent = "- 08:00:00 内容";
		const savedMemos: MemoRecord[] = [];
		const settings = createTestSettings();
		const orchestrator = new SyncOrchestrator(
			{
				vault: {
					getAbstractFileByPath: (_path: string) => file,
					cachedRead: async () => dailyContent,
					process: async (_file: unknown, callback: (content: string) => string) => {
						dailyContent = callback(dailyContent);
						return dailyContent;
					},
				},
			} as never,
			() => settings,
			{} as never,
			{
				upsertMemoBlock: async () => {
					throw new Error("月度失败");
				},
			} as never,
			{
				upsertMemo: async (_folder: string, memo: MemoRecord) => {
					savedMemos.push(memo);
					return memo;
				},
			} as never,
			{ mark: (_path: string) => undefined } as never,
			service,
		);

		assert.equal(await orchestrator.ensureReferenceBlockId(createReferenceMemo("- 08:00:00 内容")), "aaaaaa");
		const savedMemo = savedMemos[0];
		if (savedMemo === undefined) {
			assert.fail("memo-index was not updated");
		}
		assert.equal(savedMemo.syncStatus, "monthly_failed");
		assert.equal(savedMemo.issue?.message, "月度失败");
		assert.equal(savedMemo.dailyRef.lastKnownBlock, "- 08:00:00 内容 ^aaaaaa");
	} finally {
		Math.random = originalRandom;
	}
});

test("syncExternalDailyFile syncs a manual edit under the daily heading", async () => {
	const { SyncOrchestrator } = await loadSyncOrchestrator();
	const { TFile } = await import("obsidian");
	const file = Object.assign(new TFile(), {
		path: "Daily/2026-05-18.md",
		basename: "2026-05-18",
		extension: "md",
	});
	const memo = createReferenceMemo("- 08:00:00 旧内容");
	memo.contentSnapshot = "旧内容";
	memo.contentHash = hashMemoContent("旧内容");
	memo.dailyRef.lineNumberHint = 4;
	memo.dailyRef.lastKnownHash = hashText(memo.dailyRef.lastKnownBlock);
	const savedMemos: MemoRecord[] = [];
	const monthlyBlocks: string[] = [];
	const settings = createTestSettings();
	const orchestrator = new SyncOrchestrator(
		{
			vault: {
				cachedRead: async () => "# 2026-05-18\n\n## Knomo\n- 08:00:00 新内容",
			},
		} as never,
		() => settings,
		{
			getStatus: () => ({ enabled: true, folder: "Daily", format: "YYYY-MM-DD", message: "ok" }),
			getDailyNotesConfig: async () => ({ folder: "Daily", format: "YYYY-MM-DD" }),
		} as never,
		{
			upsertMemoBlock: async (_settings: KnomoSettings, _memo: MemoRecord, block: string) => {
				monthlyBlocks.push(block);
				return {
					file: { path: "Memos/Memos-2026-05.md" },
					content: block,
					ref: {
						path: "Memos/Memos-2026-05.md",
						dateHeading: "## 2026-05-18",
						lastKnownBlock: block,
						lastKnownHash: hashText(block),
						lineNumberHint: 1,
						lastSyncedAt: "2026-05-18T08:00:00.000+08:00",
					},
				};
			},
		} as never,
		{
			loadAll: async () => [memo],
			upsertMemo: async (_folder: string, updatedMemo: MemoRecord) => {
				savedMemos.push(updatedMemo);
				return updatedMemo;
			},
		} as never,
		{ mark: (_path: string) => undefined } as never,
		service,
	);

	assert.equal(await orchestrator.syncExternalDailyFile(file), true);
	assert.deepEqual(monthlyBlocks, ["- 08:00:00 新内容"]);
	assert.equal(savedMemos[0]?.contentSnapshot, "新内容");
	assert.equal(savedMemos[0]?.lastMarkdownSyncSource, "file_watch");
	assert.equal(savedMemos[0]?.issue, null);
});

test("syncExternalDailyFile refreshes task status changed in the daily note", async () => {
	const { SyncOrchestrator } = await loadSyncOrchestrator();
	const { TFile } = await import("obsidian");
	const file = Object.assign(new TFile(), {
		path: "Daily/2026-05-18.md",
		basename: "2026-05-18",
		extension: "md",
	});
	const rawBlock = "- 08:00:00\n\t- [ ] task";
	const memo = createReferenceMemo(rawBlock);
	memo.contentSnapshot = "- [ ] task";
	memo.contentHash = hashMemoContent("- [ ] task");
	memo.dailyRef.lineNumberHint = 4;
	memo.dailyRef.lastKnownHash = hashText(rawBlock);
	const savedMemos: MemoRecord[] = [];
	const monthlyBlocks: string[] = [];
	const settings = createTestSettings();
	const orchestrator = new SyncOrchestrator(
		{
			vault: {
				cachedRead: async () => "# 2026-05-18\n\n## Knomo\n- 08:00:00\n\t- [x] task",
			},
		} as never,
		() => settings,
		{
			getStatus: () => ({ enabled: true, folder: "Daily", format: "YYYY-MM-DD", message: "ok" }),
			getDailyNotesConfig: async () => ({ folder: "Daily", format: "YYYY-MM-DD" }),
		} as never,
		{
			upsertMemoBlock: async (_settings: KnomoSettings, _memo: MemoRecord, block: string) => {
				monthlyBlocks.push(block);
				return {
					file: { path: "Memos/Memos-2026-05.md" },
					content: block,
					ref: {
						path: "Memos/Memos-2026-05.md",
						dateHeading: "## 2026-05-18",
						lastKnownBlock: block,
						lastKnownHash: hashText(block),
						lineNumberHint: 1,
						lastSyncedAt: "2026-05-18T08:00:00.000+08:00",
					},
				};
			},
		} as never,
		{
			loadAll: async () => [memo],
			upsertMemo: async (_folder: string, updatedMemo: MemoRecord) => {
				savedMemos.push(updatedMemo);
				return updatedMemo;
			},
		} as never,
		{ mark: (_path: string) => undefined } as never,
		service,
	);

	assert.equal(await orchestrator.syncExternalDailyFile(file), true);
	assert.deepEqual(monthlyBlocks, ["- 08:00:00\n\t- [x] task"]);
	assert.equal(savedMemos[0]?.contentSnapshot, "- [x] task");
	assert.equal(savedMemos[0]?.lastMarkdownSyncSource, "file_watch");
});

test("syncExternalDailyFile imports new blocks and tombstones missing indexed memos", async () => {
	const { SyncOrchestrator } = await loadSyncOrchestrator();
	const { TFile } = await import("obsidian");
	const file = Object.assign(new TFile(), {
		path: "Daily/2026-05-18.md",
		basename: "2026-05-18",
		extension: "md",
	});
	const deletedMemo = createReferenceMemo("- 08:00:00 旧内容");
	deletedMemo.contentSnapshot = "旧内容";
	deletedMemo.contentHash = hashMemoContent("旧内容");
	deletedMemo.dailyRef.lineNumberHint = 4;
	deletedMemo.dailyRef.lastKnownHash = hashText(deletedMemo.dailyRef.lastKnownBlock);
	deletedMemo.monthlyRef.lastKnownBlock = "- 08:00:00 旧内容";
	deletedMemo.monthlyRef.lastKnownHash = hashText(deletedMemo.monthlyRef.lastKnownBlock);
	const createdMemos: MemoRecord[] = [];
	const savedMemos: MemoRecord[] = [];
	const deletedMonthly: string[] = [];
	const settings = createTestSettings();
	const orchestrator = new SyncOrchestrator(
		{
			vault: {
				getAbstractFileByPath: () => null,
				cachedRead: async () => "# 2026-05-18\n\n## Knomo\n- 09:00:00 手动新增",
			},
		} as never,
		() => settings,
		{
			getStatus: () => ({ enabled: true, folder: "Daily", format: "YYYY-MM-DD", message: "ok" }),
			getDailyNotesConfig: async () => ({ folder: "Daily", format: "YYYY-MM-DD" }),
		} as never,
		{
			upsertMemoBlock: async (_settings: KnomoSettings, _memo: MemoRecord, block: string) => ({
				file: { path: "Memos/Memos-2026-05.md" },
				content: block,
				ref: {
					path: "Memos/Memos-2026-05.md",
					dateHeading: "## 2026-05-18",
					lastKnownBlock: block,
					lastKnownHash: hashText(block),
					lineNumberHint: 1,
					lastSyncedAt: "2026-05-18T09:00:00.000+08:00",
				},
			}),
			deleteMemoBlock: async (memo: MemoRecord) => {
				deletedMonthly.push(memo.id);
				return {
					file: { path: memo.monthlyRef.path },
					content: "",
					ref: {
						...memo.monthlyRef,
						lastKnownBlock: memo.monthlyRef.lastKnownBlock,
						lastKnownHash: hashText(memo.monthlyRef.lastKnownBlock),
						lastSyncedAt: "2026-05-18T09:00:00.000+08:00",
					},
				};
			},
		} as never,
		{
			loadAll: async () => [deletedMemo],
			addMemo: async (_folder: string, memo: MemoRecord) => {
				createdMemos.push(memo);
				return memo;
			},
			upsertMemo: async (_folder: string, memo: MemoRecord) => {
				savedMemos.push(memo);
				return memo;
			},
		} as never,
		{ mark: (_path: string) => undefined } as never,
		service,
	);

	assert.equal(await orchestrator.syncExternalDailyFile(file), true);
	assert.equal(createdMemos[0]?.contentSnapshot, "手动新增");
	assert.equal(createdMemos[0]?.lastMarkdownSyncSource, "file_watch");
	const tombstone = savedMemos.find((memo) => memo.status === "deleted");
	assert.ok(tombstone);
	assert.equal(tombstone.deleteSource, "file_watch");
	assert.equal(tombstone.deletedDailyBlock, "- 08:00:00 旧内容");
	assert.equal(tombstone.deletedMonthlyBlock, "- 08:00:00 旧内容");
	assert.equal(tombstone.issue, null);
	assert.deepEqual(deletedMonthly, [deletedMemo.id]);
});

test("syncRenamedDailyFile preserves memoId and updates the indexed daily path", async () => {
	const { SyncOrchestrator } = await loadSyncOrchestrator();
	const { TFile } = await import("obsidian");
	const oldPath = "Daily/2026-05-18.md";
	const file = Object.assign(new TFile(), {
		path: "Daily/2026-05-19.md",
		basename: "2026-05-19",
		extension: "md",
	});
	const memo = createReferenceMemo("- 08:00:00 内容");
	memo.dailyRef.path = oldPath;
	memo.dailyRef.lineNumberHint = 4;
	memo.dailyRef.lastKnownHash = hashText(memo.dailyRef.lastKnownBlock);
	const savedMemos: MemoRecord[] = [];
	let created = 0;
	const settings = createTestSettings();
	const orchestrator = new SyncOrchestrator(
		{
			vault: {
				cachedRead: async () => "# 2026-05-19\n\n## Knomo\n- 08:00:00 内容",
			},
		} as never,
		() => settings,
		{
			getStatus: () => ({ enabled: true, folder: "Daily", format: "YYYY-MM-DD", message: "ok" }),
			getDailyNotesConfig: async () => ({ folder: "Daily", format: "YYYY-MM-DD" }),
		} as never,
		{
			upsertMemoBlock: async (_settings: KnomoSettings, _memo: MemoRecord, block: string) => ({
				file: { path: "Memos/Memos-2026-05.md" },
				content: block,
				ref: {
					...memo.monthlyRef,
					lastKnownBlock: block,
					lastKnownHash: hashText(block),
				},
			}),
		} as never,
		{
			loadAll: async () => [memo],
			addMemo: async (_folder: string, createdMemo: MemoRecord) => {
				created += 1;
				return createdMemo;
			},
			upsertMemo: async (_folder: string, updatedMemo: MemoRecord) => {
				savedMemos.push(updatedMemo);
				return updatedMemo;
			},
		} as never,
		{ mark: (_path: string) => undefined } as never,
		service,
	);

	assert.equal(await orchestrator.syncRenamedDailyFile(file, oldPath), true);
	assert.equal(created, 0);
	assert.equal(savedMemos[0]?.id, memo.id);
	assert.equal(savedMemos[0]?.dailyRef.path, file.path);
	assert.equal(savedMemos[0]?.status, "active");
});

test("syncDeletedDailyFile tombstones memos indexed under the deleted path", async () => {
	const { SyncOrchestrator } = await loadSyncOrchestrator();
	const path = "Daily/2026-05-18.md";
	const memo = createReferenceMemo("- 08:00:00 内容");
	memo.dailyRef.path = path;
	const savedMemos: MemoRecord[] = [];
	const deletedMonthly: string[] = [];
	const orchestrator = new SyncOrchestrator(
		{} as never,
		() => createTestSettings(),
		{
			getStatus: () => ({ enabled: true, folder: "Daily", format: "YYYY-MM-DD", message: "ok" }),
			getDailyNotesConfig: async () => ({ folder: "Daily", format: "YYYY-MM-DD" }),
		} as never,
		{
			deleteMemoBlock: async (deletedMemo: MemoRecord) => {
				deletedMonthly.push(deletedMemo.id);
				return {
					file: { path: deletedMemo.monthlyRef.path },
					content: "",
					ref: deletedMemo.monthlyRef,
				};
			},
		} as never,
		{
			loadAll: async () => [memo],
			upsertMemo: async (_folder: string, deletedMemo: MemoRecord) => {
				savedMemos.push(deletedMemo);
				return deletedMemo;
			},
		} as never,
		{ mark: (_path: string) => undefined } as never,
		service,
	);

	assert.equal(await orchestrator.syncDeletedDailyFile(path), true);
	assert.deepEqual(deletedMonthly, [memo.id]);
	assert.equal(savedMemos[0]?.status, "deleted");
	assert.equal(savedMemos[0]?.deleteSource, "file_watch");
});

test("syncRenamedDailyFile tombstones memos moved outside the daily note path", async () => {
	const { SyncOrchestrator } = await loadSyncOrchestrator();
	const { TFile } = await import("obsidian");
	const oldPath = "Daily/2026-05-18.md";
	const file = Object.assign(new TFile(), {
		path: "Archive/2026-05-18.md",
		basename: "2026-05-18",
		extension: "md",
	});
	const memo = createReferenceMemo("- 08:00:00 内容");
	memo.dailyRef.path = oldPath;
	const savedMemos: MemoRecord[] = [];
	const orchestrator = new SyncOrchestrator(
		{} as never,
		() => createTestSettings(),
		{
			getStatus: () => ({ enabled: true, folder: "Daily", format: "YYYY-MM-DD", message: "ok" }),
			getDailyNotesConfig: async () => ({ folder: "Daily", format: "YYYY-MM-DD" }),
		} as never,
		{
			deleteMemoBlock: async (deletedMemo: MemoRecord) => ({
				file: { path: deletedMemo.monthlyRef.path },
				content: "",
				ref: deletedMemo.monthlyRef,
			}),
		} as never,
		{
			loadAll: async () => [memo],
			upsertMemo: async (_folder: string, deletedMemo: MemoRecord) => {
				savedMemos.push(deletedMemo);
				return deletedMemo;
			},
		} as never,
		{ mark: (_path: string) => undefined } as never,
		service,
	);

	assert.equal(await orchestrator.syncRenamedDailyFile(file, oldPath), true);
	assert.equal(savedMemos[0]?.status, "deleted");
	assert.equal(savedMemos[0]?.dailyRef.path, oldPath);
});

test("full daily scan tombstones indexed memos whose daily file no longer exists", async () => {
	const { SyncOrchestrator } = await loadSyncOrchestrator();
	const path = "2026-05-18.md";
	const memo = createReferenceMemo("- 08:00:00 内容");
	memo.dailyRef.path = path;
	const savedMemos: MemoRecord[] = [];
	const orchestrator = new SyncOrchestrator(
		{
			vault: {
				getMarkdownFiles: () => [],
				getAbstractFileByPath: () => null,
			},
		} as never,
		() => createTestSettings(),
		{
			getStatus: () => ({ enabled: true, folder: null, format: "YYYY-MM-DD", message: "ok" }),
			getDailyNotesConfig: async () => ({ folder: null, format: "YYYY-MM-DD" }),
		} as never,
		{
			deleteMemoBlock: async (deletedMemo: MemoRecord) => ({
				file: { path: deletedMemo.monthlyRef.path },
				content: "",
				ref: deletedMemo.monthlyRef,
			}),
		} as never,
		{
			loadAll: async () => [memo],
			upsertMemo: async (_folder: string, deletedMemo: MemoRecord) => {
				savedMemos.push(deletedMemo);
				return deletedMemo;
			},
		} as never,
		{ mark: (_path: string) => undefined } as never,
		service,
	);

	const result = await orchestrator.scanDailyMemos();

	assert.equal(result.deleted, 1);
	assert.equal(savedMemos[0]?.status, "deleted");
	assert.equal(savedMemos[0]?.dailyRef.path, path);
});

test("full daily scan keeps indexed memos whose file still exists outside the current daily folder", async () => {
	const { SyncOrchestrator } = await loadSyncOrchestrator();
	const { TFile, TFolder } = await import("obsidian");
	const path = "Archive/2026-05-18.md";
	const file = Object.assign(new TFile(), {
		path,
		basename: "2026-05-18",
		extension: "md",
	});
	const dailyFolder = Object.assign(new TFolder(), {
		path: "Daily",
		children: [],
	});
	const memo = createReferenceMemo("- 08:00:00 内容");
	memo.dailyRef.path = path;
	let saved = false;
	const orchestrator = new SyncOrchestrator(
		{
			vault: {
				getAbstractFileByPath: (requestedPath: string) => requestedPath === "Daily" ? dailyFolder : requestedPath === path ? file : null,
			},
		} as never,
		() => createTestSettings(),
		{
			getStatus: () => ({ enabled: true, folder: "Daily", format: "YYYY-MM-DD", message: "ok" }),
			getDailyNotesConfig: async () => ({ folder: "Daily", format: "YYYY-MM-DD" }),
		} as never,
		{} as never,
		{
			loadAll: async () => [memo],
			upsertMemo: async (_folder: string, savedMemo: MemoRecord) => {
				saved = true;
				return savedMemo;
			},
		} as never,
		{ mark: (_path: string) => undefined } as never,
		service,
	);

	const result = await orchestrator.scanDailyMemos();

	assert.equal(result.deleted, 0);
	assert.equal(saved, false);
});

test("listDeletedMemos returns only deleted memos by deletedAt descending", async () => {
	const { SyncOrchestrator } = await loadSyncOrchestrator();
	const deletedOlder = {
		...createReferenceMemo("- 08:00:00 旧删除"),
		id: "older",
		status: "deleted" as const,
		deletedAt: "2026-05-18T08:00:00.000+08:00",
	};
	const deletedNewer = {
		...createReferenceMemo("- 09:00:00 新删除"),
		id: "newer",
		status: "deleted" as const,
		createdAt: "2026-05-18T09:00:00.000+08:00",
		deletedAt: "2026-05-18T09:00:00.000+08:00",
	};
	const deletedWithoutTime = {
		...createReferenceMemo("- 10:00:00 无删除时间"),
		id: "without-time",
		status: "deleted" as const,
		createdAt: "2026-05-18T10:00:00.000+08:00",
	};
	const activeMemo = createReferenceMemo("- 11:00:00 活跃");
	activeMemo.id = "active";
	const orchestrator = new SyncOrchestrator(
		{} as never,
		() => createTestSettings(),
		{} as never,
		{} as never,
		{
			loadAll: async () => [activeMemo, deletedWithoutTime, deletedOlder, deletedNewer],
		} as never,
		{ mark: (_path: string) => undefined } as never,
		service,
	);

	assert.deepEqual((await orchestrator.listDeletedMemos()).map((memo) => memo.id), [
		"newer",
		"older",
		"without-time",
	]);
});

test("updateMemo reloads the latest index memo before syncing monthly archive", async () => {
	const { SyncOrchestrator } = await loadSyncOrchestrator();
	const { TFile } = await import("obsidian");
	const dailyFile = Object.assign(new TFile(), {
		path: "Daily/2026-05-18.md",
		basename: "2026-05-18",
		extension: "md",
	});
	let dailyContent = "# 2026-05-18\n\n## Knomo\n- 08:00:00 远端内容";
	const staleMemo = createReferenceMemo("- 08:00:00 旧内容");
	staleMemo.contentSnapshot = "旧内容";
	staleMemo.contentHash = hashMemoContent("旧内容");
	staleMemo.monthlyRef.lastKnownBlock = "- 08:00:00 旧内容";
	staleMemo.monthlyRef.lastKnownHash = hashText(staleMemo.monthlyRef.lastKnownBlock);
	const latestMemo = createReferenceMemo("- 08:00:00 远端内容");
	latestMemo.contentSnapshot = "远端内容";
	latestMemo.contentHash = hashMemoContent("远端内容");
	latestMemo.version = 7;
	latestMemo.dailyRef.lineNumberHint = 4;
	latestMemo.dailyRef.lastKnownHash = hashText(latestMemo.dailyRef.lastKnownBlock);
	latestMemo.monthlyRef.lastKnownBlock = "- 08:00:00 远端内容";
	latestMemo.monthlyRef.lastKnownHash = hashText(latestMemo.monthlyRef.lastKnownBlock);
	const monthlyBlocks: string[] = [];
	const savedMemos: MemoRecord[] = [];
	let monthlyLastKnownBlockForUpdate = "";
	const settings = createTestSettings();
	const orchestrator = new SyncOrchestrator(
		{
			vault: {
				getAbstractFileByPath: (path: string) => path === dailyFile.path ? dailyFile : null,
				process: async (_file: unknown, callback: (content: string) => string) => {
					dailyContent = callback(dailyContent);
					return dailyContent;
				},
			},
		} as never,
		() => settings,
		{} as never,
		{
			upsertMemoBlock: async (_settings: KnomoSettings, memo: MemoRecord, block: string) => {
				monthlyLastKnownBlockForUpdate = memo.monthlyRef.lastKnownBlock;
				monthlyBlocks.push(block);
				return {
					file: { path: memo.monthlyRef.path },
					content: block,
					ref: {
						...memo.monthlyRef,
						lastKnownBlock: block,
						lastKnownHash: hashText(block),
						lineNumberHint: 1,
						lastSyncedAt: "2026-05-18T09:00:00.000+08:00",
					},
				};
			},
		} as never,
		{
			findMemoByIdInPeriod: async () => latestMemo,
			upsertMemo: async (_folder: string, memo: MemoRecord) => {
				savedMemos.push(memo);
				return memo;
			},
		} as never,
		{ mark: (_path: string) => undefined } as never,
		service,
	);

	const updatedMemo = await orchestrator.updateMemo(staleMemo, "最终内容");

	assert.equal(dailyContent, "# 2026-05-18\n\n## Knomo\n- 08:00:00 最终内容");
	assert.deepEqual(monthlyBlocks, ["- 08:00:00 最终内容"]);
	assert.equal(monthlyLastKnownBlockForUpdate, "- 08:00:00 远端内容");
	assert.equal(updatedMemo.version, 8);
	assert.equal(savedMemos[0]?.monthlyRef.lastKnownBlock, "- 08:00:00 最终内容");
});

test("restoreMemo writes daily and monthly blocks before reactivating the index", async () => {
	const { SyncOrchestrator } = await loadSyncOrchestrator();
	const { TFile } = await import("obsidian");
	const dailyFile = Object.assign(new TFile(), {
		path: "Daily/2026-05-18.md",
		basename: "2026-05-18",
		extension: "md",
	});
	const monthlyFile = Object.assign(new TFile(), {
		path: "Memos/Memos-2026-05.md",
		basename: "Memos-2026-05",
		extension: "md",
	});
	let dailyContent = "# 2026-05-18\n\n## Knomo";
	let monthlyContent = "# 2026-05\n\n## 2026-05-18";
	const monthlyBlocks: string[] = [];
	const savedMemos: MemoRecord[] = [];
	const deletedMemo = {
		...createReferenceMemo("- 08:00:00 内容 ^abc123"),
		status: "deleted" as const,
		deletedAt: "2026-05-18T09:00:00.000+08:00",
		deleteSource: "knomo_ui",
		deletedDailyBlock: "- 08:00:00 内容 ^abc123",
		deletedMonthlyBlock: "- 08:00:00 内容 ^abc123",
	};
	const settings = createTestSettings();
	const orchestrator = new SyncOrchestrator(
		{
			vault: {
				getAbstractFileByPath: (path: string) => {
					if (path === dailyFile.path) return dailyFile;
					if (path === monthlyFile.path) return monthlyFile;
					return null;
				},
				cachedRead: async (file: { path: string }) => file.path === monthlyFile.path ? monthlyContent : dailyContent,
				process: async (file: { path: string }, callback: (content: string) => string) => {
					if (file.path === dailyFile.path) {
						dailyContent = callback(dailyContent);
						return dailyContent;
					}
					monthlyContent = callback(monthlyContent);
					return monthlyContent;
				},
			},
		} as never,
		() => settings,
		{
			getOrCreateDailyNoteForDate: async () => dailyFile,
		} as never,
		{
			upsertMemoBlock: async (_settings: KnomoSettings, _memo: MemoRecord, block: string) => {
				monthlyBlocks.push(block);
				monthlyContent = `${monthlyContent}\n${block}`;
				return {
					file: monthlyFile,
					content: monthlyContent,
					ref: {
						path: monthlyFile.path,
						dateHeading: "## 2026-05-18",
						lastKnownBlock: block,
						lastKnownHash: hashText(block),
						lineNumberHint: 4,
						lastSyncedAt: "2026-05-18T09:00:00.000+08:00",
					},
				};
			},
		} as never,
		{
			findMemoById: async () => deletedMemo,
			updateMemo: async (_folder: string, memo: MemoRecord, update: (memo: MemoRecord) => MemoRecord) => {
				const updatedMemo = update(memo);
				savedMemos.push(updatedMemo);
				return updatedMemo;
			},
		} as never,
		{ mark: (_path: string) => undefined } as never,
		service,
	);

	const restoredMemo = await orchestrator.restoreMemo(deletedMemo.id);

	assert.equal(dailyContent, "# 2026-05-18\n\n## Knomo\n- 08:00:00 内容 ^abc123");
	assert.deepEqual(monthlyBlocks, ["- 08:00:00 内容 ^abc123"]);
	assert.equal(restoredMemo.status, "active");
	assert.equal(restoredMemo.deletedAt, undefined);
	assert.equal(restoredMemo.deletedDailyBlock, undefined);
	assert.equal(savedMemos[0]?.dailyRef.lastKnownBlock, "- 08:00:00 内容 ^abc123");
	assert.equal(savedMemos[0]?.monthlyRef.lastKnownBlock, "- 08:00:00 内容 ^abc123");
});

test("restoreMemo keeps deleted status when monthly restore fails and does not duplicate restored daily block", async () => {
	const { SyncOrchestrator } = await loadSyncOrchestrator();
	const { TFile } = await import("obsidian");
	const dailyFile = Object.assign(new TFile(), {
		path: "Daily/2026-05-18.md",
		basename: "2026-05-18",
		extension: "md",
	});
	let dailyContent = "# 2026-05-18\n\n## Knomo\n- 08:00:00 内容 ^abc123";
	let updateCalled = false;
	const deletedMemo = {
		...createReferenceMemo("- 08:00:00 内容 ^abc123"),
		status: "deleted" as const,
		deletedAt: "2026-05-18T09:00:00.000+08:00",
		deletedDailyBlock: "- 08:00:00 内容 ^abc123",
		deletedMonthlyBlock: "- 08:00:00 内容 ^abc123",
	};
	const orchestrator = new SyncOrchestrator(
		{
			vault: {
				getAbstractFileByPath: (_path: string) => dailyFile,
				cachedRead: async () => "",
				process: async (_file: unknown, callback: (content: string) => string) => {
					dailyContent = callback(dailyContent);
					return dailyContent;
				},
			},
		} as never,
		() => createTestSettings(),
		{
			getOrCreateDailyNoteForDate: async () => dailyFile,
		} as never,
		{
			upsertMemoBlock: async () => {
				throw new Error("月度失败");
			},
		} as never,
		{
			findMemoById: async () => deletedMemo,
			updateMemo: async () => {
				updateCalled = true;
				throw new Error("不应更新索引");
			},
		} as never,
		{ mark: (_path: string) => undefined } as never,
		service,
	);

	await assert.rejects(() => orchestrator.restoreMemo(deletedMemo.id), /月度失败/);
	assert.equal(dailyContent, "# 2026-05-18\n\n## Knomo\n- 08:00:00 内容 ^abc123");
	assert.equal(updateCalled, false);
});

test("purgeDeletedMemo only clears a deleted tombstone from the index", async () => {
	const { SyncOrchestrator } = await loadSyncOrchestrator();
	const deletedMemo = {
		...createReferenceMemo("- 08:00:00 内容"),
		status: "deleted" as const,
		deletedAt: "2026-05-18T09:00:00.000+08:00",
	};
	let purgedMemoId = "";
	const orchestrator = new SyncOrchestrator(
		{} as never,
		() => createTestSettings(),
		{} as never,
		{
			deleteMemoBlock: async () => {
				assert.fail("purge should not touch markdown");
			},
		} as never,
		{
			findMemoById: async () => deletedMemo,
			purgeDeletedMemo: async (_folder: string, memoId: string) => {
				purgedMemoId = memoId;
			},
		} as never,
		{ mark: (_path: string) => undefined } as never,
		service,
	);

	await orchestrator.purgeDeletedMemo(deletedMemo.id);
	assert.equal(purgedMemoId, deletedMemo.id);
});

test("deleteMemo no-ops when the latest index memo is already deleted", async () => {
	const { SyncOrchestrator } = await loadSyncOrchestrator();
	const deletedMemo = {
		...createReferenceMemo("- 08:00:00 内容"),
		status: "deleted" as const,
		deletedAt: "2026-05-18T09:00:00.000+08:00",
	};
	let processed = false;
	const orchestrator = new SyncOrchestrator(
		{
			vault: {
				process: async () => {
					processed = true;
					return "";
				},
			},
		} as never,
		() => createTestSettings(),
		{} as never,
		{
			deleteMemoBlock: async () => {
				assert.fail("deleted memo should not delete monthly block again");
			},
		} as never,
		{
			findMemoById: async () => deletedMemo,
		} as never,
		{ mark: (_path: string) => undefined } as never,
		service,
	);

	assert.equal(await orchestrator.deleteMemo(deletedMemo), deletedMemo);
	assert.equal(processed, false);
});

test("deleteMemo marks deleted without monthly_delete_failed when monthlyRef is empty", async () => {
	const { SyncOrchestrator } = await loadSyncOrchestrator();
	const { TFile } = await import("obsidian");
	const dailyFile = Object.assign(new TFile(), {
		path: "Daily/2026-05-18.md",
		basename: "2026-05-18",
		extension: "md",
	});
	let dailyContent = "# 2026-05-18\n\n## Knomo\n- 08:00:00 内容";
	const memo = createReferenceMemo("- 08:00:00 内容");
	memo.dailyRef.lineNumberHint = 4;
	memo.dailyRef.lastKnownHash = hashText(memo.dailyRef.lastKnownBlock);
	memo.monthlyRef = {
		path: "",
		dateHeading: "",
		lastKnownBlock: "",
		lastKnownHash: "",
		lineNumberHint: null,
		lastSyncedAt: null,
	};
	let monthlyDeleteCalled = false;
	let savedMemo: MemoRecord | null = null;
	const orchestrator = new SyncOrchestrator(
		{
			vault: {
				getAbstractFileByPath: (_path: string) => dailyFile,
				process: async (_file: unknown, callback: (content: string) => string) => {
					dailyContent = callback(dailyContent);
					return dailyContent;
				},
			},
		} as never,
		() => createTestSettings(),
		{} as never,
		{
			deleteMemoBlock: async () => {
				monthlyDeleteCalled = true;
				throw new Error("不应删除月度块");
			},
		} as never,
		{
			findMemoById: async () => memo,
			upsertMemo: async (_folder: string, nextMemo: MemoRecord) => {
				savedMemo = nextMemo;
				return nextMemo;
			},
		} as never,
		{ mark: (_path: string) => undefined } as never,
		service,
	);

	const deletedMemo = await orchestrator.deleteMemo(memo);

	assert.equal(monthlyDeleteCalled, false);
	assert.equal(dailyContent, "# 2026-05-18\n\n## Knomo");
	assert.equal(deletedMemo.status, "deleted");
	assert.equal(deletedMemo.syncStatus, "synced");
	assert.equal(deletedMemo.deletedDailyBlock, "- 08:00:00 内容");
	assert.equal(deletedMemo.deletedMonthlyBlock, "");
	assert.equal(deletedMemo.issue, null);
});

test("all-diary rebuild does not read a corrupt live index before committing candidate indexes", async () => {
	const { SyncOrchestrator } = await loadSyncOrchestrator();
	const { TFile } = await import("obsidian");
	const today = new Date();
	const oldDate = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 120);
	const todayPath = `${formatTestDate(today)}.md`;
	const oldPath = `${formatTestDate(oldDate)}.md`;
	const todayFile = Object.assign(new TFile(), {
		path: todayPath,
		basename: todayPath.replace(/\.md$/, ""),
		extension: "md",
	});
	const oldFile = Object.assign(new TFile(), {
		path: oldPath,
		basename: oldPath.replace(/\.md$/, ""),
		extension: "md",
	});
	const contents = new Map<string, string>([
		[todayPath, `# ${formatTestDate(today)}\n\n## Knomo\n- 08:00 今日内容`],
		[oldPath, `# ${formatTestDate(oldDate)}\n\n## Knomo\n- 09:00:00 旧内容`],
	]);
	let backupCalled = false;
	let monthlyCalled = false;
	let created = 0;
	let committed = false;
	let rejectLiveIndexRead = false;
	const candidateStore = {
		initializeEmptyPeriods: async () => undefined,
		addMemo: async (_folder: string, memo: MemoRecord) => {
			created += 1;
			return memo;
		},
		listExistingPeriods: () => [formatTestDate(today).slice(0, 7), formatTestDate(oldDate).slice(0, 7)],
		loadPeriods: async () => [],
		getIndexFilePath: (_folder: string, period: string) => `Memos/_knomo-system/backups/rebuild-index/rebuilt-indexes/memo-index-${period}.json`,
	};
	const orchestrator = new SyncOrchestrator(
		{
			vault: {
				getMarkdownFiles: () => [todayFile, oldFile],
				getAbstractFileByPath: () => null,
				cachedRead: async (file: { path: string }) => contents.get(file.path) ?? "",
			},
		} as never,
		() => createTestSettings(),
		{
			getStatus: () => ({ enabled: true, folder: null, format: "YYYY-MM-DD", message: "ok" }),
			getDailyNotesConfig: async () => ({ folder: null, format: "YYYY-MM-DD" }),
		} as never,
		{
			upsertMemoBlock: async () => {
				monthlyCalled = true;
				throw new Error("index-only rebuild should not write monthly archives");
			},
		} as never,
		{
			loadAll: async () => {
				if (rejectLiveIndexRead) {
					throw new Error("Corrupt memo-index JSON");
				}
				return [];
			},
			backupIndexes: async () => {
				backupCalled = true;
				return "Memos/_knomo-system/backups/rebuild-index";
			},
			createStoreAtIndexFolder: () => candidateStore,
			listExistingPeriods: () => [formatTestDate(today).slice(0, 7)],
			commitCandidateIndexes: async () => {
				committed = true;
			},
		} as never,
		{ mark: (_path: string) => undefined } as never,
		service,
	);

	const estimate = await orchestrator.estimateRebuildIndex("30d");
	assert.equal(estimate.scannedFiles, 1);
	assert.equal(estimate.estimatedNew, 1);

	rejectLiveIndexRead = true;
	const result = await orchestrator.rebuildIndex("all", "index-only");
	assert.equal(result.scannedFiles, 2);
	assert.equal(created, 2);
	assert.equal(backupCalled, true);
	assert.equal(committed, true);
	assert.equal(monthlyCalled, false);
	assert.equal(result.backupPath, "Memos/_knomo-system/backups/rebuild-index");
});

test("all-diary monthly rebuild reuses the existing monthly block reference", async () => {
	const { SyncOrchestrator } = await loadSyncOrchestrator();
	const { TFile } = await import("obsidian");
	const today = new Date();
	const dateText = formatTestDate(today);
	const period = dateText.slice(0, 7);
	const dailyPath = `${dateText}.md`;
	const monthlyPath = `Memos/Memos-${period}.md`;
	const rawBlock = "- 08:00:00 今日内容";
	const dailyFile = Object.assign(new TFile(), {
		path: dailyPath,
		basename: dateText,
		extension: "md",
	});
	const monthlyFile = Object.assign(new TFile(), {
		path: monthlyPath,
		basename: `Memos-${period}`,
		extension: "md",
	});
	const monthlyMemos: MemoRecord[] = [];
	const candidateStore = {
		initializeEmptyPeriods: async () => undefined,
		addMemo: async (_folder: string, memo: MemoRecord) => memo,
		listExistingPeriods: () => [period],
		loadPeriods: async () => [],
		getIndexFilePath: (_folder: string, memoPeriod: string) => `Memos/_knomo-system/backups/rebuild-index/rebuilt-indexes/memo-index-${memoPeriod}.json`,
	};
	const orchestrator = new SyncOrchestrator(
		{
			vault: {
				getMarkdownFiles: () => [dailyFile],
				getAbstractFileByPath: (path: string) => path === monthlyPath ? monthlyFile : null,
				cachedRead: async (file: { path: string }) => file.path === monthlyPath
					? `# ${period}\n\n## ${dateText}\n${rawBlock}`
					: `# ${dateText}\n\n## Knomo\n${rawBlock}`,
			},
		} as never,
		() => createTestSettings(),
		{
			getStatus: () => ({ enabled: true, folder: null, format: "YYYY-MM-DD", message: "ok" }),
			getDailyNotesConfig: async () => ({ folder: null, format: "YYYY-MM-DD" }),
		} as never,
		{
			backupMonthlyArchives: async () => undefined,
			upsertMemoBlock: async (_settings: KnomoSettings, memo: MemoRecord, block: string) => {
				monthlyMemos.push(memo);
				return {
					file: monthlyFile,
					content: block,
					ref: memo.monthlyRef,
				};
			},
		} as never,
		{
			backupIndexes: async () => "Memos/_knomo-system/backups/rebuild-index",
			createStoreAtIndexFolder: () => candidateStore,
			listExistingPeriods: () => [period],
			commitCandidateIndexes: async () => undefined,
		} as never,
		{ mark: (_path: string) => undefined } as never,
		service,
	);

	const result = await orchestrator.rebuildIndex("all", "index-and-monthly");

	assert.equal(result.created, 1);
	assert.equal(monthlyMemos[0]?.monthlyRef.path, monthlyPath);
	assert.equal(monthlyMemos[0]?.monthlyRef.lineNumberHint, 4);
	assert.equal(monthlyMemos[0]?.monthlyRef.lastKnownBlock, rawBlock);
});

test("index-only rebuild does not delete monthly block when indexed memo is missing", async () => {
	const { SyncOrchestrator } = await loadSyncOrchestrator();
	const { TFile } = await import("obsidian");
	const today = new Date();
	const todayPath = `${formatTestDate(today)}.md`;
	const todayFile = Object.assign(new TFile(), {
		path: todayPath,
		basename: todayPath.replace(/\.md$/, ""),
		extension: "md",
	});
	const rawBlock = "- 08:00:00 旧内容";
	const missingMemo = createReferenceMemo(rawBlock);
	missingMemo.id = "missing-index-only-memo";
	missingMemo.createdAt = `${formatTestDate(today)}T08:00:00.000+08:00`;
	missingMemo.updatedAt = missingMemo.createdAt;
	missingMemo.contentSnapshot = "旧内容";
	missingMemo.contentHash = hashMemoContent("旧内容");
	missingMemo.dailyRef = {
		...missingMemo.dailyRef,
		path: todayPath,
		lastKnownBlock: rawBlock,
		lastKnownHash: hashText(rawBlock),
	};
	missingMemo.monthlyRef = {
		...missingMemo.monthlyRef,
		path: "Memos/Memos-2026-05.md",
		lastKnownBlock: rawBlock,
		lastKnownHash: hashText(rawBlock),
	};
	let monthlyDeleteCalled = false;
	const savedMemos: MemoRecord[] = [];
	const orchestrator = new SyncOrchestrator(
		{
			vault: {
				getMarkdownFiles: () => [todayFile],
				cachedRead: async () => `# ${formatTestDate(today)}\n\n## Knomo\n`,
			},
		} as never,
		() => createTestSettings(),
		{
			getStatus: () => ({ enabled: true, folder: null, format: "YYYY-MM-DD", message: "ok" }),
			getDailyNotesConfig: async () => ({ folder: null, format: "YYYY-MM-DD" }),
		} as never,
		{
			deleteMemoBlock: async () => {
				monthlyDeleteCalled = true;
				throw new Error("index-only rebuild should not delete monthly archives");
			},
		} as never,
		{
			loadAll: async () => [missingMemo],
			upsertMemo: async (_folder: string, memo: MemoRecord) => {
				savedMemos.push(memo);
				return memo;
			},
			backupIndexes: async () => "Memos/_knomo-system/backups/rebuild-index",
			restoreIndexes: async () => undefined,
		} as never,
		{ mark: (_path: string) => undefined } as never,
		service,
	);

	const result = await orchestrator.rebuildIndex("30d", "index-only");

	assert.equal(monthlyDeleteCalled, false);
	assert.equal(result.deleted, 1);
	assert.equal(savedMemos[0]?.status, "deleted");
	assert.equal(savedMemos[0]?.deletedMonthlyBlock, rawBlock);
});

test("rebuild index restores backup when monthly rebuild fails", async () => {
	const { SyncOrchestrator } = await loadSyncOrchestrator();
	const { TFile } = await import("obsidian");
	const today = new Date();
	const todayPath = `${formatTestDate(today)}.md`;
	const todayFile = Object.assign(new TFile(), {
		path: todayPath,
		basename: todayPath.replace(/\.md$/, ""),
		extension: "md",
	});
	const backupPath = "Memos/_knomo-system/backups/rebuild-index-20260521-120000";
	let monthlyCalled = false;
	let monthlyBackupCalled = false;
	let monthlyRestoreCalled = false;
	let restoreCalled = false;
	const orchestrator = new SyncOrchestrator(
		{
			vault: {
				getMarkdownFiles: () => [todayFile],
				getAbstractFileByPath: () => null,
				cachedRead: async () => `# ${formatTestDate(today)}\n\n## Knomo\n- 08:00 今日内容`,
			},
		} as never,
		() => createTestSettings(),
		{
			getStatus: () => ({ enabled: true, folder: null, format: "YYYY-MM-DD", message: "ok" }),
			getDailyNotesConfig: async () => ({ folder: null, format: "YYYY-MM-DD" }),
		} as never,
		{
			backupMonthlyArchives: async (_settings: KnomoSettings, monthlyBackupPath: string | null) => {
				monthlyBackupCalled = true;
				assert.equal(monthlyBackupPath, backupPath);
			},
			restoreMonthlyArchives: async (_settings: KnomoSettings, monthlyBackupPath: string | null) => {
				monthlyRestoreCalled = true;
				assert.equal(monthlyBackupPath, backupPath);
			},
			upsertMemoBlock: async () => {
				monthlyCalled = true;
				throw new Error("月度写入失败");
			},
		} as never,
		{
			loadAll: async () => [],
			addMemo: async (_folder: string, memo: MemoRecord) => memo,
			backupIndexes: async () => backupPath,
			restoreIndexes: async (_folder: string, restoredBackupPath: string | null) => {
				restoreCalled = true;
				assert.equal(restoredBackupPath, backupPath);
			},
		} as never,
		{ mark: (_path: string) => undefined } as never,
		service,
	);

	await assert.rejects(
		() => orchestrator.rebuildIndex("30d", "index-and-monthly"),
		/Rebuild index failed: 1 files did not sync; stopped refreshing the view\./,
	);
	assert.equal(monthlyCalled, true);
	assert.equal(monthlyBackupCalled, true);
	assert.equal(monthlyRestoreCalled, true);
	assert.equal(restoreCalled, true);
});

test("restoreIndexes removes index files that were created by a failed rebuild", async () => {
	const { MemoIndexStore } = await loadMemoIndexStore();
	const { TFile, TFolder, Vault } = await import("obsidian");
	const backupPath = "Memos/_knomo-system/backups/rebuild-index-20260521-120000";
	const indexBackupPath = `${backupPath}/indexes`;
	const monthlyFolder = Object.assign(new TFolder(), { path: "Memos", children: [] as unknown[] });
	const systemFolder = Object.assign(new TFolder(), { path: "Memos/_knomo-system", children: [] as unknown[] });
	const indexFolder = Object.assign(new TFolder(), { path: "Memos/_knomo-system/indexes", children: [] as unknown[] });
	const backupFolder = Object.assign(new TFolder(), { path: indexBackupPath, children: [] as unknown[] });
	const existingIndexFile = Object.assign(new TFile(), { path: "Memos/_knomo-system/indexes/memo-index-2026-05.json" });
	const failedIndexFile = Object.assign(new TFile(), { path: "Memos/_knomo-system/indexes/memo-index-2026-06.json" });
	const backupIndexFile = Object.assign(new TFile(), { path: `${indexBackupPath}/memo-index-2026-05.json` });
	indexFolder.children = [existingIndexFile, failedIndexFile];
	backupFolder.children = [backupIndexFile];
	const filesByPath = new Map<string, unknown>([
		[monthlyFolder.path, monthlyFolder],
		[systemFolder.path, systemFolder],
		[indexFolder.path, indexFolder],
		[backupFolder.path, backupFolder],
		[existingIndexFile.path, existingIndexFile],
		[failedIndexFile.path, failedIndexFile],
		[backupIndexFile.path, backupIndexFile],
	]);
	const contents = new Map<string, string>([
		[existingIndexFile.path, "failed content"],
		[backupIndexFile.path, "backup content"],
	]);
	const deletedPaths: string[] = [];
	const originalRecurseChildren = Vault.recurseChildren;
	Vault.recurseChildren = ((folder: { children: unknown[] }, callback: (child: unknown) => void) => {
		for (const child of folder.children) {
			callback(child);
		}
	}) as typeof Vault.recurseChildren;

	try {
		const store = new MemoIndexStore({
			vault: {
				getAbstractFileByPath: (path: string) => filesByPath.get(path) ?? null,
				cachedRead: async (file: { path: string }) => contents.get(file.path) ?? "",
				process: async (file: { path: string }, callback: (content: string) => string) => {
					const nextContent = callback(contents.get(file.path) ?? "");
					contents.set(file.path, nextContent);
					return nextContent;
				},
				create: async (path: string, content: string) => {
					const file = Object.assign(new TFile(), { path });
					filesByPath.set(path, file);
					contents.set(path, content);
					return file;
				},
				createFolder: async (path: string) => {
					const folder = Object.assign(new TFolder(), { path, children: [] });
					filesByPath.set(path, folder);
					return folder;
				},
			},
			fileManager: {
				trashFile: async (file: { path: string }) => {
					deletedPaths.push(file.path);
					filesByPath.delete(file.path);
				},
			},
		} as never);

		await store.restoreIndexes("Memos", backupPath);
	} finally {
		Vault.recurseChildren = originalRecurseChildren;
	}

	assert.deepEqual(deletedPaths, [failedIndexFile.path]);
	assert.equal(contents.get(existingIndexFile.path), "backup content");
});

test("restoreMonthlyArchives restores old archives and removes failed rebuild archives", async () => {
	const { MonthlyArchiveService } = await loadMonthlyArchiveService();
	const { TFile, TFolder, Vault } = await import("obsidian");
	const backupPath = "Memos/_knomo-system/backups/rebuild-index-20260521-120000";
	const monthlyBackupPath = `${backupPath}/monthly`;
	const monthlyFolder = Object.assign(new TFolder(), { path: "Memos", children: [] as unknown[] });
	const backupFolder = Object.assign(new TFolder(), { path: monthlyBackupPath, children: [] as unknown[] });
	const existingMonthlyFile = Object.assign(new TFile(), { path: "Memos/Memos-2026-05.md" });
	const failedMonthlyFile = Object.assign(new TFile(), { path: "Memos/Memos-2026-06.md" });
	const backupMonthlyFile = Object.assign(new TFile(), { path: `${monthlyBackupPath}/Memos-2026-05.md` });
	monthlyFolder.children = [existingMonthlyFile, failedMonthlyFile];
	backupFolder.children = [backupMonthlyFile];
	const filesByPath = new Map<string, unknown>([
		[monthlyFolder.path, monthlyFolder],
		[backupFolder.path, backupFolder],
		[existingMonthlyFile.path, existingMonthlyFile],
		[failedMonthlyFile.path, failedMonthlyFile],
		[backupMonthlyFile.path, backupMonthlyFile],
	]);
	const contents = new Map<string, string>([
		[existingMonthlyFile.path, "failed content"],
		[backupMonthlyFile.path, "backup content"],
	]);
	const deletedPaths: string[] = [];
	const originalRecurseChildren = Vault.recurseChildren;
	Vault.recurseChildren = ((folder: { children: unknown[] }, callback: (child: unknown) => void) => {
		for (const child of folder.children) {
			callback(child);
		}
	}) as typeof Vault.recurseChildren;

	try {
		const service = new MonthlyArchiveService({
			vault: {
				getAbstractFileByPath: (path: string) => filesByPath.get(path) ?? null,
				cachedRead: async (file: { path: string }) => contents.get(file.path) ?? "",
				process: async (file: { path: string }, callback: (content: string) => string) => {
					const nextContent = callback(contents.get(file.path) ?? "");
					contents.set(file.path, nextContent);
					return nextContent;
				},
				create: async (path: string, content: string) => {
					const file = Object.assign(new TFile(), { path });
					filesByPath.set(path, file);
					contents.set(path, content);
					return file;
				},
				createFolder: async (path: string) => {
					const folder = Object.assign(new TFolder(), { path, children: [] });
					filesByPath.set(path, folder);
					return folder;
				},
			},
			fileManager: {
				trashFile: async (file: { path: string }) => {
					deletedPaths.push(file.path);
					filesByPath.delete(file.path);
				},
			},
		} as never);

		await service.restoreMonthlyArchives(createTestSettings(), backupPath);
	} finally {
		Vault.recurseChildren = originalRecurseChildren;
	}

	assert.deepEqual(deletedPaths, [failedMonthlyFile.path]);
	assert.equal(contents.get(existingMonthlyFile.path), "backup content");
});

test("monthly archive insertion preserves trailing blank lines in a date heading section", async () => {
	const { MonthlyArchiveService, MONTHLY_ARCHIVE_READONLY_COMMENT } = await loadMonthlyArchiveService();
	const { TFile } = await import("obsidian");
	const monthlyFile = Object.assign(new TFile(), {
		path: "Memos/Memos-2026-05.md",
		basename: "Memos-2026-05",
		extension: "md",
	});
	const content = [
		MONTHLY_ARCHIVE_READONLY_COMMENT,
		"",
		"# 2026-05",
		"",
		"## 2026-05-14",
		"",
		"- 11:00:00 旧 memo",
		"",
		"",
		"## 2026-05-15",
	].join("\n");
	const contents = new Map<string, string>([[monthlyFile.path, content]]);
	const archiveService = new MonthlyArchiveService({
		vault: {
			getAbstractFileByPath: (path: string) => path === monthlyFile.path ? monthlyFile : null,
			process: async (file: { path: string }, callback: (content: string) => string) => {
				const nextContent = callback(contents.get(file.path) ?? "");
				contents.set(file.path, nextContent);
				return nextContent;
			},
		},
	} as never);

	const result = await archiveService.insertMemoBlock(
		createTestSettings(),
		new Date("2026-05-14T12:00:00"),
		service.buildMemoBlock("新 memo", "12:00:00"),
	);

	assert.equal(
		result.content,
		[
			MONTHLY_ARCHIVE_READONLY_COMMENT,
			"",
			"# 2026-05",
			"",
			"## 2026-05-14",
			"",
			"- 11:00:00 旧 memo",
			"- 12:00:00 新 memo",
			"",
			"",
			"## 2026-05-15",
		].join("\n"),
	);
});

test("legacy daily memo preview groups headings and root while ignoring frontmatter, tasks, and code fences", async () => {
	const { SyncOrchestrator } = await loadSyncOrchestrator();
	const { TFile } = await import("obsidian");
	const file = Object.assign(new TFile(), {
		path: "2026-05-18.md",
		basename: "2026-05-18",
		extension: "md",
	});
	const content = [
		"---",
		"- 06:00 frontmatter",
		"---",
		"- 07:00 root #tag [[Link]] ![[Assets/a.png]]",
		"  root continuation",
		"- [ ] 08:00 task",
		"- normal list",
		"```",
		"- 08:30 code",
		"```",
		"## Memos",
		"- 09:00 heading memo",
		"## 随手记",
		"- 10:00:12 other memo ^abc123",
	].join("\n");
	const orchestrator = new SyncOrchestrator(
		{
			vault: {
				getMarkdownFiles: () => [file],
				cachedRead: async () => content,
			},
		} as never,
		() => createTestSettings(),
		{
			getDailyNotesConfig: async () => ({ folder: null, format: "YYYY-MM-DD" }),
			getStatus: () => ({ enabled: true, folder: null, format: "YYYY-MM-DD", message: "ok" }),
		} as never,
		{} as never,
		{ loadAll: async () => [] } as never,
		{ mark: (_path: string) => undefined } as never,
		service,
	);

	const preview = await orchestrator.previewLegacyDailyMemos("all");
	const root = preview.groups.find((group) => group.key === "root");
	const memos = preview.groups.find((group) => group.key === "heading:## Memos");
	const other = preview.groups.find((group) => group.key === "heading:## 随手记");

	assert.equal(preview.scannedFiles, 1);
	assert.equal(preview.candidateCount, 3);
	assert.equal(root?.count, 1);
	assert.equal(root?.selectedByDefault, false);
	assert.equal(root?.samples[0]?.content, "root #tag [[Link]] ![[Assets/a.png]]\nroot continuation");
	assert.equal(memos?.count, 1);
	assert.equal(memos?.selectedByDefault, true);
	assert.equal(other?.count, 1);
	assert.equal(other?.selectedByDefault, false);
});

test("legacy daily memo import skips duplicates and preserves root daily refs", async () => {
	const { SyncOrchestrator } = await loadSyncOrchestrator();
	const { TFile } = await import("obsidian");
	const file = Object.assign(new TFile(), {
		path: "2026-05-18.md",
		basename: "2026-05-18",
		extension: "md",
	});
	const content = [
		"- 07:00 root memo",
		"## Memos",
		"- 09:00 duplicate memo",
		"## 随手记",
		"- 10:00 other memo",
	].join("\n");
	const duplicate = createReferenceMemo("- 09:00 duplicate memo");
	duplicate.dailyRef.path = file.path;
	duplicate.dailyRef.heading = "## Memos";
	duplicate.dailyRef.lastKnownHash = hashText(duplicate.dailyRef.lastKnownBlock);
	duplicate.contentSnapshot = "duplicate memo";
	duplicate.contentHash = hashMemoContent("duplicate memo");
	const importedMemos: MemoRecord[] = [];
	const monthlyBlocks: string[] = [];
	const orchestrator = new SyncOrchestrator(
		{
			vault: {
				getMarkdownFiles: () => [file],
				cachedRead: async () => content,
			},
		} as never,
		() => createTestSettings(),
		{
			getDailyNotesConfig: async () => ({ folder: null, format: "YYYY-MM-DD" }),
			getStatus: () => ({ enabled: true, folder: null, format: "YYYY-MM-DD", message: "ok" }),
		} as never,
		{
			upsertMemoBlock: async (_settings: KnomoSettings, _memo: MemoRecord, block: string) => {
				monthlyBlocks.push(block);
				return {
					file: { path: "Memos/Memos-2026-05.md" },
					content: block,
					ref: {
						path: "Memos/Memos-2026-05.md",
						dateHeading: "## 2026-05-18",
						lastKnownBlock: block,
						lastKnownHash: hashText(block),
						lineNumberHint: 1,
						lastSyncedAt: "2026-05-18T10:00:00.000+08:00",
					},
				};
			},
		} as never,
		{
			loadAll: async () => [duplicate],
			addMemo: async (_folder: string, memo: MemoRecord) => {
				importedMemos.push(memo);
				return memo;
			},
		} as never,
		{ mark: (_path: string) => undefined } as never,
		service,
	);

	const result = await orchestrator.importLegacyDailyMemos({
		scope: "all",
		selectedGroupKeys: ["root", "heading:## Memos", "heading:## 随手记"],
	});

	const rootMemo = importedMemos.find((memo) => memo.dailyRef.sectionType === "root");
	const headingMemo = importedMemos.find((memo) => memo.dailyRef.heading === "## 随手记");
	assert.equal(result.imported, 2);
	assert.equal(result.skipped, 1);
	assert.equal(rootMemo?.dailyRef.heading, null);
	assert.equal(rootMemo?.dailyRef.sectionType, "root");
	assert.equal(headingMemo?.dailyRef.sectionType, "heading");
	assert.deepEqual(result.importedHeadings, ["## 随手记"]);
	assert.deepEqual(monthlyBlocks, ["- 07:00 root memo", "- 10:00 other memo"]);
});

test("legacy daily memo import preserves existing Obsidian block IDs without mutating daily markdown", async () => {
	const { SyncOrchestrator } = await loadSyncOrchestrator();
	const { TFile } = await import("obsidian");
	const file = Object.assign(new TFile(), {
		path: "2026-05-18.md",
		basename: "2026-05-18",
		extension: "md",
	});
	const content = "## Memos\n- 09:00 imported memo\n- 10:00 existing memo ^abc123";
	const importedMemos: MemoRecord[] = [];
	const monthlyBlocks: string[] = [];
	const orchestrator = new SyncOrchestrator(
		{
			vault: {
				getMarkdownFiles: () => [file],
				cachedRead: async () => content,
				process: async () => {
					throw new Error("旧导入不应修改日记文件。");
				},
			},
		} as never,
		() => createTestSettings(),
		{
			getDailyNotesConfig: async () => ({ folder: null, format: "YYYY-MM-DD" }),
			getStatus: () => ({ enabled: true, folder: null, format: "YYYY-MM-DD", message: "ok" }),
		} as never,
		{
			upsertMemoBlock: async (_settings: KnomoSettings, _memo: MemoRecord, block: string) => {
				monthlyBlocks.push(block);
				return {
					file: { path: "Memos/Memos-2026-05.md" },
					content: block,
					ref: {
						path: "Memos/Memos-2026-05.md",
						dateHeading: "## 2026-05-18",
						lastKnownBlock: block,
						lastKnownHash: hashText(block),
						lineNumberHint: 1,
						lastSyncedAt: "2026-05-18T10:00:00.000+08:00",
					},
				};
			},
		} as never,
		{
			loadAll: async () => [],
			addMemo: async (_folder: string, memo: MemoRecord) => {
				importedMemos.push(memo);
				return memo;
			},
		} as never,
		{ mark: (_path: string) => undefined } as never,
		service,
	);

	const result = await orchestrator.importLegacyDailyMemos({
		scope: "all",
		selectedGroupKeys: ["heading:## Memos"],
	});

	const missingBlockIdMemo = importedMemos.find((memo) => memo.contentSnapshot === "imported memo");
	const existingBlockIdMemo = importedMemos.find((memo) => memo.contentSnapshot === "existing memo");
	assert.equal(result.imported, 2);
	assert.equal(content, "## Memos\n- 09:00 imported memo\n- 10:00 existing memo ^abc123");
	assert.deepEqual(monthlyBlocks, ["- 09:00 imported memo", "- 10:00 existing memo ^abc123"]);
	assert.equal(missingBlockIdMemo?.dailyRef.lastKnownBlock, "- 09:00 imported memo");
	assert.equal(existingBlockIdMemo?.dailyRef.lastKnownBlock, "- 10:00 existing memo ^abc123");
});

async function loadDailyNotesProvider(): Promise<typeof import("../src/services/DailyNotesProvider")> {
	await ensureObsidianStub();
	return import("../src/services/DailyNotesProvider");
}

async function loadDailyNoteService(): Promise<typeof import("../src/services/DailyNoteService")> {
	await ensureObsidianStub();
	return import("../src/services/DailyNoteService");
}

async function loadSyncOrchestrator(): Promise<typeof import("../src/services/SyncOrchestrator")> {
	await ensureObsidianStub();
	return import("../src/services/SyncOrchestrator");
}

async function loadMemoIndexStore(): Promise<typeof import("../src/services/MemoIndexStore")> {
	await ensureObsidianStub();
	return import("../src/services/MemoIndexStore");
}

async function loadMonthlyArchiveService(): Promise<typeof import("../src/services/MonthlyArchiveService")> {
	await ensureObsidianStub();
	return import("../src/services/MonthlyArchiveService");
}

async function loadReferenceService(): Promise<typeof import("../src/services/ReferenceService")> {
	await ensureObsidianStub();
	return import("../src/services/ReferenceService");
}

function createTestSettings(): KnomoSettings {
	return {
		settingsVersion: 2,
		dailyHeading: "## Knomo",
		dailyInsertPosition: "bottom",
		memoTimeFormat: "HH:mm:ss",
		monthlyMemoFolder: "Memos",
		monthlyMemoFileFormat: "Memos-YYYY-MM.md",
		monthlyDateHeadingFormat: "## YYYY-MM-DD",
		monthlyDateOrder: "asc",
		legacyDailyHeadings: [],
		mobileCompactMode: "auto",
		syncDebounceMs: 1000,
		desktopSidebarWidth: 248,
		desktopSidebarCollapsed: false,
		excludeMonthlyMemosFromObsidian: false,
		managedObsidianExcludeRuleOwned: false,
		pinnedTags: [],
	};
}

function createReferenceMemo(rawBlock: string): MemoRecord {
	return {
		id: "2026051808000000",
		createdAt: "2026-05-18T08:00:00.000+08:00",
		updatedAt: "2026-05-18T08:00:00.000+08:00",
		contentSnapshot: "内容",
		contentHash: hashMemoContent("内容"),
		status: "active",
		syncStatus: "synced",
		source: "plugin_input",
		version: 1,
		tags: [],
		links: [],
		images: [],
		references: [],
		sourceMemoId: null,
		issue: null,
		lastMarkdownSyncAt: null,
		lastMarkdownSyncSource: null,
		dailyRef: {
			path: "Daily/2026-05-18.md",
			heading: "## Knomo",
			lastKnownBlock: rawBlock,
			lastKnownHash: "",
			lineNumberHint: 1,
			lastSyncedAt: "2026-05-18T08:00:00.000+08:00",
		},
		monthlyRef: {
			path: "Memos/Memos-2026-05.md",
			dateHeading: "## 2026-05-18",
			lastKnownBlock: rawBlock,
			lastKnownHash: "",
			lineNumberHint: 1,
			lastSyncedAt: "2026-05-18T08:00:00.000+08:00",
		},
	};
}

function formatTestDate(date: Date): string {
	const year = date.getFullYear();
	const month = String(date.getMonth() + 1).padStart(2, "0");
	const day = String(date.getDate()).padStart(2, "0");
	return `${year}-${month}-${day}`;
}

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
					if (options.configFile === undefined) {
						throw new Error("missing config file");
					}
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
	if (value === undefined) {
		delete globalRecord["window"];
	} else {
		globalRecord["window"] = value;
	}
	return () => {
		if (!hadWindow) {
			delete globalRecord["window"];
			return;
		}
		globalRecord["window"] = previousWindow;
	};
}

async function ensureObsidianStub(): Promise<void> {
	const stubPath = resolve(__dirname, "../node_modules/obsidian/index.js");
	await mkdir(dirname(stubPath), { recursive: true });
	await writeFile(
		stubPath,
			[
				"class TFile {}",
				"class TFolder { constructor() { this.children = []; } }",
				"const Vault = { recurseChildren() {} };",
				"const normalizePath = (value) => value.replace(/\\\\/g, '/').replace(/\\/+/g, '/').replace(/^\\//, '').replace(/\\/$/, '');",
				"let languageValue = 'en';",
				"function getLanguage() { return languageValue; }",
				"getLanguage.set = (value) => { languageValue = value; };",
				"function setIcon(el, icon) { if (el && typeof el.setAttr === 'function') el.setAttr('data-icon', icon); return el; }",
				"function addIcon() {}",
				"let localeValue = 'en';",
				"const moment = (date = new Date()) => ({ format: () => date.toISOString().slice(0, 10) });",
				"moment.locale = (value) => { if (typeof value === 'string') localeValue = value; return localeValue; };",
				"module.exports = { TFile, TFolder, Vault, normalizePath, moment, getLanguage, setIcon, addIcon };",
			].join("\n"),
	);
	const dailyNotesInterfaceStubPath = resolve(__dirname, "../node_modules/obsidian-daily-notes-interface/index.js");
	await mkdir(dirname(dailyNotesInterfaceStubPath), { recursive: true });
	await writeFile(
		dailyNotesInterfaceStubPath,
		[
			"async function createDailyNote(date) {",
			"  return window.__knomoCreateDailyNote(date);",
			"}",
			"module.exports = { createDailyNote };",
		].join("\n"),
	);
}
