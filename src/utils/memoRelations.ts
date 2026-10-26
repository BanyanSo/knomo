import { decodeHTMLStrict } from "entities/decode";
import { parseSearchMarkdown, extractReadableSearchBody } from "../services/SearchDocument";
import { parseMarkdownReferences } from "./markdownReferences";
import { parseMarkdownImages } from "./markdownImages";

// 仅供关联查询使用；既有引用显示、筛选与统计继续使用原提取规则。
export function relationBody(content: string, excludeQuotes = true): string {
	const ranges: Array<{ from: number; to: number; masked?: string }> = [];
	parseSearchMarkdown(content).tree.iterate({ enter(node) {
		if (node.name === "CommentBlock") {
			const raw = content.slice(node.from, node.to), close = raw.indexOf("-->");
			if (close >= 0) {
				const split = close + 3;
				ranges.push({ from: node.from, to: node.to,
					masked: raw.slice(0, split).replace(/[^\r\n]/gu, " ") + relationBody(raw.slice(split), excludeQuotes) });
				return false;
			}
		}
		if (/^(FencedCode|CodeBlock|InlineCode|Comment|CommentBlock|ObsidianComment|HTMLBlock|Escape)$/u.test(node.name)
			|| excludeQuotes && node.name === "Blockquote") {
			ranges.push({ from: node.from, to: node.to });
			return false;
		}
	} });
	let result = "", start = 0;
	for (const range of ranges) {
		result += content.slice(start, range.from) + (range.masked ?? content.slice(range.from, range.to).replace(/[^\r\n]/gu, " "));
		start = range.to;
	}
	return result + content.slice(start);
}

export function parseMemoRelationTarget(target: string): { path: string; blockId: string } | null {
	try {
		const decoded = decodeURIComponent(decodeHTMLStrict(target));
		if (/^[a-z][\w+.-]*:/iu.test(decoded)) return null;
		const match = /^(.*?)#\^([A-Za-z0-9-]+)$/u.exec(decoded);
		return match ? { path: match[1], blockId: match[2] } : null;
	} catch { return null; }
}

export function extractMemoRelationTargets(content: string): string[] {
	return [...new Set(parseMarkdownReferences(relationBody(content))
		.filter(link => link.valid && parseMemoRelationTarget(link.target) !== null).map(link => link.target))];
}

export function collectRelationBlockAnchors(content: string): Record<string, number> {
	const anchors: Record<string, number> = Object.create(null) as Record<string, number>;
	const pattern = /(?:^|[\t ])\^([A-Za-z0-9-]+)[\t ]*$/gmu;
	const withoutFrontmatter = content.replace(/^---\r?\n[\s\S]*?\r?\n(?:---|\.\.\.)[\t ]*(?:\r?\n|$)/u, value => value.replace(/[^\r\n]/gu, " "));
	const body = relationBody(withoutFrontmatter, false);
	let match: RegExpExecArray | null;
	while ((match = pattern.exec(body)) !== null) {
		anchors[match[1]] = (anchors[match[1]] ?? 0) + 1;
	}
	return anchors;
}

export function memoLevelRelationBlockId(rawBlock: string, blockId: string | null): string | null {
	const body = relationBody(rawBlock);
	const firstLine = body.split("\n", 1)[0];
	const firstId = /(?:^|[\t ])\^([A-Za-z0-9-]+)[\t ]*$/u.exec(firstLine)?.[1];
	if (firstId) return firstId;
	if (!blockId) return null;
	const index = body.lastIndexOf("^" + blockId);
	if (index < 0) return null;
	const tree = parseSearchMarkdown(rawBlock).tree;
	let itemDepth = 0;
	for (let node = tree.resolveInner(index, -1); node; node = node.parent!) {
		if (node.name === "ListItem") itemDepth++;
		if (/^(Blockquote|FencedCode|CodeBlock|InlineCode)$/u.test(node.name)) return null;
	}
	if (itemDepth !== 1) return null;
	const lineStart = body.lastIndexOf("\n", index) + 1;
	if (lineStart === 0) return blockId;
	const before = body.slice(lineStart, index);
	// 独占的 Memo 锚点及第一段续行可定位整条；内部段落、任务和列表不能提升。
	if (/^ {2}\s*$/u.test(before) && body.slice(index).trim() === "^" + blockId) return blockId;
	return !/\n\s*\n/u.test(body.slice(0, index)) && !/^\s*(?:[-*+]|\d+[.)]|>|#)\s/u.test(before) ? blockId : null;
}

export function extractMemoRelationSummary(content: string): { text: string; imageOnly: boolean } {
	let body = relationBody(content);
	const hasImage = parseMarkdownImages(body).some(image => /\.(?:avif|bmp|gif|jpe?g|png|svg|webp)(?:[?#]|$)/iu.test(image.path));
	const refs = parseMarkdownReferences(body);
	for (const link of refs.slice().reverse()) {
		if (link.raw.startsWith("!") || parseMemoRelationTarget(link.target)) {
			const start = link.startOffset!;
			body = body.slice(0, start) + " ".repeat(link.raw.length) + body.slice(start + link.raw.length);
		}
	}
	body = body.replace(/!\[\[[^\]]+\]\]|!\[[^\]]*\]\([^\n]*?\)/gu, " ");
	const text = extractReadableSearchBody(body).join(" ").replace(/\s+/gu, " ").trim();
	return { text, imageOnly: text.length === 0 && hasImage };
}
