import type { MemoViewItem as MemoRecord } from "../types/memoView";
import { parseMarkdownImages } from "./markdownImages";
import { stripTrailingWikiLink } from "./references";

export interface MemoContentStats {
	chineseCharacterCount: number;
	englishWordCount: number;
	numberCount: number;
	wordCount: number;
}

type MemoContentStatsSource = Pick<MemoRecord, "contentSnapshot" | "references">;

interface MemoContentStatsCacheEntry {
	contentSnapshot: string;
	hasReference: boolean;
	stats: MemoContentStats;
}

const CHINESE_CHARACTER_PATTERN = /\p{Script=Han}/gu;
const ENGLISH_WORD_PATTERN = /\p{Script=Latin}+(?:['’-]\p{Script=Latin}+)*/gu;
const NUMBER_PATTERN = /\p{Number}+/gu;
const INLINE_CODE_PATTERN = /`+[^`\n]*`+/g;
const MARKDOWN_LINK_PATTERN = /\[([^\]]+)\]\([^)]+\)/g;
const WIKI_LINK_PATTERN = /\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g;
const WEB_URL_PATTERN = /\bhttps?:\/\/[^\s<>"'，。！？；：、（）【】《》]+/gi;
const BLOCK_ID_PATTERN = /\^[A-Za-z0-9_-]+\b/g;
const statsCache = new WeakMap<MemoContentStatsSource, MemoContentStatsCacheEntry>();

export function getMemoContentStats(memo: MemoContentStatsSource): MemoContentStats {
	const hasReference = memo.references.length > 0;
	const cached = statsCache.get(memo);
	if (
		cached !== undefined &&
		cached.contentSnapshot === memo.contentSnapshot &&
		cached.hasReference === hasReference
	) {
		return cached.stats;
	}
	const stats = getMemoContentStatsFromContent(memo.contentSnapshot, hasReference);
	statsCache.set(memo, {
		contentSnapshot: memo.contentSnapshot,
		hasReference,
		stats,
	});
	return stats;
}

export function getMemoContentStatsFromContent(contentSnapshot: string, hasReference = false): MemoContentStats {
	const content = hasReference
		? stripTrailingWikiLink(contentSnapshot)
		: contentSnapshot;
	const countableText = getCountableMemoText(content);
	const chineseCharacterCount = (countableText.match(CHINESE_CHARACTER_PATTERN) ?? []).length;
	const englishWordCount = (countableText.match(ENGLISH_WORD_PATTERN) ?? []).length;
	const numberCount = (countableText.match(NUMBER_PATTERN) ?? []).length;
	return {
		chineseCharacterCount,
		englishWordCount,
		numberCount,
		wordCount: chineseCharacterCount + englishWordCount + numberCount,
	};
}

function getCountableMemoText(content: string): string {
	return removeMarkdownImages(removeMarkdownCode(content))
		.replace(MARKDOWN_LINK_PATTERN, "$1")
		.replace(WIKI_LINK_PATTERN, (_match: string, target: string, alias: string | undefined) => alias ?? target)
		.replace(WEB_URL_PATTERN, " ")
		.replace(BLOCK_ID_PATTERN, " ");
}

function removeMarkdownImages(content: string): string {
	const images = parseMarkdownImages(content);
	if (images.length === 0) {
		return content;
	}
	const textParts: string[] = [];
	let textStart = 0;
	for (const image of images) {
		textParts.push(content.slice(textStart, image.start), " ");
		textStart = image.end;
	}
	textParts.push(content.slice(textStart));
	return textParts.join("");
}

function removeMarkdownCode(content: string): string {
	const lines = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
	let fence: { marker: string; length: number } | null = null;
	return lines.map((line) => {
		const fenceMatch = line.match(/^ {0,3}(`{3,}|~{3,})/);
		if (fence === null && fenceMatch !== null) {
			fence = { marker: fenceMatch[1].charAt(0), length: fenceMatch[1].length };
			return "";
		}
		if (fence !== null) {
			const closingPattern = new RegExp(`^ {0,3}${escapeRegExp(fence.marker)}{${fence.length},}\\s*$`);
			if (closingPattern.test(line)) {
				fence = null;
			}
			return "";
		}
		return line.replace(INLINE_CODE_PATTERN, " ");
	}).join("\n");
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
