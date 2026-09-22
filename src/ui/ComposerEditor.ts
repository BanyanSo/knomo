import { Compartment, EditorState, StateEffect, StateField, Transaction, type ChangeDesc } from "@codemirror/state";
import { Decoration, EditorView, WidgetType, drawSelection, keymap, placeholder, runScopeHandlers, type DecorationSet } from "@codemirror/view";
import { standardKeymap, history, historyKeymap, insertNewline, isolateHistory } from "@codemirror/commands";
import { getListEnterPatchForNativeInput } from "../utils/composerInput";
import { revealComposerRange, scanComposerSyntax, type ComposerSyntax, type ComposerSyntaxRange, type SourceRange } from "../utils/composerSyntax";
import type { ComposerEdit } from "../utils/composerCommands";
import { isCjkMemoContent } from "./KnomoCardMetadata";
import { t } from "../i18n";
import { TreeFragment, type ChangedRange } from "@lezer/common";
import { composerImageLinks, composerImageHistory } from "./ComposerImageState";

declare global {
	interface HTMLElementEventMap {
		"composer-reset": Event;
		"composer-change": CustomEvent<{ event: InputEvent | null; userInput: boolean; history: boolean }>;
		"composer-compositionend": CustomEvent<CompositionEvent>;
		"composer-transactions": CustomEvent<readonly Transaction[]>;
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
const contextEffect = StateEffect.define<null>();
const contextField = StateField.define({
	create: () => ({}),
	update: (value, tr) => tr.effects.some(e => e.is(contextEffect)) ? {} : value,
});
const composingField = StateField.define({
	create: () => false,
	update: (value: boolean, tr) => tr.effects.reduce((next, effect) => effect.is(composingEffect) ? effect.value : next, value),
});

// 普通候选文字不会引入 Markdown 分隔符；只复用可确认不改变结构的输入。
function preservesCompositionSyntax(tr: Transaction, syntax: ComposerSyntax): boolean {
	let safe = true;
	tr.changes.iterChanges((from, to, fromB, _toB, inserted) => {
		const removed = tr.startState.sliceDoc(from, to);
		const changedText = removed + inserted.toString();
		if (/[\r\n\t\\`*_~=$%<>\[\]{}#!|:+.\-]/u.test(changedText)) { safe = false; return; }
		const line = tr.startState.doc.lineAt(from);
		const nextLine = tr.newDoc.lineAt(fromB);
		const list = syntax.ranges.find(r => r.list && tr.startState.doc.lineAt(r.from).from === line.from);
		const contentFrom = list?.contentFrom ?? line.from;
		const nextContentFrom = tr.changes.mapPos(contentFrom, -1);
		const neighbors = tr.startState.sliceDoc(Math.max(line.from, from - 1), from) + tr.startState.sliceDoc(to, Math.min(line.to, to + 1));
		if (from < contentFrom || !tr.newDoc.sliceString(nextContentFrom, nextLine.to).trim()
			|| /^[\t ]*/u.exec(line.text)![0] !== /^[\t ]*/u.exec(nextLine.text)![0]
			|| changedText.includes(" ") && /[^ \p{L}\p{M}\p{N}]/u.test(neighbors)
			|| !list && /^[\t ]*\d+[.)](?:\s|$)/u.test(nextLine.text)
			|| /[\\<>\[\]*_~=$%]/u.test(neighbors)
			|| syntax.contexts.some(n => n.type === "HTMLTag" && from >= n.from && to <= n.to)
			|| syntax.ranges.some(r => r.markers.some(m => from === to ? from > m.from && from < m.to : from < m.to && to > m.from))) safe = false;
	});
	return safe;
}

// 语法树片段交给 Lezer 复用，已确认区间则随候选文字移动，供下一次边界判断使用。
function mapCompositionSyntax(syntax: ComposerSyntax, changes: ChangeDesc): ComposerSyntax {
	const map = <T extends SourceRange>(range: T): T => ({ ...range, from: changes.mapPos(range.from, -1), to: changes.mapPos(range.to, 1) });
	const mapMarker = (range: SourceRange): SourceRange => {
		const from = changes.mapPos(range.from, 1);
		return { from, to: Math.max(from, changes.mapPos(range.to, -1)) };
	};
	return { ...syntax, contexts: syntax.contexts.map(map), sourceRanges: syntax.sourceRanges.map(map),
		protectedRanges: syntax.protectedRanges.map(map), proseLines: syntax.proseLines.map(map),
		ranges: syntax.ranges.map(r => ({ ...map(r), contentFrom: changes.mapPos(r.contentFrom, -1), contentTo: changes.mapPos(r.contentTo, 1),
			markers: r.markers.map(mapMarker), separators: r.separators.map(mapMarker), target: r.target && map(r.target), escapes: r.escapes?.map(mapMarker),
			list: r.list && { ...r.list, item: map(r.list.item), content: map(r.list.content) },
			task: r.task && { ...r.task, from: changes.mapPos(r.task.from, 1) },
		})),
	};
}
const syntaxField = StateField.define({
	create: state => {
		const syntax = scanComposerSyntax(state.doc.toString());
		return { syntax, fragments: TreeFragment.addTree(syntax.tree), cjk: isCjkMemoContent(state.doc.toString()), dirty: false, safeUntil: state.doc.length };
	},
	update: (value, tr) => {
		const changes: ChangedRange[] = [];
		tr.changes.iterChangedRanges((fromA, toA, fromB, toB) => changes.push({ fromA, toA, fromB, toB }));
		const fragments = changes.length ? TreeFragment.applyChanges(value.fragments, changes) : value.fragments;
		// 候选拼音只更新正文；提交后再解析一次，避免每个按键扫描整篇草稿。
		if (tr.state.field(composingField)) {
			if (!tr.docChanged) return value;
			let safeUntil = value.safeUntil;
			const preservesSyntax = preservesCompositionSyntax(tr, value.syntax);
			if (!preservesSyntax) tr.changes.iterChangedRanges(from => {
				// 空行变化可能把前一段变成 Setext 标题或连接成同一块。
				let blockFrom = 0;
				for (const node of value.syntax.contexts) {
					if (node.from > from) break;
					if (node.parent === 0) blockFrom = node.from;
				}
				// 未确认的新语法可能影响后续全文；仅保留未触及的前置块。
				safeUntil = Math.min(safeUntil, blockFrom);
			});
			return { ...value, syntax: mapCompositionSyntax(value.syntax, tr.changes), fragments, dirty: true,
				safeUntil: tr.changes.mapPos(safeUntil, preservesSyntax && safeUntil === tr.startState.doc.length ? 1 : -1) };
		}
		if (!tr.docChanged && !value.dirty) return value;
		const syntax = scanComposerSyntax(tr.newDoc.toString(), fragments);
		return { syntax, fragments: TreeFragment.addTree(syntax.tree), cjk: isCjkMemoContent(tr.newDoc.toString()), dirty: false, safeUntil: tr.newDoc.length };
	},
});

class ComposerMarker extends WidgetType {
	constructor(private readonly range: ComposerSyntaxRange, private readonly label: string, private readonly state: EditorState) { super(); }
	eq(other: ComposerMarker): boolean {
		return this.range.kind === other.range.kind && this.label === other.label && this.range.from === other.range.from
			&& this.state.doc === other.state.doc && this.state.readOnly === other.state.readOnly
			&& this.state.field(contextField) === other.state.field(contextField);
	}
	toDOM(view: EditorView): HTMLElement {
		const kind = this.range.kind;
		const element = view.dom.ownerDocument.adoptNode(createSpan());
		element.className = `knomo-composer-marker knomo-composer-${kind}-marker`;
		if (kind === "task") {
			const checkbox = element.createEl("input");
			checkbox.type = "checkbox";
			checkbox.className = "task-list-item-checkbox";
			checkbox.checked = this.label.toLowerCase() === "x";
			checkbox.setAttribute("data-task", this.label);
			checkbox.setAttribute("aria-label", t("composer.toggleTask", { text: view.state.doc.lineAt(this.range.from).text.slice(this.range.to - view.state.doc.lineAt(this.range.from).from) }));
			checkbox.disabled = this.state.readOnly;
			const toggle = () => {
				const editor = (view.contentDOM as ComposerInput).composer;
				if (!editor || editor.readOnly || editor.composing || !view.dom.contains(element)
					|| view.state.doc !== this.state.doc || view.state.field(contextField) !== this.state.field(contextField)) return;
				const task = view.state.field(syntaxField).syntax.ranges.find(r => r.from === this.range.from && r.kind === "task")?.task;
				if (!task || view.state.sliceDoc(task.from, task.from + 1) !== task.state) return;
				view.dispatch({ changes: { from: task.from, to: task.from + 1, insert: task.state === " " ? "x" : " " },
					annotations: [Transaction.userEvent.of("input.task"), isolateHistory.of("full")] });
				// 控件重建后保持键盘入口，不移动正文选区。
				if (focused) {
					const next = view.dom.querySelector<HTMLInputElement>(`input[data-composer-task="${task.from}"]`);
					next?.focus();
				}
			};
			let focused = false;
			checkbox.setAttribute("data-composer-task", String(this.range.task!.from));
			checkbox.addEventListener("pointerdown", event => event.stopPropagation());
			checkbox.addEventListener("click", event => {
				event.preventDefault(); focused = view.dom.ownerDocument.activeElement === checkbox; toggle();
			});
			checkbox.addEventListener("keydown", event => {
				const editor = (view.contentDOM as ComposerInput).composer;
				if (editor && !editor.readOnly && !editor.composing && runScopeHandlers(view, event, "composer-task")) {
					event.preventDefault(); event.stopPropagation();
					const next = view.dom.querySelector<HTMLInputElement>(`input[data-composer-task="${this.range.task!.from}"]`);
					if (next) next.focus(); else view.focus();
					return;
				}
				if (event.key === " ") { event.preventDefault(); event.stopPropagation(); focused = true; if (!event.repeat) toggle(); }
				if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
					event.preventDefault(); view.dispatch({ selection: { anchor: this.range.markers[this.range.markers.length - 1].to } }); view.focus();
				}
			});
		} else {
			// 与卡片一样由浏览器生成 ::marker，不用字体字符模拟圆点或编号。
			const list = element.createEl(kind === "ordered" ? "ol" : "ul");
			if (list instanceof view.dom.ownerDocument.defaultView!.HTMLOListElement) list.start = parseInt(this.label, 10);
			list.createEl("li");
			element.setAttribute("aria-hidden", "true");
			element.addEventListener("pointerdown", event => {
				event.preventDefault();
				view.dispatch({ selection: { anchor: this.range.markers[0].to } }); view.focus();
			});
		}
		return element;
	}
	ignoreEvent(): boolean { return true; }
}

function decorations(state: EditorState): DecorationSet {
	const result = [];
	const selection = state.selection.ranges;
	const { syntax, cjk } = state.field(syntaxField);
	const revealed = syntax.ranges.filter(r => revealComposerRange(r, selection));
	const revealedSet = new Set(revealed);
	let revealIndex = 0;
	for (const line of cjk ? syntax.proseLines : []) {
		while (revealIndex < revealed.length && revealed[revealIndex].to <= line.from) revealIndex++;
		if (revealIndex === revealed.length || revealed[revealIndex].from >= line.to) {
			result.push(Decoration.line({ class: "knomo-composer-prose" }).range(line.from));
		}
	}
	for (const range of syntax.ranges) {
		if (revealedSet.has(range)) continue;
		if (["task", "bullet", "ordered"].includes(range.kind)) {
			const label = range.task?.state ?? (range.kind === "bullet" ? "" : `${range.list!.display}.`);
			result.push(Decoration.line({ attributes: {
				class: `knomo-composer-list-line${range.kind === "task" ? " knomo-composer-task-line" : ""}${range.kind === "task" && label.toLowerCase() === "x" ? " is-checked" : ""}`,
				style: `--knomo-composer-marker-width: ${range.kind === "ordered" ? label.length : 0}ch`,
			} }).range(state.doc.lineAt(range.from).from));
			result.push(Decoration.replace({ widget: new ComposerMarker(range, label, state) }).range(range.from, range.to));
		} else {
			if (range.from < range.contentFrom) result.push(Decoration.replace({}).range(range.from, range.contentFrom));
			for (const escape of range.escapes ?? []) result.push(Decoration.replace({}).range(escape.from, escape.to));
			result.push(Decoration.mark({
				tagName: range.kind === "bold" ? "strong" : range.kind === "highlight" ? "mark" : range.kind === "italic" ? "em" : range.kind === "strike" ? "s" : range.kind === "code" ? "code" : "a",
				class: `knomo-composer-${range.kind}${range.kind === "link" ? " internal-link" : ""}`,
			}).range(range.contentFrom, range.contentTo));
			if (range.contentTo < range.to) result.push(Decoration.replace({}).range(range.contentTo, range.to));
		}
	}
	return Decoration.set(result, true);
}

const decorationsField = StateField.define<DecorationSet>({
	create: decorations,
	update: (previous, tr) => {
		// 输入法期间仅映射有效装饰；光标进入节点时仍立即显露源码。
		if (tr.state.field(composingField)) {
			const { safeUntil, syntax } = tr.state.field(syntaxField);
			const revealed = syntax.ranges.filter(r => revealComposerRange(r, tr.state.selection.ranges));
			return previous.map(tr.changes).update({ filter: (from, to, decoration) => from < safeUntil && to <= safeUntil
				&& !revealed.some(r => from === to
					? r.list && tr.state.doc.lineAt(r.from).from === from
						|| decoration.spec.class === "knomo-composer-prose" && r.from < tr.state.doc.lineAt(from).to && r.to > from
					: from < r.to && to > r.from) });
		}
		if (!tr.docChanged && !tr.selection && !tr.reconfigured && !tr.effects.some(effect => effect.is(composingEffect) || effect.is(contextEffect))) return previous;
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
				view.contentDOM.dispatchEvent(new view.dom.ownerDocument.defaultView!.CustomEvent("composer-transactions", { detail: transactions }));
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
			history(), composerImageLinks, composerImageHistory, this.editable.of(this.availabilityExtensions()),
			// 通过 facet 保留宿主类名，避免焦点切换时被 CodeMirror 重写。
			EditorView.editorAttributes.of({ class: "knomo-composer-editor" }),
			// Memo 是自然语言输入，覆盖代码编辑器默认关闭的系统纠错和联想能力。
			EditorView.contentAttributes.of({ "aria-labelledby": label, "aria-multiline": "true", role: "textbox", class: "knomo-composer-input",
				inputmode: "text", spellcheck: "true", autocorrect: "on", autocapitalize: "sentences", writingsuggestions: "true" }),
			EditorView.lineWrapping, placeholder(hint), drawSelection({ drawRangeCursor: false }),
			keymap.of([...historyKeymap.map(binding => ({ ...binding, scope: "editor composer-task" })), ...standardKeymap.filter(binding => binding.key !== "Enter"), { key: "Enter", run: insertNewline, shift: insertNewline }]),
			contextField, composingField, syntaxField,
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
				// 保留未变正文的范围映射；整篇替换会误取消图片任务和链接校验记录。
				return patch ? [tr, { changes: getMinimalTextChange(tr.newDoc.toString(), patch.value),
					selection: { anchor: patch.cursor }, sequential: true }] : tr;
			}),
		] });
	}

	apply(edit: ComposerEdit): boolean {
		if (this.disposed || !this.enabled || this.saving || this.composing) return false;
		const value = this.input.value;
		if (value === edit.value) return false;
		// 最小差异保留选区映射和输入法附近的 DOM，文本与选区只提交一次。
		this.view.dispatch({ changes: getMinimalTextChange(value, edit.value),
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
		if (!this.disposed) this.view.dispatch({ effects: contextEffect.of(null) });
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
	destroy(): void { if (this.disposed) return; this.invalidateContext(); this.disposed = true; this.view.destroy(); }
}

function getMinimalTextChange(value: string, nextValue: string): { from: number; to: number; insert: string } {
	let from = 0, end = value.length, nextEnd = nextValue.length;
	while (from < end && from < nextEnd && value[from] === nextValue[from]) from++;
	while (end > from && nextEnd > from && value[end - 1] === nextValue[nextEnd - 1]) { end--; nextEnd--; }
	return { from, to: end, insert: nextValue.slice(from, nextEnd) };
}

export function applyComposerEdit(input: ComposerInput, value: string, anchor: number, head = anchor): boolean {
	return input.composer.apply({ value, anchor, head });
}
