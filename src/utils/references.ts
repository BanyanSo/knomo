import type { MemoViewItem as MemoRecord } from "../types/memoView";
import { splitMarkdownLines } from "./markdown";

type MemoReferenceView = Pick<MemoRecord, "sourceMemoId" | "references" | "contentSnapshot">;

interface BlockReferenceCandidate {
	sourceMemoIdAlias: string | null;
	quoted: boolean;
	referenceText: string;
}

export function hasMemoReference(memo: MemoReferenceView): boolean {
	return memo.sourceMemoId !== null
		|| memo.references.length > 0
		|| getPreferredReferenceCandidates(memo.contentSnapshot).some((candidate) => candidate.sourceMemoIdAlias !== null);
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
	return content.replace(/\s*!?\[\[[^\]]+#\^[^\]]+\]\]/g, "").trim();
}

export function withCreatedAtAlias(referenceText: string, createdAt: string): string {
	return withReferenceAlias(referenceText, formatCreatedAtAlias(createdAt));
}

export function getPreferredMemoBlockReferenceText(content: string): string | null {
	const candidate = getPreferredReferenceCandidates(content)
		.find((item) => item.sourceMemoIdAlias !== null);
	if (candidate === undefined) {
		return null;
	}
	return candidate.referenceText.startsWith("![[") ? candidate.referenceText.slice(1) : candidate.referenceText;
}

export function formatCreatedAtAlias(createdAt: string): string {
	const match = createdAt.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})?$/u);
	return match === null ? createdAt : `${match[1]}${match[2]}${match[3]}-${match[4]}${match[5]}${match[6]}`;
}

export function withMemoIdAlias(referenceText: string, memoId: string): string {
	return withReferenceAlias(referenceText, formatMemoIdAlias(memoId));
}

function withReferenceAlias(referenceText: string, alias: string): string {
	const normalizedText = referenceText.startsWith("![[") ? referenceText.slice(1) : referenceText;
	if (!normalizedText.startsWith("[[") || !normalizedText.endsWith("]]")) {
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
	const candidates: BlockReferenceCandidate[] = [];
	let codeFence: "`" | "~" | null = null;
	for (const line of splitMarkdownLines(content)) {
		const fence = line.trim().match(/^(`{3,}|~{3,})/)?.[1].charAt(0) as "`" | "~" | undefined;
		if (fence !== undefined) {
			codeFence = codeFence === null ? fence : codeFence === fence ? null : codeFence;
			continue;
		}
		if (codeFence !== null) {
			continue;
		}
		const quoted = /^\s*>/.test(line);
		const referencePattern = /!?\[\[([^\]]+#\^[^\]]+)\]\]/g;
		let match = referencePattern.exec(line);
		while (match !== null) {
			const separatorIndex = match[1].indexOf("|");
			const target = separatorIndex === -1 ? match[1] : match[1].slice(0, separatorIndex);
			const alias = separatorIndex === -1 ? null : match[1].slice(separatorIndex + 1);
			const fragmentIndex = target.lastIndexOf("#^");
			if (fragmentIndex !== -1 && fragmentIndex + 2 < target.length) {
				candidates.push({
					sourceMemoIdAlias: parseMemoIdAlias(alias),
					quoted,
					referenceText: match[0],
				});
			}
			match = referencePattern.exec(line);
		}
	}
	return candidates;
}

function parseMemoIdAlias(alias: string | null): string | null {
	if (alias === null) {
		return null;
	}
	if (/^\d{14}(?:\d{2})?$/.test(alias)) {
		return alias;
	}
	const formatted = alias.match(/^(\d{8})-(\d{6})(?:-(\d{2}))?$/);
	return formatted === null ? null : `${formatted[1]}${formatted[2]}${formatted[3] ?? ""}`;
}
