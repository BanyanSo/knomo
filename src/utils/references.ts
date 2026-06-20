import type { MemoRecord } from "../types/memo";
import { extractTrailingBlockId, findLastEffectiveLineIndex, splitMarkdownLines } from "./markdown";

export type ResolveReferenceLinkPath = (linkPath: string, sourcePath: string) => string | null;

interface BlockReferenceCandidate {
	referenceText: string;
	linkPath: string;
	blockId: string;
	sourceMemoId: string | null;
	quoted: boolean;
}

export function hasMemoReference(memo: MemoRecord): boolean {
	return memo.sourceMemoId !== null
		|| memo.references.length > 0
		|| getPreferredReferenceCandidates(memo.contentSnapshot).some((candidate) => candidate.sourceMemoId !== null);
}

export function recoverMemoReferenceMetadata(
	memos: readonly MemoRecord[],
	resolveLinkPath: ResolveReferenceLinkPath,
): MemoRecord[] {
	const memoIds = new Set(memos.map((memo) => memo.id));
	const sourceMemoIdsByTarget = buildSourceMemoIdsByTarget(memos);
	return memos.map((memo) => recoverMemoReference(memo, memoIds, sourceMemoIdsByTarget, resolveLinkPath));
}

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

function recoverMemoReference(
	memo: MemoRecord,
	memoIds: ReadonlySet<string>,
	sourceMemoIdsByTarget: ReadonlyMap<string, ReadonlySet<string>>,
	resolveLinkPath: ResolveReferenceLinkPath,
): MemoRecord {
	if (memo.sourceMemoId === null && memo.references.length > 0) {
		return { ...memo, sourceMemoId: memo.references[0].memoId };
	}
	if (memo.sourceMemoId !== null && memo.references.length > 0 && memoIds.has(memo.sourceMemoId)) {
		return memo;
	}
	const recovered = resolveReferenceCandidate(memo, sourceMemoIdsByTarget, resolveLinkPath);
	if (recovered === null) {
		return memo;
	}
	if (memo.sourceMemoId !== null && memoIds.has(memo.sourceMemoId) && memo.sourceMemoId !== recovered.sourceMemoId) {
		return memo;
	}
	if (
		memo.sourceMemoId === recovered.sourceMemoId
		&& memo.references.length === 1
		&& memo.references[0].memoId === recovered.sourceMemoId
		&& memo.references[0].referenceText === recovered.referenceText
	) {
		return memo;
	}
	return {
		...memo,
		sourceMemoId: recovered.sourceMemoId,
		references: [{ memoId: recovered.sourceMemoId, referenceText: recovered.referenceText }],
	};
}

function resolveReferenceCandidate(
	memo: MemoRecord,
	sourceMemoIdsByTarget: ReadonlyMap<string, ReadonlySet<string>>,
	resolveLinkPath: ResolveReferenceLinkPath,
): { sourceMemoId: string; referenceText: string } | null {
	const resolved = new Map<string, BlockReferenceCandidate>();
	for (const candidate of getPreferredReferenceCandidates(memo.contentSnapshot)) {
		const resolvedPath = candidate.linkPath.length === 0
			? memo.dailyRef.path
			: resolveLinkPath(candidate.linkPath, memo.dailyRef.path);
		const targetMemoIds = resolvedPath === null
			? undefined
			: sourceMemoIdsByTarget.get(getReferenceTargetKey(resolvedPath, candidate.blockId));
		const targetMemoId = targetMemoIds?.size === 1 ? [...targetMemoIds][0] : null;
		const sourceMemoId = targetMemoId ?? candidate.sourceMemoId;
		if (sourceMemoId !== null && !resolved.has(sourceMemoId)) {
			resolved.set(sourceMemoId, candidate);
		}
	}
	if (resolved.size !== 1) {
		return null;
	}
	const [sourceMemoId, candidate] = [...resolved.entries()][0];
	return { sourceMemoId, referenceText: candidate.referenceText };
}

function buildSourceMemoIdsByTarget(memos: readonly MemoRecord[]): Map<string, Set<string>> {
	const result = new Map<string, Set<string>>();
	for (const memo of memos) {
		const blockId = getMemoBlockId(memo);
		if (blockId === null) {
			continue;
		}
		const key = getReferenceTargetKey(memo.dailyRef.path, blockId);
		const memoIds = result.get(key) ?? new Set<string>();
		memoIds.add(memo.id);
		result.set(key, memoIds);
	}
	return result;
}

function getMemoBlockId(memo: MemoRecord): string | null {
	const lines = splitMarkdownLines(memo.dailyRef.lastKnownBlock);
	const lastLineIndex = findLastEffectiveLineIndex(lines);
	return lastLineIndex === -1 ? null : extractTrailingBlockId(lines[lastLineIndex]).blockId;
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
					referenceText: match[0],
					linkPath: target.slice(0, fragmentIndex),
					blockId: target.slice(fragmentIndex + 2),
					sourceMemoId: parseMemoIdAlias(alias),
					quoted,
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
	if (/^\d{16}$/.test(alias)) {
		return alias;
	}
	const formatted = alias.match(/^(\d{8})-(\d{6})-(\d{2})$/);
	return formatted === null ? null : `${formatted[1]}${formatted[2]}${formatted[3]}`;
}

function getReferenceTargetKey(path: string, blockId: string): string {
	return `${path}#^${blockId}`;
}
