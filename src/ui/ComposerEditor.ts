import { Compartment, EditorState, StateEffect, StateField, Transaction } from "@codemirror/state";
import { Decoration, EditorView, WidgetType, keymap, placeholder, type DecorationSet } from "@codemirror/view";
import { standardKeymap, history, historyKeymap, insertNewline, isolateHistory } from "@codemirror/commands";
import { getListEnterPatchForNativeInput } from "../utils/composerInput";
import { revealComposerRange, scanComposerSyntax } from "../utils/composerSyntax";
import type { ComposerEdit } from "../utils/composerCommands";
import { isCjkMemoContent } from "./KnomoCardMetadata";

declare global {
	interface HTMLElementEventMap {
		"composer-reset": Event;
		"composer-change": CustomEvent<{ event: InputEvent | null; userInput: boolean; history: boolean }>;
		"composer-compositionend": CustomEvent<CompositionEvent>;
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
	create: state => ({ syntax: scanComposerSyntax(state.doc.toString()), cjk: isCjkMemoContent(state.doc.toString()), dirty: false }),
	update: (value, tr) => {
		// 候选拼音只更新正文；提交后再解析一次，避免每个按键扫描整篇草稿。
		if (tr.state.field(composingField)) return tr.docChanged && !value.dirty ? { ...value, dirty: true } : value;
		return tr.docChanged || value.dirty ? { syntax: scanComposerSyntax(tr.newDoc.toString()), cjk: isCjkMemoContent(tr.newDoc.toString()), dirty: false } : value;
	},
});

class ComposerMarker extends WidgetType {
	constructor(private readonly kind: string, private readonly label: string, private readonly from: number) { super(); }
	eq(other: ComposerMarker): boolean { return this.kind === other.kind && this.label === other.label && this.from === other.from; }
	toDOM(view: EditorView): HTMLElement {
		const element = view.dom.ownerDocument.adoptNode(createSpan());
		element.className = `knomo-composer-marker knomo-composer-${this.kind}-marker`;
		if (this.kind === "task") {
			const checkbox = element.createEl("input");
			checkbox.type = "checkbox";
			checkbox.className = "task-list-item-checkbox";
			checkbox.checked = this.label === "x";
			checkbox.setAttribute("data-task", this.label);
			checkbox.tabIndex = -1;
		} else {
			// 与卡片一样由浏览器生成 ::marker，不用字体字符模拟圆点或编号。
			const list = element.createEl(this.kind === "ordered" ? "ol" : "ul");
			if (list instanceof view.dom.ownerDocument.defaultView!.HTMLOListElement) list.start = parseInt(this.label, 10);
			list.createEl("li");
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
	for (const range of state.field(syntaxField).syntax.ranges) {
		if (revealComposerRange(range, selection)) continue;
		if (["task", "bullet", "ordered"].includes(range.kind)) {
			const raw = state.sliceDoc(range.from, range.to);
			const label = range.kind === "task" ? raw.includes("[x]") ? "x" : " " : range.kind === "bullet" ? "" : `${parseInt(raw, 10)}.`;
			result.push(Decoration.line({ attributes: {
				class: `knomo-composer-list-line${range.kind === "task" ? " knomo-composer-task-line" : ""}${range.kind === "task" && label === "x" ? " is-checked" : ""}`,
				style: `--knomo-composer-marker-width: ${range.kind === "ordered" ? label.length : 0}ch`,
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
	private saving = false;
	private disposed = false;
	private session = 0;
	private revision = 0;
	private lastCompositionEnd = -Infinity;
	private compositionActive = false;
	private compositionGeneration = 0;
	private beforeInput: InputEvent | null = null;

	constructor(parent: HTMLElement, doc: string, private readonly label: string, private readonly hint: string) {
		this.view = new EditorView({ parent, state: this.createState(doc, label, hint),
			dispatchTransactions: (transactions, view) => {
				// 即使调用方绕过 transactionFilter，保存期间也不能修改正文。
				if ((!this.enabled || this.saving) && transactions.some(tr => tr.docChanged)) return;
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
				if (this.enabled === !disabled) return;
				this.enabled = !disabled;
				this.syncAvailability();
			} },
		});
		this.input.setSelectionRange = (start, end, direction) => this.view.dispatch({ selection: {
			anchor: direction === "backward" ? end : start, head: direction === "backward" ? start : end,
		} });
		this.input.addEventListener("beforeinput", event => { this.beforeInput = event; }, { capture: true });
		const startComposition = () => {
			// 不在原生事件中 dispatch：此时 DOM 可能已有尚未读入的拼音/中文。
			this.compositionActive = true;
			this.compositionGeneration++;
		};
		this.input.addEventListener("compositionstart", startComposition, { capture: true });
		this.input.addEventListener("compositionupdate", startComposition, { capture: true });
		this.input.addEventListener("compositionend", event => {
			this.lastCompositionEnd = event.timeStamp;
			this.finishComposition(event);
		});
		this.input.addEventListener("keydown", event => {
			// 保留 229：部分 IME 的确认键未携带 isComposing，不能落入编辑/提交快捷键。
			if (event.isComposing || event.keyCode === 229 || this.view.composing || event.timeStamp - this.lastCompositionEnd < 50) {
				event.stopImmediatePropagation();
			}
		}, { capture: true });
	}

	private finishComposition(event: CompositionEvent): void {
		const generation = ++this.compositionGeneration;
		// CodeMirror 在测量前接收待处理的原生输入；write 之后才可提交显示事务。
		// 单独的 compositionend 微任务会抢在手机延迟的 DOM 读取之前。
		this.view.requestMeasure({
			key: this,
			read: () => undefined,
			write: () => queueMicrotask(() => {
				if (this.disposed || generation !== this.compositionGeneration || this.view.compositionStarted) return;
				this.compositionActive = false;
				if (this.view.state.field(composingField)) this.view.dispatch({ effects: composingEffect.of(false) });
				this.input.dispatchEvent(new this.input.ownerDocument.defaultView!.CustomEvent("composer-compositionend", { detail: event }));
			}),
		});
	}

	private createState(doc: string, label: string, hint: string): EditorState {
		return EditorState.create({ doc, selection: { anchor: doc.length }, extensions: [
			history(), this.editable.of(this.availabilityExtensions()),
			// 通过 facet 保留宿主类名，避免焦点切换时被 CodeMirror 重写。
			EditorView.editorAttributes.of({ class: "knomo-composer-editor" }),
			// Memo 是自然语言输入，覆盖代码编辑器默认关闭的系统纠错和联想能力。
			EditorView.contentAttributes.of({ "aria-labelledby": label, "aria-multiline": "true", role: "textbox", class: "knomo-composer-input",
				inputmode: "text", spellcheck: "true", autocorrect: "on", autocapitalize: "sentences", writingsuggestions: "true" }),
			EditorView.lineWrapping, placeholder(hint),
			keymap.of([...historyKeymap, ...standardKeymap.filter(binding => binding.key !== "Enter"), { key: "Enter", run: insertNewline, shift: insertNewline }]),
			composingField, syntaxField,
			EditorView.contentAttributes.of(state => ({
				"data-cjk": String(state.state.field(syntaxField).cjk),
			})),
			decorationsField,
			EditorState.transactionExtender.of(tr => {
				const composing = this.compositionActive;
				return composing !== tr.startState.field(composingField) ? { effects: composingEffect.of(composing) } : null;
			}),
			EditorState.transactionFilter.of(tr => {
				if (!tr.docChanged || this.composing || !tr.isUserEvent("input.type") || tr.isUserEvent("input.type.compose")) return tr;
				let insertedNewline = false;
				tr.changes.iterChanges((_from, _to, _nextFrom, _nextTo, inserted) => { if (inserted.lines > 1) insertedNewline = true; });
				if (!insertedNewline) return tr;
				const selection = tr.newSelection.main;
				const patch = getListEnterPatchForNativeInput(tr.startState.doc.toString(), tr.newDoc.toString(), selection.from, selection.to,
					{ allowTextChangeWithNewline: true, allowInsertedMarkerCorrection: true });
				return patch ? [tr, { changes: { from: 0, to: tr.newDoc.length, insert: patch.value },
					selection: { anchor: patch.cursor }, sequential: true }] : tr;
			}),
		] });
	}

	apply(edit: ComposerEdit): boolean {
		if (this.disposed || !this.enabled || this.saving || this.composing) return false;
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

	private availabilityExtensions() {
		return [EditorView.editable.of(this.enabled), EditorState.readOnly.of(!this.enabled || this.saving),
			EditorView.contentAttributes.of({ "aria-readonly": String(this.saving || !this.enabled), "aria-disabled": String(!this.enabled) })];
	}
	private syncAvailability(): void {
		this.view.dispatch({ effects: this.editable.reconfigure(this.availabilityExtensions()) });
	}
	setSaving(saving: boolean): void {
		if (this.saving === saving || this.disposed) return;
		this.saving = saving;
		if (saving) this.invalidateContext();
		this.syncAvailability();
	}

	invalidateContext(): void {
		this.session++;
		this.input.dispatchEvent(new this.input.ownerDocument.defaultView!.Event("composer-reset"));
	}
	reset(doc: string): void {
		this.session++;
		this.revision++;
		this.compositionGeneration++;
		this.compositionActive = false;
		this.beforeInput = null;
		this.view.setState(this.createState(doc, this.label, this.hint));
		this.input.dispatchEvent(new this.input.ownerDocument.defaultView!.Event("composer-reset"));
	}
	get readOnly(): boolean { return this.saving || !this.enabled || this.disposed; }
	get composing(): boolean { return this.compositionActive || this.view.compositionStarted || this.view.state.field(composingField); }
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
