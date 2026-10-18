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
