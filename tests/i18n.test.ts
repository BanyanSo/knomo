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

async function loadLocaleModule(): Promise<typeof import("../src/i18n/locale")> {
	await ensureObsidianStub();
	return import("../src/i18n/locale");
}

async function setObsidianLanguage(locale: string): Promise<void> {
	await ensureObsidianStub();
	const { getLanguage } = await import("obsidian");
	(getLanguage as unknown as { set(value: string): void }).set(locale);
}
