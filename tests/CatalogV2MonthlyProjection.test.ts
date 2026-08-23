import assert from "node:assert/strict";
import test from "node:test";
import { IDBFactory, IDBKeyRange } from "fake-indexeddb";

import {
	buildCatalogV2MonthlyProjection,
	CATALOG_V2_MONTHLY_READONLY_COMMENT,
	formatCatalogV2MonthlyDateHeading,
	getCatalogV2MonthlyConflictPeriod,
} from "../src/services/CatalogV2MonthlyProjection";
import { CatalogV2MonthlyProjectionOutboxRunner } from "../src/services/CatalogV2MonthlyProjectionOutbox";
import { IndexedDbCatalogV2TransactionStore } from "../src/services/IndexedDbCatalogV2TransactionStore";
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

	const first = await buildCatalogV2MonthlyProjection({ period: "2026-08", settings, observations: [later, earlier] });
	const second = await buildCatalogV2MonthlyProjection({ period: "2026-08", settings, observations: [earlier, later] });

	assert.equal(first.content, second.content);
	assert.equal(first.semanticHash, second.semanticHash);
	assert.equal(first.outputSha256, second.outputSha256);
	assert.equal(first.path, "Knomo/Memos-2026-08.md");
	assert.equal(first.content, [
		CATALOG_V2_MONTHLY_READONLY_COMMENT,
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

test("Monthly heading 的名称 token 固定为英文，不读取设备 locale", () => {
	assert.equal(formatCatalogV2MonthlyDateHeading("## D MMMM YYYY dddd", "2026-08-09"), "## 9 August 2026 Sunday");
});

test("Monthly conflict copy 只识别 canonical 同目录的 side copy", () => {
	const settings = makeSettings();
	assert.equal(getCatalogV2MonthlyConflictPeriod(settings, "Knomo/Memos-2026-08 (conflict).md"), "2026-08");
	assert.equal(getCatalogV2MonthlyConflictPeriod(settings, "Knomo/Memos-2026-08.md"), null);
	assert.equal(getCatalogV2MonthlyConflictPeriod(settings, "Elsewhere/Memos-2026-08 (conflict).md"), null);
});

test("Monthly outbox 按 period 合并，失败时保留整月请求", async () => {
	const store = new IndexedDbCatalogV2TransactionStore("phase5-monthly-outbox", {
		factory: new IDBFactory(),
		keyRange: IDBKeyRange,
	});
	await store.open();
	for (const memoId of ["memo-a", "memo-b"]) {
		await store.putOutbox({
			id: `monthly:${memoId}:2026-08-09`,
			kind: "monthly_projection",
			memoId,
			logicalDate: "2026-08-09",
			sourceRevision: "a".repeat(64),
			createdAt: "2026-08-09T00:00:00.000Z",
		});
	}
	let attempts = 0;
	const failing = new CatalogV2MonthlyProjectionOutboxRunner(store, {
		project: async () => {
			attempts += 1;
			throw new Error("not covered");
		},
	});
	assert.deepEqual(await failing.run(), { projected: 0, failed: 1 });
	assert.equal(attempts, 1);
	assert.equal((await store.listOutbox()).length, 2);

	const periods: string[] = [];
	const succeeding = new CatalogV2MonthlyProjectionOutboxRunner(store, {
		project: async (item) => { periods.push(item.period ?? ""); },
	});
	assert.deepEqual(await succeeding.run(), { projected: 1, failed: 0 });
	assert.deepEqual(periods, ["2026-08"]);
	assert.deepEqual(await store.listOutbox(), []);
	store.close();
});

function makeSettings(): KnomoSettings {
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
