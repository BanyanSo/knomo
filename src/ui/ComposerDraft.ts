import { buildQuoteCreatedMemoContent } from "../utils/references";

export type ComposerMode = "create" | "edit" | "quote";

export interface ComposerQuoteContext {
	sourceMemoId: string | null;
	referenceText: string | null;
	markdownText: string | null;
}

export interface PreparedComposerCreateInput {
	content: string;
	sourceMemoId: string | null;
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
		sourceMemoId: string | null;
		sourceReferenceText: string | null;
		dailyTrailer: string | null;
	};

export function getComposerMode(editingMemo: object | null, quoteSourceMemoId: string | null): ComposerMode {
	if (editingMemo !== null) {
		return "edit";
	}
	if (quoteSourceMemoId !== null) {
		return "quote";
	}
	return "create";
}

export function getDraftForComposerClose(
	draft: string,
	mode: ComposerMode,
	quoteMarkdownText: string | null,
): string {
	if (mode !== "quote" || quoteMarkdownText === null) {
		return draft;
	}
	const normalizedDraft = draft.replace(/\s+$/g, "");
	const normalizedQuote = quoteMarkdownText.trim();
	if (normalizedDraft === normalizedQuote) {
		return "";
	}
	return draft;
}

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
		quoteContext.sourceMemoId === null ||
		quoteContext.referenceText === null ||
		quoteContext.markdownText === null
	) {
		return {
			content: input,
			sourceMemoId: null,
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
		sourceMemoId: quoteContext.sourceMemoId,
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
		source: createInput.sourceMemoId === null ? "plugin_input" : "quote_create",
		sourceMemoId: createInput.sourceMemoId,
		sourceReferenceText: createInput.sourceReferenceText,
		dailyTrailer: createInput.quoteTrailer,
	};
}
