import { parseMarkdownReferences } from "./markdownReferences";

interface BlockReferenceCandidate {
	startOffset: number;
	referenceText: string;
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
	let before = content.slice(0, reference.startOffset);
	let after = content.slice(reference.startOffset + reference.referenceText.length);
	// 只移除独占引用行自身的换行或同一行的一个分隔空格，保留正文空白。
	if ((before.length === 0 || before.endsWith("\n")) && (after.length === 0 || after.startsWith("\n") || after.startsWith("\r\n"))) {
		if (after.startsWith("\n")) after = after.slice(1);
		else if (after.startsWith("\r\n")) after = after.slice(2);
		else if (before.endsWith("\n")) before = before.slice(0, before.endsWith("\r\n") ? -2 : -1);
	} else if (before.endsWith(" ") && !/[ \t] $/u.test(before)) {
		before = before.slice(0, -1);
	}
	return `${before}${after}`;
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
	const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})?$/u.exec(createdAt);
	return match === null
		? createdAt
		: `${match[1]}${match[2]}${match[3]}-${match[4]}${match[5]}${match[6] ?? ""}`;
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

function getPreferredReferenceCandidates(content: string): BlockReferenceCandidate[] {
	return parseMarkdownReferences(content.replace(/^\s*>[^\r\n]*/gmu, (value) => value.replace(/[^\r\n]/gu, " ")))
		.filter((link) => link.valid && /#(?:\^|%5[eE])/u.test(link.target))
		.map((link) => ({ startOffset: link.startOffset!, referenceText: link.raw }));
}
