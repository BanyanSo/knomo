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

for (const targetKind of ["detached-button", "exposed-layer"] as const) {
	test(`清除引用后 ${targetKind} 的尾随触摸与鼠标事件不能再次移走真实编辑器焦点`, async () => {
		const f = await createMobilePopupFixture("clear-reference");
		const { KnomoView } = await import("../src/ui/KnomoView");
		try {
			Object.assign(f.view, { focusComposerInputNow: (KnomoView.prototype as unknown as { focusComposerInputNow: (resize: boolean, viewport: boolean) => void }).focusComposerInputNow.bind(f.view, false, false) });
			const editor = f.view.inputEl.composer;
			editor.view.focus();
			f.view.inputEl.setSelectionRange(1, 3, "backward");
			const before = editor.view.state.selection.main;
			let blurs = 0;
			f.view.inputEl.addEventListener("blur", () => blurs++);
			f.pointer(f.button, "pointerdown"); f.pointer(f.button, "pointerup");
			assert.equal(f.button.isConnected, false, "清除引用会移除原触摸目标");
			assert.equal(f.win.document.activeElement, f.view.inputEl);
			const target = targetKind === "detached-button" ? f.button : f.layer;
			const end = new f.win.Event("touchend", { bubbles: true, cancelable: true });
			Object.defineProperties(end, { touches: { value: [] }, changedTouches: { value: [{ identifier: 1, clientX: 20, clientY: 20 }] } });
			target.dispatchEvent(end);
			assert.equal(end.defaultPrevented, true, "原按钮移除后仍阻止同次 touchend 的默认焦点处理");
			for (const type of ["mousedown", "mouseup", "click"]) {
				const tail = new f.win.MouseEvent(type, { bubbles: true, cancelable: true, detail: 1, clientX: 20, clientY: 20 });
				target.dispatchEvent(tail);
				assert.equal(tail.defaultPrevented, true, type);
			}
			assert.equal(blurs, 0);
			assert.equal(f.win.document.activeElement, f.view.inputEl);
			assert.equal(editor.view.state.selection.main.eq(before), true);
			assert.equal(f.view.inputEl.value, "创建草稿：保留这段正文与选区。");
			assert.equal(f.view.quoteReferenceText, null);
			assert.deepEqual(f.calls, ["clear-reference"]);
		} finally { f.close(); }
	});
}

test("清除引用的尾随保护允许语义激活和下一次独立触摸", async () => {
	const f = await createMobilePopupFixture("clear-reference");
	try {
		let calls = 0;
		const other = f.win.document.body.createEl("button");
		other.addEventListener("click", () => calls++);
		f.pointer(f.button, "pointerdown"); f.pointer(f.button, "pointerup");
		await f.click(other, 0); assert.equal(calls, 1, "键盘和辅助技术不属于旧触摸");
		f.pointer(other, "pointerdown", { id: 2 }); f.pointer(other, "pointerup", { id: 2 });
		const mouse = new f.win.MouseEvent("mousedown", { bubbles: true, cancelable: true, clientX: 20, clientY: 20 });
		other.dispatchEvent(mouse); assert.equal(mouse.defaultPrevented, false);
		await f.click(other); assert.equal(calls, 2);
	} finally { f.close(); }
});

test("清除引用的尾随保护卸载后不会拦截已移除按钮上的事件", async () => {
	const f = await createMobilePopupFixture("clear-reference");
	let closed = false;
	try {
		f.pointer(f.button, "pointerdown"); f.pointer(f.button, "pointerup");
		f.close(); closed = true;
		const end = new f.win.Event("touchend", { bubbles: true, cancelable: true });
		Object.defineProperty(end, "changedTouches", { value: [{ identifier: 1, clientX: 20, clientY: 20 }] });
		f.button.dispatchEvent(end);
		assert.equal(end.defaultPrevented, false, "必须释放旧节点上的监听器");
	} finally { if (!closed) f.close(); }
});
