import test from "node:test";
import assert from "node:assert/strict";

import { DesktopSidebarStateController } from "../src/ui/DesktopSidebarStateController";
import {
	SIDEBAR_MAX_WIDTH,
	SIDEBAR_MIN_WIDTH,
} from "../src/ui/KnomoSidebar";

test("desktop sidebar state loads settings and clamps the saved width", () => {
	const controller = new DesktopSidebarStateController();

	controller.setFromSettings(999, true);

	assert.deepEqual(controller.getSnapshot(), {
		collapsed: true,
		width: SIDEBAR_MAX_WIDTH,
	});
});

test("desktop sidebar state toggles and expands without changing width", () => {
	const controller = new DesktopSidebarStateController();
	controller.setFromSettings(260, true);

	controller.toggleCollapsed();
	assert.deepEqual(controller.getSnapshot(), { collapsed: false, width: 260 });

	controller.setCollapsed(true);
	controller.expandWithoutPersisting();
	assert.deepEqual(controller.getSnapshot(), { collapsed: false, width: 260 });
});

test("desktop sidebar state clamps explicit width updates", () => {
	const controller = new DesktopSidebarStateController();

	controller.setWidth(100);
	assert.equal(controller.getSnapshot().width, SIDEBAR_MIN_WIDTH);

	controller.setWidth(999);
	assert.equal(controller.getSnapshot().width, SIDEBAR_MAX_WIDTH);
});

test("desktop sidebar state blocks resize while collapsed", () => {
	const controller = new DesktopSidebarStateController();
	controller.setFromSettings(248, true);

	assert.equal(controller.startResize(1, 100), false);
	assert.equal(controller.resize(1, 180), false);
	assert.deepEqual(controller.getSnapshot(), { collapsed: true, width: 248 });
});

test("desktop sidebar state resizes only the active pointer", () => {
	const controller = new DesktopSidebarStateController();
	controller.setFromSettings(240, false);

	assert.equal(controller.startResize(7, 100), true);
	assert.equal(controller.resize(8, 160), false);
	assert.equal(controller.getSnapshot().width, 240);

	assert.equal(controller.resize(7, 130), true);
	assert.equal(controller.getSnapshot().width, 270);
	assert.equal(controller.stopResize(8), false);
	assert.equal(controller.stopResize(7), true);
});

test("desktop sidebar state clears stale drag state when settings are reloaded", () => {
	const controller = new DesktopSidebarStateController();
	controller.setFromSettings(240, false);

	assert.equal(controller.startResize(7, 100), true);
	controller.setFromSettings(250, false);

	assert.equal(controller.resize(7, 160), false);
	assert.deepEqual(controller.getSnapshot(), { collapsed: false, width: 250 });
});
