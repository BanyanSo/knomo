import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
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
	const suggest = new KnomoTagSuggest({} as never, editor.input, () => undefined, {
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
		second.dispatchEvent(new win.MouseEvent("pointermove", { bubbles: true }));
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
