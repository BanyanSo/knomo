import { Compartment, EditorState, StateEffect, StateField, Transaction } from "@codemirror/state";
import { Decoration, EditorView, WidgetType, keymap, placeholder, type DecorationSet } from "@codemirror/view";
import { standardKeymap, history, historyKeymap, insertNewline, isolateHistory } from "@codemirror/commands";
import { getListEnterPatchForNativeInput } from "../utils/composerInput";
import { revealComposerRange, scanComposerSyntax } from "../utils/composerSyntax";
import type { ComposerEdit } from "../utils/composerCommands";

declare global {
	interface HTMLElementEventMap {
		"composer-change": CustomEvent<{ event: InputEvent | null; userInput: boolean; history: boolean }>;
	}
}

// DOM 只承担焦点、事件与布局；所有正文和选区都直接访问同一个 EditorState。
export interface ComposerInput extends HTMLElement {
	value: string;
	readonly selectionStart: number;
	readonly selectionEnd: number;
	readonly selectionDirection: "forward" | "backward";
	disabled: boolean;
	setSelectionRange(start: number, end: number, direction?: string): void;
	composer: ComposerEditor;
}

const composingEffect = StateEffect.define<boolean>();
const composingField = StateField.define({
	create: () => false,
	update: (value: boolean, tr) => tr.effects.reduce((next, effect) => effect.is(composingEffect) ? effect.value : next, value),
});
const syntaxField = StateField.define({
	create: state => scanComposerSyntax(state.doc.toString()),
	update: (value, tr) => tr.docChanged ? scanComposerSyntax(tr.newDoc.toString()) : value,
});

class ComposerMarker extends WidgetType {
	constructor(private readonly kind: string, private readonly label: string, private readonly from: number) { super(); }
	eq(other: ComposerMarker): boolean { return this.kind === other.kind && this.label === other.label && this.from === other.from; }
	toDOM(view: EditorView): HTMLElement {
		const element = view.dom.ownerDocument.createElement("span");
		element.className = `knomo-composer-marker knomo-composer-${this.kind}-marker`;
		if (this.kind === "task") {
			const checkbox = view.dom.ownerDocument.createElement("input");
			checkbox.type = "checkbox";
			checkbox.className = "task-list-item-checkbox";
			checkbox.checked = this.label === "x";
			checkbox.setAttribute("data-task", this.label);
			checkbox.tabIndex = -1;
			element.appendChild(checkbox);
		} else {
			// 与卡片一样由浏览器生成 ::marker，不用字体字符模拟圆点或编号。
			const list = view.dom.ownerDocument.createElement(this.kind === "ordered" ? "ol" : "ul");
			if (list instanceof view.dom.ownerDocument.defaultView!.HTMLOListElement) list.start = parseInt(this.label, 10);
			list.appendChild(view.dom.ownerDocument.createElement("li"));
			element.appendChild(list);
		}
		element.setAttribute("aria-hidden", "true");
		element.addEventListener("pointerdown", event => {
			event.preventDefault();
			view.dispatch({ selection: { anchor: this.from } });
			view.focus();
		});
		// 标记仅负责显露源码，不执行浏览器默认勾选或独立正文修改。
		element.addEventListener("click", event => event.preventDefault());
		return element;
	}
	ignoreEvent(): boolean { return true; }
}

function decorations(state: EditorState): DecorationSet {
	const result = [];
	const selection = state.selection.ranges;
	for (const range of state.field(syntaxField).ranges) {
		if (revealComposerRange(range, selection)) continue;
		if (["task", "bullet", "ordered"].includes(range.kind)) {
			const raw = state.sliceDoc(range.from, range.to);
			const label = range.kind === "task" ? raw.includes("[x]") ? "x" : " " : range.kind === "bullet" ? "" : `${parseInt(raw, 10)}.`;
			result.push(Decoration.line({ attributes: {
				class: `knomo-composer-list-line${range.kind === "task" ? " knomo-composer-task-line" : ""}${range.kind === "task" && label === "x" ? " is-checked" : ""}`,
				style: `--knomo-composer-marker-width: ${range.kind === "ordered" ? label.length + 1 : 0}ch`,
			} }).range(state.doc.lineAt(range.from).from));
			result.push(Decoration.replace({ widget: new ComposerMarker(range.kind, label, range.from) }).range(range.from, range.to));
		} else {
			result.push(Decoration.replace({}).range(range.from, range.contentFrom));
			result.push(Decoration.mark({
				tagName: range.kind === "bold" ? "strong" : range.kind === "highlight" ? "mark" : "a",
				class: `knomo-composer-${range.kind}${range.kind === "link" ? " internal-link" : ""}`,
			}).range(range.contentFrom, range.contentTo));
			result.push(Decoration.replace({}).range(range.contentTo, range.to));
		}
	}
	return Decoration.set(result, true);
}

const decorationsField = StateField.define<DecorationSet>({
	create: decorations,
	update: (previous, tr) => {
		// 输入法工作期间仅映射既有装饰，不重建正在使用的编辑 DOM。
		if (tr.state.field(composingField)) return previous.map(tr.changes);
		if (!tr.docChanged && !tr.selection && !tr.effects.some(effect => effect.is(composingEffect))) return previous;
		return decorations(tr.state);
	},
	provide: field => EditorView.decorations.from(field),
});

export class ComposerEditor {
	readonly input: ComposerInput;
	readonly view: EditorView;
	private readonly editable = new Compartment();
	private enabled = true;
	private disposed = false;
	private session = 0;
	private revision = 0;
	private lastCompositionEnd = -Infinity;
	private beforeInput: InputEvent | null = null;

	constructor(parent: HTMLElement, doc: string, private readonly label: string, private readonly hint: string) {
		this.view = new EditorView({ parent, state: this.createState(doc, label, hint),
			dispatchTransactions: (transactions, view) => {
				view.update(transactions);
				if (transactions.some(tr => tr.docChanged)) {
					this.revision++;
					const isNativeInput = transactions.some(tr => tr.isUserEvent("input.type"));
					const event = isNativeInput ? this.beforeInput : null;
					this.beforeInput = null;
					const win = view.dom.ownerDocument.defaultView!;
					view.contentDOM.dispatchEvent(new win.CustomEvent("composer-change", { detail: {
						event, userInput: transactions.some(tr => tr.isUserEvent("input.type")),
						history: transactions.some(tr => tr.isUserEvent("undo") || tr.isUserEvent("redo")),
					} }));
				}
			},
		});
		this.input = this.view.contentDOM as ComposerInput;
		this.input.composer = this;
		Object.defineProperties(this.input, {
			value: { get: () => this.view.state.doc.toString(), set: (value: string) => this.reset(value) },
			selectionStart: { get: () => this.view.state.selection.main.from },
			selectionEnd: { get: () => this.view.state.selection.main.to },
			selectionDirection: { get: () => this.view.state.selection.main.anchor > this.view.state.selection.main.head ? "backward" : "forward" },
			disabled: { get: () => !this.enabled, set: (disabled: boolean) => {
				this.enabled = !disabled;
				this.view.dispatch({ effects: this.editable.reconfigure(EditorView.editable.of(!disabled)) });
			} },
		});
		this.input.setSelectionRange = (start, end, direction) => this.view.dispatch({ selection: {
			anchor: direction === "backward" ? end : start, head: direction === "backward" ? start : end,
		} });
		this.input.addEventListener("beforeinput", event => { this.beforeInput = event as InputEvent; }, { capture: true });
		this.input.addEventListener("compositionstart", () => this.view.dispatch({ effects: composingEffect.of(true) }));
		this.input.addEventListener("compositionend", event => {
			this.lastCompositionEnd = event.timeStamp;
			// 让原生 composition 的最后一次输入先完成，再更新显示。
			queueMicrotask(() => { if (!this.disposed) this.view.dispatch({ effects: composingEffect.of(false) }); });
		});
		this.input.addEventListener("keydown", event => {
			if (event.isComposing || event.keyCode === 229 || this.view.composing || event.timeStamp - this.lastCompositionEnd < 50) {
				event.stopImmediatePropagation();
			}
		}, { capture: true });
	}

	private createState(doc: string, label: string, hint: string): EditorState {
		return EditorState.create({ doc, selection: { anchor: doc.length }, extensions: [
			history(), this.editable.of(EditorView.editable.of(this.enabled)),
			// 通过 facet 保留宿主类名，避免焦点切换时被 CodeMirror 重写。
			EditorView.editorAttributes.of({ class: "knomo-composer-editor" }),
			EditorView.contentAttributes.of({ "aria-labelledby": label, "aria-multiline": "true", role: "textbox", class: "knomo-composer-input" }),
			EditorView.lineWrapping, placeholder(hint),
			keymap.of([...historyKeymap, ...standardKeymap.filter(binding => binding.key !== "Enter"), { key: "Enter", run: insertNewline, shift: insertNewline }]),
			composingField, syntaxField,
			decorationsField,
			EditorState.transactionFilter.of(tr => {
				if (!tr.docChanged || !tr.isUserEvent("input.type") || tr.isUserEvent("input.type.compose")) return tr;
				const selection = tr.newSelection.main;
				const patch = getListEnterPatchForNativeInput(tr.startState.doc.toString(), tr.newDoc.toString(), selection.from, selection.to,
					{ allowTextChangeWithNewline: true, allowInsertedMarkerCorrection: true });
				return patch ? [tr, { changes: { from: 0, to: tr.newDoc.length, insert: patch.value },
					selection: { anchor: patch.cursor }, sequential: true }] : tr;
			}),
		] });
	}

	apply(edit: ComposerEdit): boolean {
		if (this.disposed || !this.enabled || this.view.composing || this.view.state.field(composingField)) return false;
		const value = this.input.value;
		if (value === edit.value) return false;
		// 最小差异保留选区映射和输入法附近的 DOM，文本与选区只提交一次。
		let from = 0, end = value.length, nextEnd = edit.value.length;
		while (from < end && from < nextEnd && value[from] === edit.value[from]) from++;
		while (end > from && nextEnd > from && value[end - 1] === edit.value[nextEnd - 1]) { end--; nextEnd--; }
		this.view.dispatch({ changes: { from, to: end, insert: edit.value.slice(from, nextEnd) },
			selection: { anchor: edit.anchor, head: edit.head }, annotations: [Transaction.userEvent.of("input.toolbar"), isolateHistory.of("full")] });
		return true;
	}

	invalidateContext(): void {
		this.session++;
		this.input.dispatchEvent(new this.input.ownerDocument.defaultView!.Event("composer-reset"));
	}
	reset(doc: string): void {
		this.session++;
		this.revision++;
		this.view.setState(this.createState(doc, this.label, this.hint));
		this.input.dispatchEvent(new this.input.ownerDocument.defaultView!.Event("composer-reset"));
	}
	get composing(): boolean { return this.view.composing || this.view.state.field(composingField); }
	capture(): { valid: () => boolean; sameSession: () => boolean; anchor: number; head: number } {
		const session = this.session, revision = this.revision;
		return { valid: () => !this.disposed && session === this.session && revision === this.revision,
			sameSession: () => !this.disposed && session === this.session,
			anchor: this.view.state.selection.main.anchor, head: this.view.state.selection.main.head };
	}
	coordsAtPos(pos: number): DOMRect | null {
		const rect = this.view.coordsAtPos(pos);
		const win = this.input.ownerDocument.defaultView!;
		return rect ? new win.DOMRect(rect.left, rect.top, rect.right - rect.left, rect.bottom - rect.top) : null;
	}
	destroy(): void { if (this.disposed) return; this.disposed = true; this.session++; this.view.destroy(); }
}

export function applyComposerEdit(input: ComposerInput, value: string, anchor: number, head = anchor): boolean {
	return input.composer.apply({ value, anchor, head });
}
