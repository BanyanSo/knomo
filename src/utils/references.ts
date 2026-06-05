import type { MemoRecord } from "../types/memo";

export function buildMemoReferences(
	content: string,
	sourceMemoId: string | null,
	sourceReferenceText: string | null,
): MemoRecord["references"] {
	if (sourceMemoId === null) {
		return [];
	}
	if (sourceReferenceText !== null) {
		return [{ memoId: sourceMemoId, referenceText: sourceReferenceText }];
	}
	const referenceText = extractFirstBlockReference(content);
	if (referenceText === null) {
		return [];
	}
	return [{ memoId: sourceMemoId, referenceText }];
}

export function buildQuoteCreatedMemoContent(input: string, quoteText: string, referenceText: string): string {
	const prefix = `${quoteText}\n\n`;
	if (input.startsWith(prefix)) {
		const userContent = input.slice(prefix.length).trim();
		if (userContent.length > 0) {
			return `${userContent} ${referenceText}\n${quoteText}`;
		}
		return `${quoteText}\n${referenceText}`;
	}
	return `${input.trimEnd()}${referenceText}`;
}

export function stripTrailingWikiLink(content: string): string {
	return content.replace(/\s*!?\[\[[^\]]+#\^[^\]]+\]\]/g, "").trim();
}

export function withMemoIdAlias(referenceText: string, memoId: string): string {
	const normalizedText = referenceText.startsWith("![[") ? referenceText.slice(1) : referenceText;
	if (!normalizedText.startsWith("[[") || !normalizedText.endsWith("]]")) {
		return referenceText;
	}
	const target = normalizedText.slice(2, -2).split("|")[0];
	return `[[${target}|${formatMemoIdAlias(memoId)}]]`;
}

export function formatMemoIdAlias(memoId: string): string {
	if (!/^\d{16}$/.test(memoId)) {
		return memoId;
	}
	return `${memoId.slice(0, 8)}-${memoId.slice(8, 14)}-${memoId.slice(14)}`;
}

function extractFirstBlockReference(content: string): string | null {
	return content.match(/!?\[\[[^\]]+#\^[^\]]+\]\]/)?.[0] ?? null;
}
