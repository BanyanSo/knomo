import { parser, Strikethrough, Table } from "@lezer/markdown";
import { decodeHTMLStrict } from "entities/decode";
import { normalizeSearchText } from "../utils/searchText";

const searchMarkdownParser = parser.configure([Table, Strikethrough]);
interface Replacement { from: number; to: number; text: string | null }

// 直接解析源 Markdown，不启动宿主渲染，也不使用搜索正文反向提取 task/tag/reference。
export function extractReadableSearchBody(content: string): string[] {
	const replacements: Replacement[] = [];
	const protectedRanges: Replacement[] = [];
	const replace = (from: number, to: number, text: string | null, protectedText = false) => {
		const range = { from, to, text };
		replacements.push(range);
		if (protectedText) protectedRanges.push(range);
	};
	searchMarkdownParser.parse(content).iterate({
		enter(node) {
			const raw = content.slice(node.from, node.to);
			if (node.name === "FencedCode" || node.name === "Comment") {
				replace(node.from, node.to, null, true);
				return false;
			}
			if (node.name === "InlineCode") {
				const marker = /^\x60+/u.exec(raw)?.[0] ?? "";
				let text = raw.slice(marker.length, -marker.length).replace(/\r?\n/gu, " ");
				if (/^ .* $/u.test(text) && /[^ ]/u.test(text)) text = text.slice(1, -1);
				replace(node.from, node.to, text, true);
				return false;
			}
			const wiki = /^(!?)\[\[([^\]]+)\]\]$/u.exec(raw);
			if ((node.name === "Link" || node.name === "Image") && wiki) {
				const parts = wiki[2].split("|");
				const alias = parts.length > 1 ? parts.slice(1).join("|") : null;
				const text = wiki[1] ? (alias !== null && !/^\d+(?:x\d+)?$/u.test(alias) ? alias : "")
					: alias ?? parts[0];
				replace(node.from, node.to, decodeHTMLStrict(text), true);
				return false;
			}
			if (node.name === "Image") {
				const labelEnd = raw.lastIndexOf("](");
				const label = labelEnd >= 0 ? raw.slice(2, labelEnd) : raw.slice(2, -1);
				replace(node.from, node.to, extractReadableSearchBody(label).join(" "), true);
				return false;
			}
			if (node.name === "Escape") { replace(node.from, node.to, raw.slice(1)); return false; }
			if (node.name === "Entity") { replace(node.from, node.to, decodeHTMLStrict(raw)); return false; }
			if (node.name === "URL" && node.node.parent?.name === "Link") { replace(node.from, node.to, ""); return false; }
			if (/^(?:EmphasisMark|StrikethroughMark|HeaderMark|QuoteMark|ListMark|LinkMark|LinkLabel|HTMLTag|HorizontalRule|LinkReference)$/u.test(node.name)) {
				replace(node.from, node.to, "");
				return false;
			}
			if (node.name === "Paragraph" && node.node.parent?.name === "ListItem") {
				const task = /^\[[ xX-]\][ \t]+/u.exec(raw);
				if (task) replace(node.from, node.from + task[0].length, "");
			}
		},
	});
	// Obsidian 高亮沿用现有成对定界符；代码和已处理链接/图片内不再解释这些符号。
	const protectedSorted = protectedRanges.sort((a, b) => a.from - b.from);
	let protectedIndex = 0;
	const wikiLinks = /!?\[\[([^\]\r\n]+)\]\]/gu;
	let wikiMatch: RegExpExecArray | null;
	let wikiProtectedIndex = 0;
	while ((wikiMatch = wikiLinks.exec(content)) !== null) {
		while (wikiProtectedIndex < protectedSorted.length && protectedSorted[wikiProtectedIndex].to <= wikiMatch.index) wikiProtectedIndex++;
		if (protectedSorted[wikiProtectedIndex]?.from < wikiMatch.index + wikiMatch[0].length) continue;
		let escapes = 0;
		for (let index = wikiMatch.index - 1; index >= 0 && content[index] === "\\"; index--) escapes++;
		if (escapes % 2) continue;
		const parts = wikiMatch[1].split("|");
		replace(wikiMatch.index, wikiMatch.index + wikiMatch[0].length, decodeHTMLStrict(parts.length > 1 ? parts.slice(1).join("|") : parts[0]));
	}
	const highlights = /==([^=\r\n]+)==/gu;
	let match: RegExpExecArray | null;
	while ((match = highlights.exec(content)) !== null) {
		while (protectedIndex < protectedSorted.length && protectedSorted[protectedIndex].to <= match.index) protectedIndex++;
		if (protectedSorted[protectedIndex]?.from < match.index + match[0].length) continue;
		let backslashes = 0;
		for (let index = match.index - 1; index >= 0 && content[index] === "\\"; index--) backslashes++;
		if (backslashes % 2) continue;
		replace(match.index, match.index + 2, "");
		replace(match.index + match[0].length - 2, match.index + match[0].length, "");
	}
	const segments: string[] = [];
	let text = "", offset = 0;
	for (const replacement of replacements.sort((a, b) => a.from - b.from || b.to - a.to)) {
		if (replacement.from < offset) continue;
		text += content.slice(offset, replacement.from);
		if (replacement.text === null) { segments.push(text); text = ""; }
		else text += replacement.text;
		offset = replacement.to;
	}
	text += content.slice(offset);
	segments.push(text);
	return segments.filter(segment => normalizeSearchText(segment).length > 0);
}

export function buildSearchBody(content: string): string[] {
	return extractReadableSearchBody(content).map(normalizeSearchText);
}
