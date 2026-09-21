import assert from "node:assert/strict";
import test from "node:test";
import type { KnomoQuickCommand } from "../src/ui/KnomoQuickCommands";
import type { CatalogFeatureFilter } from "../src/types/catalogView";
import { KnomoViewStateController } from "../src/ui/KnomoViewStateController";
import { ensureObsidianStub } from "./helpers/obsidianStub";

async function harness() {
	await ensureObsidianStub();
	const { KnomoView } = await import("../src/ui/KnomoView");
	const events: string[] = [];
	const editorState = { selection: { anchor: 2, head: 5 }, history: ["before", "draft"] };
	const input = {
		get value() { return "unfinished draft"; },
		set value(_text: string) { assert.fail("命令不得重设编辑器值"); },
		composer: { composing: false, view: { state: editorState, focus: () => { events.push("focus"); } } },
	};
	const state = new KnomoViewStateController();
	const view = Object.assign(Object.create(KnomoView.prototype), {
		trashViewClosed: false, executingQuickCommand: false, isSaving: false, composerIsComposing: false,
		composerOpen: false, currentLayout: "desktop-wide", inputEl: input,
		editingMemo: null, quoteReferenceText: null, quoteMarkdownText: null,
		draftContent: "unfinished draft", suspendedCreate: { content: "suspended" },
		viewStateController: state, mobileSearchController: { isOpen: false }, popupState: { scopeMenuOpen: false },
		settingsService: { getSettings: () => ({ timeBuoyEnabled: true }) },
		mobileComposerController: {
			clearFocus: () => { events.push("clear-focus"); },
			prepareDesktopOpen: () => {},
			focusInputSoon: () => { input.composer.view.focus(); },
			resetInactiveState: () => {},
			queueViewportUpdate: () => {},
			open: () => { view.composerOpen = true; input.composer.view.focus(); },
			closeKeepingDraft: () => { view.composerOpen = false; },
		},
		pauseMobileBackgroundWork: () => {}, resizeInput: () => {},
		syncRootState: () => {}, syncComposerMode: () => {}, updateSendButtonState: () => {}, updateCancelEditButtonState: () => {},
		closeTimeBuoyPicker: () => {}, tagSuggest: null, wikiLinkSuggest: null,
		closeMobileSearchPage: () => { view.mobileSearchController.isOpen = false; events.push("close-search"); },
		clearSearchDebounce: () => {}, getCardFlowViewStateKey: () => "old", getCardFlowChangeIntent: () => "view-scope-change",
		renderFilteredListState: () => {}, refreshCatalogActiveQuery: () => { events.push("query"); },
		renderScopeState: () => {}, syncSearchInputs: () => {},
		onQuickCommandInteraction: () => { events.push("cancel-command"); },
	}) as ViewHarness;
	return { view, state, input, editorState, events };
}

interface ViewHarness {
	executeQuickCommand(command: KnomoQuickCommand): void;
	buildCatalogActiveQuery(all: boolean): CatalogFeatureFilter;
	setSidebarNav(nav: string): void;
	setTitleMode(mode: string): void;
	returnFromRecordStats(): void;
	onOpen(): Promise<void>;
	waitForQuickCommands(): Promise<boolean>;
	initializeView(): Promise<void>;
	settleQuickCommandReady(value: boolean): void;
	quickCommandReady: Promise<boolean>;
	trashViewClosed: boolean;
	composerOpen: boolean;
	isSaving: boolean;
	composerIsComposing: boolean;
	currentLayout: string;
	editingMemo: { observationHandle: object } | null;
	quoteReferenceText: string | null;
	quoteMarkdownText: string | null;
	suspendedCreate: object;
	mobileSearchController: { isOpen: boolean };
	settingsService: { getSettings(): { timeBuoyEnabled: boolean } };
}

test("新建命令在桌面与移动端打开同一草稿，重复执行不改选区与历史", async () => {
	for (const layout of ["desktop-wide", "mobile"]) {
		const h = await harness();
		h.view.currentLayout = layout;
		const suspended = h.view.suspendedCreate;
		h.view.executeQuickCommand("new-memo");
		h.view.executeQuickCommand("new-memo");
		assert.equal(h.view.composerOpen, true);
		assert.equal(h.input.value, "unfinished draft");
		assert.equal(h.input.composer.view.state, h.editorState);
		assert.deepEqual(h.editorState, { selection: { anchor: 2, head: 5 }, history: ["before", "draft"] });
		assert.equal(h.view.suspendedCreate, suspended);
		assert.deepEqual(h.events, ["focus", "focus"]);
	}
});

test("新建命令保留编辑 observation 与引用上下文，且关闭移动搜索覆盖层", async () => {
	const h = await harness();
	const editingMemo = { observationHandle: { revision: "original" } };
	h.view.editingMemo = editingMemo;
	h.view.quoteReferenceText = "reference";
	h.view.quoteMarkdownText = "[[source]]";
	h.view.mobileSearchController.isOpen = true;
	h.view.executeQuickCommand("new-memo");
	assert.equal(h.view.editingMemo, editingMemo);
	assert.equal(h.view.quoteReferenceText, "reference");
	assert.equal(h.view.quoteMarkdownText, "[[source]]");
	assert.deepEqual(h.events, ["close-search", "focus"]);
});

test("从记录统计新建先通过现有返回入口恢复可见输入区，不重建会话", async () => {
	const h = await harness();
	h.state.setSidebarNav("record-stats");
	h.view.returnFromRecordStats = () => { h.state.returnFromRecordStats(); h.events.push("return-from-stats"); };
	h.view.executeQuickCommand("new-memo");
	assert.equal(h.state.activeNav, "all");
	assert.equal(h.view.composerOpen, true);
	assert.equal(h.input.composer.view.state, h.editorState);
	assert.deepEqual(h.events, ["return-from-stats", "focus"]);
});

test("保存或输入法组合期间的新建不重开或聚焦编辑器", async () => {
	for (const mode of ["saving", "view-composing", "editor-composing"]) {
		const h = await harness();
		h.view.isSaving = mode === "saving";
		h.view.composerIsComposing = mode === "view-composing";
		h.input.composer.composing = mode === "editor-composing";
		h.view.executeQuickCommand("new-memo");
		assert.deepEqual(h.events, []);
		assert.equal(h.input.value, "unfinished draft");
	}
});

test("五个功能命令调用共享入口且收起输入时保留会话", async () => {
	for (const [command, expected] of [
		["random-revisit", "random"], ["shuffle-day", "shuffleDay"], ["time-buoy", "time-buoy"],
		["record-stats", "record-stats"], ["on-this-day", "anniversary"],
	] as const) {
		const h = await harness();
		const editing = { observationHandle: {} };
		h.view.editingMemo = editing;
		h.view.composerOpen = true;
		h.view.setSidebarNav = (nav) => { h.events.push(nav); };
		h.view.setTitleMode = (mode) => { h.events.push(mode); };
		h.view.executeQuickCommand(command);
		assert.equal(h.view.composerOpen, false);
		assert.equal(h.view.editingMemo, editing);
		assert.equal(h.input.composer.view.state, h.editorState);
		assert.deepEqual(h.events, ["clear-focus", expected]);
	}
});

test("那年今日实际共享筛选入口清除组合条件，重复执行不变成 toggle", async () => {
	const h = await harness();
	Object.assign(h.state, {
		activeNav: "things", searchQuery: "release", searchDateFilter: "last-30", activeTag: "tag", activeTagKey: "tag",
		recordStatsSearchFilter: { type: "day", date: "2026-09-20" },
	});
	h.view.executeQuickCommand("on-this-day");
	h.view.executeQuickCommand("on-this-day");
	assert.equal(h.state.activeNav, "all");
	assert.equal(h.state.scopeFilter, "anniversary");
	assert.equal(h.state.searchQuery, "");
	assert.equal(h.state.searchDateFilter, null);
	assert.equal(h.state.activeTagKey, null);
	assert.equal(h.state.recordStatsSearchFilter, null);
	const date = new Date();
	const monthDay = `${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
	assert.deepEqual(h.view.buildCatalogActiveQuery(false), { monthDay, excludeDate: `${date.getFullYear()}-${monthDay}` });
	assert.equal(h.events.includes("cancel-command"), false);
});

test("时光浮标开关和已关闭视图在入口内部再次校验", async () => {
	const h = await harness();
	h.view.setSidebarNav = () => assert.fail("不应导航");
	h.view.settingsService.getSettings = () => ({ timeBuoyEnabled: false });
	h.view.executeQuickCommand("time-buoy");
	h.view.trashViewClosed = true;
	h.view.executeQuickCommand("new-memo");
	assert.deepEqual(h.events, []);
});

test("视图就绪只在初始化成功后报告，失败与关闭不会报告可操作", async () => {
	for (const mode of ["ready", "failed", "closed"]) {
		const h = await harness();
		h.view.quickCommandReady = new Promise((resolve) => { h.view.settleQuickCommandReady = resolve; });
		h.view.initializeView = async () => {
			if (mode === "failed") throw new Error("initialization failed");
			if (mode === "closed") h.view.trashViewClosed = true;
		};
		if (mode === "failed") await assert.rejects(h.view.onOpen(), /initialization failed/);
		else await h.view.onOpen();
		assert.equal(await h.view.waitForQuickCommands(), mode === "ready");
	}
});

test("那年今日在闰日使用本地 02-29，不添加过去年份条件", async (context) => {
	const h = await harness();
	context.mock.timers.enable({ apis: ["Date"], now: new Date(2024, 1, 29, 12).getTime() });
	h.view.executeQuickCommand("on-this-day");
	assert.deepEqual(h.view.buildCatalogActiveQuery(false), { monthDay: "02-29", excludeDate: "2024-02-29" });
});
