import test from "node:test";
import assert from "node:assert/strict";

import { MarkdownBlockService } from "../src/services/MarkdownBlockService";
import { parseDailyNoteDateFromPath } from "../src/utils/dailyNotes";
import { hashMemoContent } from "../src/utils/hash";
import { isSupportedMemoImage } from "../src/utils/markdown";
import {
	buildQuoteCreatedMemoContent,
	formatCreatedAtAlias,
	stripTrailingWikiLink,
	withCreatedAtAlias,
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

test("hash ignores blockId", () => {
	assert.equal(hashMemoContent("第一行"), hashMemoContent("第一行 ^abc123"));
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

	const file = await dailyNoteService.getOrCreateDailyNoteForDateWithConfig(new Date("2026-05-14T10:00:00"), { folder: "Daily", format: "YYYY-MM-DD" });

	assert.equal(file, existingFile);
	assert.equal(createCalls, 0);
});

test("daily note creation without a template creates an empty file", async () => {
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

		const file = await dailyNoteService.getOrCreateDailyNoteForDateWithConfig(new Date("2026-05-14T10:00:00"), { folder: "Daily", format: "YYYY-MM-DD" });

		assert.equal(file.path, "Daily/2026-05-14.md");
	} finally {
		restoreWindow();
	}
});

test("disabled Daily Notes cannot provide a creation path", async () => {
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

	assert.equal(dailyNoteService.getStatus().enabled, false);
	assert.throws(
		() => dailyNoteService.getDailyNotePathForDate(new Date("2026-05-14T10:00:00")),
		/Daily Notes/,
	);
});

test("appends blockId to list-leading memo content", () => {
	assert.equal(
		service.buildMemoBlockWithBlockId("- 第一项\n- 第二项", "12:00:00", "abc123"),
		"- 12:00:00\n\t- 第一项\n\t- 第二项 ^abc123",
	);
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

test("formats new reference aliases from createdAt without exposing internal memoId", () => {
	const memoId = "m_0123456789abcdef0123456789abcdef";
	const referenceText = withCreatedAtAlias(
		`[[Daily/2026-06-05#^abc123|${memoId}]]`,
		"2026-06-05T14:30:12.987+08:00",
	);

	assert.equal(referenceText, "[[Daily/2026-06-05#^abc123|20260605-143012]]");
	assert.equal(referenceText.includes(memoId), false);
	assert.equal(formatCreatedAtAlias("2026-06-05T14:30:12"), "20260605-143012");
	assert.equal(withCreatedAtAlias("[target](../Daily/Note.md#%5Eblock)", "2026-06-05T14:30"),
		"[20260605-1430](../Daily/Note.md#%5Eblock)");
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
