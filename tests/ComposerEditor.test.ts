import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM, VirtualConsole } from "jsdom";
import { Transaction } from "@codemirror/state";
import { redo, undo, undoDepth } from "@codemirror/commands";
import { ComposerEditor } from "../src/ui/ComposerEditor";
import { runComposerCommand } from "../src/utils/composerCommands";
import { registerComposerToolGesture } from "../src/ui/ComposerToolGesture";
import { parser } from "@lezer/markdown";
import { ensureObsidianStub } from "./helpers/obsidianStub";

function environment(value: string) {
	const dom = new JSDOM("<!doctype html><body><div id='host'></div></body>", { pretendToBeVisual: true });
	const win = dom.window;
	Object.assign(win.Node.prototype, { createEl(this: HTMLElement, tag: string) { return this.appendChild(this.ownerDocument.createElement(tag)); } });
	// jsdom 没有原生布局 API；让 CodeMirror 的测量临时节点能正常完成清理。
	win.Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
	win.Range.prototype.getBoundingClientRect = () => new win.DOMRect();
	const previous = new Map<string, PropertyDescriptor | undefined>();
	for (const name of ["createSpan", "window", "document", "MutationObserver", "Node", "HTMLElement", "getComputedStyle", "requestAnimationFrame", "cancelAnimationFrame"]) {
		previous.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
		const source = name === "createSpan" ? () => win.document.createElement("span") : name === "window" ? win : (win as unknown as Record<string, unknown>)[name];
		Object.defineProperty(globalThis, name, { configurable: true, writable: true, value: typeof source === "function" && name !== "Node" && name !== "HTMLElement" && name !== "MutationObserver" ? source.bind(win) : source });
	}
	const editor = new ComposerEditor(win.document.getElementById("host")!, value, "label", "Write here");
	return { editor, win, close() {
		editor.destroy(); dom.window.close();
		for (const [name, descriptor] of previous) {
			if (descriptor) Object.defineProperty(globalThis, name, descriptor);
			else Reflect.deleteProperty(globalThis, name);
		}
	} };
}

test("浮标返回焦点时恢复编辑状态选区而非旧 DOM 光标", async () => {
	await ensureObsidianStub();
	const { KnomoView } = await import("../src/ui/KnomoView");
	for (const value of ["plain", "**bold** ==highlight==", "[[Note]] tail"]) {
		const { editor, win, close } = environment(value);
		try {
			editor.view.focus();
			editor.input.blur();
			const next = value + " @2026-09-13 ";
			editor.apply({ value: next, anchor: next.length, head: next.length });
			win.document.getSelection()!.collapse(editor.input, 0);
			(KnomoView.prototype as unknown as { focusComposerInputNow(this: unknown, resize: boolean, viewport: boolean): void })
				.focusComposerInputNow.call({ inputEl: editor.input }, false, false);
			const selection = win.document.getSelection()!;
			assert.equal(editor.view.posAtDOM(selection.anchorNode!, selection.anchorOffset), next.length);
			assert.equal(editor.input.selectionStart, next.length);
			assert.equal(editor.input.value, next);
		} finally { close(); }
	}
});

test("real EditorView keeps one Markdown state, atomic toolbar history and session invalidation", async () => {
	const { editor, close } = environment("中文 memo");
	try {
		editor.view.focus();
		await new Promise(resolve => setTimeout(resolve, 30));
		assert.equal(editor.view.dom.classList.contains("knomo-composer-editor"), true);
		editor.input.setSelectionRange(0, 2, "backward");
		const selection = editor.view.state.selection.main;
		const command = runComposerCommand(editor.input.value, selection.anchor, selection.head, "bold");
		assert.equal(command.type, "changed");
		const context = editor.capture();
		if (command.type === "changed") editor.apply(command.edit);
		assert.equal(context.valid(), false);
		assert.equal(editor.input.value, "**中文** memo");
		assert.equal(editor.input.selectionDirection, "backward");
		assert.equal(undoDepth(editor.view.state), 1);
		undo(editor.view);
		assert.equal(editor.input.value, "中文 memo");
		assert.equal(editor.input.selectionStart, 0);
		assert.equal(editor.input.selectionEnd, 2);
		redo(editor.view);
		assert.equal(editor.input.value, "**中文** memo");
		editor.reset("another Memo");
		assert.equal(editor.input.classList.contains("knomo-composer-input"), true);
		assert.equal(editor.view.dom.classList.contains("knomo-composer-editor"), true);
		assert.equal(undo(editor.view), false);
		assert.equal(editor.input.value, "another Memo");
		assert.equal(editor.view.dom.querySelector("textarea"), null);
	} finally { close(); }
});

test("natural-language keyboard hints survive focus, editing and draft reset", async () => {
	const { editor, close } = environment("hello");
	try {
		const check = () => {
			for (const [name, value] of Object.entries({ inputmode: "text", spellcheck: "true", autocorrect: "on", autocapitalize: "sentences", writingsuggestions: "true" })) {
				assert.equal(editor.input.getAttribute(name), value);
			}
		};
		check();
		editor.view.focus();
		await new Promise(resolve => setTimeout(resolve, 30));
		check();
		editor.apply({ value: "hello world", anchor: 11, head: 11 });
		check();
		editor.reset("new draft");
		check();
	} finally { close(); }
});

test("rendered elements use semantic Markdown and native checkbox styling without mutating source", () => {
	const value = "- [ ] 待办\n- [x] 完成\n- 项目\n\n12) 编号\n\n**粗体** ==高亮== [[链接]]\nend";
	const { editor, win, close } = environment(value);
	try {
		const checkboxes = editor.input.querySelectorAll<HTMLInputElement>("input.task-list-item-checkbox");
		assert.equal(checkboxes.length, 2);
		assert.equal(checkboxes[0].checked, false);
		assert.equal(checkboxes[1].checked, true);
		assert.equal(checkboxes[0].tabIndex, -1);
		assert.equal(editor.input.querySelectorAll(".knomo-composer-list-line").length, 4);
		assert.equal(editor.input.querySelectorAll(".knomo-composer-task-line.is-checked").length, 1);
		assert.equal(editor.input.querySelectorAll(".knomo-composer-bullet-marker ul > li").length, 1);
		assert.equal(editor.input.querySelector(".knomo-composer-bullet-marker")?.textContent, "");
		assert.equal(editor.input.querySelector<HTMLOListElement>(".knomo-composer-ordered-marker ol")?.start, 12);
		assert.equal(editor.input.querySelectorAll(".knomo-composer-ordered-marker ol > li").length, 1);
		assert.equal(editor.input.querySelector("strong")?.textContent, "粗体");
		assert.equal(editor.input.querySelector("mark")?.textContent, "高亮");
		assert.equal(editor.input.querySelector("a.internal-link")?.textContent, "链接");
		assert.equal(editor.input.querySelector("a.internal-link")?.hasAttribute("href"), false);
		checkboxes[0].click();
		assert.equal(checkboxes[0].checked, false);
		checkboxes[0].dispatchEvent(new win.MouseEvent("pointerdown", { bubbles: true, cancelable: true }));
		assert.equal(editor.input.selectionStart, 0);
		assert.equal(editor.input.querySelectorAll("input.task-list-item-checkbox").length, 1);
		assert.equal(editor.input.value, value);
		assert.equal(undoDepth(editor.view.state), 0);
		editor.input.setSelectionRange(value.length, value.length);
		assert.equal(editor.input.querySelectorAll("input.task-list-item-checkbox").length, 2);
	} finally { close(); }
});

test("async insertion handles remain invalid after edit-undo, new context, and destruction", () => {
	const { editor, close } = environment("original");
	try {
		const first = editor.capture();
		editor.apply({ value: "changed", anchor: 7, head: 7 });
		undo(editor.view);
		assert.equal(editor.input.value, "original");
		assert.equal(first.valid(), false);
		assert.equal(first.sameSession(), true);
		const second = editor.capture();
		editor.invalidateContext();
		assert.equal(second.valid(), false);
		assert.equal(second.sameSession(), false);
		const third = editor.capture();
		editor.destroy();
		assert.equal(third.valid(), false);
	} finally { close(); }
});

test("real decorations reveal locally without editing Markdown or selection or undo history", () => {
	const value = "- [ ] **one** and **two**\nend";
	const { editor, close } = environment(value);
	try {
		assert.equal(editor.input.querySelectorAll(".knomo-composer-bold").length, 2);
		assert.equal(editor.input.querySelectorAll(".knomo-composer-marker").length, 1);
		editor.input.setSelectionRange(9, 9);
		assert.equal(editor.input.querySelectorAll(".knomo-composer-bold").length, 1);
		assert.equal(editor.input.querySelectorAll(".knomo-composer-marker").length, 1);
		editor.input.setSelectionRange(6, 6);
		assert.equal(editor.input.querySelectorAll(".knomo-composer-marker").length, 0);
		assert.equal(editor.input.value, value);
		assert.equal(editor.input.selectionStart, 6);
		assert.equal(undoDepth(editor.view.state), 0);
		editor.input.setSelectionRange(0, value.length);
		assert.equal(editor.view.state.sliceDoc(editor.input.selectionStart, editor.input.selectionEnd), value);
	} finally { close(); }
});

test("native newline correction joins the input transaction but paste and undo remain literal", () => {
	const { editor, close } = environment("- [x] done");
	try {
		editor.view.dispatch({ changes: { from: 10, insert: "\n" }, selection: { anchor: 11 }, annotations: Transaction.userEvent.of("input.type") });
		assert.equal(editor.input.value, "- [x] done\n- [ ] ");
		assert.equal(undoDepth(editor.view.state), 1);
		undo(editor.view);
		assert.equal(editor.input.value, "- [x] done");
		editor.view.dispatch({ changes: { from: 10, insert: "\n" }, selection: { anchor: 11 }, annotations: Transaction.userEvent.of("input.paste") });
		assert.equal(editor.input.value, "- [x] done\n");
	} finally { close(); }
});

test("editor only installs ordinary text keys and Shift-Enter remains a literal newline", () => {
	const { editor, win, close } = environment("- item");
	try {
		editor.input.dispatchEvent(new win.KeyboardEvent("keydown", { key: "K", ctrlKey: true, shiftKey: true, bubbles: true }));
		assert.equal(editor.input.value, "- item");
		editor.input.dispatchEvent(new win.KeyboardEvent("keydown", { key: "Enter", shiftKey: true, bubbles: true, cancelable: true }));
		assert.equal(editor.input.value, "- item\n");
	} finally { close(); }
});

test("composition events leave pending native DOM and editor state untouched", async () => {
	const { editor, win, close } = environment("ni");
	try {
		editor.view.focus();
		await new Promise(resolve => setTimeout(resolve, 30));
		const state = editor.view.state;
		const text = editor.input.querySelector(".cm-line")!.firstChild!;
		text.nodeValue = "你";
		win.document.getSelection()!.collapse(text, 1);
		editor.input.dispatchEvent(new win.CompositionEvent("compositionstart", { bubbles: true }));
		assert.equal(editor.view.state, state, "compositionstart must not dispatch over pending DOM input");
		assert.equal(editor.input.textContent, "你");
		editor.input.dispatchEvent(new win.CompositionEvent("compositionend", { data: "你", bubbles: true }));
		await new Promise(resolve => setTimeout(resolve, 80));
		assert.equal(editor.input.value, "你");
		assert.equal(editor.input.textContent, "你");
		assert.equal(editor.input.selectionStart, 1);
		assert.equal(editor.composing, false);
		undo(editor.view);
		assert.equal(editor.input.value, "ni");
	} finally { close(); }
});

test("composition defers Markdown parsing until native input settles", async t => {
	const { editor, win, close } = environment("**bold**\n");
	const parse = t.mock.method(parser, "parse");
	try {
		editor.input.dispatchEvent(new win.CompositionEvent("compositionstart"));
		for (const text of ["n", "ni", "你"]) {
			editor.view.dispatch({ changes: { from: 9, to: editor.view.state.doc.length, insert: text },
				selection: { anchor: 9 + text.length }, annotations: Transaction.userEvent.of("input.type.compose") });
		}
		assert.equal(parse.mock.callCount(), 0, "preedit changes must not parse the full draft");
		assert.equal(editor.input.querySelector("strong")?.textContent, "bold");
		editor.input.dispatchEvent(new win.CompositionEvent("compositionend", { data: "你" }));
		await new Promise(resolve => setTimeout(resolve, 80));
		assert.equal(parse.mock.callCount(), 1);
		assert.equal(editor.input.value, "**bold**\n你");
		assert.equal(editor.composing, false);
	} finally { parse.mock.restore(); close(); }
});

test("composition completion reads the last native replacement before notifying consumers", async () => {
	const { editor, win, close } = environment("ni");
	try {
		editor.view.focus();
		await new Promise(resolve => setTimeout(resolve, 30));
		const committed: string[] = [];
		editor.input.addEventListener("composer-compositionend", () => {
			assert.equal(editor.composing, false);
			committed.push(editor.input.value);
		});
		editor.input.dispatchEvent(new win.CompositionEvent("compositionstart"));
		editor.input.dispatchEvent(new win.CompositionEvent("compositionend", { data: "你" }));
		await Promise.resolve();
		assert.equal(editor.composing, true);
		assert.deepEqual(committed, []);
		const text = editor.input.querySelector(".cm-line")!.firstChild!;
		text.nodeValue = "你";
		win.document.getSelection()!.collapse(text, 1);
		editor.input.dispatchEvent(new win.InputEvent("input", { inputType: "insertText", data: "你" }));
		await new Promise(resolve => setTimeout(resolve, 80));
		assert.deepEqual(committed, ["你"]);
		assert.equal(editor.input.value, "你");
	} finally { close(); }
});

test("rapid compositions and reset invalidate older completion callbacks", async () => {
	const { editor, win, close } = environment("draft");
	try {
		let completed = 0;
		editor.input.addEventListener("composer-compositionend", () => completed++);
		editor.input.dispatchEvent(new win.CompositionEvent("compositionstart"));
		editor.input.dispatchEvent(new win.CompositionEvent("compositionend"));
		editor.input.dispatchEvent(new win.CompositionEvent("compositionstart"));
		await new Promise(resolve => setTimeout(resolve, 60));
		assert.equal(completed, 0);
		assert.equal(editor.composing, true);
		assert.equal(editor.apply({ value: "wrong", anchor: 5, head: 5 }), false);
		editor.input.dispatchEvent(new win.CompositionEvent("compositionend"));
		await new Promise(resolve => setTimeout(resolve, 60));
		assert.equal(completed, 1);
		assert.equal(editor.composing, false);
		editor.input.dispatchEvent(new win.CompositionEvent("compositionstart"));
		editor.input.dispatchEvent(new win.CompositionEvent("compositionend"));
		editor.reset("new draft");
		await new Promise(resolve => setTimeout(resolve, 60));
		assert.equal(completed, 1);
		assert.equal(editor.input.value, "new draft");
		assert.equal(editor.composing, false);
	} finally { close(); }
});

test("unchanged editability does not dispatch during native composition", () => {
	const { editor, win, close } = environment("draft");
	try {
		editor.input.dispatchEvent(new win.CompositionEvent("compositionstart"));
		const state = editor.view.state;
		editor.input.disabled = false;
		assert.equal(editor.view.state, state);
		assert.equal(editor.composing, true);
	} finally { close(); }
});

test("composition blocks toolbar edits and candidate confirmation propagation", async () => {
	const { editor, win, close } = environment("中文");
	try {
		editor.input.dispatchEvent(new win.CompositionEvent("compositionstart"));
		assert.equal(editor.apply({ value: "changed", anchor: 7, head: 7 }), false);
		assert.equal(editor.input.value, "中文");
		let forwarded = 0;
		editor.input.addEventListener("keydown", () => forwarded++);
		editor.input.dispatchEvent(new win.KeyboardEvent("keydown", { key: "Enter", isComposing: true, bubbles: true }));
		assert.equal(forwarded, 0);
		assert.equal(undoDepth(editor.view.state), 0);
	} finally { close(); }
});

test("toolbar Tap executes once, Swipe never executes and configuration does not reset editor", () => {
	const { editor, win, close } = environment("draft");
	try {
		const tools = win.document.createElement("div");
		const button = tools.appendChild(win.document.createElement("button"));
		button.dataset.action = "insert-bold";
		win.document.body.appendChild(tools);
		let calls = 0;
		const cleanup = registerComposerToolGesture(tools, () => calls++);
		const pointer = (type: string, x: number) => {
			const event = new win.MouseEvent(type, { clientX: x, bubbles: true, cancelable: true });
			Object.defineProperties(event, { pointerId: { value: 1 }, pointerType: { value: "touch" } });
			button.dispatchEvent(event);
		};
		pointer("pointerdown", 0); pointer("pointermove", 20); pointer("pointerup", 20);
		button.dispatchEvent(new win.MouseEvent("click", { bubbles: true, detail: 1 }));
		assert.equal(calls, 0);
		pointer("pointerdown", 0); pointer("pointerup", 0);
		button.dispatchEvent(new win.MouseEvent("click", { bubbles: true, detail: 1 }));
		assert.equal(calls, 1);
		editor.input.setSelectionRange(1, 4);
		const context = editor.capture();
		button.hidden = true;
		assert.equal(editor.input.value, "draft");
		assert.equal(editor.input.selectionStart, 1);
		assert.equal(context.valid(), true);
		cleanup();
	} finally { close(); }
});

test("toolbar gesture ignores a hover move without an active pointer", () => {
	const errors: Error[] = [];
	const virtualConsole = new VirtualConsole();
	virtualConsole.on("jsdomError", error => errors.push(error));
	const dom = new JSDOM("<!doctype html><body></body>", { virtualConsole });
	const tools = dom.window.document.createElement("div");
	const button = tools.appendChild(dom.window.document.createElement("button"));
	button.dataset.action = "insert-bold";
	dom.window.document.body.appendChild(tools);
	const cleanup = registerComposerToolGesture(tools, () => assert.fail("hover move must not run an action"));
	try {
		const hover = new dom.window.MouseEvent("pointermove", { bubbles: true });
		Object.defineProperty(hover, "pointerType", { value: "mouse" });
		button.dispatchEvent(hover);
		assert.deepEqual(errors, []);
	} finally {
		cleanup();
		dom.window.close();
	}
});

test("Tag Suggest uses the same editor transaction and preserves IME and save shortcut priority", async () => {
	await ensureObsidianStub();
	const { KnomoTagSuggest } = await import("../src/ui/KnomoTagSuggest");
	const { editor, win, close } = environment("#");
	const prototype = win.HTMLElement.prototype as unknown as Record<string, unknown>;
	prototype.createDiv = function(this: HTMLElement, options: { cls?: string }) {
		const child = this.ownerDocument.createElement("div");
		child.className = options.cls ?? "";
		this.appendChild(child);
		return child;
	};
	prototype.setText = function(this: HTMLElement, text: string) { this.textContent = text; };
	prototype.empty = function(this: HTMLElement) { this.replaceChildren(); };
	prototype.addClass = function(this: HTMLElement, name: string) { this.classList.add(name); };
	prototype.removeClass = function(this: HTMLElement, name: string) { this.classList.remove(name); };
	prototype.toggleClass = function(this: HTMLElement, name: string, enabled: boolean) { this.classList.toggle(name, enabled); };
	prototype.scrollIntoView = () => undefined;
	let selections = 0;
	const suggest = new KnomoTagSuggest({} as never, editor.input, () => { selections++; }, {
		getSnapshot: () => ({ suggestions: ["alpha", "beta"] }), ensureReady: async () => undefined,
	} as never);
	const unregister = suggest.registerLifecycle();
	try {
		editor.view.focus();
		suggest.refresh();
		assert.equal(win.document.querySelectorAll(".suggestion-item").length, 2);
		const key = (type: string, key: string) => editor.input.dispatchEvent(new win.KeyboardEvent(type, { key, bubbles: true, cancelable: true }));
		const popover = win.document.querySelector<HTMLElement>(".suggestion-container")!;
		const second = popover.children[1] as HTMLElement;
		const hover = new win.MouseEvent("pointermove", { bubbles: true });
		Object.defineProperty(hover, "pointerType", { value: "mouse" });
		second.dispatchEvent(hover);
		assert.equal(second.getAttribute("aria-selected"), "true");
		let scrolled = 0;
		(popover.children[0] as HTMLElement).scrollIntoView = () => { scrolled++; popover.scrollTop = 80; };
		key("keydown", "ArrowDown"); key("keyup", "ArrowDown");
		assert.equal(scrolled, 1);
		assert.equal(win.document.querySelector(".suggestion-container"), popover);
		assert.equal(popover.scrollTop, 80);
		assert.equal(popover.children[0].getAttribute("aria-selected"), "true");
		assert.equal(key("keydown", "Escape"), false);
		key("keyup", "Escape");
		assert.equal(win.document.querySelector(".suggestion-container"), null);
		assert.equal(key("keydown", "Escape"), true);
		editor.apply({ value: "#a", anchor: 2, head: 2 });
		key("keyup", "a");
		assert.notEqual(win.document.querySelector(".suggestion-container"), null);
		editor.input.blur();
		key("keyup", "a");
		assert.equal(win.document.querySelector(".suggestion-container"), null);
		editor.view.focus();
		suggest.open();
		editor.reset("#");
		key("keyup", "Escape");
		assert.equal(win.document.querySelector(".suggestion-container"), null);
		editor.view.focus();
		suggest.open();
		editor.invalidateContext();
		key("keyup", "Escape");
		assert.equal(win.document.querySelector(".suggestion-container"), null);
		suggest.open();
		assert.equal(suggest.handleKeydown(new win.KeyboardEvent("keydown", { key: "Enter", ctrlKey: true })), false);
		assert.equal(suggest.handleKeydown(new win.KeyboardEvent("keydown", { key: "Enter", isComposing: true })), false);
		assert.equal(editor.input.value, "#");
		assert.equal(suggest.handleKeydown(new win.KeyboardEvent("keydown", { key: "ArrowDown" })), true);
		assert.equal(suggest.handleKeydown(new win.KeyboardEvent("keydown", { key: "Enter" })), true);
		assert.equal(editor.input.value, "#beta ");
		assert.equal(editor.input.selectionStart, 6);
		assert.equal(win.document.querySelector(".suggestion-container"), null);
		undo(editor.view);
		assert.equal(editor.input.value, "#");
		for (const gesture of ["tap", "scroll", "cancel", "reset", "mouse"] as const) {
			editor.reset("#"); editor.view.focus(); suggest.open();
			const target = win.document.querySelectorAll<HTMLElement>(".suggestion-item")[1];
			const before = selections;
			const pointer = (type: string, y = 0) => {
				const event = new win.MouseEvent(type, { bubbles: true, cancelable: true, clientY: y });
				Object.defineProperties(event, { pointerId: { value: 1 }, pointerType: { value: gesture === "mouse" ? "mouse" : "touch" } });
				target.dispatchEvent(event);
			};
			pointer("pointerdown");
			assert.equal(editor.input.value, "#", "按下不能选中，必须允许滚动");
			if (gesture === "scroll") pointer("pointermove", 30);
			if (gesture === "cancel") pointer("pointercancel");
			if (gesture === "reset") editor.reset("#new-session");
			pointer("pointerup", gesture === "scroll" ? 30 : 0);
			if (gesture === "tap") assert.equal(editor.input.value, "#beta ", "触摸松手应先于兼容鼠标事件填入标签");
			if (gesture === "tap") {
				// 候选项已经移除：后续事件会重新命中编辑器或蒙层，而非旧候选 DOM。
				const backdrop = win.document.body.appendChild(win.document.createElement("div"));
				let closed = 0;
				backdrop.addEventListener("click", () => { closed++; editor.input.blur(); });
				const end = new win.Event("touchend", { bubbles: true, cancelable: true });
				Object.defineProperty(end, "changedTouches", { value: [{ clientX: 0, clientY: 0 }] });
				assert.equal(editor.input.dispatchEvent(end), false);
				if (editor.input.dispatchEvent(new win.MouseEvent("mousedown", { bubbles: true, cancelable: true }))) {
					editor.input.setSelectionRange(0, 0);
				}
				backdrop.dispatchEvent(new win.MouseEvent("mouseup", { bubbles: true, cancelable: true }));
				backdrop.dispatchEvent(new win.MouseEvent("click", { bubbles: true, cancelable: true, detail: 1 }));
				assert.equal(closed, 0);
				assert.equal(editor.input.selectionStart, 6);
				assert.equal(win.document.activeElement, editor.input);
				// 下一次主动点击仍应正常到达下层。
				backdrop.dispatchEvent(new win.MouseEvent("pointerdown", { bubbles: true }));
				backdrop.dispatchEvent(new win.MouseEvent("click", { bubbles: true, detail: 1 }));
				assert.equal(closed, 1);
				editor.view.focus(); backdrop.remove();
			}
			// 模拟 WebView 的默认失焦；mousedown 被阻止时编辑器应保持焦点。
			if (target.dispatchEvent(new win.MouseEvent("mousedown", { bubbles: true, cancelable: true }))) editor.input.blur();
			target.dispatchEvent(new win.MouseEvent("click", { bubbles: true, cancelable: true, detail: 1 }));
			const chosen = gesture === "tap" || gesture === "mouse";
			assert.equal(selections, before + (chosen ? 1 : 0), gesture);
			assert.equal(editor.input.value, chosen ? "#beta " : gesture === "reset" ? "#new-session" : "#", gesture);
			if (chosen) {
				assert.equal(win.document.activeElement, editor.input);
				assert.equal(undoDepth(editor.view.state), 1);
				undo(editor.view); assert.equal(editor.input.value, "#");
			}
		}
		for (const release of ["next-pointer", "reset", "timeout", "unregister"] as const) {
			editor.reset("#"); editor.view.focus(); suggest.open();
			const target = win.document.querySelectorAll<HTMLElement>(".suggestion-item")[1];
			for (const type of ["pointerdown", "pointerup"]) {
				const event = new win.MouseEvent(type, { bubbles: true, cancelable: true, clientX: 40, clientY: 80 });
				Object.defineProperties(event, { pointerId: { value: 2 }, pointerType: { value: "touch" } });
				target.dispatchEvent(event);
			}
			const click = (x = 40, detail = 1) => editor.input.dispatchEvent(new win.MouseEvent("click", {
				bubbles: true, cancelable: true, clientX: x, clientY: 80, detail,
			}));
			assert.equal(click(200), true, "不同位置的点击不能被吞掉");
			assert.equal(click(40, 0), true, "键盘/辅助功能激活不能被吞掉");
			if (release === "next-pointer") editor.input.dispatchEvent(new win.MouseEvent("pointerdown", { bubbles: true }));
			if (release === "reset") editor.reset("new session");
			if (release === "timeout") await new Promise(resolve => win.setTimeout(resolve, 650));
			if (release === "unregister") unregister();
			assert.equal(click(), true, release);
		}
	} finally { unregister(); close(); }
});

test("IME 的 229 确认键即使没有 isComposing 也不进入快捷键", () => {
	const { editor, win, close } = environment("draft");
	try {
		let shortcuts = 0;
		editor.input.addEventListener("keydown", () => { shortcuts++; });
		editor.input.dispatchEvent(new win.KeyboardEvent("keydown", { key: "Enter", keyCode: 229, ctrlKey: true, bubbles: true }));
		assert.equal(shortcuts, 0);
		assert.equal(editor.input.value, "draft");
		editor.input.dispatchEvent(new win.KeyboardEvent("keydown", { key: "a", bubbles: true }));
		assert.equal(shortcuts, 1);
	} finally { close(); }
});

test("saving freezes native and programmatic changes while retaining selection and history", () => {
	const { editor, close } = environment("draft");
	try {
		editor.apply({ value: "draft!", anchor: 6, head: 6 });
		const pending = editor.capture();
		editor.setSaving(true);
		assert.equal(pending.sameSession(), false);
		assert.equal(editor.input.disabled, false);
		assert.equal(editor.input.getAttribute("aria-readonly"), "true");
		for (const event of ["input.type", "input.paste", "input.drop", "input.toolbar"]) {
			editor.view.dispatch({ changes: { from: 0, insert: "bad" }, annotations: Transaction.userEvent.of(event) });
			assert.equal(editor.input.value, "draft!");
		}
		editor.view.dispatch({ changes: { from: 0, insert: "bad" }, filter: false });
		undo(editor.view); redo(editor.view);
		assert.equal(editor.apply({ value: "bad", anchor: 0, head: 0 }), false);
		assert.equal(editor.input.value, "draft!");
		editor.input.setSelectionRange(0, 5);
		assert.equal(editor.view.state.sliceDoc(editor.input.selectionStart, editor.input.selectionEnd), "draft");
		editor.setSaving(false);
		undo(editor.view);
		assert.equal(editor.input.value, "draft");
		editor.input.disabled = true;
		editor.setSaving(true); editor.setSaving(false);
		assert.equal(editor.input.disabled, true);
		assert.equal(editor.apply({ value: "bad", anchor: 0, head: 0 }), false);
	} finally { close(); }
});

test("CJK threshold changes with body and waits until composition settles", async () => {
	const { editor, win, close } = environment("中文");
	try {
		assert.equal(editor.input.getAttribute("data-cjk"), "false");
		editor.input.dispatchEvent(new win.CompositionEvent("compositionstart"));
		editor.view.dispatch({ changes: { from: 2, insert: "这是中文测试文本" }, annotations: Transaction.userEvent.of("input.type.compose") });
		assert.equal(editor.input.getAttribute("data-cjk"), "false");
		editor.input.dispatchEvent(new win.CompositionEvent("compositionend"));
		await new Promise(resolve => setTimeout(resolve, 80));
		assert.equal(editor.input.getAttribute("data-cjk"), "true");
		editor.input.setSelectionRange(0, 2);
		assert.equal(editor.input.getAttribute("data-cjk"), "true");
	} finally { close(); }
});

async function sessionView(editor: ComposerEditor) {
	await ensureObsidianStub();
	const { KnomoView } = await import("../src/ui/KnomoView");
	const fields = {
		inputEl: editor.input, draftContent: "", suspendedCreate: null as unknown,
		editingMemo: null as import("../src/types/memoView").MemoViewItem | null,
		quoteReferenceText: null as string | null, quoteMarkdownText: null as string | null,
		composerOpen: true, isSaving: false, trashViewClosed: false, composerRenderPending: false,
		currentLayout: "desktop", composerIsComposing: false,
		focusComposerInputNow: () => undefined,
		closeTimeBuoyPicker: () => undefined, syncRootState: () => undefined,
		updateStatus: (_message: string, _error: boolean) => undefined,
		updateSendButtonState: () => undefined, updateCancelEditButtonState: () => undefined,
		syncComposerMode: () => undefined, syncUiChrome: () => undefined, resizeInput: () => undefined,
		openComposer() { this.composerOpen = true; },
		mobileComposerController: { resetInactiveState: () => undefined },
		getDailyNotesStatus: () => ({ enabled: true }), isComposerCreationAvailable: () => true,
		resolveCatalogMemo: async (memo: import("../src/types/memoView").MemoViewItem) => memo.catalog!,
		memoCommandService: {
			startCreate: (_content: string) => ({ dailyCommitted: Promise.resolve(), settled: Promise.resolve({ status: "saved" as const, memo: null, timeBuoyDates: [], followUpPending: false, localRefreshPending: false }) }),
			startEdit: (_memo: unknown, _content: string) => ({ dailyCommitted: Promise.resolve(), settled: Promise.resolve({ status: "saved" as const, memo: null, timeBuoyDates: [], followUpPending: false, localRefreshPending: false }) }),
			createReferenceText: async (_memo: unknown) => ({ text: "[[reference]]" }),
		},
		reloadMemos: async () => true, showTimeBuoySaveFeedback: () => undefined,
		closeCardMenu: () => undefined, syncCardMenuState: () => undefined,
	};
	return Object.assign(Object.create(KnomoView.prototype), fields) as typeof fields & {
		startEditing(memo: import("../src/types/memoView").MemoViewItem): void;
		cancelEditing(): void; clearReference(): void; saveInput(): Promise<void>;
		closeComposerKeepingDraft(): void; cancelComposerFromEscape(): void;
		handleMemoAction(action: "reference", memo: import("../src/types/memoView").MemoViewItem): Promise<void>;
		render(): Promise<void>;
	};
}

function sessionMemo(id: string) {
	// 只提供会话测试使用的目标字段；原 observation 对象必须原样到达服务。
	return { id, contentSnapshot: "original " + id, dailyRef: { path: "Daily/2026-09-19.md" }, catalog: { observationHandle: { sourcePath: "Daily/2026-09-19.md", sourceRevision: id } } } as unknown as import("../src/types/memoView").MemoViewItem;
}

test("S01-S05 Create and Reference survive Edit, close, reopen, refusal and Cancel", async () => {
	const { editor, close } = environment("comment");
	try {
		const view = await sessionView(editor);
		view.quoteReferenceText = "[[source]]"; view.quoteMarkdownText = "> source";
		editor.apply({ value: "comment!", anchor: 2, head: 5 });
		const pending = editor.capture(); const memo = sessionMemo("a");
		view.startEditing(memo);
		assert.equal(pending.sameSession(), false);
		editor.apply({ value: "edited A", anchor: 8, head: 8 });
		const editing = editor.capture();
		view.closeComposerKeepingDraft(); view.cancelComposerFromEscape();
		assert.equal(editing.valid(), true);
		view.openComposer();
		view.startEditing({ ...memo });
		assert.equal(editing.valid(), true);
		view.startEditing(sessionMemo("b"));
		assert.equal(view.editingMemo, memo);
		let references = 0;
		view.memoCommandService.createReferenceText = async () => { references++; return { text: "[[bad]]" }; };
		await view.handleMemoAction("reference", sessionMemo("b"));
		assert.equal(references, 0);
		view.cancelEditing();
		assert.equal(editor.input.value, "comment!");
		assert.equal(view.quoteReferenceText, "[[source]]");
		assert.equal(view.quoteMarkdownText, "> source");
		assert.equal(editor.input.selectionStart, 2);
		assert.equal(editor.input.selectionEnd, 5);
		assert.equal(undo(editor.view), false); assert.equal(redo(editor.view), false);
		assert.equal(editing.sameSession(), false);
		view.clearReference();
		assert.equal(editor.input.value, "comment!");
		assert.equal(view.quoteReferenceText, null);
	} finally { close(); }
});

test("W01-W05 edit saves the original handle once while frozen and restores Create", async () => {
	const { editor, close } = environment("create draft");
	try {
		const view = await sessionView(editor); const memo = sessionMemo("a");
		view.quoteReferenceText = "[[source]]"; view.quoteMarkdownText = "> source";
		view.startEditing(memo); editor.apply({ value: "edited", anchor: 6, head: 6 });
		let complete!: () => void; const daily = new Promise<void>(resolve => { complete = resolve; });
		let calls = 0;
		view.memoCommandService.startEdit = (target, content) => {
			calls++; assert.equal(target, memo.catalog); assert.equal(content, "edited");
			return { dailyCommitted: daily, settled: Promise.resolve({ status: "saved", memo: null, timeBuoyDates: [], followUpPending: false, localRefreshPending: false }) };
		};
		const saving = view.saveInput(); await Promise.resolve();
		view.cancelEditing(); view.clearReference(); view.startEditing(sessionMemo("b"));
		view.closeComposerKeepingDraft(); view.openComposer();
		assert.equal(editor.apply({ value: "bad", anchor: 0, head: 0 }), false);
		await view.saveInput(); assert.equal(calls, 1);
		assert.equal(view.editingMemo, memo);
		complete(); await saving;
		assert.equal(editor.input.value, "create draft"); assert.equal(view.quoteReferenceText, "[[source]]");
		assert.equal(view.editingMemo, null); assert.equal(view.isSaving, false);
		assert.equal(editor.input.getAttribute("aria-readonly"), "false");
	} finally { close(); }
});

test("W03 stale retains edits and original target, failure restores current availability", async () => {
	const { editor, close } = environment("draft");
	try {
		const view = await sessionView(editor); const memo = sessionMemo("a");
		view.startEditing(memo); editor.apply({ value: "unsaved", anchor: 7, head: 7 });
		let status = ""; view.updateStatus = message => { status = message; };
		view.memoCommandService.startEdit = () => { view.getDailyNotesStatus = () => ({ enabled: false }); throw new Error("stale: refresh and reselect"); };
		await view.saveInput();
		assert.equal(editor.input.value, "unsaved"); assert.equal(view.editingMemo, memo);
		assert.equal(editor.input.disabled, true); assert.equal(view.isSaving, false);
		assert.match(status, /stale/);
	} finally { close(); }
});

test("S08 late Reference result cannot attach to a switched or restored session", async () => {
	const { editor, close } = environment("comment");
	try {
		const view = await sessionView(editor); let finish!: (value: { text: string }) => void;
		view.memoCommandService.createReferenceText = () => new Promise(resolve => { finish = resolve; });
		const pending = view.handleMemoAction("reference", sessionMemo("source"));
		await Promise.resolve();
		view.startEditing(sessionMemo("edit")); view.cancelEditing();
		finish({ text: "[[late]]" }); await pending;
		assert.equal(view.quoteReferenceText, null); assert.equal(editor.input.value, "comment");
	} finally { close(); }
});

test("W06-W07 late settled refresh preserves new errors, sheet and scroll ownership", async () => {
	const { editor, close } = environment("first");
	try {
		const view = await sessionView(editor);
		let finish!: (result: Awaited<ReturnType<typeof view.memoCommandService.startCreate>["settled"]>) => void;
		const settled: ReturnType<typeof view.memoCommandService.startCreate>["settled"] = new Promise(resolve => { finish = resolve; });
		view.memoCommandService.startCreate = () => ({ dailyCommitted: Promise.resolve(), settled });
		let status = ""; view.updateStatus = message => { status = message; };
		let refreshed!: () => void; const refreshedPromise = new Promise<void>(resolve => { refreshed = resolve; });
		view.reloadMemos = async () => { refreshed(); return true; };
		await view.saveInput();
		editor.reset("new draft"); view.openComposer(); status = "new error";
		finish({ status: "saved", memo: null, timeBuoyDates: [], followUpPending: false, localRefreshPending: false });
		await refreshedPromise; await Promise.resolve();
		assert.equal(editor.input.value, "new draft"); assert.equal(view.composerOpen, true); assert.equal(status, "new error");
	} finally { close(); }
});

test("W10 rebuild waits for consumption and close does not cancel the committed write or update DOM", async () => {
	for (const closing of [false, true]) {
		const { editor, close } = environment("submitted");
		try {
			const view = await sessionView(editor);
			let commit!: () => void; const dailyCommitted = new Promise<void>(resolve => { commit = resolve; });
			let finish!: (result: Awaited<ReturnType<typeof view.memoCommandService.startCreate>["settled"]>) => void;
			const settled: ReturnType<typeof view.memoCommandService.startCreate>["settled"] = new Promise(resolve => { finish = resolve; });
			view.memoCommandService.startCreate = () => ({ dailyCommitted, settled });
			const saving = view.saveInput();
			await view.render(); assert.equal(view.composerRenderPending, true);
			let renders = 0;
			view.render = async () => { renders++; assert.equal(editor.input.value, ""); assert.equal(view.draftContent, ""); };
			if (closing) {
				view.trashViewClosed = true; editor.destroy();
				view.updateStatus = view.updateSendButtonState = view.syncRootState = () => { throw new Error("closed DOM"); };
				view.reloadMemos = async () => { throw new Error("closed reload"); };
			}
			commit(); await saving;
			finish({ status: "saved", memo: null, timeBuoyDates: [], followUpPending: false, localRefreshPending: false });
			await Promise.resolve(); await Promise.resolve();
			assert.equal(renders, closing ? 0 : 1); assert.equal(view.isSaving, false);
		} finally { close(); }
	}
});
