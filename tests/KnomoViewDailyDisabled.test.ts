import assert from "node:assert/strict";
import test from "node:test";
import { ensureObsidianStub } from "./helpers/obsidianStub";
import { t } from "../src/i18n";

test("日记关闭时历史等待界面显示启用指引，重新启用后恢复加载提示", async () => {
	await ensureObsidianStub();
	const { KnomoView } = await import("../src/ui/KnomoView");
	const titles: string[] = [];
	const element = {
		empty: () => { titles.length = 0; },
		createDiv: (options: { text?: string }) => {
			if (options.text !== undefined) titles.push(options.text);
			return element;
		},
		setAttrs: () => undefined,
	};
	let enabled = false;
	const view = Object.assign(Object.create(KnomoView.prototype), {
		cardFlowEl: element,
		containerEl: { win: {} },
		memoMarkdownRenderer: { clear: () => undefined },
		cardImageLoadQueue: { clear: () => undefined },
		cardFlowCoordinator: { generation: 0, resetFlowRuntime: () => undefined },
		renderedCardMemos: new Map(),
		getDailyNotesStatus: () => ({ enabled }),
	}) as { renderAllMemosLoadingState(): void };

	view.renderAllMemosLoadingState();
	assert.deepEqual(titles, [t("service.dailyNotesDisabled")]);
	enabled = true;
	view.renderAllMemosLoadingState();
	assert.deepEqual(titles, [t("empty.loadingAllMemos")]);
});
