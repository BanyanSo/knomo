import { EditorState, Transaction } from "@codemirror/state";
import { history, isolateHistory } from "@codemirror/commands";
import { getListEnterPatch } from "../../src/utils/composerInput";

// 验证面仅使用现有续行规则，不加载默认 Markdown 键位。
export function createProbeState(doc: string, anchor = doc.length): EditorState {
	return EditorState.create({ doc, selection: { anchor }, extensions: [history()] });
}

export function probeListEnter(state: EditorState): Transaction | null {
	const range = state.selection.main;
	const patch = getListEnterPatch(state.doc.toString(), range.from, range.to);
	if (patch === null) return null;
	return state.update({
		changes: { from: 0, to: state.doc.length, insert: patch.value },
		selection: { anchor: patch.cursor },
		annotations: [Transaction.userEvent.of("input"), isolateHistory.of("full")],
	});
}

export function probeWrapSelection(state: EditorState): Transaction | null {
	const range = state.selection.main;
	if (range.empty) return null;
	return state.update({
		changes: [{ from: range.from, insert: "**" }, { from: range.to, insert: "**" }],
		selection: { anchor: range.anchor + 2, head: range.head + 2 },
		annotations: [Transaction.userEvent.of("input"), isolateHistory.of("full")],
	});
}

// 只验证一个确定的首行 marker；这不是正式 Markdown 识别器。
export function probeMarkerHidden(state: EditorState): boolean {
	return state.doc.line(1).text.startsWith("- [ ] ")
		&& state.selection.ranges.every(range => range.from > 6);
}
