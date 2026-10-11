import test from "node:test";
import assert from "node:assert/strict";

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
