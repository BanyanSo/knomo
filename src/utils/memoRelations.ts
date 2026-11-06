import { decodeHTMLStrict } from "entities";
import { parseSearchMarkdown, extractReadableSearchBody } from "../services/SearchDocument";
import { parseMarkdownReferences } from "./markdownReferences";
import { parseMarkdownImages } from "./markdownImages";
import type { MemoLinkSyntax } from "../types/memo";
import type { MemoRelationTarget } from "../types/memoRelations";

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

export function parseMemoRelationTarget(target: string, syntax: MemoLinkSyntax): MemoRelationTarget | null {
	try {
		// WikiLink 是原始文件路径；仅 Markdown URL 解码，派生索引保存解析结果。
		const decoded = syntax === "wiki_link" ? target : decodeURIComponent(decodeHTMLStrict(target));
		if (/^[a-z][\w+.-]*:/iu.test(decoded)) return null;
		const match = /^(.*?)#\^([A-Za-z0-9-]+)$/u.exec(decoded);
		return match ? { path: match[1], blockId: match[2] } : null;
	} catch { return null; }
}

export function extractMemoRelationTargets(content: string): MemoRelationTarget[] {
	const targets = new Map<string, MemoRelationTarget>();
	for (const link of parseMarkdownReferences(relationBody(content))) {
		const target = link.valid ? parseMemoRelationTarget(link.target, link.syntax) : null;
		if (target) targets.set(JSON.stringify([target.path, target.blockId]), target);
	}
	return [...targets.values()];
}

export function collectRelationBlockAnchors(content: string): Record<string, number> {
	const anchors: Record<string, number> = Object.create(null) as Record<string, number>;
	const pattern = /(?:^|[\t ])\^([A-Za-z0-9-]+)[\t ]*$/gmu;
	const withoutFrontmatter = content.replace(/^---\r?\n[\s\S]*?\r?\n(?:---|\.\.\.)[\t ]*(?:\r?\n|$)/u, value => value.replace(/[^\r\n]/gu, " "));
	const body = relationBody(withoutFrontmatter, false);
	let match: RegExpExecArray | null;
	while ((match = pattern.exec(withoutFrontmatter)) !== null) {
		const index = match.index + match[0].indexOf("^");
		// 遮罩只判断可见性；不能把代码或注释前的 ID 变成原文行尾锚点。
		if (body.slice(index, index + match[1].length + 1) !== "^" + match[1]) continue;
		anchors[match[1]] = (anchors[match[1]] ?? 0) + 1;
	}
	return anchors;
}

export function memoLevelRelationBlockId(rawBlock: string): string | null {
	if (!rawBlock.includes("^")) return null;
	const body = relationBody(rawBlock);
	const tree = parseSearchMarkdown(rawBlock).tree;
	const item = tree.topNode.firstChild?.firstChild;
	const first = item?.firstChild?.nextSibling;
	if (item?.name !== "ListItem" || first?.name !== "Paragraph") return null;
	const hostBlockPattern = /(?:^|\n)[\t ]*(?:\$\$|\[\^[^\]]+\]:)/u;
	const atParagraphEnd = (from: number, to: number): string | null => {
		const paragraph = rawBlock.slice(from, to);
		// 通用语法树不识别宿主公式块和脚注定义，不能将其中的文字锚点提升。
		if (hostBlockPattern.test(paragraph)) return null;
		const match = /(?:^|[\t ])\^([A-Za-z0-9-]+)[\t ]*$/u.exec(paragraph);
		if (!match) return null;
		const index = from + match.index + match[0].indexOf("^");
		return body.slice(index, index + match[1].length + 1) === "^" + match[1] ? match[1] : null;
	};
	// 首段续行末尾的 ID 优先，不能被解析器提取到的末个子块 ID 遮蔽。
	// 宿主公式和脚注会结束普通段落，保留这些结构之前正常写入的 Memo 级锚点。
	const hostBlock = hostBlockPattern.exec(rawBlock.slice(first.from, first.to));
	const firstId = atParagraphEnd(first.from, hostBlock ? first.from + hostBlock.index : first.to);
	if (firstId) return firstId;
	const tail = rawBlock.trimEnd();
	const match = /(?:^|[\t ])\^([A-Za-z0-9-]+)$/u.exec(tail);
	if (!match) return null;
	const index = match.index + match[0].indexOf("^");
	const last = tree.resolveInner(index, 1);
	if (last.name !== "Paragraph" || last.parent?.name !== "ListItem"
		|| last.from < item.from || last.to > item.to || rawBlock.slice(last.to).trim() !== "") return null;
	// 兼容旧版末行写法：末段或末个列表项的引用归到所属 Memo，原生链接目标不变。
	// 首段锚点仍优先；非末行子块以及代码、引用块、表格中的文字不提升。
	return atParagraphEnd(last.from, last.to);
}

export function extractMemoRelationSummary(content: string): { text: string; imageOnly: boolean } {
	let body = relationBody(content);
	const hasImage = parseMarkdownImages(body).some(image => /\.(?:avif|bmp|gif|jpe?g|png|svg|webp)(?:[?#]|$)/iu.test(image.path));
	const refs = parseMarkdownReferences(body);
	for (const link of refs.slice().reverse()) {
		if (link.raw.startsWith("!") || parseMemoRelationTarget(link.target, link.syntax)) {
			const start = link.startOffset!;
			body = body.slice(0, start) + " ".repeat(link.raw.length) + body.slice(start + link.raw.length);
		}
	}
	body = body.replace(/!\[\[[^\]]+\]\]|!\[[^\]]*\]\([^\n]*?\)/gu, " ");
	const text = extractReadableSearchBody(body).join(" ").replace(/\s+/gu, " ").trim();
	return { text, imageOnly: text.length === 0 && hasImage };
}
