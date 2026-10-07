import test from "node:test";
import assert from "node:assert/strict";
import { createMobilePopupFixture, type MobilePopupAction } from "./helpers/mobilePopupFixture";

for (const action of ["save-input", "cancel-edit", "clear-reference"] as const satisfies readonly MobilePopupAction[]) {
	for (const reason of ["second-pointer", "lost-capture", "session", "saving", "disabled", "composition", "closed", "inside-slop", "context", "window-scroll", "close-reopen"] as const) {
		test(`${action}: ${reason} invalidates a pending confirmation`, async () => {
			const f = await createMobilePopupFixture(action);
			try {
				f.pointer(f.button, "pointerdown");
				if (reason === "second-pointer") f.pointer(f.button, "pointerdown", { id: 2, primary: false });
				if (reason === "lost-capture") f.pointer(f.button, "lostpointercapture");
				if (reason === "session") f.view.inputEl.composer.invalidateContext();
				if (reason === "saving") f.view.isSaving = true;
				if (reason === "disabled") f.button.disabled = true;
				if (reason === "closed") f.view.composerOpen = false;
				if (reason === "inside-slop") { f.pointer(f.button, "pointermove", { x: 32 }); f.pointer(f.button, "pointermove"); }
				if (reason === "context") f.view.quoteReferenceText = "[[another-context]]";
				if (reason === "window-scroll") f.win.dispatchEvent(new f.win.Event("scroll"));
				if (reason === "close-reopen") f.view.inputEl.dispatchEvent(new f.win.Event("composer-action-cancel", { bubbles: true }));
				if (reason === "composition") f.view.inputEl.dispatchEvent(new f.win.CompositionEvent("compositionstart", { bubbles: true }));
				f.pointer(f.button, "pointerup");
				await f.click(f.button);
				assert.deepEqual(f.calls, []);
			} finally { f.close(); }
		});
	}
	test(`${action}: semantic activation is independent of a cancelled pointer`, async () => {
		const f = await createMobilePopupFixture(action);
		try {
			f.pointer(f.button, "pointerdown"); f.pointer(f.button, "pointercancel");
			await f.click(f.button, 0);
			assert.deepEqual(f.calls, [action]);
		} finally { f.close(); }
	});
}

test("a second independent send succeeds immediately; IME never queues a send", async () => {
	const f = await createMobilePopupFixture();
	try {
		for (const id of [1, 2]) {
			f.pointer(f.button, "pointerdown", { id }); f.pointer(f.button, "pointerup", { id }); await f.click(f.button);
		}
		assert.deepEqual(f.calls, ["save-input", "save-input"]);
		f.view.inputEl.dispatchEvent(new f.win.CompositionEvent("compositionstart", { bubbles: true }));
		f.pointer(f.button, "pointerdown", { id: 3 });
		f.view.inputEl.dispatchEvent(new f.win.CompositionEvent("compositionend", { bubbles: true }));
		f.pointer(f.button, "pointerup", { id: 3 }); await f.click(f.button);
		assert.equal(f.calls.length, 2);
	} finally { f.close(); }
});

test("secondary touches cannot bypass cancellation or the popup dismissal sequence", async () => {
	const f = await createMobilePopupFixture();
	try {
		f.pointer(f.button, "pointerdown"); f.pointer(f.button, "pointerdown", { id: 2, primary: false });
		f.pointer(f.button, "pointerup", { id: 2, primary: false });
		await f.click(f.button); assert.deepEqual(f.calls, []);
		f.pointer(f.button, "pointerup"); await f.click(f.button); assert.deepEqual(f.calls, []);
		f.openPopup("scope"); f.pointer(f.root, "pointerdown", { id: 3 });
		f.pointer(f.dailyButton, "pointerdown", { id: 4, primary: false });
		f.pointer(f.dailyButton, "pointerup", { id: 4, primary: false }); await f.click(f.dailyButton);
		assert.deepEqual(f.calls, []);
		f.pointer(f.root, "pointerup", { id: 3 }); await f.click(f.dailyButton);
		assert.deepEqual(f.calls, [], "多指的每个尾随 click 都属于关闭手势");
		f.pointer(f.dailyButton, "pointerdown", { id: 5 }); f.pointer(f.dailyButton, "pointerup", { id: 5 });
		await f.click(f.dailyButton); assert.deepEqual(f.calls, ["open-daily"]);
	} finally { f.close(); }
});

for (const action of ["cancel-edit", "clear-reference"] as const) {
	test(`desktop ${action} retains its existing business entry during composition`, async () => {
		const f = await createMobilePopupFixture(action);
		try {
			Object.assign(f.view, { currentLayout: "desktop-wide" });
			f.view.inputEl.dispatchEvent(new f.win.CompositionEvent("compositionstart", { bubbles: true }));
			await f.click(f.button, 0);
			assert.deepEqual(f.calls, [action], "移动动作确认不可扩大桌面业务限制");
		} finally { f.close(); }
	});
}

test("dismissal also consumes a retargeted click outside the plugin root", async () => {
	const f = await createMobilePopupFixture();
	try {
		const native = f.win.document.createElement("button");
		f.win.document.body.appendChild(native);
		let nativeCalls = 0;
		native.addEventListener("click", () => { nativeCalls++; });
		f.openPopup("card"); f.pointer(f.root, "pointerdown"); f.pointer(native, "pointerup");
		await f.click(native); assert.equal(nativeCalls, 0, "DOM 改变后的 click 不能绕过根路由防护");
		f.pointer(native, "pointerdown", { id: 2 }); f.pointer(native, "pointerup", { id: 2 });
		await f.click(native); assert.equal(nativeCalls, 1);
	} finally { f.close(); }
});

test("a lost window release does not occupy the next action or dismissal sequence", async () => {
	const f = await createMobilePopupFixture();
	try {
		f.pointer(f.button, "pointerdown"); f.win.dispatchEvent(new f.win.Event("blur"));
		f.pointer(f.button, "pointerdown", { id: 2 }); f.pointer(f.button, "pointerup", { id: 2 }); await f.click(f.button);
		assert.deepEqual(f.calls, ["save-input"]);
		f.openPopup("scope"); f.pointer(f.root, "pointerdown", { id: 3 }); f.win.dispatchEvent(new f.win.Event("blur"));
		f.pointer(f.dailyButton, "pointerdown", { id: 4 }); f.pointer(f.dailyButton, "pointerup", { id: 4 }); await f.click(f.dailyButton);
		assert.deepEqual(f.calls, ["save-input", "open-daily"]);
	} finally { f.close(); }
});
