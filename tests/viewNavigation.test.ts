import test from "node:test";
import assert from "node:assert/strict";

import {
	getCurrentTitleMode,
	getDesktopTitleLabel,
	getMobileTitleLabel,
	type ViewTitleState,
} from "../src/ui/viewNavigation";

const baseTitleState: ViewTitleState = {
	activeTag: null,
	activeTagKey: null,
	activeNav: "all",
	scopeFilter: "all",
	searchQuery: "",
	searchDateFilter: null,
	recordStatsSearchFilter: null,
};

test("desktop title label prioritizes transient filters before list state", () => {
	assert.equal(getDesktopTitleLabel({
		...baseTitleState,
		searchQuery: "  knomo  ",
	}), "Search");
	assert.equal(getDesktopTitleLabel({
		...baseTitleState,
		searchDateFilter: "last-30",
	}), "Last 30 days");
	assert.equal(getDesktopTitleLabel({
		...baseTitleState,
		recordStatsSearchFilter: { type: "day", date: "2026-06-08" },
	}), "2026-06-08");
	assert.equal(getDesktopTitleLabel({
		...baseTitleState,
		activeTag: "Project",
		activeTagKey: "project",
	}), "#Project");
	assert.equal(getDesktopTitleLabel({
		...baseTitleState,
		scopeFilter: "with-image",
	}), "With images");
});

test("mobile title label stays anchored to the list state", () => {
	assert.equal(getMobileTitleLabel({
		...baseTitleState,
		searchQuery: "knomo",
		searchDateFilter: "week",
		activeNav: "review",
	}), "Beyond today");
	assert.equal(getMobileTitleLabel({
		...baseTitleState,
		activeTag: "Project",
		activeTagKey: "project",
	}), "#Project");
});

test("current title mode follows nav and scope state", () => {
	assert.equal(getCurrentTitleMode(baseTitleState), "all");
	assert.equal(getCurrentTitleMode({
		...baseTitleState,
		activeNav: "random",
	}), "random");
	assert.equal(getCurrentTitleMode({
		...baseTitleState,
		activeTagKey: "project",
	}), "");
	assert.equal(getCurrentTitleMode({
		...baseTitleState,
		scopeFilter: "anniversary",
	}), "anniversary");
});
