import test from "node:test";
import assert from "node:assert/strict";

import { KnomoViewStateController } from "../src/ui/KnomoViewStateController";

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
	assert.equal(state.setSidebarNav("shuffleDay").refreshShuffleDay, true);
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
