import assert from "node:assert/strict";
import test from "node:test";
import type { MemoSaveResult } from "../src/types/catalogView";

import { ensureObsidianStub } from "./helpers/obsidianStub";

test("composer 在 Daily 提交后立即清空，不等待后续查询反馈", async () => {
	await ensureObsidianStub();
	const { KnomoView } = await import("../src/ui/KnomoView");
	const reloadCalls: Array<{ loadAll: boolean; forceRebuild: boolean | undefined }> = [];
	const dailyCommitted = createDeferred<void>();
	const saveSettled = createDeferred<MemoSaveResult>();
	const { Notice } = await import("obsidian");
	const notices = (Notice as unknown as { messages: string[] }).messages; notices.length = 0;
	const view = Object.create(KnomoView.prototype) as SaveInputView;
	view.inputEl = createComposerInput("memo");
	view.getDailyNotesStatus = () => ({ enabled: true });
	view.isComposerCreationAvailable = () => true;
	view.isSaving = false;
	view.editingMemo = null;
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
	view.syncRootState = () => undefined;
	view.memoCommandService = {
		startCreate: () => ({ dailyCommitted: dailyCommitted.promise, settled: saveSettled.promise }),
	};
	view.reloadMemos = async (loadAll, forceRebuild) => {
		reloadCalls.push({ loadAll, forceRebuild });
		return true;
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

	assert.deepEqual(notices, []);
	saveSettled.resolve(makeSaveResult());
	await view.composerSaveRefreshQueue;
	assert.deepEqual(notices, []);
	assert.deepEqual(reloadCalls, []);
});

test("强制替换会话的新草稿不会被旧保存清空", async () => {
	await ensureObsidianStub();
	const { KnomoView } = await import("../src/ui/KnomoView");
	const dailyCommitted = createDeferred<void>();
	const view = Object.create(KnomoView.prototype) as SaveInputView;
	view.inputEl = createComposerInput("old memo");
	view.getDailyNotesStatus = () => ({ enabled: true });
	view.isComposerCreationAvailable = () => true;
	view.isSaving = false;
	view.editingMemo = null;
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

test("保存期间切换到同文新会话不会被旧提交清空，失败保留草稿", async () => {
	await ensureObsidianStub();
	const { KnomoView } = await import("../src/ui/KnomoView");
	for (const fail of [false, true]) {
		const daily = createDeferred<void>();
		const view = Object.create(KnomoView.prototype) as SaveInputView;
		Object.assign(view, {
			getDailyNotesStatus: () => ({ enabled: true }), isComposerCreationAvailable: () => true,
			inputEl: createComposerInput("same text"), isSaving: false, editingMemo: null,
			quoteReferenceText: null, quoteMarkdownText: null, currentLayout: "desktop",
			draftContent: "same text", composerOpen: true,
			closeTimeBuoyPicker: () => undefined, updateStatus: () => undefined,
			updateSendButtonState: () => undefined, syncRootState: () => undefined,
			clearComposerContext: () => { throw new Error("Must retain context"); },
			memoCommandService: { startCreate: () => {
				if (fail) throw new Error("Daily unavailable");
				return { dailyCommitted: daily.promise, settled: Promise.resolve(makeSaveResult()) };
			} },
			reloadMemos: async () => true,
		});
		const saving = view.saveInput();
		if (!fail) view.inputEl = createComposerInput("same text");
		daily.resolve(undefined);
		await saving;
		assert.equal(view.inputEl?.value, "same text");
		assert.equal(view.composerOpen, true);
		assert.equal(view.isSaving, false);
	}
});

test("任务提交成功后由广播更新展示，不重复查询或改写复选框", async () => {
	await ensureObsidianStub();
	const { KnomoView } = await import("../src/ui/KnomoView");
	for (const id of ["memo-1", "old-revision-key"]) {
		const events: string[] = [];
		const original = { id };
		const view = Object.create(KnomoView.prototype) as TaskToggleView;
		view.resolveCatalogMemo = async memo => { assert.equal(memo, original); return { observationHandle: {} }; };
		view.memoCommandService = { toggleTask: async () => {
			events.push("save");
			return { status: "saved", memo: { key: "memo-1" }, localRefreshPending: false };
		} };
		view.reloadMemos = async () => { events.push("reload"); return true; };
		view.memoMarkdownRenderer = { syncTaskCheckboxesForMemo: () => { events.push("sync"); } };
		view.cardFlowEl = null;
		view.mobileSearchController = { results: null };
		await view.handleCatalogTaskToggle(original, 0, true);
		assert.deepEqual(events, ["save"]);
	}
});

test("任务正文提交失败时恢复原复选框", async () => {
	await ensureObsidianStub();
	const { KnomoView } = await import("../src/ui/KnomoView");
	const original = { id: "memo-1" };
	const view = Object.create(KnomoView.prototype) as TaskToggleView;
	view.resolveCatalogMemo = async () => ({ observationHandle: {} });
	view.memoCommandService = { toggleTask: async () => { throw new Error("Daily unavailable"); } };
	const synced: Array<{ id: string }> = [];
	view.memoMarkdownRenderer = { syncTaskCheckboxesForMemo: (_containers, memo) => { synced.push(memo); } };
	view.cardFlowEl = null;
	view.mobileSearchController = { results: null };
	await view.handleCatalogTaskToggle(original, 0, true);
	assert.deepEqual(synced, [original]);
});

interface SaveInputView {
	getDailyNotesStatus: () => { enabled: boolean };
	isComposerCreationAvailable: () => boolean;
	inputEl: ReturnType<typeof createComposerInput> | null;
	isSaving: boolean;
	editingMemo: null;
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
	syncRootState: () => void;
	memoCommandService: {
		startCreate: (content: string) => {
			dailyCommitted: Promise<void>;
			settled: Promise<MemoSaveResult>;
		};
	};
	reloadMemos: (loadAll: boolean, forceRebuild?: boolean) => Promise<boolean>;
	saveInput: () => Promise<void>;
	composerSaveRefreshQueue: Promise<void>;
}

interface TaskToggleView {
	resolveCatalogMemo: (memo: { id: string }) => Promise<{ observationHandle: object }>;
	memoCommandService: {
		toggleTask: (
			item: { observationHandle: object },
			taskIndex: number,
			checked: boolean,
		) => Promise<{ status: "saved"; memo: { key: string }; localRefreshPending: boolean }>;
	};
	reloadMemos: (loadAll: boolean, forceRebuild?: boolean) => Promise<boolean>;
	cardFlowEl: null;
	mobileSearchController: { results: null };
	memoMarkdownRenderer: {
		syncTaskCheckboxesForMemo: (containers: readonly null[], memo: { id: string }) => void;
	};
	handleCatalogTaskToggle: (memo: { id: string }, taskIndex: number, checked: boolean) => Promise<void>;
}

function makeSaveResult(): MemoSaveResult {
	return {
		status: "saved",
		memo: null,
		timeBuoyDates: [],
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

function createComposerInput(initial: string) {
	let value = initial, revision = 0;
	return {
		get value() { return value; },
		set value(next: string) { value = next; revision++; },
		composer: { setSaving: (_saving: boolean) => undefined, capture: () => { const current = revision; return { valid: () => current === revision, sameSession: () => current === revision }; } },
	};
}
