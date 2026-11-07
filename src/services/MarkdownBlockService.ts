import MarkdownIt from "markdown-it";
import { indentMemoContinuationLine, parseMemoMarkdown, splitMarkdownLines } from "../utils/markdown";
import { parseDiaryMemoBlock } from "./DiaryMemoParser";

const tabComparisonMarkdown = new MarkdownIt({ html: true });

// 构造写入 Daily 的 Memo Markdown 块。
export class MarkdownBlockService {
	buildMemoBlock(content: string, time: string): string {
		return this.buildMemoBlockWithBlockId(content, time, null);
	}

	buildMemoBlockWithBlockId(content: string, time: string, blockId: string | null): string {
		const lines = splitMarkdownLines(content);
		const firstLine = lines[0] ?? "";
		const text = lines.join("\n");
		const tree = parseMemoMarkdown(text);
		const firstBlock = tree.topNode.firstChild;
		const leadingBlank = firstLine.trim().length === 0;
		const footnote = /^ {0,3}\[\^[^\]]+\]:/u.test(firstLine);
		const hostBlock = footnote || /^ {0,3}(?:\$\$|%%)/u.test(firstLine);
		let inline = !leadingBlank && !hostBlock && firstBlock?.name === "Paragraph";
		let wide = !inline || (blockId !== null && (lines.length > 1 || firstLine !== firstLine.trimEnd())) || lines.some(line => line.includes("\t"));
		for (let block = firstBlock; block; block = block.nextSibling) {
			if (block.name !== "Paragraph") wide = true;
		}
		const anchorLine = inline ? text.slice(0, firstBlock!.to).split("\n").length - 1 : 0;
		const headerCollision = inline && wide && /^\^[A-Za-z0-9_-]+$/u.test(firstLine) && (blockId === null || anchorLine > 0);
		if (headerCollision) inline = false;
		const indent = wide ? (line: string) => `\t${line}` : indentMemoContinuationLine;
		const id = blockId === null ? "" : ` ^${blockId}`;
		if (inline) {
			if (blockId !== null) {
				// 宿主要求 ID 位于段落末尾，不能仅因 Memo 多行就分离正文或插入空行。
				lines[anchorLine] += id;
			}
			const originalBlock = [`-${wide ? "   " : " "}${time} ${lines[0]}`, ...lines.slice(1).map(indent)].join("\n");
			return wide ? preferTwoColumnBlock(
				[`- ${time} ${lines[0]}`, ...lines.slice(1).map(indentMemoContinuationLine)], text, blockId, originalBlock,
			) : originalBlock;
		}
		const bodyLines = lines.map(indent);
		// 时间段落必须止于时间行；不能接受吞掉前几行后才出现的同类子块。
		const probe = parseMemoMarkdown([`-   ${time}`, ...bodyLines].join("\n"));
		const timeParagraph = probe.topNode.firstChild?.firstChild?.firstChild?.nextSibling;
		const needsSeparator = leadingBlank || footnote || headerCollision || (!hostBlock && firstBlock?.name !== "Paragraph"
			&& (timeParagraph?.name !== "Paragraph" || timeParagraph.to !== 4 + time.length
				|| timeParagraph.nextSibling?.name !== firstBlock?.name));
		const originalBlock = [`-   ${time}${id}`, ...(needsSeparator ? ["\t"] : []), ...bodyLines].join("\n");
		// 必要分隔空行在旧两列读取中属于正文，不能改用空白协议将其与用户空行区分。
		if (needsSeparator && !leadingBlank) return originalBlock;
		// 用户已有前导空行时，它本身足以分隔段落，不再额外添加结构空行。
		return preferTwoColumnBlock([`- ${time}${id}`, ...lines.map(indentMemoContinuationLine)], text, blockId, originalBlock);
	}
}

function preferTwoColumnBlock(lines: string[], content: string, blockId: string | null, originalBlock: string): string {
	const parsed = parseDiaryMemoBlock(lines, 0);
	// 直接复用历史读取规则，不能通过改动旧 ID 归属、吞掉用户空白或子块 ID 来统一前缀。
	if (parsed?.content !== content || parsed.blockId !== blockId || parsed.endLine !== lines.length - 1) return originalBlock;
	const candidate = lines.join("\n");
	if (content.includes("\t")) {
		// Tab 只在结构缩进等上下文按四列停靠；比较实际渲染，同时检查代码的字面空白。
		// 普通文本和围栏中的字面 Tab 不因其字符类型单独退回四列。
		if (tabComparisonMarkdown.render(candidate) !== tabComparisonMarkdown.render(originalBlock)) return originalBlock;
	}
	return candidate;
}
