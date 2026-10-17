import test, { before } from "node:test";
import assert from "node:assert/strict";

import { ensureObsidianStub } from "./helpers/obsidianStub";

let KnomoViewStateController: typeof import("../src/ui/KnomoViewStateController").KnomoViewStateController;
before(async () => {
	await ensureObsidianStub();
	({ KnomoViewStateController } = await import("../src/ui/KnomoViewStateController"));
});

test("Things 保留组合条件、单项清除、Scope 日期与统计返回", () => {
	const state = new KnomoViewStateController();
	state.activeTag = "project";
	state.activeTagKey = "project";
	state.searchQuery = "release";
	state.scopeFilter = "last-30";
	state.setSidebarNav("things");
	assert.equal(state.scopeFilter, "all");
	assert.equal(state.searchDateFilter, "last-30");
	state.setSidebarNav("things");
	assert.equal(state.searchQuery, "release");
	assert.equal(state.activeTagKey, "project");
	state.setSearchQuery("");
	assert.equal(state.activeNav, "things");
	assert.equal(state.searchDateFilter, "last-30");
	state.setScope("last-30");
	assert.equal(state.searchDateFilter, null);
	state.setScope("week");
	state.setSearchQuery("ship");
	state.setSidebarNav("record-stats");
	assert.equal(state.returnFromRecordStats().reloadCatalogQuery, true);
	assert.equal(state.activeNav, "things");
	assert.equal(state.searchQuery, "ship");
	assert.equal(state.searchDateFilter, "week");
	assert.equal(state.activeTagKey, "project");
	state.setSidebarNav("all");
	assert.equal(state.isDefaultListState(), true);
});

test("从专用视图进入 Things 清除专用条件", () => {
	for (const nav of ["review", "random", "shuffleDay", "time-buoy", "record-stats", "trash"] as const) {
		const state = new KnomoViewStateController();
		state.activeNav = nav;
		state.searchQuery = "old";
		state.recordStatsSearchFilter = { type: "day", date: "2026-09-20" };
		state.setSidebarNav("things");
		assert.equal(state.activeNav, "things");
		assert.equal(state.searchQuery, "");
		assert.equal(state.recordStatsSearchFilter, null);
	}
});

test("scope transition closes chrome without changing an already active default scope", () => {
	const state = new KnomoViewStateController();
	state.mobileDrawerOpen = true;
	state.desktopSearchOpen = true;

	const result = state.setScope("all");

	assert.equal(result.type, "already-active");
	assert.equal(result.closeScopeMenu, true);
	assert.equal(state.activeNav, "all");
	assert.equal(state.scopeFilter, "all");
	assert.equal(state.mobileDrawerOpen, false);
	assert.equal(state.desktopSearchOpen, false);
});

test("scope transition clears desktop search and active tag when changing list scope", () => {
	const state = new KnomoViewStateController();
	state.activeNav = "review";
	state.activeTag = "Work";
	state.activeTagKey = "work";
	state.searchQuery = "memo";
	state.searchDateFilter = "week";
	state.mobileDrawerOpen = true;
	state.desktopSearchOpen = true;

	const result = state.setScope("with-image");

	assert.equal(result.type, "changed");
	assert.equal(result.closeScopeMenu, true);
	assert.equal(state.activeNav, "all");
	assert.equal(state.scopeFilter, "with-image");
	assert.equal(state.searchQuery, "");
	assert.equal(state.searchDateFilter, null);
	assert.equal(state.activeTag, null);
	assert.equal(state.activeTagKey, null);
	assert.equal(state.mobileDrawerOpen, false);
	assert.equal(state.desktopSearchOpen, false);
});

test("search query moves the view back to all notes and clears card menu only", () => {
	const state = new KnomoViewStateController();
	state.activeNav = "review";
	state.activeTag = "Work";
	state.activeTagKey = "work";
	state.scopeFilter = "with-image";

	const result = state.setSearchQuery(" memo ");

	assert.equal(result.type, "changed");
	assert.equal(result.clearCardMenu, true);
	assert.equal(state.activeNav, "all");
	assert.equal(state.scopeFilter, "all");
	assert.equal(state.searchQuery, " memo ");
	assert.equal(state.activeTag, null);
	assert.equal(state.activeTagKey, null);
});

test("search date toggles filter and clears record statistics search", () => {
	const state = new KnomoViewStateController();
	state.recordStatsSearchFilter = {
		type: "range",
		startDate: "2026-06-01",
		endDateExclusive: "2026-07-01",
	};
	state.activeTag = "Work";
	state.activeTagKey = "work";
	state.desktopSearchOpen = true;
	state.compactSearchOpen = true;

	const first = state.setSearchDateFilter("week");

	assert.equal(first.clearCardMenu, true);
	assert.equal(state.searchDateFilter, "week");
	assert.equal(state.recordStatsSearchFilter, null);
	assert.equal(state.activeTag, null);
	assert.equal(state.activeTagKey, null);
	assert.equal(state.activeNav, "all");
	assert.equal(state.scopeFilter, "all");
	assert.equal(state.desktopSearchOpen, false);
	assert.equal(state.compactSearchOpen, false);

	state.setSearchDateFilter("week");
	assert.equal(state.searchDateFilter, null);
});

test("sidebar navigation stores and restores record statistics return state", () => {
	const state = new KnomoViewStateController();
	state.activeNav = "random";
	state.scopeFilter = "with-image";
	state.searchQuery = "memo";
	state.searchDateFilter = "month";
	state.recordStatsSearchFilter = {
		type: "with-image",
		startDate: "2026-06-01",
		endDateExclusive: "2026-07-01",
	};
	state.activeTag = "Work";
	state.activeTagKey = "work";

	const openStats = state.setSidebarNav("record-stats");

	assert.equal(openStats.type, "changed");
	assert.equal(openStats.prepareRecordStats, true);
	assert.equal(openStats.clearRandomReunion, false);
	assert.equal(openStats.closeScopeMenu, true);
	assert.equal(openStats.clearCardMenu, true);
	assert.equal(state.activeNav, "record-stats");
	assert.equal(state.scopeFilter, "all");
	assert.equal(state.searchQuery, "");
	assert.equal(state.searchDateFilter, null);
	assert.equal(state.recordStatsSearchFilter, null);
	assert.equal(state.activeTag, null);
	assert.equal(state.activeTagKey, null);

	const returned = state.returnFromRecordStats();

	assert.equal(returned.type, "returned");
	assert.equal(returned.returnedNav, "random");
	assert.equal(returned.refreshRandomReunionIfEmpty, true);
	assert.equal(returned.reloadCatalogQuery, false);
	assert.equal(state.activeNav, "random");
	assert.equal(state.scopeFilter, "with-image");
	assert.equal(state.searchQuery, "memo");
	assert.equal(state.searchDateFilter, "month");
	assert.deepEqual(state.recordStatsSearchFilter, {
		type: "with-image",
		startDate: "2026-06-01",
		endDateExclusive: "2026-07-01",
	});
	assert.equal(state.activeTag, "Work");
	assert.equal(state.activeTagKey, "work");
});

test("sidebar navigation exposes follow-up side effects for heavy routes", () => {
	const state = new KnomoViewStateController();

	assert.equal(state.setSidebarNav("review").reloadCatalogQuery, true);
	assert.equal(state.setSidebarNav("all").reloadCatalogQuery, true);
	assert.equal(state.setSidebarNav("random").refreshRandomReunion, true);
	const leaveRandom = state.setSidebarNav("all");
	assert.equal(leaveRandom.clearRandomReunion, false);
	assert.equal(state.setSidebarNav("shuffleDay").refreshShuffleDay, true);
	const leaveShuffleDay = state.setSidebarNav("all");
	assert.equal(leaveShuffleDay.clearShuffleDay, false);
	assert.equal(state.setSidebarNav("trash").loadTrashMemos, true);
});

test("record statistics return preserves shuffle day state", () => {
	const state = new KnomoViewStateController();
	state.activeNav = "shuffleDay";

	const openStats = state.setSidebarNav("record-stats");
	assert.equal(openStats.clearShuffleDay, false);
	assert.equal(state.activeNav, "record-stats");

	const returned = state.returnFromRecordStats();
	assert.equal(returned.type, "returned");
	assert.equal(returned.returnedNav, "shuffleDay");
	assert.equal(returned.refreshShuffleDayIfEmpty, true);
	assert.equal(state.activeNav, "shuffleDay");
});

test("reset to all notes reports whether only chrome sync is needed", () => {
	const defaultState = new KnomoViewStateController();
	defaultState.mobileDrawerOpen = true;
	const defaultResult = defaultState.resetToAllNotes();

	assert.equal(defaultResult.type, "already-default");
	assert.equal(defaultResult.clearCardMenu, true);
	assert.equal(defaultResult.reloadCatalogQuery, false);
	assert.equal(defaultState.mobileDrawerOpen, false);
	assert.equal(defaultState.activeNav, "all");

	const filteredState = new KnomoViewStateController();
	filteredState.activeNav = "review";
	filteredState.searchQuery = "memo";
	filteredState.scopeFilter = "with-image";
	filteredState.compactSearchOpen = true;
	const changedResult = filteredState.resetToAllNotes();

	assert.equal(changedResult.type, "changed");
	assert.equal(changedResult.reloadCatalogQuery, true);
	assert.equal(filteredState.activeNav, "all");
	assert.equal(filteredState.searchQuery, "");
	assert.equal(filteredState.scopeFilter, "all");
	assert.equal(filteredState.compactSearchOpen, false);
});

test("恢复旧导航：普通搜索回到全部，切换范围清空搜索", () => {
 const state = new KnomoViewStateController();
 state.activeNav = "review"; state.scopeFilter = "with-image";
 state.activeTag = "work"; state.activeTagKey = "work";
 state.setSearchQuery("20261009 项目");
 assert.equal(state.activeNav, "all"); assert.equal(state.scopeFilter, "all");
 assert.equal(state.activeTagKey, null);
 assert.equal(state.search.applied.date?.kind, "range");
 state.setScope("with-image");
 assert.equal(state.searchQuery, ""); assert.equal(state.search.applied.date, null);
 assert.equal(state.scopeFilter, "with-image");
});

test("Workspace 导出只保留已提交搜索，恢复重新解析并清除旧请求与临时 chrome", () => {
	const source = new KnomoViewStateController();
	source.activeNav = "things";
	source.activeTag = "Work"; source.activeTagKey = "work";
	source.searchQuery = "20261009 项目";
	source.search.updateDraft("2026-");
	source.search.beginComposition();
	const saved = source.exportWorkspaceState();
	assert.equal(saved.navigation.search.input, "20261009 项目");
	assert.equal(source.search.draft.text, "2026-");
	const restored = new KnomoViewStateController();
	restored.mobileDrawerOpen = restored.desktopSearchOpen = restored.compactSearchOpen = true;
	restored.search.commitResult({ text: "old" }, 10, "old");
	restored.applyWorkspaceState(saved);
	assert.equal(restored.activeNav, "things");
	assert.equal(restored.activeTagKey, "work");
	assert.deepEqual(restored.search.applied.terms, ["项目"]);
	assert.deepEqual(restored.search.applied.date, { kind: "range", granularity: "day", fromDate: "2026-10-09", toDate: "2026-10-09" });
	assert.equal(restored.search.draft.text, "20261009 项目");
	assert.equal(restored.search.draft.composing, false);
	assert.equal(restored.search.result, null);
	assert.equal(restored.search.requestStatus, "idle");
	assert.equal(restored.mobileDrawerOpen || restored.desktopSearchOpen || restored.compactSearchOpen, false);
});

test("Workspace 恢复 Stats 的单层返回导航、tag、快捷日期与独立 filter", () => {
	const source = new KnomoViewStateController();
	source.activeNav = "things";
	source.activeTag = "Project"; source.activeTagKey = "project";
	source.searchQuery = "release"; source.searchDateFilter = "last-30";
	source.recordStatsSearchFilter = { type: "max-daily-notes", dates: ["2024-02-29"] };
	source.setSidebarNav("record-stats");
	const saved = source.exportWorkspaceState(), first = new KnomoViewStateController(), second = new KnomoViewStateController();
	first.applyWorkspaceState(saved); second.applyWorkspaceState(saved);
	assert.equal(first.activeNav, "record-stats");
	assert.equal(first.returnFromRecordStats().returnedNav, "things");
	assert.equal(first.activeTag, "Project");
	assert.equal(first.searchQuery, "release");
	assert.equal(first.searchDateFilter, "last-30");
	assert.deepEqual(first.recordStatsSearchFilter, { type: "max-daily-notes", dates: ["2024-02-29"] });
	if (first.recordStatsSearchFilter?.type === "max-daily-notes") first.recordStatsSearchFilter.dates[0] = "2000-01-01";
	assert.equal(second.returnFromRecordStats().returnedNav, "things");
	assert.deepEqual(second.recordStatsSearchFilter, { type: "max-daily-notes", dates: ["2024-02-29"] });
	assert.deepEqual(saved.recordStatsReturn?.recordStatsSearchFilter, { type: "max-daily-notes", dates: ["2024-02-29"] });
	assert.equal(first.exportWorkspaceState().recordStatsReturn, null);
});
