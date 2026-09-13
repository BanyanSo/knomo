import test from "node:test";
import assert from "node:assert/strict";
import { EditorState, Transaction } from "@codemirror/state";
import { undo, redo, undoDepth } from "@codemirror/commands";
import { createProbeState, probeListEnter, probeMarkerHidden, probeWrapSelection } from "../scripts/composer/kernelProbe";

function harness(initial: EditorState) {
	const editor = { state: initial, dispatch: (transaction: Transaction) => { editor.state = transaction.state; } };
	return editor;
}

test("probe transaction undo and redo preserve raw Markdown and reversed selection", () => {
	const doc = "中文正文\nsecond line";
	const editor = harness(createProbeState(doc));
	editor.dispatch(editor.state.update({ selection: { anchor: 4, head: 0 } }));
	const transaction = probeWrapSelection(editor.state);
	assert.ok(transaction);
	editor.dispatch(transaction);
	assert.equal(editor.state.doc.toString(), "**中文正文**\nsecond line");
	assert.equal(editor.state.selection.main.anchor, 6);
	assert.equal(editor.state.selection.main.head, 2);
	assert.equal(undoDepth(editor.state), 1);
	assert.equal(undo(editor), true);
	assert.equal(editor.state.doc.toString(), doc);
	assert.equal(editor.state.selection.main.anchor, 4);
	assert.equal(editor.state.selection.main.head, 0);
	assert.equal(redo(editor), true);
	assert.equal(editor.state.doc.toString(), "**中文正文**\nsecond line");
	assert.equal(editor.state.selection.main.head, 2);
});

test("probe reuses task and list Enter baseline in a single undoable transaction", () => {
	for (const [before, after] of [
		["- item", "- item\n- "], ["2) item", "2) item\n3. "],
		["- [x] 完成", "- [x] 完成\n- [ ] "], ["- ", ""],
	]) {
		const editor = harness(createProbeState(before));
		const transaction = probeListEnter(editor.state);
		assert.ok(transaction, before);
		editor.dispatch(transaction);
		assert.equal(editor.state.doc.toString(), after);
		assert.equal(undo(editor), true);
		assert.equal(editor.state.doc.toString(), before);
	}
});

test("probe marker reveal changes neither raw Markdown nor history", () => {
	const doc = "- [ ] 测试\n后续正文";
	const editor = harness(createProbeState(doc));
	assert.equal(probeMarkerHidden(editor.state), true);
	for (const anchor of [6, 5, 0]) {
		editor.dispatch(editor.state.update({ selection: { anchor } }));
		assert.equal(probeMarkerHidden(editor.state), false);
		assert.equal(editor.state.doc.toString(), doc);
		assert.equal(editor.state.sliceDoc(0, 6), "- [ ] ");
		assert.equal(undoDepth(editor.state), 0);
	}
	editor.dispatch(editor.state.update({ selection: { anchor: 0, head: doc.length } }));
	assert.equal(probeMarkerHidden(editor.state), false);
	assert.equal(editor.state.sliceDoc(editor.state.selection.main.from, editor.state.selection.main.to), doc);
});

test("probe fresh session and no-op have no edit history", () => {
	const editor = harness(createProbeState("plain"));
	assert.equal(probeWrapSelection(editor.state), null);
	assert.equal(probeListEnter(editor.state), null);
	assert.equal(undo(editor), false);
	editor.dispatch(editor.state.update({ changes: { from: 0, insert: "新" } }));
	assert.equal(undoDepth(editor.state), 1);
	editor.state = createProbeState("另一个 Memo");
	assert.equal(undo(editor), false);
});
