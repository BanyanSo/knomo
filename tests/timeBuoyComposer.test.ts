import test from "node:test";
import assert from "node:assert/strict";

import {
	alreadyHasTimeBuoyDate,
	getTimeBuoyTriggerStartAfterComposition,
	getTimeBuoyTriggerStartForDirectInput,
	insertTimeBuoyDateAtSelection,
	replaceTimeBuoyTrigger,
} from "../src/utils/timeBuoyComposer";

test("opens only for a direct legal at-sign text input", () => {
	const direct = (value: string, inputType: string, data: string | null, cursor: number, isComposing = false) => (
		getTimeBuoyTriggerStartForDirectInput(value, {
			inputType,
			data,
			isComposing,
			selectionStart: cursor,
			selectionEnd: cursor,
		})
	);
	assert.equal(direct("回看 @", "insertText", "@", 4), 3);
	assert.equal(direct("回看 ＠", "insertText", "＠", 4), 3);
	assert.equal(direct("user@", "insertText", "@", 5), null);
	assert.equal(direct("回看 @", "insertFromPaste", "@", 4), null);
	assert.equal(direct("回看 @", "insertFromDrop", "@", 4), null);
	assert.equal(direct("回看 @", "historyUndo", null, 4), null);
	assert.equal(direct("回看 @", "insertText", "@", 4, true), null);
});

test("fullwidth composition opens only after the committed character is present", () => {
	assert.equal(getTimeBuoyTriggerStartAfterComposition("回看 ＠", 4, 4, "＠"), 3);
	assert.equal(getTimeBuoyTriggerStartAfterComposition("回看 ＠", 4, 4, "回看"), null);
	assert.equal(getTimeBuoyTriggerStartAfterComposition("`＠`", 2, 2, "＠"), null);
});

test("inserts a standard date token at the selection end with token boundaries", () => {
	assert.deepEqual(insertTimeBuoyDateAtSelection("回看反馈", 4, "2026-07-20"), {
		value: "回看反馈 @2026-07-20 ",
		cursor: 17,
	});
	assert.deepEqual(insertTimeBuoyDateAtSelection("回看反馈。", 4, "2026-07-20"), {
		value: "回看反馈 @2026-07-20。",
		cursor: 16,
	});
	assert.deepEqual(insertTimeBuoyDateAtSelection("回看反馈", 2, "2026-07-20"), {
		value: "回看 @2026-07-20 反馈",
		cursor: 15,
	});
});

test("replaces only a valid halfwidth or fullwidth at trigger", () => {
	assert.deepEqual(replaceTimeBuoyTrigger("回看 @", 3, 4, "2026-07-20"), {
		value: "回看 @2026-07-20 ",
		cursor: 15,
	});
	assert.deepEqual(replaceTimeBuoyTrigger("回看 ＠", 3, 4, "2026-07-20"), {
		value: "回看 @2026-07-20 ",
		cursor: 15,
	});
	assert.deepEqual(replaceTimeBuoyTrigger("回看 @ 继续", 3, 4, "2026-07-20"), {
		value: "回看 @2026-07-20 继续",
		cursor: 15,
	});
	assert.equal(replaceTimeBuoyTrigger("回看 X", 3, 4, "2026-07-20"), null);
});

test("duplicate detection uses the same Markdown exclusions as indexing", () => {
	assert.equal(alreadyHasTimeBuoyDate("正文 @2026-07-20", "2026-07-20"), true);
	assert.equal(alreadyHasTimeBuoyDate("`@2026-07-20`", "2026-07-20"), false);
});
