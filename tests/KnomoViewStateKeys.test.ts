import test from "node:test";
import assert from "node:assert/strict";

import type { MemoRecord } from "./helpers/memoViewFixture";
import { ensureObsidianStub } from "./helpers/obsidianStub";

test("builds card flow view keys from normalized filters", async () => {
	await ensureObsidianStub();
	const {
		getCardFlowChangeIntent,
		getCardFlowViewStateKey,
	} = await import("../src/ui/KnomoViewStateKeys");

	const key = getCardFlowViewStateKey({
		activeNav: "all",
		scopeFilter: "all",
		activeTagKey: "project",
		searchQuery: "  Memo  ",
		searchDateFilter: "week",
		recordStatsSearchFilter: null,
	});

	assert.equal(getCardFlowChangeIntent(key, {
		activeNav: "all",
		scopeFilter: "all",
		activeTagKey: "project",
		searchQuery: "memo",
		searchDateFilter: "week",
		recordStatsSearchFilter: null,
	}), "content-change");
	assert.equal(getCardFlowChangeIntent(key, {
		activeNav: "all",
		scopeFilter: "all",
		activeTagKey: "other",
		searchQuery: "memo",
		searchDateFilter: "week",
		recordStatsSearchFilter: null,
	}), "view-scope-change");
});

test("keys record stats idle state as loading", async () => {
	await ensureObsidianStub();
	const { getCardFlowStateKey } = await import("../src/ui/KnomoViewStateKeys");
	const base = {
		activeNav: "record-stats" as const,
		recordStatsView: "week" as const,
		recordStatsSelectedDate: new Date(2026, 5, 1),
		today: new Date(2026, 5, 2),
		presentation: {
			type: "empty" as const,
			title: "Loading",
			description: "",
		},
	};

	assert.equal(
		getCardFlowStateKey({
			...base,
			recordStatsSnapshot: { state: "idle", error: null, updating: false },
		}),
		getCardFlowStateKey({
			...base,
			recordStatsSnapshot: { state: "loading", error: null, updating: false },
		}),
	);
	assert.notEqual(
		getCardFlowStateKey({
			...base,
			recordStatsSnapshot: { state: "ready", error: null, updating: false },
		}),
		getCardFlowStateKey({
			...base,
			recordStatsSnapshot: { state: "ready", error: null, updating: true },
		}),
	);
});

test("keys closed mobile search independently from visible memos", async () => {
	await ensureObsidianStub();
	const {
		getMobileSearchIdsKey,
		getMobileSearchStateKey,
	} = await import("../src/ui/KnomoViewStateKeys");
	const memo = makeMemo("memo-1");

	assert.equal(getMobileSearchStateKey({
		open: false,
		query: "memo",
		dateFilter: null,
		recordStatsFilter: null,
		visibleMemos: [memo],
	}), "closed");
	assert.equal(getMobileSearchIdsKey(false, [memo]), "closed");
	assert.equal(getMobileSearchIdsKey(true, [memo]), "memo-1");
});

function makeMemo(id: string): MemoRecord {
	return {
		id,
		createdAt: "2026-06-02T00:00:00+08:00",
		updatedAt: "2026-06-02T00:00:00+08:00",
		contentSnapshot: id,
		contentHash: id,
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
			path: "Journal/2026-06-02.md",
			heading: null,
			lastKnownBlock: contentBlock(id),
			lastKnownHash: id,
			lineNumberHint: 1,
			lastSyncedAt: null,
		},
		monthlyRef: {
			path: "Knomo/2026-06.md",
			dateHeading: "2026-06-02",
			lastKnownBlock: contentBlock(id),
			lastKnownHash: id,
			lineNumberHint: 1,
			lastSyncedAt: null,
		},
	};
}

function contentBlock(content: string): string {
	return `- 00:00 ${content}`;
}
