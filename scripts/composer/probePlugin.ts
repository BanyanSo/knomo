import { Modal, Plugin } from "obsidian";
import { EditorView, Decoration, keymap, WidgetType } from "@codemirror/view";
import { StateEffect } from "@codemirror/state";
import { historyKeymap } from "@codemirror/commands";
import { createProbeState, probeListEnter, probeMarkerHidden, probeWrapSelection } from "./kernelProbe";

class ComposerProbeModal extends Modal {
	private editor: EditorView | null = null;

	onOpen(): void {
		this.titleEl.setText("Composer 内核验证 · 非正式编辑器");
		const parent = this.contentEl.createDiv();
		const status = this.contentEl.createEl("pre");
		const view = new EditorView({
			parent,
			state: createProbeState("- [ ] 验证中文输入\n选择这里，测试一次事务与撤销"),
		});
		this.editor = view;
		const updateStatus = () => {
			status.textContent = JSON.stringify({ markdown: view.state.doc.toString(),
				selection: view.state.selection.toJSON(), composing: view.composing }, null, 2);
		};
		// 在同一状态中添加显示能力，不创建第二份可编辑正文。
		view.dispatch({ effects: StateEffect.appendConfig.of([
			keymap.of([...historyKeymap, { key: "Enter", run: editor => {
				if (editor.composing) return false;
				const transaction = probeListEnter(editor.state);
				if (transaction === null) return false;
				editor.dispatch(transaction);
				return true;
			} }]),
			EditorView.lineWrapping,
			EditorView.theme({ "&": { fontFamily: "var(--font-text)", fontSize: "var(--font-text-size)" },
				".cm-scroller": { fontFamily: "inherit", maxHeight: "40vh", overflow: "auto" },
				".cm-content": { minHeight: "8em" } }),
			EditorView.decorations.compute(["doc", "selection"], state => probeMarkerHidden(state)
				? Decoration.set([Decoration.replace({ widget: new ProbeCheckbox() }).range(0, 6)]) : Decoration.none),
			EditorView.updateListener.of(updateStatus),
		]) });
		const button = this.contentEl.createEl("button", { text: "选区加粗（仅事务验证）" });
		button.addEventListener("mousedown", event => event.preventDefault());
		button.addEventListener("click", () => {
			if (view.composing) { status.textContent = "请先完成输入法输入"; return; }
			const transaction = probeWrapSelection(view.state);
			if (transaction !== null) view.dispatch(transaction);
			view.focus();
		});
		updateStatus();
		view.focus();
	}

	onClose(): void {
		this.editor?.destroy();
		this.editor = null;
		this.contentEl.empty();
	}
}

class ProbeCheckbox extends WidgetType {
	toDOM(view: EditorView): HTMLElement {
		const marker = view.dom.ownerDocument.createElement("span");
		marker.textContent = "☐ ";
		marker.setAttribute("aria-hidden", "true");
		marker.addEventListener("pointerdown", event => {
			event.preventDefault();
			view.dispatch({ selection: { anchor: 0 } });
			view.focus();
		});
		return marker;
	}
	ignoreEvent(): boolean { return false; }
}

export default class ComposerProbePlugin extends Plugin {
	private modal: ComposerProbeModal | null = null;
	onload(): void {
		this.addCommand({ id: "open", name: "打开 Composer 内核验证", callback: () => {
			this.modal?.close();
			this.modal = new ComposerProbeModal(this.app);
			this.modal.open();
		} });
	}
	onunload(): void { this.modal?.close(); }
}
