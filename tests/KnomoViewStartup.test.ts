import test from "node:test";
import assert from "node:assert/strict";
import { KnomoViewStateController } from "../src/ui/KnomoViewStateController";
import { RecordStatsViewStateController } from "../src/ui/RecordStatsViewStateController";
import { ensureObsidianStub } from "./helpers/obsidianStub";

test("冷启动与新工作区首次打开始终显示全部笔记，不恢复旧页面、筛选或搜索", async () => {
	for (const nav of ["all", "things", "review", "random", "shuffleDay", "trash", "time-buoy", "record-stats"]) {
		for (const beforeOpen of [true, false]) {
			const h = await startupView();
			try {
				const saved = { version: 1, navigation: { activeNav: nav, scopeFilter: "with-image", activeTag: "Work", activeTagKey: "work",
					search: { input: "old search", shortcut: "last-7" } }, mobileSearch: { input: "old mobile search" },
					recordStats: { view: "year", selectedDate: "2024-02-29" } };
				if (beforeOpen) await h.view.setState(saved, { history: false });
				await h.view.onOpen();
				if (!beforeOpen) await h.view.setState(saved, { history: false });
				for (const run of h.timers.values()) run();
				for (let tick = 0; tick < 12; tick++) await Promise.resolve();
				assert.deepEqual(h.opened, [{ nav: "all", filter: {} }], `${nav}, beforeOpen=${beforeOpen}`);
				assert.equal(h.state.isDefaultListState(), true);
				assert.deepEqual(h.view.getState(), {});
				assert.equal(h.loads(), 0, "宿主状态不能在首屏建立后启动第二次页面加载");
			} finally { h.close(); }
		}
	}
});

test("迟到宿主布局不能改变当前会话的新导航或草稿", async () => {
	const h = await startupView();
	try {
		await h.view.onOpen();
		h.state.setScope("with-image");
		await h.view.setState({ version: 1, navigation: { activeNav: "random" } }, { history: false });
		assert.equal(h.state.activeNav, "all");
		assert.equal(h.state.scopeFilter, "with-image");
		assert.equal(h.view.draftContent, "local draft");
	} finally { h.close(); }
});

async function startupView() {
	await ensureObsidianStub();
	const { KnomoView } = await import("../src/ui/KnomoView");
	const state = new KnomoViewStateController();
	const timers = new Map<number, () => void>();
	const cleanups: Array<() => void> = [];
	const opened: Array<{ nav: string; filter: object }> = [];
	let loads = 0;
	const noop = () => {};
	const load = async () => { loads++; return true; };
	const view = Object.assign(Object.create(KnomoView.prototype), {
		app: { loadLocalStorage: () => null, saveLocalStorage: noop },
		containerEl: { doc: {}, win: { setTimeout: (run: () => void) => { timers.set(timers.size + 1, run); return timers.size; },
			clearTimeout: (id: number) => timers.delete(id) } },
		viewStateController: state, recordStatsViewStateController: new RecordStatsViewStateController(),
		mobileSearchController: { isOpen: false },
		settingsService: { getSettings: () => ({ timeBuoyEnabled: true }) },
		randomReunionController: { cancelPending: noop, refresh: load }, shuffleDayController: { cancelPending: noop, refresh: load },
		timeBuoyViewController: { clear: noop, loadInitial: load }, trashMemoController: { loadTrashMemos: load },
		trashViewClosed: false, register: (run: () => void) => cleanups.push(run), registerDomEvent: noop,
		initializeView: async () => {
			opened.push({ nav: state.activeNav, filter: state.search.getFilter(state.getSearchSource()) });
			view.draftContent = "local draft";
		},
		validateRestoredDraft: async () => {}, recoverMobileViewFocus: noop, settleQuickCommandReady: noop, flushLocalDraft: noop,
		renderUiState: noop, syncSearchInputs: noop, reloadCurrentCatalogQuery: load, loadInitialMobileMemos: load,
		getCatalogReadService: () => ({ getLibraryIndexes: async () => ({ value: null }) }), prepareRecordStats: load, syncRecordStatsSource: noop,
	}) as { onOpen(): Promise<void>; setState(raw: unknown, result: { history: boolean }): Promise<void>; getState(): object; draftContent: string };
	return { view, state, timers, opened, loads: () => loads, close: () => cleanups.reverse().forEach(run => run()) };
}
