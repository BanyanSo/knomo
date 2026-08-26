import assert from "node:assert/strict";
import test from "node:test";

import { moment } from "obsidian";

import {
	buildMonthlyProjection,
	MONTHLY_READONLY_COMMENT,
	formatMonthlyDateHeading,
	getMonthlyConflictPeriod,
	normalizeMonthlyLocaleKey,
} from "../src/services/MonthlyProjection";
import type { CatalogObservation } from "../src/types/catalog";
import type { KnomoSettings } from "../src/types/settings";

test("Monthly projection 对同一 Catalog 输入生成确定字节且只保留 Daily 已有 block ID", async () => {
	const settings = makeSettings();
	const later = makeObservation({
		observationKey: "Daily/2026-08-02.md\0a",
		sourcePath: "Daily/2026-08-02.md",
		logicalDate: "2026-08-02",
		startLine: 8,
		time: "09:30",
		content: "second\nline",
		existingBlockId: "kept-id",
	});
	const earlier = makeObservation({
		observationKey: "Daily/2026-08-01.md\0a",
		sourcePath: "Daily/2026-08-01.md",
		logicalDate: "2026-08-01",
		startLine: 2,
		time: "08:00:00",
		content: "first",
		existingBlockId: null,
	});

	const first = await buildMonthlyProjection({ period: "2026-08", settings, observations: [later, earlier] });
	const second = await buildMonthlyProjection({ period: "2026-08", settings, observations: [earlier, later] });

	assert.equal(first.content, second.content);
	assert.equal(first.semanticHash, second.semanticHash);
	assert.equal(first.outputSha256, second.outputSha256);
	assert.equal(first.path, "Knomo/Memos-2026-08.md");
	assert.equal(first.content, [
		MONTHLY_READONLY_COMMENT,
		"# 2026-08",
		"## [[2026-08-01]]",
		"- 08:00:00 first",
		"## [[2026-08-02]]",
		"- 09:30 second\n\tline ^kept-id",
		"",
	].join("\n\n").replace(/\n\n$/u, "\n"));
	assert.equal(first.content.includes("^kept-id"), true);
	assert.equal(first.content.match(/\^[\w-]+/gu)?.length, 1);
	assert.equal(first.content.includes("\r"), false);
	assert.equal(first.content.endsWith("\n"), true);
	assert.equal(first.content.endsWith("\n\n"), false);
});

test("Monthly heading 只使用传入 locale，且支持相邻的完整 token", () => {
	assert.equal(normalizeMonthlyLocaleKey("zh"), "zh-cn");
	assert.equal(normalizeMonthlyLocaleKey("fr_FR"), "fr-fr");
	moment.locale("fr");
	assert.equal(
		formatMonthlyDateHeading("## D MMMM YYYY dddd", "2026-08-09", "en"),
		"## 9 August 2026 Sunday",
	);
	moment.locale("en");
	assert.equal(
		formatMonthlyDateHeading("## YYYYM MMMMM MMMMD DDdddd", "2026-08-09", "fr"),
		"## 20268 août8 août9 09dimanche",
	);
});

test("两台不同 UI 语言设备使用同一共享 locale 时生成字节级相同 Monthly", async () => {
	const observation = makeObservation({ logicalDate: "2026-08-09" });
	moment.locale("en");
	const left = await buildMonthlyProjection({
		period: "2026-08",
		settings: makeSettings("fr"),
		observations: [observation],
	});
	moment.locale("fr");
	const right = await buildMonthlyProjection({
		period: "2026-08",
		settings: makeSettings("fr"),
		observations: [observation],
	});
	moment.locale("en");

	assert.deepEqual(right.bytes, left.bytes);
	assert.equal(right.content, left.content);
	assert.match(right.content, /## \[\[2026-08-09\]\]/u);
});

test("Monthly conflict copy 只识别 canonical 同目录的 side copy", () => {
	const settings = makeSettings();
	assert.equal(getMonthlyConflictPeriod(settings, "Knomo/Memos-2026-08 (conflict).md"), "2026-08");
	assert.equal(getMonthlyConflictPeriod(settings, "Knomo/Memos-2026-08.md"), null);
	assert.equal(getMonthlyConflictPeriod(settings, "Elsewhere/Memos-2026-08 (conflict).md"), null);
});

function makeSettings(locale = "en"): KnomoSettings & { locale: string } {
	return {
		settingsVersion: 4,
		dailyHeading: "## Memos",
		dailyInsertPosition: "bottom",
		memoTimeFormat: "HH:mm:ss",
		knomoDataRoot: "Knomo",
		knomoDataRootConfigured: true,
		monthlyMemoFolder: "Knomo",
		monthlyMemoFileFormat: "Memos-YYYY-MM.md",
		monthlyDateHeadingFormat: "## [[YYYY-MM-DD]]",
		monthlyDateOrder: "asc",
		legacyDailyHeadings: [],
		timeBuoyEnabled: true,
		mobileCompactMode: "auto",
		syncDebounceMs: 1000,
		desktopSidebarWidth: 248,
		desktopSidebarCollapsed: false,
		excludeMonthlyMemosFromObsidian: true,
		pinnedTags: [],
		locale,
	};
}

function makeObservation(overrides: Partial<CatalogObservation>): CatalogObservation {
	return {
		observationKey: "Daily/2026-08-09.md\u00000000000001",
		createdAtKey: "2026-08-09T09:00:00",
		sourcePath: "Daily/2026-08-09.md",
		sourceRevision: "a".repeat(64),
		rawBlockHash: "fnv1a-rawblock",
		logicalDate: "2026-08-09",
		section: "## Memos",
		startLine: 1,
		endLine: 1,
		time: "09:00",
		content: "memo",
		contentHash: "fnv1a-11111111",
		existingBlockId: null,
		tags: [],
		links: [],
		images: [],
		tasks: [],
		timeBuoyDates: [],
		searchText: "memo",
		searchTokens: ["memo"],
		tagKeys: [],
		linkTargets: [],
		imagePaths: [],
		explicitReferenceTargets: [],
		hasLink: 0,
		hasImage: 0,
		hasTask: 0,
		hasTimeBuoy: 0,
		...overrides,
	};
}
