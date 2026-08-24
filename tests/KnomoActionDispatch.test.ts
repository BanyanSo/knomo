import test from "node:test";
import assert from "node:assert/strict";

import {
	getMemoActionDispatch,
	getKnomoActionDispatch,
	getTrashActionDispatch,
	isComposerToolAction,
	isMemoAction,
	isTrashAction,
	shouldRenderAfterActionDispatch,
} from "../src/ui/KnomoActionDispatch";

test("classifies known view actions", () => {
	assert.deepEqual(getKnomoActionDispatch(null), { type: "none" });
	assert.deepEqual(getKnomoActionDispatch("toggle-card-menu"), { type: "toggle-card-menu" });
	assert.deepEqual(getKnomoActionDispatch("refresh-random-reunion"), { type: "refresh-random-reunion" });
	assert.deepEqual(getKnomoActionDispatch("load-more-mobile-search"), { type: "load-more-mobile-search" });
	assert.deepEqual(getKnomoActionDispatch("clear-reference"), { type: "clear-reference" });
	assert.deepEqual(getKnomoActionDispatch("save-input"), { type: "save-input" });
	assert.deepEqual(getKnomoActionDispatch("record-stats-back"), { type: "record-stats-back" });
	assert.deepEqual(getKnomoActionDispatch("record-stats-next"), { type: "record-stats-next" });
	assert.deepEqual(getKnomoActionDispatch("retry-all-memos"), { type: "retry-all-memos" });
	assert.deepEqual(getKnomoActionDispatch("enable-time-buoy-intro"), { type: "enable-time-buoy-intro" });
	assert.deepEqual(getKnomoActionDispatch("time-buoy-tab-today"), { type: "time-buoy-tab-today" });
	assert.deepEqual(getKnomoActionDispatch("time-buoy-tab-upcoming"), { type: "time-buoy-tab-upcoming" });
	assert.deepEqual(getKnomoActionDispatch("time-buoy-tab-past"), { type: "time-buoy-tab-past" });
	assert.deepEqual(getKnomoActionDispatch("record-stats-view-month"), { type: "record-stats-view-month" });
	assert.deepEqual(getKnomoActionDispatch("record-stats-filter-trend"), { type: "record-stats-filter-trend" });
	assert.deepEqual(getKnomoActionDispatch("record-stats-filter-hour"), { type: "record-stats-filter-hour" });
	assert.deepEqual(getKnomoActionDispatch("record-stats-filter-notes"), { type: "record-stats-filter-notes" });
	assert.deepEqual(getKnomoActionDispatch("record-stats-filter-with-tag"), { type: "record-stats-filter-with-tag" });
	assert.deepEqual(getKnomoActionDispatch("record-stats-filter-no-tag"), { type: "record-stats-filter-no-tag" });
	assert.deepEqual(getKnomoActionDispatch("record-stats-filter-with-image"), { type: "record-stats-filter-with-image" });
	assert.deepEqual(getKnomoActionDispatch("record-stats-filter-tag"), { type: "record-stats-filter-tag" });
	assert.deepEqual(getKnomoActionDispatch("record-stats-filter-references"), {
		type: "record-stats-filter-references",
	});
	assert.deepEqual(getKnomoActionDispatch("record-stats-filter-max-daily-notes"), {
		type: "record-stats-filter-max-daily-notes",
	});
	assert.deepEqual(getKnomoActionDispatch("record-stats-filter-max-daily-words"), {
		type: "record-stats-filter-max-daily-words",
	});
	assert.deepEqual(getKnomoActionDispatch("something-new"), { type: "unknown", action: "something-new" });
});

test("classifies composer tool actions", () => {
	assert.deepEqual(getKnomoActionDispatch("insert-tag"), { type: "composer-tool", action: "insert-tag" });
	assert.deepEqual(getKnomoActionDispatch("insert-image"), { type: "composer-tool", action: "insert-image" });
	assert.deepEqual(getKnomoActionDispatch("insert-list"), { type: "composer-tool", action: "insert-list" });
	assert.deepEqual(getKnomoActionDispatch("insert-numbered-list"), {
		type: "composer-tool",
		action: "insert-numbered-list",
	});
	assert.equal(isComposerToolAction("insert-tag"), true);
	assert.equal(isComposerToolAction("save-input"), false);
});

test("classifies memo and trash actions", () => {
	assert.deepEqual(getMemoActionDispatch(null), { type: "none" });
	assert.deepEqual(getMemoActionDispatch("edit"), { type: "memo-action", action: "edit" });
	assert.deepEqual(getMemoActionDispatch("reference"), { type: "memo-action", action: "reference" });
	assert.deepEqual(getMemoActionDispatch("open-daily"), { type: "memo-action", action: "open-daily" });
	assert.deepEqual(getMemoActionDispatch("copy-text"), { type: "memo-action", action: "copy-text" });
	assert.deepEqual(getMemoActionDispatch("copy-link"), { type: "memo-action", action: "copy-link" });
	assert.deepEqual(getMemoActionDispatch("delete"), { type: "memo-action", action: "delete" });
	assert.deepEqual(getMemoActionDispatch("mark-reviewed"), { type: "memo-action", action: "mark-reviewed" });
	assert.deepEqual(getMemoActionDispatch("confirm-identity"), { type: "memo-action", action: "confirm-identity" });
	assert.deepEqual(getMemoActionDispatch("restore"), { type: "unknown", action: "restore" });
	assert.equal(isMemoAction("edit"), true);
	assert.equal(isMemoAction("purge"), false);

	assert.deepEqual(getTrashActionDispatch(null), { type: "none" });
	assert.deepEqual(getTrashActionDispatch("restore"), { type: "trash-action", action: "restore" });
	assert.deepEqual(getTrashActionDispatch("purge"), { type: "unknown", action: "purge" });
	assert.deepEqual(getTrashActionDispatch("open-daily"), { type: "unknown", action: "open-daily" });
	assert.deepEqual(getTrashActionDispatch("copy-text"), { type: "unknown", action: "copy-text" });
	assert.equal(isTrashAction("restore"), true);
	assert.equal(isTrashAction("copy-text"), false);
});

test("keeps legacy render-after-action behavior explicit", () => {
	const renderAfterActions = [
		"open-drawer",
		"close-drawer",
		"toggle-scope-menu",
		"toggle-sidebar",
		"collapse-sidebar",
		"focus-stats",
		"toggle-compact-search",
		"unknown-action",
	];
	for (const action of renderAfterActions) {
		assert.equal(shouldRenderAfterActionDispatch(getKnomoActionDispatch(action)), true);
	}

	const immediateActions = [
		null,
		"toggle-card-menu",
		"refresh-random-reunion",
		"load-more",
		"load-more-mobile-search",
		"reset-list-state",
		"close-mobile-search",
		"record-stats-back",
		"refresh",
		"retry-all-memos",
		"open-composer",
		"insert-tag",
		"clear-reference",
		"cancel-edit",
		"save-input",
	];
	for (const action of immediateActions) {
		assert.equal(shouldRenderAfterActionDispatch(getKnomoActionDispatch(action)), false);
	}
});
