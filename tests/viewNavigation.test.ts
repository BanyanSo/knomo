import test from "node:test";
import assert from "node:assert/strict";
import { translate } from "../src/i18n";
import { getSidebarNavItems, TITLE_MODE_OPTIONS } from "../src/ui/viewNavigation";

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

test("Things 固定入口紧随全部笔记，组合查询仍显示正式名称", () => {
	assert.deepEqual(getSidebarNavItems().slice(0, 2).map(item => item.nav), ["all", "things"]);
	assert.deepEqual(TITLE_MODE_OPTIONS.slice(0, 2).map(item => item.mode), ["all", "things"]);
	const state = { ...baseTitleState, activeNav: "things" as const, searchQuery: "release", activeTag: "project", activeTagKey: "project" };
	assert.equal(getDesktopTitleLabel(state), "Things");
	assert.equal(getMobileTitleLabel(state), "Things");
	assert.equal(getCurrentTitleMode(state), "things");
	assert.equal(translate("zh-CN", "nav.things"), "勾事记");
	assert.equal(translate("en", "nav.things"), "Things");
});

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
		activeNav: "shuffleDay",
	}), "shuffleDay");
	assert.equal(getCurrentTitleMode({
		...baseTitleState,
		activeTagKey: "project",
	}), "");
	assert.equal(getCurrentTitleMode({
		...baseTitleState,
		scopeFilter: "anniversary",
	}), "anniversary");
});
