import { buildQuoteCreatedMemoContent } from "../utils/references";
import type { ComposerImageLink } from "./ComposerImageState";

export interface ComposerDraftSnapshot {
	content: string;
	referenceText: string | null;
	markdownText: string | null;
	anchor: number;
	head: number;
	scrollTop: number;
	imageLinks?: readonly ComposerImageLink[];
}

export interface ComposerQuoteContext {
	referenceText: string | null;
	markdownText: string | null;
}

export interface PreparedComposerCreateInput {
	content: string;
	sourceReferenceText: string | null;
	quoteTrailer: string | null;
}

export type PreparedComposerSaveInput<TEditingMemo> =
	| { type: "empty" }
	| {
		type: "update";
		previousMemo: TEditingMemo;
		content: string;
	}
	| {
		type: "create";
		content: string;
		source: "plugin_input" | "quote_create";
		sourceReferenceText: string | null;
		dailyTrailer: string | null;
	};

export function formatMarkdownQuoteDraft(content: string): string {
	return content
		.split("\n")
		.map((line) => `> ${line}`)
		.join("\n");
}

export function prepareComposerCreateInput(
	input: string,
	quoteContext: ComposerQuoteContext,
): PreparedComposerCreateInput {
	if (
		quoteContext.referenceText === null ||
		quoteContext.markdownText === null
	) {
		return {
			content: input,
			sourceReferenceText: null,
			quoteTrailer: null,
		};
	}
	return {
		content: buildQuoteCreatedMemoContent(
			`${quoteContext.markdownText}\n\n${input}`,
			quoteContext.markdownText,
			quoteContext.referenceText,
		),
		sourceReferenceText: quoteContext.referenceText,
		quoteTrailer: null,
	};
}

export function prepareComposerSaveInput<TEditingMemo>(
	input: string,
	editingMemo: TEditingMemo | null,
	quoteContext: ComposerQuoteContext,
): PreparedComposerSaveInput<TEditingMemo> {
	if (input.trim().length === 0) {
		return { type: "empty" };
	}
	if (editingMemo !== null) {
		return {
			type: "update",
			previousMemo: editingMemo,
			content: input,
		};
	}
	const createInput = prepareComposerCreateInput(input, quoteContext);
	return {
		type: "create",
		content: createInput.content,
		source: createInput.sourceReferenceText === null ? "plugin_input" : "quote_create",
		sourceReferenceText: createInput.sourceReferenceText,
		dailyTrailer: createInput.quoteTrailer,
	};
}
