import test from "node:test";
import assert from "node:assert/strict";

import {
	formatMarkdownQuoteDraft,
	prepareComposerCreateInput,
	prepareComposerSaveInput,
} from "../src/ui/ComposerDraft";

test("formats referenced memo content as a Markdown quote draft", () => {
	assert.equal(formatMarkdownQuoteDraft("source memo"), "> source memo");
	assert.equal(formatMarkdownQuoteDraft("first\n\nsecond"), "> first\n> \n> second");
});

test("composer create input leaves plain create input unchanged", () => {
	assert.deepEqual(
		prepareComposerCreateInput("plain memo", {
			referenceText: null,
			markdownText: null,
		}),
		{
			content: "plain memo",
			sourceReferenceText: null,
			quoteTrailer: null,
		},
	);
});

test("composer create input builds referenced quote content", () => {
	assert.deepEqual(
		prepareComposerCreateInput("reply memo", {
			referenceText: "[[Daily#^abc]]",
			markdownText: "> source memo",
		}),
		{
			content: "reply memo [[Daily#^abc]]\n> source memo",
			sourceReferenceText: "[[Daily#^abc]]",
			quoteTrailer: null,
		},
	);
});

test("composer save input rejects blank content", () => {
	assert.deepEqual(
		prepareComposerSaveInput(" \n\t", null, {
			referenceText: null,
			markdownText: null,
		}),
		{ type: "empty" },
	);
});

test("composer save input prepares edits without quote context", () => {
	const editingMemo = { id: "memo-1" };

	assert.deepEqual(
		prepareComposerSaveInput("updated memo", editingMemo, {
			referenceText: "[[Daily#^abc]]",
			markdownText: "> source memo",
		}),
		{
			type: "update",
			previousMemo: editingMemo,
			content: "updated memo",
		},
	);
});

test("composer save input prepares plain creates", () => {
	assert.deepEqual(
		prepareComposerSaveInput("plain memo", null, {
			referenceText: null,
			markdownText: null,
		}),
		{
			type: "create",
			content: "plain memo",
			source: "plugin_input",
			sourceReferenceText: null,
			dailyTrailer: null,
		},
	);
});

test("quote create preserves the explicit block reference when identity is absent", () => {
	assert.deepEqual(
		prepareComposerSaveInput("reply memo", null, {
			referenceText: "[[Daily#^abc]]",
			markdownText: "> source memo",
		}),
		{
			type: "create",
			content: "reply memo [[Daily#^abc]]\n> source memo",
			source: "quote_create",
			sourceReferenceText: "[[Daily#^abc]]",
			dailyTrailer: null,
		},
	);
});
