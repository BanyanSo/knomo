import assert from "node:assert/strict";
import test from "node:test";
import { ensureObsidianStub } from "./helpers/obsidianStub";
import { t } from "../src/i18n";
import { KnomoViewStateController } from "../src/ui/KnomoViewStateController";
import type { CardFlowPresentation } from "../src/ui/KnomoCardFlowPresenter";

test("日记关闭时首屏直接显示启用指引，重新启用后进入安静等待", async () => {
	await ensureObsidianStub();
	const { KnomoView } = await import("../src/ui/KnomoView");
	let enabled = false;
	const view = Object.assign(Object.create(KnomoView.prototype), {
		viewStateController: new KnomoViewStateController(),
		catalogStatus: { content: "ready", catalog: "complete", projection: "ready" },
		catalogCoverage: null, cardFlowError: null,
		hasCommittedCatalogDesktopQuery: false, hasConfirmedMemoPresentation: false,
		initialCatalogQueryPending: true,
		getDailyNotesStatus: () => ({ enabled }),
	}) as { getCurrentCardFlowPresentation(): CardFlowPresentation };
	const disabled = view.getCurrentCardFlowPresentation();
	assert.equal(disabled.type, "empty");
	if (disabled.type === "empty") {
		assert.equal(disabled.title, t("service.dailyNotesDisabled"));
		assert.notEqual(disabled.loading, true);
	}
	enabled = true;
	const pending = view.getCurrentCardFlowPresentation();
	assert.equal(pending.type, "empty");
	if (pending.type === "empty") {
		assert.equal(pending.title, "");
		assert.equal(pending.loading, true);
	}
});

test("新建输入和图片入口只遵循 Daily 配置，Catalog 未就绪或不可用仍可记录", async () => {
	await ensureObsidianStub();
	const { KnomoView } = await import("../src/ui/KnomoView");
	let enabled = true, statusUpdates = 0;
	const view = Object.assign(Object.create(KnomoView.prototype), {
		inputEl: { disabled: false }, isSaving: false, editingMemo: null, quoteReferenceText: null, cardFlowError: null,
		getDailyNotesStatus: () => ({ enabled }), getTodayDailyNotePath: () => "Daily/2026-10-18.md",
		updateStatus: () => { statusUpdates++; },
	}) as {
		inputEl: { disabled: boolean }; catalogReadState: string;
		syncComposerDailyStatus(): void; getImageSourcePath(): string | null;
	};
	for (const readState of ["ready", "history_building", "storage_unavailable"]) {
		view.catalogReadState = readState;
		for (const dailyEnabled of [true, false]) {
			enabled = dailyEnabled;
			view.syncComposerDailyStatus();
			assert.equal(view.inputEl.disabled, !dailyEnabled, readState);
			assert.equal(view.getImageSourcePath(), dailyEnabled ? "Daily/2026-10-18.md" : null, readState);
		}
	}
	assert.equal(statusUpdates, 6);
});

test("同步 Daily 配置保留保存中、编辑、引用和列表故障的状态提示", async () => {
	await ensureObsidianStub();
	const { KnomoView } = await import("../src/ui/KnomoView");
	for (const state of [{ isSaving: true }, { editingMemo: {} }, { quoteReferenceText: "reference" }, { cardFlowError: "failed" }]) {
		const view = Object.assign(Object.create(KnomoView.prototype), {
			inputEl: { disabled: true }, isSaving: false, editingMemo: null, quoteReferenceText: null, cardFlowError: null,
			getDailyNotesStatus: () => ({ enabled: true }), updateStatus: () => assert.fail("不能覆盖当前提示"), ...state,
		}) as { inputEl: { disabled: boolean }; syncComposerDailyStatus(): void };
		view.syncComposerDailyStatus();
		assert.equal(view.inputEl.disabled, false);
	}
});
