import assert from "node:assert/strict";
import test from "node:test";

import { ensureObsidianStub } from "./helpers/obsidianStub";

test("composer 在 Daily 提交后立即清空，不等待卡片刷新", async () => {
	await ensureObsidianStub();
	const { KnomoView } = await import("../src/ui/KnomoView");
	const reloadCalls: Array<{ loadAll: boolean; forceRebuild: boolean | undefined }> = [];
	const dailyCommitted = createDeferred<void>();
	const saveSettled = createDeferred<SaveResult>();
	const reloadStarted = createDeferred<void>();
	const reloadFinished = createDeferred<boolean>();
	const view = Object.create(KnomoView.prototype) as SaveInputView;
	view.inputEl = { value: "memo" };
	view.isSaving = false;
	view.editingMemo = null;
	view.quoteSourceMemoId = null;
	view.quoteReferenceText = null;
	view.quoteMarkdownText = null;
	view.currentLayout = "desktop";
	view.draftContent = "memo";
	view.composerOpen = true;
	view.closeTimeBuoyPicker = () => undefined;
	view.updateStatus = () => undefined;
	view.updateSendButtonState = () => undefined;
	view.clearComposerContext = () => undefined;
	view.syncComposerMode = () => undefined;
	view.updateCancelEditButtonState = () => undefined;
	view.resizeInput = () => undefined;
	view.showTimeBuoySaveFeedback = () => undefined;
	view.syncRootState = () => undefined;
	view.memoCommandService = {
		startCreate: () => ({ dailyCommitted: dailyCommitted.promise, settled: saveSettled.promise }),
	};
	view.reloadMemos = async (loadAll, forceRebuild) => {
		reloadCalls.push({ loadAll, forceRebuild });
		reloadStarted.resolve();
		return reloadFinished.promise;
	};

	const saving = view.saveInput();
	await Promise.resolve();
	assert.equal(view.inputEl.value, "memo");
	assert.equal(view.isSaving, true);
	dailyCommitted.resolve(undefined);
	await saving;
	assert.equal(view.inputEl.value, "");
	assert.equal(view.isSaving, false);
	assert.deepEqual(reloadCalls, []);

	saveSettled.resolve(makeSaveResult());
	await reloadStarted.promise;
	try {
		assert.deepEqual(reloadCalls, [{ loadAll: false, forceRebuild: undefined }]);
	} finally {
		reloadFinished.resolve(true);
		await Promise.resolve();
	}
});

test("Daily 提交前继续输入的新草稿不会被旧保存清空", async () => {
	await ensureObsidianStub();
	const { KnomoView } = await import("../src/ui/KnomoView");
	const dailyCommitted = createDeferred<void>();
	const view = Object.create(KnomoView.prototype) as SaveInputView;
	view.inputEl = { value: "old memo" };
	view.isSaving = false;
	view.editingMemo = null;
	view.quoteSourceMemoId = null;
	view.quoteReferenceText = null;
	view.quoteMarkdownText = null;
	view.currentLayout = "desktop";
	view.draftContent = "old memo";
	view.composerOpen = true;
	view.closeTimeBuoyPicker = () => undefined;
	view.updateStatus = () => undefined;
	view.updateSendButtonState = () => undefined;
	view.clearComposerContext = () => undefined;
	view.syncComposerMode = () => undefined;
	view.updateCancelEditButtonState = () => undefined;
	view.resizeInput = () => undefined;
	view.showTimeBuoySaveFeedback = () => undefined;
	view.syncRootState = () => undefined;
	view.memoCommandService = {
		startCreate: () => ({ dailyCommitted: dailyCommitted.promise, settled: Promise.resolve(makeSaveResult()) }),
	};
	view.reloadMemos = async () => true;

	const saving = view.saveInput();
	await Promise.resolve();
	view.inputEl.value = "new draft";
	dailyCommitted.resolve(undefined);
	await saving;

	assert.equal(view.inputEl.value, "new draft");
	assert.equal(view.composerOpen, true);
});

test("task checkbox refreshes only changed cards without forcing a full rebuild", async () => {
	await ensureObsidianStub();
	const { KnomoView } = await import("../src/ui/KnomoView");
	const reloadCalls: Array<{ loadAll: boolean; forceRebuild: boolean | undefined }> = [];
	const events: string[] = [];
	const savedCatalogMemo = { key: "memo-1" };
	const updatedMemo = { id: "memo-1" };
	const view = Object.create(KnomoView.prototype) as TaskToggleView;
	view.resolveCatalogMemo = async () => ({ observationHandle: {} });
	view.memoCommandService = {
		toggleTask: async () => ({ status: "saved", memo: savedCatalogMemo }),
	};
	view.applySavedMemo = (memo) => {
		assert.equal(memo, savedCatalogMemo);
		events.push("apply");
		return updatedMemo;
	};
	view.reloadMemos = async (loadAll, forceRebuild) => {
		events.push("reload");
		reloadCalls.push({ loadAll, forceRebuild });
		return true;
	};
	view.memoMarkdownRenderer = {
		syncTaskCheckboxesForMemo: (_containers, memo) => {
			assert.equal(memo, updatedMemo);
			events.push("sync");
		},
	};
	view.cardFlowEl = null;
	view.mobileSearchController = { results: null };

	await view.handleCatalogTaskToggle({ id: "memo-1" }, 0, true);

	assert.deepEqual(reloadCalls, [{ loadAll: false, forceRebuild: undefined }]);
	assert.deepEqual(events, ["apply", "sync", "reload"]);
});

interface SaveInputView {
	inputEl: { value: string } | null;
	isSaving: boolean;
	editingMemo: null;
	quoteSourceMemoId: string | null;
	quoteReferenceText: string | null;
	quoteMarkdownText: string | null;
	currentLayout: "desktop";
	draftContent: string;
	composerOpen: boolean;
	closeTimeBuoyPicker: (restoreFocus: boolean) => void;
	updateStatus: (message: string, isError: boolean) => void;
	updateSendButtonState: () => void;
	clearComposerContext: () => void;
	syncComposerMode: () => void;
	updateCancelEditButtonState: () => void;
	resizeInput: () => void;
	showTimeBuoySaveFeedback: (dates: readonly string[]) => void;
	syncRootState: () => void;
	memoCommandService: {
		startCreate: (content: string, sourceMemoId: string | null) => {
			dailyCommitted: Promise<void>;
			settled: Promise<SaveResult>;
		};
	};
	reloadMemos: (loadAll: boolean, forceRebuild?: boolean) => Promise<boolean>;
	saveInput: () => Promise<void>;
}

interface TaskToggleView {
	resolveCatalogMemo: (memo: { id: string }) => Promise<{ observationHandle: object }>;
	memoCommandService: {
		toggleTask: (
			item: { observationHandle: object },
			taskIndex: number,
			checked: boolean,
		) => Promise<{ status: "saved"; memo: { key: string } }>;
	};
	applySavedMemo: (memo: { key: string }) => { id: string };
	reloadMemos: (loadAll: boolean, forceRebuild?: boolean) => Promise<boolean>;
	cardFlowEl: null;
	mobileSearchController: { results: null };
	memoMarkdownRenderer: {
		syncTaskCheckboxesForMemo: (containers: readonly null[], memo: { id: string }) => void;
	};
	handleCatalogTaskToggle: (memo: { id: string }, taskIndex: number, checked: boolean) => Promise<void>;
}

interface SaveResult {
	status: "saved";
	memoId: string;
	memo: null;
	timeBuoyDates: string[];
	followUpPending: false;
	localRefreshPending: false;
}

function makeSaveResult(): SaveResult {
	return {
		status: "saved",
		memoId: "0198f02c-1a2b-7c3d-8e4f-123456789abc",
		memo: null,
		timeBuoyDates: [],
		followUpPending: false,
		localRefreshPending: false,
	};
}

function createDeferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
	let resolvePromise: (value: T) => void = () => undefined;
	const promise = new Promise<T>((resolve) => {
		resolvePromise = resolve;
	});
	return { promise, resolve: resolvePromise };
}
