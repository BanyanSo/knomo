import test from "node:test";
import assert from "node:assert/strict";
import { createMobilePopupFixture, mobilePopupText, type MobilePopupAction, type MobilePopupKind } from "./helpers/mobilePopupFixture";

// 覆盖 Composer 与通用关闭手势；移动端宿主菜单由 KnomoMobileMenu.test.ts 验证。
test("弹层夹具使用真实范围菜单、卡片动作和编辑中的 Composer", async () => {
	const fixture = await createMobilePopupFixture("cancel-edit");
	try {
		assert.deepEqual(Array.from(fixture.scopeMenu.querySelectorAll("[data-title-mode]"), item => item.getAttribute("data-title-mode")), ["all", "things", "no-tag", "with-link", "with-image", "anniversary", "review", "random", "shuffleDay"]);
		assert.deepEqual(Array.from(fixture.card.querySelectorAll("[data-memo-action]"), item => item.getAttribute("data-memo-action")), ["share-image", "edit", "reference", "copy-text", "open-daily", "copy-link", "delete"]);
		assert.equal(fixture.view.inputEl.value, mobilePopupText.editDraft);
		assert.equal(fixture.button.hidden, false);
	} finally { fixture.close(); }
});

for (const action of ["save-input", "cancel-edit", "clear-reference"] as const satisfies readonly MobilePopupAction[]) {
	test(`P0 ${action} 按下时不提交、不改变正文或编辑上下文`, async () => {
		const fixture = await createMobilePopupFixture(action);
		try {
			const before = fixture.snapshot();
			fixture.pointer(fixture.button, "pointerdown");
			assert.deepEqual(fixture.snapshot(), before, "业务动作必须等到有效抬起后才执行");
		} finally { fixture.close(); }
	});

	for (const cancel of ["pointercancel", "outside", "out-and-back", "scroll"] as const) {
		test(`P0 ${action} 的 ${cancel} 取消手势不执行业务动作`, async () => {
			const fixture = await createMobilePopupFixture(action);
			try {
				const before = fixture.snapshot();
				fixture.pointer(fixture.button, "pointerdown");
				if (cancel === "pointercancel") fixture.pointer(fixture.button, "pointercancel");
				else if (cancel === "scroll") {
					fixture.view.inputEl.composer.view.scrollDOM.dispatchEvent(new fixture.win.Event("scroll"));
					fixture.pointer(fixture.button, "pointerup");
				} else {
					fixture.pointer(fixture.button, "pointermove", { x: 180 });
					if (cancel === "out-and-back") fixture.pointer(fixture.button, "pointermove");
					fixture.pointer(cancel === "outside" ? fixture.layer : fixture.button, "pointerup", { x: cancel === "outside" ? 180 : 20 });
				}
				// 覆盖原按钮尾随 click，以及滑出后重新命中露出面板的情况。
				await fixture.click(cancel === "outside" ? fixture.layer : fixture.button);
				assert.deepEqual(fixture.snapshot(), before, "取消后必须保留原草稿、引用与编辑状态");
			} finally { fixture.close(); }
		});
	}

	test(`P0 ${action} 有效抬起与兼容 click 合计只执行一次`, async () => {
		const fixture = await createMobilePopupFixture(action);
		try {
			fixture.pointer(fixture.button, "pointerdown");
			fixture.pointer(fixture.button, "pointerup");
			assert.deepEqual(fixture.calls, [action], "有效抬起时必须执行一次，不能等兼容 click 才执行");
			await fixture.click(fixture.button);
			assert.deepEqual(fixture.calls, [action]);
			if (action === "clear-reference") {
				assert.equal(fixture.view.quoteReferenceText, null);
				assert.equal(fixture.view.inputEl.value, mobilePopupText.createDraft);
			} else if (action === "cancel-edit") {
				assert.equal(fixture.view.editingMemo, null);
				assert.equal(fixture.view.inputEl.value, mobilePopupText.createDraft);
			}
		} finally { fixture.close(); }
	});
}

for (const kind of ["scope", "card"] as const satisfies readonly MobilePopupKind[]) {
	test(`P0 ${kind} 菜单关闭手势目标改变后不穿透，下一次独立点击立即生效`, async () => {
		const fixture = await createMobilePopupFixture();
		try {
			fixture.openPopup(kind);
			fixture.pointer(fixture.root, "pointerdown");
			assert.equal(fixture.popup.hasOpenPopup(), false);
			fixture.pointer(fixture.dailyButton, "pointerup");
			await fixture.click(fixture.dailyButton);
			assert.deepEqual(fixture.calls, [], "关闭后的兼容 click 不得打开 Daily");
			fixture.pointer(fixture.dailyButton, "pointerdown", { id: 2 });
			fixture.pointer(fixture.dailyButton, "pointerup", { id: 2 });
			await fixture.click(fixture.dailyButton);
			assert.deepEqual(fixture.calls, ["open-daily"]);
		} finally { fixture.close(); }
	});

	for (const end of ["pointercancel", "pointerup"] as const) {
		test(`P0 ${kind} 菜单关闭后 ${end} 未生成 click，下一次独立点击仍立即生效`, async () => {
			const fixture = await createMobilePopupFixture();
			try {
				fixture.openPopup(kind);
				fixture.pointer(fixture.root, "pointerdown");
				fixture.pointer(fixture.root, end);
				assert.equal(fixture.popup.hasOpenPopup(), false);
				fixture.pointer(fixture.dailyButton, "pointerdown", { id: 2 });
				fixture.pointer(fixture.dailyButton, "pointerup", { id: 2 });
				await fixture.click(fixture.dailyButton);
				assert.deepEqual(fixture.calls, ["open-daily"], "新手势不能继承旧关闭手势的 click 防护");
			} finally { fixture.close(); }
		});
	}

	test(`P0 ${kind} 菜单关闭手势结束后，不吞掉无 pointer 的语义激活`, async () => {
		const fixture = await createMobilePopupFixture();
		try {
			fixture.openPopup(kind);
			fixture.pointer(fixture.root, "pointerdown");
			fixture.pointer(fixture.root, "pointercancel");
			await fixture.click(fixture.dailyButton, 0);
			assert.deepEqual(fixture.calls, ["open-daily"], "键盘或辅助技术激活不属于旧 pointer 手势");
		} finally { fixture.close(); }
	});
}
