import { parser, Strikethrough, Table, type InlineParser } from "@lezer/markdown";
import { decodeHTMLStrict } from "entities/decode";
import { normalizeSearchText } from "../utils/searchText";

interface InlineCodeRange { from: number; to: number; valid: boolean }
interface CodeContext { inlineCodes: InlineCodeRange[]; blocks: Array<{ from: number; to: number }> }

function commentInlineParser(isProtected: (pos: number) => boolean = () => false): InlineParser {
	return {
		name: "ObsidianComment",
		parse(context, next, pos) {
			if (next !== 37 || context.char(pos + 1) !== 37 || isProtected(pos)) return -1;
			const rest = context.slice(pos + 2, context.end);
			const close = rest.indexOf("%%");
			if (close < 0 || /[\r\n]/u.test(rest.slice(0, close))) return -1;
			return context.addElement(context.elt("ObsidianComment", pos, pos + close + 4));
		},
	};
}

const inlineSearchMarkdownParser = parser.configure([Table, Strikethrough, {
	defineNodes: ["ObsidianComment"], parseInline: [commentInlineParser()],
}]);

function collectCodeContext(content: string, offset = 0): CodeContext {
	const result: CodeContext = { inlineCodes: [], blocks: [] };
	inlineSearchMarkdownParser.parse(content).iterate({ enter(node) {
		if (/^(?:FencedCode|CodeBlock|HTMLBlock|CommentBlock)$/u.test(node.name)) {
			result.blocks.push({ from: node.from + offset, to: node.to + offset });
			return false;
		}
		if (node.name !== "InlineCode") return;
		result.inlineCodes.push({ from: node.from + offset, to: node.to + offset, valid: true });
		return false;
	} });
	return result;
}

function createSearchMarkdownParser(codeContext: CodeContext = { inlineCodes: [], blocks: [] }, content = "") {
	const { inlineCodes, blocks } = codeContext;
	const isProtected = (pos: number) => inlineCodes.some(range => range.valid && range.from <= pos && pos < range.to);
	const discardCommentCodes = (from: number, to: number) => {
		// 真正注释中的反引号没有代码语义，不能保护闭合标记之后的正文。
		for (const range of inlineCodes) if (range.from >= from && range.from < to) range.valid = false;
		// 注释内部的块结构若跨过真实闭合位置，重新读取受影响的后文代码范围。
		if (blocks.some(range => range.from >= from && range.from < to && range.to > to)) {
			const after = collectCodeContext(content.slice(to), to);
			const firstAfter = inlineCodes.findIndex(range => range.from >= to);
			inlineCodes.splice(firstAfter < 0 ? inlineCodes.length : firstAfter, inlineCodes.length, ...after.inlineCodes);
			const firstBlock = blocks.findIndex(range => range.from >= from);
			blocks.splice(firstBlock < 0 ? blocks.length : firstBlock, blocks.length, ...after.blocks);
		}
	};
	return inlineSearchMarkdownParser.configure({
		parseInline: [commentInlineParser(isProtected)],
		parseBlock: [{
			name: "ObsidianComment",
			after: "IndentedCode",
			endLeaf: (context, line) => line.indent - line.baseIndent < 4 && line.text.startsWith("%%", line.pos)
				&& !isProtected(context.lineStart + line.pos),
			parse(context, line) {
				if (!line.text.startsWith("%%", line.pos) || isProtected(context.lineStart + line.pos)) return false;
				const from = context.lineStart + line.pos;
				let close = line.text.indexOf("%%", line.pos + 2);
				// 单行闭合交给行内解析器；块注释可跨空行，内部 Markdown 不参与解析。
				if (close >= 0) return false;
				while (context.nextLine()) {
					close = line.text.indexOf("%%");
					if (close < 0) continue;
					const to = context.lineStart + close + 2;
					discardCommentCodes(from, to);
					context.addElement(context.elt("ObsidianComment", from, to));
					const tail = line.text.slice(close + 2);
					if (tail.trim()) context.addElement(context.elt("Paragraph", to, to + tail.length, context.parser.parseInline(tail, to)));
					context.nextLine();
					return true;
				}
				discardCommentCodes(from, context.prevLineEnd());
				context.addElement(context.elt("ObsidianComment", from, context.prevLineEnd()));
				return true;
			},
		}],
	});
}

const searchMarkdownParser = createSearchMarkdownParser();

function parseSearchMarkdown(content: string) {
	// 只在百分号与反引号共存时预读代码范围，避免块注释先截断跨行 code span。
	const needsCodeProtection = content.includes("%%") && content.includes("`");
	const codeContext = needsCodeProtection ? collectCodeContext(content) : { inlineCodes: [], blocks: [] };
	const tree = (needsCodeProtection ? createSearchMarkdownParser(codeContext, content) : searchMarkdownParser).parse(content);
	return { tree, inlineCodes: codeContext.inlineCodes };
}

interface Replacement { from: number; to: number; text: string | string[] | null }

function inlineCodeText(raw: string): string {
	const marker = /^\x60+/u.exec(raw)?.[0] ?? "";
	const text = raw.slice(marker.length, -marker.length).replace(/\r?\n/gu, " ");
	return /^ .* $/u.test(text) && /[^ ]/u.test(text) ? text.slice(1, -1) : text;
}

// 直接解析源 Markdown，不启动宿主渲染，也不使用搜索正文反向提取 task/tag/reference。
function extractSearchSegments(content: string): string[] {
	const replacements: Replacement[] = [];
	const protectedRanges: Replacement[] = [];
	const replace = (from: number, to: number, text: Replacement["text"], protectedText = false) => {
		const range = { from, to, text };
		replacements.push(range);
		if (protectedText) protectedRanges.push(range);
	};
	const { tree, inlineCodes } = parseSearchMarkdown(content);
	for (const range of inlineCodes) {
		if (range.valid) replace(range.from, range.to, inlineCodeText(content.slice(range.from, range.to)), true);
	}
	tree.iterate({
		enter(node) {
			const raw = content.slice(node.from, node.to);
			if (node.name === "CommentBlock") {
				const close = raw.indexOf("-->");
				// 块节点可能包含闭合后的同一行正文，递归提取时保留这部分及注释边界。
				replace(node.from, node.to, close < 0 ? null : ["", ...extractSearchSegments(raw.slice(close + 3))], true);
				return false;
			}
			if (node.name === "FencedCode" || node.name === "CodeBlock" || node.name === "Comment" || node.name === "ObsidianComment") {
				replace(node.from, node.to, null, true);
				return false;
			}
			if (node.name === "InlineCode") {
				replace(node.from, node.to, inlineCodeText(raw), true);
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
				replace(node.from, node.to, extractSearchSegments(label), true);
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
		else if (Array.isArray(replacement.text)) {
			text += replacement.text[0] ?? "";
			for (const part of replacement.text.slice(1)) { segments.push(text); text = part; }
		}
		else text += replacement.text;
		offset = replacement.to;
	}
	text += content.slice(offset);
	segments.push(text);
	return segments;
}

export function extractReadableSearchBody(content: string): string[] {
	return extractSearchSegments(content).filter(segment => normalizeSearchText(segment).length > 0);
}

export function buildSearchBody(content: string): string[] {
	return extractReadableSearchBody(content).map(normalizeSearchText);
}
