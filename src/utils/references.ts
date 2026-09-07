import type { MemoViewItem as MemoRecord } from "../types/memoView";
import { parseMarkdownReferences } from "./markdownReferences";

type MemoReferenceView = Pick<MemoRecord, "sourceMemoId" | "references" | "contentSnapshot">;

interface BlockReferenceCandidate {
	startOffset: number;
	quoted: boolean;
	referenceText: string;
}

export function hasMemoReference(memo: MemoReferenceView): boolean {
	return getPreferredReferenceCandidates(memo.contentSnapshot).length > 0;
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
	return `${input.replace(/\s+$/, "")}${referenceText}`;
}

export function stripTrailingWikiLink(content: string): string {
	const reference = getPreferredReferenceCandidates(content)[0];
	if (reference === undefined) return content;
	return `${content.slice(0, reference.startOffset).trimEnd()}${content.slice(reference.startOffset + reference.referenceText.length)}`.trim();
}

export function withCreatedAtAlias(referenceText: string, createdAt: string): string {
	return withReferenceAlias(referenceText, formatCreatedAtAlias(createdAt));
}

export function getPreferredMemoBlockReferenceText(content: string): string | null {
	const candidate = getPreferredReferenceCandidates(content)[0];
	if (candidate === undefined) {
		return null;
	}
	return candidate.referenceText.startsWith("![[") ? candidate.referenceText.slice(1) : candidate.referenceText;
}

export function formatCreatedAtAlias(createdAt: string): string {
	const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}(?::\d{2})?)(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})?$/u.exec(createdAt);
	return match === null ? createdAt : `${match[1]} ${match[2]}`;
}

export function withMemoIdAlias(referenceText: string, memoId: string): string {
	return withReferenceAlias(referenceText, formatMemoIdAlias(memoId));
}

function withReferenceAlias(referenceText: string, alias: string): string {
	const normalizedText = referenceText.startsWith("![[") ? referenceText.slice(1) : referenceText;
	if (!normalizedText.startsWith("[[") || !normalizedText.endsWith("]]")) {
		const link = parseMarkdownReferences(referenceText)[0];
		if (link?.valid && link.syntax === "markdown_link" && link.raw === referenceText) {
			return `[${alias}]${referenceText.slice(referenceText.indexOf("](") + 1)}`;
		}
		return referenceText;
	}
	const target = normalizedText.slice(2, -2).split("|")[0];
	return `[[${target}|${alias}]]`;
}

export function formatMemoIdAlias(memoId: string): string {
	if (!/^\d{16}$/.test(memoId)) {
		return memoId;
	}
	return `${memoId.slice(0, 8)}-${memoId.slice(8, 14)}`;
}

function getPreferredReferenceCandidates(content: string): BlockReferenceCandidate[] {
	return parseBlockReferenceCandidates(content).filter((candidate) => !candidate.quoted);
}

function parseBlockReferenceCandidates(content: string): BlockReferenceCandidate[] {
	return parseMarkdownReferences(content.replace(/^\s*>[^\r\n]*/gmu, (value) => value.replace(/[^\r\n]/gu, " ")))
		.filter((link) => link.valid && /#(?:\^|%5[eE])/u.test(link.target))
		.map((link) => ({ startOffset: link.startOffset!, quoted: false, referenceText: link.raw }));
}
