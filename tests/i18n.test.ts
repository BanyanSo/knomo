import test from "node:test";
import assert from "node:assert/strict";
import { ensureObsidianStub } from "./helpers/obsidianStub";

test("normalizes Knomo locale to zh-CN or en", async () => {
	const { normalizeKnomoLocale } = await loadLocaleModule();

	assert.equal(normalizeKnomoLocale(null), "en");
	assert.equal(normalizeKnomoLocale(undefined), "en");
	assert.equal(normalizeKnomoLocale(""), "en");
	assert.equal(normalizeKnomoLocale("en"), "en");
	assert.equal(normalizeKnomoLocale("zh"), "zh-CN");
	assert.equal(normalizeKnomoLocale("zh-CN"), "zh-CN");
	assert.equal(normalizeKnomoLocale("zh-Hans-CN"), "zh-CN");
	assert.equal(normalizeKnomoLocale("zh-TW"), "zh-CN");
	assert.equal(normalizeKnomoLocale("zh-Hant"), "zh-CN");
	assert.equal(normalizeKnomoLocale("ja"), "en");
	assert.equal(normalizeKnomoLocale("de-DE"), "en");
});

test("detects Knomo locale from Obsidian language", async () => {
	const { detectKnomoLocale } = await loadLocaleModule();

	await setObsidianLanguage("zh-Hant");
	assert.equal(detectKnomoLocale(), "zh-CN");

	await setObsidianLanguage("ja");
	assert.equal(detectKnomoLocale(), "en");

	await setObsidianLanguage("");
	assert.equal(detectKnomoLocale(), "en");
});

test("formats card word count with locale-specific colons", async () => {
	await ensureObsidianStub();
	const { translate } = await import("../src/i18n");

	assert.equal(translate("zh-CN", "card.wordCount", { count: 123 }), "字数：123");
	assert.equal(translate("en", "card.wordCount", { count: 123 }), "Words: 123");
});

test("uses matching load-more copy for historical Memos", async () => {
	await ensureObsidianStub();
	const { translate } = await import("../src/i18n");

	assert.equal(translate("zh-CN", "list.loadOlder"), "加载更多 Memos");
	assert.equal(translate("en", "list.loadOlder"), "Load more memos");
});

test("uses distinct local-history, migration, identity, and storage status copy", async () => {
	await ensureObsidianStub();
	const { translate } = await import("../src/i18n");

	assert.match(translate("zh-CN", "catalog.coveragePartial", { covered: 1, total: 3 }), /本机历史/u);
	assert.match(translate("zh-CN", "catalog.legacyMigrationAttention"), /旧版数据升级/u);
	assert.match(translate("zh-CN", "catalog.identityConflict"), /部分 Memo/u);
	assert.match(translate("zh-CN", "catalog.storageUnavailable"), /本机缓存/u);
	assert.doesNotMatch(translate("zh-CN", "catalog.stateSettling"), /关联信息仍在同步/u);
});

test("需要处理文案只描述用户影响和对应操作", async () => {
	await ensureObsidianStub();
	const { translate } = await import("../src/i18n");

	assert.match(translate("zh-CN", "settings.attention.catalog.desc"), /搜索与统计/u);
	assert.doesNotMatch(translate("zh-CN", "settings.attention.catalog.desc"), /Catalog|IndexedDB/u);
	assert.equal(translate("zh-CN", "settings.attention.retry"), "立即重试");
	assert.equal(translate("en", "settings.attention.checkAgain"), "Check again");
});

test("adds spacing only to record statistics summaries", async () => {
	await ensureObsidianStub();
	const { translate } = await import("../src/i18n");

	assert.equal(
		translate("zh-CN", "filterSummary.recordStats", { label: "2026-06-01 至 2026-06-30", count: 13 }),
		"2026-06-01 至 2026-06-30 共有 13 条 Memos",
	);
	assert.equal(
		translate("zh-CN", "mobileSearchSummary.recordStats", { label: "2026-06-01 至 2026-06-30", count: 13 }),
		"2026-06-01 至 2026-06-30 共有 13 条 Memos",
	);
	assert.equal(
		translate("zh-CN", "filterSummary.label", { label: "本月", count: 13 }),
		"本月共有 13 条 Memos",
	);
	assert.equal(
		translate("zh-CN", "mobileSearchSummary.date", { label: "本月", count: 13 }),
		"本月共有 13 条 Memos",
	);
});

test("formats common-tag chart, action, filter, and empty-state text", async () => {
	await ensureObsidianStub();
	const { translate } = await import("../src/i18n");

	assert.equal(translate("zh-CN", "recordStats.commonTags"), "常用标签");
	assert.equal(translate("zh-CN", "recordStats.commonTags.empty"), "这一范围内还没有标签");
	assert.equal(translate("zh-CN", "recordStats.chart.tagCount", { tag: "Work", count: 3 }), "#Work，3 条记录");
	assert.equal(
		translate("zh-CN", "recordStats.action.filterTag", { tag: "Work", count: 3 }),
		"筛选标签 #Work 的 3 条记录",
	);
	assert.equal(
		translate("zh-CN", "recordStats.filter.tag", {
			startDate: "2026-06-01",
			endDate: "2026-06-30",
			tag: "Work",
		}),
		"2026-06-01 至 2026-06-30 · #Work",
	);
});

test("keeps Time buoy tab empty-state copy aligned in Chinese and English", async () => {
	await ensureObsidianStub();
	const { translate } = await import("../src/i18n");

	assert.equal(translate("zh-CN", "timeBuoy.empty.today.title"), "今天没有浮标");
	assert.equal(translate("zh-CN", "timeBuoy.empty.today.desc"), "设为今天浮现的 Memos，会出现在这里。");
	assert.equal(translate("en", "timeBuoy.empty.today.title"), "No buoys today");
	assert.equal(translate("en", "timeBuoy.empty.today.desc"), "Memos set to surface today will appear here.");
	assert.equal(translate("zh-CN", "timeBuoy.empty.upcoming.title"), "还没有待浮现的 Memos");
	assert.equal(translate("zh-CN", "timeBuoy.empty.upcoming.desc"), "为 Memos 设定未来日期，它会在那一天浮现。");
	assert.equal(translate("en", "timeBuoy.empty.upcoming.title"), "No upcoming buoys");
	assert.equal(translate("en", "timeBuoy.empty.upcoming.desc"), "Memos set for a future date will surface when the day arrives.");
	assert.equal(translate("zh-CN", "timeBuoy.empty.past.title"), "还没有往日浮标");
	assert.equal(translate("zh-CN", "timeBuoy.empty.past.desc"), "已经浮现过的 Memos，会留在这里供你回看。");
	assert.equal(translate("en", "timeBuoy.empty.past.title"), "No past buoys yet");
	assert.equal(translate("en", "timeBuoy.empty.past.desc"), "Memos that have surfaced will remain here for revisiting.");
});

test("translates the 90-day Time buoy shortcut", async () => {
	await ensureObsidianStub();
	const { translate } = await import("../src/i18n");

	assert.equal(translate("zh-CN", "timeBuoy.picker.after90"), "90 天后");
	assert.equal(translate("en", "timeBuoy.picker.after90"), "In 90 days");
});

async function loadLocaleModule(): Promise<typeof import("../src/i18n/locale")> {
	await ensureObsidianStub();
	return import("../src/i18n/locale");
}

async function setObsidianLanguage(locale: string): Promise<void> {
	await ensureObsidianStub();
	const { getLanguage } = await import("obsidian");
	(getLanguage as unknown as { set(value: string): void }).set(locale);
}
