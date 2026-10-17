import test from "node:test";
import assert from "node:assert/strict";
import type { CatalogLibraryIndexesResult } from "../src/types/catalogView";
import type { CatalogQueryFilter } from "../src/types/catalog";
import type { KnomoWorkspaceMobileSearchState } from "../src/ui/KnomoWorkspaceViewState";
import { parseKnomoWorkspaceViewState } from "../src/ui/KnomoWorkspaceViewState";
import type { KnomoViewStateController } from "../src/ui/KnomoViewStateController";
import { RecordStatsViewStateController } from "../src/ui/RecordStatsViewStateController";
import { ensureObsidianStub } from "./helpers/obsidianStub";

test("Workspace在onOpen前或后提供状态，首次查询只使用恢复后的主条件", async () => {
	for (const beforeOpen of [true, false]) {
		const h = await fixture();
		try {
			const state = savedState("release");
			if (beforeOpen) await h.view.setState(state, { history: false });
			await h.view.onOpen();
			if (!beforeOpen) {
				assert.deepEqual(h.queries, [], "onOpen只建立shell，不等待宿主setState，也不先查默认页");
				assert.equal(h.timers.size, 1);
				await h.view.setState(state, { history: false });
			}
			h.flushTimers(); await settle();
			assert.deepEqual(h.queries, [{ textTerms: ["release"] }]);
			assert.equal(h.timers.size, 0);
			assert.equal(h.mobile().input, "mobile-only");
			assert.equal(h.view.composerOpen, false);
			assert.equal(h.saves(), 0, "宿主恢复本身不写回布局");
		} finally { await h.close(); }
	}
});

test("没有宿主状态时macrotask只启动一次默认查询，多个leaf条件独立", async () => {
	const first = await fixture(), second = await fixture();
	try {
		await first.view.onOpen();
		assert.deepEqual(first.queries, []);
		first.flushTimers(); first.flushTimers(); await settle();
		assert.deepEqual(first.queries, [{}]);
		await second.view.setState(savedState("second"), { history: false });
		await second.view.onOpen(); await settle();
		assert.deepEqual(second.queries, [{ textTerms: ["second"] }]);
		assert.equal(first.view.viewStateController.searchQuery, "");
		const exported = second.view.getState();
		assert.deepEqual(exported, second.view.getState());
		assert.equal(second.saves(), 0);
		await second.view.setState(savedState("next"), { history: false }); await settle();
		assert.deepEqual(second.queries.at(-1), { textTerms: ["next"] });
	} finally { await first.close(); await second.close(); }
});

test("迟到首次恢复不覆盖已开始的新导航与编辑，布局只在语义提交时保存", async () => {
	const h = await fixture();
	try {
		await h.view.onOpen();
		h.view.setScope("with-image");
		h.view.inputEl.value = "new edit";
		const editor = h.view.inputEl;
		await h.view.setState(savedState("old"), { history: false });
		h.flushTimers(); await settle();
		assert.equal(h.view.viewStateController.scopeFilter, "with-image");
		assert.equal(h.view.inputEl, editor);
		assert.equal(h.view.inputEl.value, "new edit");
		assert.deepEqual(h.queries, [{ hasImage: true }]);
		assert.equal(h.saves(), 1);
		h.view.viewStateController.search.updateDraft("draft");
		h.view.invalidateSearchDraft();
		assert.equal(h.saves(), 1);
		h.view.submitSearchDraft();
		assert.equal(h.saves(), 2);
		assert.equal(h.view.viewStateController.searchQuery, "draft");
	} finally { await h.close(); }
});

test("恢复tag只根据完整可靠facet判断，父tag保留子tag匹配", async () => {
	for (const mode of ["missing", "child", "partial", "invalidated"] as const) {
		const result = indexes(mode === "child" ? ["project/child"] : []);
		if (mode === "partial") { result.complete = false; result.coverage.kind = "partial"; }
		if (mode === "invalidated") result.invalidated = true;
		const h = await fixture(() => Promise.resolve(result));
		try {
			const state = savedState(""); state.navigation.activeTag = "Project"; state.navigation.activeTagKey = "project";
			await h.view.setState(state, { history: false }); await h.view.onOpen(); await settle();
			assert.deepEqual(h.queries, [mode === "missing" ? {} : { tags: ["project"] }]);
			assert.equal(h.view.viewStateController.activeTagKey, mode === "missing" ? null : "project");
		} finally { await h.close(); }
	}
});

test("异步tag检查期间普通编辑仍完成当前导航首查，并保留输入", async () => {
	const pending = deferred<CatalogLibraryIndexesResult>();
	const h = await fixture(() => pending.promise);
	try {
		const state = savedState(""); state.navigation.activeTag = "Project"; state.navigation.activeTagKey = "project";
		await h.view.setState(state, { history: false }); await h.view.onOpen();
		h.view.inputEl.value = "new Composer draft";
		h.view.noteWorkspaceInteraction();
		pending.resolve(indexes(["project/child"])); await settle();
		assert.deepEqual(h.queries, [{ tags: ["project"] }]);
		assert.equal(h.view.inputEl.value, "new Composer draft");
		assert.equal(h.saves(), 0);
	} finally { await h.close(); }
});

test("异步tag检查遇到新导航或关闭停止恢复，不回填条件或发起旧查询", async () => {
	for (const action of ["navigate", "close"] as const) {
		const pending = deferred<CatalogLibraryIndexesResult>();
		const h = await fixture(() => pending.promise);
		const state = savedState(""); state.navigation.activeTag = "Old"; state.navigation.activeTagKey = "old";
		await h.view.setState(state, { history: false }); await h.view.onOpen();
		if (action === "navigate") h.view.setScope("with-link");
		else await h.view.onClose();
		pending.resolve(indexes([])); await settle();
		assert.deepEqual(h.queries, action === "navigate" ? [{ hasLink: true }] : []);
		if (action === "navigate") assert.equal(h.view.viewStateController.scopeFilter, "with-link");
		await h.close();
	}
});

test("Trash首次恢复不等待侧栏统计，布局保存失败不阻断导航", async context => {
	const pending = deferred<CatalogLibraryIndexesResult>();
	const warnings: unknown[][] = [];
	context.mock.method(console, "warn", (...args: unknown[]) => { warnings.push(args); });
	const h = await fixture(() => pending.promise);
	try {
		const state = savedState(""); state.navigation.activeNav = "trash";
		await h.view.setState(state, { history: false }); await h.view.onOpen(); await settle();
		assert.deepEqual(h.routes, ["trash"]);
		assert.deepEqual(h.queries, []);
		pending.reject(new Error("Catalog unavailable")); await settle();
		h.failLayoutSave();
		assert.doesNotThrow(() => h.view.requestWorkspaceLayoutSave());
		await settle();
		assert.equal(warnings.length, 2);
		assert.deepEqual(h.routes, ["trash"]);
	} finally { await h.close(); }
});

test("Stats恢复使用索引source和统计入口，不先读取默认Memo列表", async () => {
	const h = await fixture();
	try {
		const state = savedState(""); state.navigation.activeNav = "record-stats";
		await h.view.setState(state, { history: false }); await h.view.onOpen(); await settle();
		assert.deepEqual(h.queries, []);
		assert.deepEqual(h.routes, ["stats-source", "record-stats"]);
	} finally { await h.close(); }
});

function savedState(input: string) {
	const state = parseKnomoWorkspaceViewState({ version: 1, navigation: { activeNav: "all", search: { input } },
		mobileSearch: { input: "mobile-only", shortcut: "last-7" } });
	return state;
}

function indexes(tags: string[]): CatalogLibraryIndexesResult {
	return { value: { summary: { memoCount: 1, tagCount: tags.length, imageCount: 0, wordCount: 1 },
		facets: tags.map(key => ({ key, label: key, count: 1 })) }, complete: true, catalogRevision: 1,
		coverage: { kind: "complete", coveredFromDate: "2026-01-01", pendingFileCount: 0, coveredFileCount: 1, totalFileCount: 1 },
		lifecycle: { state: "ready", persistent: true, writable: true, reason: null }, invalidated: false };
}

async function fixture(getIndexes = async () => indexes([])) {
	await ensureObsidianStub();
	const [{ KnomoView }, { Platform }, { KnomoViewStateController }] = await Promise.all([
		import("../src/ui/KnomoView"), import("obsidian"), import("../src/ui/KnomoViewStateController"),
	]);
	const previousMobile = Platform.isMobile; Platform.isMobile = false;
	const timers = new Map<number, () => void>(); let timer = 0, saveCount = 0, failSave = false;
	const cleanups: Array<() => void> = [], queries: CatalogQueryFilter[] = [], routes: string[] = [];
	let mobile: KnomoWorkspaceMobileSearchState = { input: "", shortcut: null, recordStatsSearchFilter: null };
	const noop = () => {};
	const service = (route: string) => ({ cancelPending: noop, dispose: noop, refresh: async () => { routes.push(route); } });
	const view: WorkspaceView = Object.assign(Object.create(KnomoView.prototype), {
		app: { loadLocalStorage: () => null, saveLocalStorage: noop, workspace: { requestSaveLayout: () => {
			saveCount++; return failSave ? Promise.reject(new Error("layout unavailable")) : Promise.resolve();
		} } },
		containerEl: { doc: { body: { removeClass: noop } }, win: {
			setTimeout: (callback: () => void) => { timers.set(++timer, callback); return timer; }, clearTimeout: (id: number) => { timers.delete(id); },
		} }, contentEl: { removeClass: noop }, rootEl: null, renderScope: null,
		viewStateController: new KnomoViewStateController(), recordStatsViewStateController: new RecordStatsViewStateController(),
		mobileSearchController: { isOpen: false, generation: 0, exportWorkspaceState: () => structuredClone(mobile),
			applyWorkspaceState: (state: KnomoWorkspaceMobileSearchState) => { mobile = structuredClone(state); }, cancelPendingRequest: noop,
			clearDebounce: noop, removePage: noop, resetState: noop },
		settingsService: { getSettings: () => ({ timeBuoyEnabled: false }) },
		workspaceViewReady: false, workspaceStateReceived: false, workspaceInitialLoadStarted: false, workspaceInitialLoadTimer: null,
		workspaceRestoreRun: 0, workspaceInteractionEpoch: 0, catalogRevision: 0, trashViewClosed: false, composerOpen: false,
		popupState: { scopeMenuOpen: false, activeMenuMemoId: null },
		inputEl: { value: "", composer: { composing: false } }, editingMemo: null, isSaving: false, composerIsComposing: false,
		register: (cleanup: () => void) => cleanups.push(cleanup), registerDomEvent: noop, initializeView: async () => {}, validateRestoredDraft: async () => {},
		recoverMobileViewFocus: noop, settleQuickCommandReady: noop, cancelPendingQuickCommand: noop, syncSearchInputs: noop,
		renderUiState: noop, renderStats: noop, renderTags: noop, renderFilteredListState: noop, renderScopeState: noop, syncRootState: noop,
		syncCardMenuState: noop, syncSearchControls: noop, renderCardFlow: noop, clearSearchDebounce: noop,
		getCardFlowViewStateKey: () => "view", getCardFlowChangeIntent: () => "view-scope-change", getCatalogReadService: () => ({ getLibraryIndexes: getIndexes }),
		randomReunionController: service("random"), shuffleDayController: service("shuffleDay"), timeBuoyViewController: { clear: noop, loadInitial: async () => { routes.push("time-buoy"); } },
		trashMemoController: { dispose: noop, loadTrashMemos: async () => { routes.push("trash"); } },
		getCardFlowStateKey: () => "cards", getMobileSearchStateKey: () => "mobile",
		reloadCurrentCatalogQuery: async () => { queries.push(view.viewStateController.search.getFilter(view.viewStateController.getSearchSource())); return true; },
		loadInitialMobileMemos: async () => { queries.push(view.viewStateController.search.getFilter(view.viewStateController.getSearchSource())); },
		updateStatus: noop, flushLocalDraft: noop, disposeTagIndexWarmup: noop, closeTimeBuoyPicker: noop, clearRecordStatsPreparation: noop,
		syncRecordStatsSource: () => { routes.push("stats-source"); }, prepareRecordStats: async () => { routes.push("record-stats"); return true; },
		recordStatsPreparationController: { clearRetryRequest: noop }, recordStatsService: { invalidate: noop }, resetTimeBuoyCardFlow: noop,
		clearMobileCardBatchContinuation: noop, cardFlowCoordinator: { generation: 0, setPendingScrollRestore: noop, removeSentinel: noop },
		mobileComposerController: { dispose: noop }, cardImageLoadQueue: { dispose: noop }, cardImageCache: { clear: noop },
		memoCardPreviewCache: { clear: noop }, imageResourceCache: { clear: noop }, nativeImagePickerController: { dispose: noop },
		clearMobileImagePickerFocusGuard: noop, clearSuppressNextOpenPopupDismissClick: noop, removeMobileHeaderTitle: noop,
		removeMobileHeaderActions: noop, stopDateChangeWatcher: noop, stopLayoutObserver: noop, memoMarkdownRenderer: { clear: noop },
	}) as WorkspaceView;
	return { view, timers, queries, routes, mobile: () => mobile, saves: () => saveCount, failLayoutSave: () => { failSave = true; },
		flushTimers: () => { const callbacks = [...timers.values()]; timers.clear(); for (const callback of callbacks) callback(); },
		close: async () => { if (!view.trashViewClosed) await view.onClose(); for (const cleanup of cleanups.splice(0)) cleanup(); Platform.isMobile = previousMobile; },
	};
}

async function settle() { for (let tick = 0; tick < 12; tick++) await Promise.resolve(); }
function deferred<T>() { let resolve!: (value: T) => void, reject!: (reason: unknown) => void;
	const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; }); return { promise, resolve, reject }; }

interface WorkspaceView {
	viewStateController: KnomoViewStateController;
	inputEl: { value: string };
	composerOpen: boolean;
	trashViewClosed: boolean;
	getState(): Record<string, unknown>;
	setState(state: unknown, result: { history: boolean }): Promise<void>;
	onOpen(): Promise<void>;
	onClose(): Promise<void>;
	setScope(scope: "with-image" | "with-link"): void;
	invalidateSearchDraft(): void;
	submitSearchDraft(): void;
	noteWorkspaceInteraction(): void;
	requestWorkspaceLayoutSave(): void;
}
