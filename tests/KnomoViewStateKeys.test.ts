import test from "node:test";
import assert from "node:assert/strict";

import { ensureObsidianStub } from "./helpers/obsidianStub";

test("结果数字槽从等待到终态即使 count 仍为 null 也改变渲染键", async () => {
	await ensureObsidianStub();
	const { getCardFlowStateKey } = await import("../src/ui/KnomoViewStateKeys");
	const stateKey = (count: number | null, pending: boolean) => getCardFlowStateKey({
		activeNav: "all", recordStatsView: "week", recordStatsSelectedDate: new Date(2026, 10, 11), today: new Date(2026, 10, 11),
		recordStatsSnapshot: { state: "idle", error: null, updating: false, valid: false },
		presentation: { type: "items", mode: "memo", memos: [], headers: [{ type: "result-summary", summary: {
			template: "filterSummary.search", params: { query: "memo" }, count, pending,
		} }] },
	});
	assert.notEqual(stateKey(null, true), stateKey(null, false));
	assert.notEqual(stateKey(null, true), stateKey(900, false));
	assert.notEqual(stateKey(900, false), stateKey(901, false));
});

test("随机工具栏的等待、不可用和数量变化同时进入空态与列表的渲染键", async () => {
	await ensureObsidianStub();
	const { getCardFlowStateKey } = await import("../src/ui/KnomoViewStateKeys");
	for (const type of ["empty", "items"] as const) {
		const stateKey = (count: number | null, pending: boolean) => getCardFlowStateKey({
			activeNav: "random", recordStatsView: "week", recordStatsSelectedDate: new Date(), today: new Date(),
			recordStatsSnapshot: { state: "idle", error: null, updating: false, valid: false },
			presentation: { type, title: "", description: "", mode: "memo", memos: [], headers: [{
				type: "random-toolbar", summary: { template: "list.randomSummary", params: {}, count, pending },
			}] },
		});
		assert.notEqual(stateKey(null, true), stateKey(null, false));
		assert.notEqual(stateKey(null, false), stateKey(0, false));
		assert.notEqual(stateKey(0, false), stateKey(1, false));
		assert.equal(stateKey(1, false), stateKey(1, false));
	}
});

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
			recordStatsSnapshot: { state: "idle", error: null, updating: false, valid: false },
		}),
		getCardFlowStateKey({
			...base,
			recordStatsSnapshot: { state: "loading", error: null, updating: false, valid: false },
		}),
	);
	assert.notEqual(
		getCardFlowStateKey({
			...base,
			recordStatsSnapshot: { state: "ready", error: null, updating: false, valid: true },
		}),
		getCardFlowStateKey({
			...base,
			recordStatsSnapshot: { state: "ready", error: null, updating: true, valid: false },
		}),
	);
	assert.notEqual(
		getCardFlowStateKey({ ...base, recordStatsSnapshot: { state: "ready", error: null, updating: false, valid: true } }),
		getCardFlowStateKey({ ...base, recordStatsSnapshot: { state: "ready", error: null, updating: false, valid: false } }),
		"静默失效也必须触发撤下旧被引用入口",
	);
});
