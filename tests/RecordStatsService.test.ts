import test from "node:test";
import assert from "node:assert/strict";
import { createDeferred } from "./helpers/deferred";

import {
	canAdvanceRecordStatsDate,
	canRetreatRecordStatsDate,
	getRecordStatsRange,
	RecordStatsService as ProductionRecordStatsService,
	shiftRecordStatsDate,
} from "../src/services/RecordStatsService";
import type { PreparedRecordStats } from "../src/services/RecordStatsService";
import type { MemoViewItem } from "../src/types/memoView";
import { buildRecordStatsCatalogQuery } from "../src/services/CatalogReadService";
import { ensureObsidianStub } from "./helpers/obsidianStub";

class RecordStatsService extends ProductionRecordStatsService {
	async prepare(memos: readonly MemoViewItem[], yieldToUi: () => Promise<void>): Promise<boolean> {
		const reader = await createCatalogReader(memos);
		return this.prepareFromSource(memos, isCurrent => reader.buildRecordStats(yieldToUi, isCurrent));
	}
}

test("prepares overview and selects weekly statistics with natural-day boundaries", async () => {
	const service = new RecordStatsService();
	// 本测试使用本地日历时间，避免依赖运行机器的时区。
	const memos = [
		makeMemo("monday-early", "2026-06-08T00:00:00.000", "中文 one 1", {
			tags: ["work"],
			images: [{ path: "photo.png", altText: "", syntax: "obsidian_embed" }],
		}),
		makeMemo("monday-late", "2026-06-08T23:59:59.999", "two words"),
		makeMemo("sunday", "2026-06-14T23:30:00.000", "三", {
			tags: ["journal"],
			images: [{ path: "document.pdf", altText: "", syntax: "obsidian_embed" }],
		}),
		makeMemo("next-week", "2026-06-15T00:00:00.000", "next"),
		makeMemo("deleted", "2020-06-09T12:00:00.000", "deleted", { status: "deleted" }),
	];

	assert.equal(await service.prepare(memos, async () => {}), true);
	assert.equal(service.getSnapshot().state, "ready");
	assert.equal(service.getEarliestYear(), 2026);
	const selected = service.select("week", new Date(2026, 5, 10));
	assert.notEqual(selected, null);
	assert.deepEqual(selected?.overview, {
		memoCount: 4,
		// 标签现在来自真实 Markdown，标签文字也属于当前正文计数。
		wordCount: 10,
		recordDayCount: 3,
	});
	assert.deepEqual(selected?.range, {
		memoCount: 3,
		wordCount: 9,
		recordDayCount: 2,
		referenceMemoCount: 0,
		taggedMemoCount: 2,
		untaggedMemoCount: 1,
		imageMemoCount: 1,
		maxDailyMemoCount: 2,
		maxDailyWordCount: 7,
		maxDailyMemoDates: ["2026-06-08"],
		maxDailyWordDates: ["2026-06-08"],
	});
	assert.deepEqual(selected?.trend.map((point) => point.count), [2, 0, 0, 0, 0, 0, 1]);
	assert.equal(selected?.activeHours[0].count, 1);
	assert.equal(selected?.activeHours[23].count, 2);
	const reader = await createCatalogReader(memos);
	assert.equal((await reader.count(buildRecordStatsCatalogQuery({
		type: "day",
		date: "2026-06-08",
	}).query)).count, 2);
	assert.equal((await reader.count(buildRecordStatsCatalogQuery({
		type: "range",
		startDate: selected?.startDate ?? "",
		endDateExclusive: selected?.endDateExclusive ?? "",
	}).query)).count, 3);
	assert.equal((await reader.count(buildRecordStatsCatalogQuery({
		type: "references",
		startDate: selected?.startDate ?? "",
		endDateExclusive: selected?.endDateExclusive ?? "",
	}).query)).count, 0);
	assert.equal((await reader.count(buildRecordStatsCatalogQuery({
		type: "with-tag",
		startDate: selected?.startDate ?? "",
		endDateExclusive: selected?.endDateExclusive ?? "",
	}).query)).count, 2);
	assert.equal((await reader.count(buildRecordStatsCatalogQuery({
		type: "no-tag",
		startDate: selected?.startDate ?? "",
		endDateExclusive: selected?.endDateExclusive ?? "",
	}).query)).count, 1);
	assert.equal((await reader.count(buildRecordStatsCatalogQuery({
		type: "with-image",
		startDate: selected?.startDate ?? "",
		endDateExclusive: selected?.endDateExclusive ?? "",
	}).query)).count, 1);
	assert.equal((await reader.count(buildRecordStatsCatalogQuery({
		type: "hour",
		startDate: selected?.startDate ?? "",
		endDateExclusive: selected?.endDateExclusive ?? "",
		hour: 23,
	}).query)).count, 2);
});

test("统计使用 Daily 日期和 Markdown 时间，不随设备时区换日", async () => {
	const originalTimeZone = process.env.TZ;
	process.env.TZ = "Asia/Shanghai";
	try {
		const service = new RecordStatsService();
		const memos = [
			makeMemo("same-zone", "2026-06-08T01:00:00.000+08:00", "a"),
			makeMemo("previous-day", "2026-06-08T00:30:00.000+09:00", "b"),
		];

		await service.prepare(memos, async () => {});
		const currentWeek = service.select("week", new Date(2026, 5, 8));
		const previousWeek = service.select("week", new Date(2026, 5, 1));
		assert.equal(currentWeek?.range.memoCount, 2);
		assert.equal(currentWeek?.activeHours[1].count, 1);
		assert.equal(currentWeek?.activeHours[0].count, 1);
		assert.equal(previousWeek?.range.memoCount, 0);
	} finally {
		if (originalTimeZone === undefined) delete process.env.TZ;
		else process.env.TZ = originalTimeZone;
	}
});

test("counts historical references recoverable from a Knomo memoId alias", async () => {
	const service = new RecordStatsService();
	const historicalReference = makeMemo(
		"historical-reference",
		"2026-06-08T09:00:00.000+08:00",
		"内容 [[Daily/2026-06-07#^abc123|20260607-080000-01]]",
	);

	await service.prepare([historicalReference], async () => {});
	const selected = service.select("week", new Date(2026, 5, 8));

	assert.equal(selected?.range.referenceMemoCount, 1);
	const reader = await createCatalogReader([historicalReference]);
	assert.equal((await reader.count(buildRecordStatsCatalogQuery({
		type: "references",
		startDate: "2026-06-08",
		endDateExclusive: "2026-06-15",
	}).query)).count, 1);
});

test("builds month and year trends including leap day", async () => {
	const service = new RecordStatsService();
	const memos = [
		makeMemo("leap", "2024-02-29T12:00:00+08:00", "leap"),
		makeMemo("march-a", "2024-03-01T12:00:00+08:00", "march"),
		makeMemo("march-b", "2024-03-31T12:00:00+08:00", "march"),
	];

	await service.prepare(memos, async () => {});
	const month = service.select("month", new Date(2024, 1, 12));
	assert.equal(month?.trend.length, 29);
	assert.equal(month?.trend[28].count, 1);
	const year = service.select("year", new Date(2024, 7, 1));
	assert.equal(year?.trend.length, 12);
	assert.equal(year?.trend[1].count, 1);
	assert.equal(year?.trend[2].count, 2);
});

test("retains every tied maximum date", async () => {
	const service = new RecordStatsService();
	await service.prepare([
		makeMemo("a", "2026-06-08T10:00:00+08:00", "one"),
		makeMemo("b", "2026-06-09T10:00:00+08:00", "two"),
	], async () => {});

	const selected = service.select("week", new Date(2026, 5, 8));
	assert.deepEqual(selected?.range.maxDailyMemoDates, ["2026-06-08", "2026-06-09"]);
	assert.deepEqual(selected?.range.maxDailyWordDates, ["2026-06-08", "2026-06-09"]);
});

test("returns the top ten normalized tags by memo count", async () => {
	const service = new RecordStatsService();
	const memos = [
		makeMemo("a", "2026-06-08T10:00:00+08:00", "one", { tags: ["#Work", "work", "alpha"] }),
		makeMemo("b", "2026-06-09T10:00:00+08:00", "two", { tags: ["WORK", "beta"] }),
		makeMemo("c", "2026-06-10T10:00:00+08:00", "three", { tags: ["gamma"] }),
		makeMemo("d", "2026-06-11T10:00:00+08:00", "four", { tags: ["delta"] }),
		makeMemo("e", "2026-06-12T10:00:00+08:00", "five", { tags: ["epsilon"] }),
		makeMemo("f", "2026-06-13T10:00:00+08:00", "six", { tags: ["zeta", "eta", "theta", "iota", "kappa", "lambda", "mu"] }),
		makeMemo("outside", "2026-06-15T10:00:00+08:00", "outside", { tags: ["alpha"] }),
	];

	await service.prepare(memos, async () => {});
	const selected = service.select("week", new Date(2026, 5, 10));
	assert.deepEqual(selected?.commonTags, [
		{ key: "work", label: "WORK", count: 2 },
		{ key: "alpha", label: "alpha", count: 1 },
		{ key: "beta", label: "beta", count: 1 },
		{ key: "delta", label: "delta", count: 1 },
		{ key: "epsilon", label: "epsilon", count: 1 },
		{ key: "eta", label: "eta", count: 1 },
		{ key: "gamma", label: "gamma", count: 1 },
		{ key: "iota", label: "iota", count: 1 },
		{ key: "kappa", label: "kappa", count: 1 },
		{ key: "lambda", label: "lambda", count: 1 },
	]);
	const reader = await createCatalogReader(memos);
	for (const tag of selected?.commonTags ?? []) {
		assert.equal((await reader.count(buildRecordStatsCatalogQuery({
			type: "tag",
			startDate: selected?.startDate ?? "",
			endDateExclusive: selected?.endDateExclusive ?? "",
			tagKey: tag.key,
			tagLabel: tag.label,
		}).query)).count, tag.count);
	}
});

test("returns an empty common-tag list when the selected range has no tags", async () => {
	const service = new RecordStatsService();
	await service.prepare([
		makeMemo("plain", "2026-06-08T10:00:00+08:00", "plain"),
	], async () => {});

	assert.deepEqual(service.select("week", new Date(2026, 5, 8))?.commonTags, []);
});

test("周月年均在合并全部日期后取十项，不提前截断每日候选", async () => {
	const memos: MemoViewItem[] = [];
	for (let day = 8; day <= 10; day++) {
		const date = `2026-06-${String(day).padStart(2, "0")}T10:00:00`;
		memos.push(makeMemo(`shared-${day}`, date, "shared", { tags: ["共享/三级/标签"] }));
		for (let index = 0; index < 10; index++) {
			for (let repeat = 0; repeat < 2; repeat++) memos.push(makeMemo(`${day}-${index}-${repeat}`, date, "same", { tags: [`day${day}/tag${index}`] }));
		}
	}
	const service = new RecordStatsService();
	await service.prepare(memos, async () => {});
	const expected = [...new Set(memos.flatMap(memo => memo.tags))].filter(tag => tag !== "共享/三级/标签").sort((a, b) => a.localeCompare(b)).slice(0, 9);
	for (const view of ["week", "month", "year"] as const) {
		const selected = service.select(view, new Date(2026, 5, 9))!;
		assert.deepEqual(selected.commonTags.map(tag => tag.key), ["共享/三级/标签", ...expected]);
		assert.equal(selected.commonTags[0].count, 3);
	}
});

test("零至十一项候选按实际数量输出，只有三级标签不生成祖先", async () => {
	for (const count of [0, 1, 5, 6, 10, 11]) {
		const service = new RecordStatsService();
		const tags = Array.from({ length: count }, (_, i) => `项目/子级/标签${String(i).padStart(2, "0")}`);
		await service.prepare([makeMemo("one", "2026-06-08T10:00:00", "one", { tags })], async () => {});
		for (const view of ["week", "month", "year"] as const) {
			assert.deepEqual(service.select(view, new Date(2026, 5, 8))!.commonTags.map(tag => tag.key), tags.slice(0, 10));
		}
	}
});

test("常用标签按完整标签独立计数，精确候选和分页钻取数量一致", async () => {
	const reader = await createCatalogReader([
		makeMemo("a", "2026-06-08T10:00:00", "same", { tags: ["Project", "project/a", "project/b"] }),
		makeMemo("b", "2026-06-08T10:00:00", "same", { tags: ["project/a", "project/b"] }),
		makeMemo("c", "2026-06-09T10:00:00", "child", { tags: ["PROJECT/C"] }),
		makeMemo("d", "2026-06-10T10:00:00", "parent", { tags: ["project"] }),
		makeMemo("e", "2026-06-10T10:00:00", "prefix", { tags: ["projects"] }),
		makeMemo("outside", "2026-06-15T10:00:00", "outside", { tags: ["project/a"] }),
	]);
	const stats = new ProductionRecordStatsService();
	await stats.prepareFromSource("tree", current => reader.buildRecordStats(async () => {}, current));
	const selected = stats.select("week", new Date(2026, 5, 8))!;
	assert.deepEqual(selected.commonTags.map(({ key, count }) => ({ key, count })), [
		{ key: "project", count: 2 }, { key: "project/a", count: 2 }, { key: "project/b", count: 2 },
		{ key: "project/c", count: 1 }, { key: "projects", count: 1 },
	]);
	for (const tag of selected.commonTags) {
		const query = buildRecordStatsCatalogQuery({ type: "tag", startDate: selected.startDate,
			endDateExclusive: selected.endDateExclusive, tagKey: tag.key, tagLabel: tag.label }).query;
		assert.equal((await reader.count(query)).count, tag.count);
		let page = await reader.query({ ...query, limit: 1 });
		let total = page.items.length;
		while (page.nextCursor) { page = await reader.query({ ...query, limit: 1, cursor: page.nextCursor }); total += page.items.length; }
		assert.equal(total, tag.count);
	}
	assert.deepEqual(stats.select("week", new Date(2026, 5, 15))!.commonTags.map(tag => tag.key), ["project/a"]);
	reader.relations.dispose();
});

test("reports empty and error states without exposing partial statistics", async () => {
	const emptyService = new RecordStatsService();
	assert.equal(await emptyService.prepare([], async () => {}), true);
	assert.equal(emptyService.getSnapshot().state, "empty");
	assert.equal(emptyService.select("week", new Date(2026, 5, 8))?.range.memoCount, 0);

	const service = new RecordStatsService();
	const incomplete = await createCatalogReader([makeMemo("known", "2026-06-08T12:00:00", "text")], false);
	assert.equal(await service.prepareFromSource("partial", isCurrent => incomplete.buildRecordStats(async () => {}, isCurrent)), false);
	assert.equal(service.getSnapshot().state, "error");
	assert.equal(service.select("week", new Date(2026, 5, 8)), null);
});

test("与对象属性同名的实际标签保留数值计数、显示名并与钻取一致", async () => {
	const reader = await createCatalogReader([
		makeMemo("a", "2026-06-08T10:00:00", "same", { tags: ["Constructor", "__PROTO__"] }),
		makeMemo("b", "2026-06-09T10:00:00", "same", { tags: ["Constructor", "__PROTO__"] }),
	]);
	try {
		const stats = new ProductionRecordStatsService();
		await stats.prepareFromSource("keys", current => reader.buildRecordStats(async () => {}, current));
		const selected = stats.select("week", new Date(2026, 5, 8))!;
		assert.equal(selected.commonTags.find(tag => tag.key === "constructor")?.count, 2);
		assert.equal(selected.commonTags.find(tag => tag.key === "__proto__")?.count, 2);
		assert.equal(selected.commonTags.find(tag => tag.key === "constructor")?.label, "Constructor");
		assert.equal(selected.commonTags.find(tag => tag.key === "__proto__")?.label, "__PROTO__");
		for (const tag of selected.commonTags) {
			const query = buildRecordStatsCatalogQuery({ type: "tag", startDate: selected.startDate,
				endDateExclusive: selected.endDateExclusive, tagKey: tag.key, tagLabel: tag.label }).query;
			assert.equal((await reader.count(query)).count, tag.count);
		}
	} finally { reader.relations.dispose(); }
});

test("invalidating an in-flight preparation discards its result", async () => {
	const service = new RecordStatsService();
	const memos = Array.from({ length: 251 }, (_, index) => {
		return makeMemo(`memo-${index}`, "2026-06-08T12:00:00+08:00", "text");
	});
	let yielded = false;
	const preparing = service.prepare(memos, async () => {
		yielded = true;
		service.invalidate();
	});

	assert.equal(await preparing, false);
	assert.equal(yielded, true);
	assert.equal(service.getSnapshot().state, "idle");
});

test("prepares statistics from a scanned source key", async () => {
	const service = new RecordStatsService();
	const prepared = await buildStats([
		makeMemo("memo-1", "2026-06-08T10:00:00+08:00", "one"),
		makeMemo("memo-2", "2026-06-09T10:00:00+08:00", "two words"),
	]);
	let loadCalls = 0;

	assert.equal(await service.prepareFromSource("catalog:1", async () => {
		loadCalls += 1;
		return prepared;
	}), true);
	assert.equal(await service.prepareFromSource("catalog:1", async () => {
		loadCalls += 1;
		return null;
	}), true);

	assert.equal(loadCalls, 1);
	assert.equal(service.getSnapshot().state, "ready");
	assert.equal(service.select("week", new Date(2026, 5, 8))?.range.memoCount, 2);
});

test("source refresh keeps committed statistics visible until the replacement is ready", async () => {
	const service = new RecordStatsService();
	const oldPrepared = await buildStats([makeMemo("old", "2026-06-08T10:00:00+08:00", "old")]);
	assert.equal(await service.prepareFromSource("catalog:1", async () => oldPrepared), true);

	const nextPrepared = createDeferred<PreparedRecordStats>();
	service.invalidate();
	assert.deepEqual(service.getSnapshot(), { state: "ready", error: null, updating: true, valid: false });
	const refreshing = service.prepareFromSource("catalog:2", async () => nextPrepared.promise);

	assert.deepEqual(service.getSnapshot(), { state: "ready", error: null, updating: true, valid: false });
	assert.equal(service.select("week", new Date(2026, 5, 8))?.range.memoCount, 1);

	const replacement = await buildStats([
		makeMemo("new-1", "2026-06-08T10:00:00+08:00", "new one"),
		makeMemo("new-2", "2026-06-09T10:00:00+08:00", "new two"),
	]);
	nextPrepared.resolve(replacement);
	assert.equal(await refreshing, true);
	assert.deepEqual(service.getSnapshot(), { state: "ready", error: null, updating: false, valid: true });
	assert.equal(service.select("week", new Date(2026, 5, 8))?.range.memoCount, 2);
});

test("routine complete-revision refresh keeps committed statistics visible without an updating marker", async () => {
	const service = new RecordStatsService();
	const oldPrepared = await buildStats([makeMemo("old", "2026-06-08T10:00:00+08:00", "old")]);
	assert.equal(await service.prepareFromSource("catalog:1", async () => oldPrepared), true);

	const nextPrepared = createDeferred<PreparedRecordStats>();
	service.invalidate(false);
	assert.deepEqual(service.getSnapshot(), { state: "ready", error: null, updating: false, valid: false });
	const refreshing = service.prepareFromSource("catalog:2", async () => nextPrepared.promise, false);

	assert.deepEqual(service.getSnapshot(), { state: "ready", error: null, updating: false, valid: false });
	assert.equal(service.select("week", new Date(2026, 5, 8))?.range.memoCount, 1);

	const replacement = await buildStats([
		makeMemo("new-1", "2026-06-08T10:00:00+08:00", "new one"),
		makeMemo("new-2", "2026-06-09T10:00:00+08:00", "new two"),
	]);
	nextPrepared.resolve(replacement);
	assert.equal(await refreshing, true);
	assert.deepEqual(service.getSnapshot(), { state: "ready", error: null, updating: false, valid: true });
	assert.equal(service.select("week", new Date(2026, 5, 8))?.range.memoCount, 2);
});

test("calculates Monday ranges and bounded calendar navigation", () => {
	const week = getRecordStatsRange("week", new Date(2026, 5, 14));
	assert.deepEqual(toDateParts(week.start), [2026, 6, 8]);
	assert.deepEqual(toDateParts(week.endExclusive), [2026, 6, 15]);
	assert.deepEqual(toDateParts(shiftRecordStatsDate("month", new Date(2026, 0, 31), 1)), [2026, 2, 1]);
	assert.deepEqual(toDateParts(shiftRecordStatsDate("year", new Date(2026, 5, 1), -1)), [2025, 1, 1]);
	assert.equal(canAdvanceRecordStatsDate("week", new Date(2026, 5, 8), new Date(2026, 5, 19)), true);
	assert.equal(canAdvanceRecordStatsDate("week", new Date(2026, 5, 19), new Date(2026, 5, 19)), false);
	assert.equal(canRetreatRecordStatsDate("year", new Date(2021, 5, 1), 2021), false);
	assert.equal(canRetreatRecordStatsDate("year", new Date(2022, 5, 1), 2021), true);
	assert.equal(canRetreatRecordStatsDate("month", new Date(2021, 0, 1), 2021), false);
	assert.equal(canRetreatRecordStatsDate("month", new Date(2021, 1, 1), 2021), true);
	assert.equal(canRetreatRecordStatsDate("week", new Date(2021, 0, 4), 2021), true);
	assert.equal(canRetreatRecordStatsDate("week", new Date(2020, 11, 28), 2021), false);
	assert.equal(canRetreatRecordStatsDate("week", new Date(2026, 5, 8), null), false);
});

function makeMemo(
	id: string,
	createdAt: string,
	contentSnapshot: string,
	overrides: {
		status?: MemoViewItem["status"];
		tags?: MemoViewItem["tags"];
		images?: MemoViewItem["images"];
	} = {},
): MemoViewItem {
	return {
		id,
		createdAt,
		updatedAt: createdAt,
		contentSnapshot,
		contentHash: `${id}-hash`,
		status: overrides.status ?? "active",
		tags: overrides.tags ?? [],
		links: [],
		images: overrides.images ?? [],
		dailyRef: {
			path: `Daily/${createdAt.slice(0, 10)}.md`,
			heading: "## Memos",
			lineNumberHint: 1,
		},
	};
}

async function createCatalogReader(memos: readonly MemoViewItem[], complete = true) {
	await ensureObsidianStub();
	const { DiaryMemoParser } = await import("../src/services/DiaryMemoParser");
	const { MarkdownBlockService } = await import("../src/services/MarkdownBlockService");
	const { MemoCatalogService } = await import("../src/services/MemoCatalogService");
	const { InMemoryMemoCatalogStore } = await import("../src/services/MemoCatalogStore");
	const { CatalogReadService } = await import("../src/services/CatalogReadService");
	const parser = new DiaryMemoParser();
	const blocks = new MarkdownBlockService();
	const store = new InMemoryMemoCatalogStore();
	const catalog = new MemoCatalogService(store);
	await catalog.open();
	const daily = new Map<string, string[]>();
	for (const memo of memos) {
		if (memo.status !== "active") continue;
		const date = memo.dailyRef!.path.slice(6, -3);
		const content = [memo.contentSnapshot, ...memo.tags.map(tag => `#${tag.replace(/^#/, "")}`),
			...memo.images.map(image => `![[${image.path}]]`)].join("\n");
		const file = daily.get(date) ?? [];
		file.push(blocks.buildMemoBlock(content, memo.createdAt.slice(11, 19)));
		daily.set(date, file);
	}
	for (const [logicalDate, fileBlocks] of daily) {
		const sourcePath = `Daily/${logicalDate}.md`;
		const bytes = new TextEncoder().encode(`## Memos\n${fileBlocks.join("\n")}\n`);
		const parsed = await parser.parse({ sourcePath, logicalDate, bytes });
		await catalog.replaceFile({ inventory: { sourcePath, logicalDate, mtime: 1, size: bytes.length },
			sourceRevision: parsed.sourceRevision, observations: parsed.observations,
			parserVersion: 1, settingsFingerprint: "stats-test", auditedAt: 1 });
	}
	await store.setCoverage({ kind: complete ? "complete" : "partial", coveredFromDate: "1900-01-01",
		pendingFileCount: complete ? 0 : 1, coveredFileCount: daily.size, totalFileCount: daily.size + (complete ? 0 : 1) });
	return new CatalogReadService({ catalog });
}

async function buildStats(memos: readonly MemoViewItem[]): Promise<PreparedRecordStats> {
	const reader = await createCatalogReader(memos);
	const prepared = await reader.buildRecordStats(async () => {}, () => true);
	assert.notEqual(prepared, null);
	return prepared!;
}


function toDateParts(date: Date): [number, number, number] {
	return [date.getFullYear(), date.getMonth() + 1, date.getDate()];
}
