import MarkdownIt from "markdown-it";
import { indentMemoContinuationLine, parseMemoMarkdown, splitMarkdownLines } from "../utils/markdown";
import { parseDiaryMemoBlock } from "./DiaryMemoParser";
import type { MemoBlockAnchor, MemoObservation } from "../types/catalog";
import { collectRelationBlockAnchors, findLeadingParagraphAnchor, findMemoBlockAnchor } from "../utils/memoRelations";
import { KnomoError } from "../types/serviceError";

const tabComparisonMarkdown = new MarkdownIt({ html: true });

export interface MemoBlockSerialization {
	rawBlock: string;
	existingBlockId: string | null;
}

type ImplicitAnchor = Pick<MemoBlockAnchor, "blockId" | "trailingWhitespace"> & { kind: "header" | "paragraph" | "auto" };

export class MemoAnchorPreservationError extends KnomoError {
	constructor() {
		super("memo_anchor_preservation_failed");
		this.name = "MemoAnchorPreservationError";
	}
}

// 构造写入 Daily 的 Memo Markdown 块。
export class MarkdownBlockService {
	buildMemoBlock(content: string, time: string): string {
		return this.buildMemoBlockWithBlockId(content, time, null);
	}

	buildMemoBlockWithBlockId(content: string, time: string, blockId: string | null): string {
		return this.build(content, time, blockId === null ? null : { blockId, kind: "auto", trailingWhitespace: "" });
	}

	serializeObservation(observation: Pick<MemoObservation, "content" | "time" | "existingBlockId" | "blockAnchor">,
		content = observation.content, appendBlockId: string | null = null): MemoBlockSerialization {
		const source = observation.blockAnchor;
		if (appendBlockId !== null && observation.existingBlockId !== null
			|| source === undefined && observation.existingBlockId !== null) throw new MemoAnchorPreservationError();
		const implicit: ImplicitAnchor | null = appendBlockId !== null ? { blockId: appendBlockId, kind: "auto", trailingWhitespace: "" }
			: source?.kind === "header" || source?.kind === "paragraph" ? { ...source, kind: source.kind } : null;
		// 预期候选由用户输入及原锚点用途确定，不能从已接受的输出反填。
		const existingBlockId = implicit?.blockId ?? contentAnchor(content, observation.time)?.blockId ?? null;
		const expectedAnchors = collectRelationBlockAnchors(content);
		if (implicit !== null) {
			if (expectedAnchors[implicit.blockId]) throw new MemoAnchorPreservationError();
			expectedAnchors[implicit.blockId] = 1;
			if (implicit.kind === "paragraph" && !hasInlineParagraph(content)) throw new MemoAnchorPreservationError();
		}
		const rawBlock = this.build(content, observation.time, implicit);
		const lines = rawBlock.split("\n");
		const parsed = parseDiaryMemoBlock(lines, 0);
		if (parsed?.content !== content || parsed.blockId !== existingBlockId || parsed.endLine !== lines.length - 1
			|| implicit !== null && implicit.kind !== "auto" && parsed.blockAnchor?.kind !== implicit.kind
			|| !sameAnchors(collectRelationBlockAnchors(rawBlock), expectedAnchors)) throw new MemoAnchorPreservationError();
		return { rawBlock, existingBlockId };
	}

	private build(content: string, time: string, anchor: ImplicitAnchor | null): string {
		const blockId = anchor?.blockId ?? null;
		const expectedBlockId = blockId ?? contentAnchor(content, time)?.blockId ?? null;
		const lines = splitMarkdownLines(content);
		const firstLine = lines[0] ?? "";
		const text = lines.join("\n");
		const tree = parseMemoMarkdown(text);
		const firstBlock = tree.topNode.firstChild;
		const leadingBlank = firstLine.trim().length === 0;
		const footnote = /^ {0,3}\[\^[^\]]+\]:/u.test(firstLine);
		const hostBlock = footnote || /^ {0,3}(?:\$\$|%%)/u.test(firstLine);
		const inlineParagraph = !leadingBlank && !hostBlock && firstBlock?.name === "Paragraph";
		let inline = inlineParagraph && anchor?.kind !== "header";
		let wide = !inline || lines.some(line => line.includes("\t"));
		for (let block = firstBlock; block; block = block.nextSibling) {
			if (block.name !== "Paragraph") wide = true;
		}
		const anchorLine = inline ? text.slice(0, firstBlock!.to).split("\n").length - 1 : 0;
		const headerCollision = inline && ((anchor === null && findLeadingParagraphAnchor(text) !== null)
			|| /^\^[A-Za-z0-9-]+[\t ]*$/u.test(firstLine) && (blockId === null || anchorLine > 0));
		if (headerCollision) inline = false;
		if (!inline) wide = true;
		const indent = wide ? (line: string) => `\t${line}` : indentMemoContinuationLine;
		const id = blockId === null ? "" : ` ^${blockId}`;
		if (inline) {
			if (blockId !== null) {
				// 宿主要求 ID 位于段落末尾，不能仅因 Memo 多行就分离正文或插入空行。
				const line = lines[anchorLine];
				const suffix = anchor?.trailingWhitespace ?? "";
				const at = suffix.length > 0 && line.endsWith(suffix) ? line.length - suffix.length : line.length;
				lines[anchorLine] = line.slice(0, at) + id + line.slice(at);
			}
			const originalBlock = [`-${wide ? "   " : " "}${time} ${lines[0]}`, ...lines.slice(1).map(indent)].join("\n");
			return wide ? preferTwoColumnBlock(
				[`- ${time} ${lines[0]}`, ...lines.slice(1).map(indentMemoContinuationLine)], text, expectedBlockId, originalBlock,
			) : originalBlock;
		}
		const bodyLines = lines.map(indent);
		// 时间段落必须止于时间行；不能接受吞掉前几行后才出现的同类子块。
		const probe = parseMemoMarkdown([`-   ${time}`, ...bodyLines].join("\n"));
		const timeParagraph = probe.topNode.firstChild?.firstChild?.firstChild?.nextSibling;
		const needsSeparator = leadingBlank || footnote || headerCollision || anchor?.kind === "header" && inlineParagraph
			|| (!hostBlock && firstBlock?.name !== "Paragraph"
			&& (timeParagraph?.name !== "Paragraph" || timeParagraph.to !== 4 + time.length
				|| timeParagraph.nextSibling?.name !== firstBlock?.name));
		const headerSuffix = anchor?.kind === "header" ? anchor.trailingWhitespace : "";
		const originalBlock = [`-   ${time}${id}${headerSuffix}`, ...(needsSeparator ? ["\t"] : []), ...bodyLines].join("\n");
		// 必要分隔空行在旧两列读取中属于正文，不能改用空白协议将其与用户空行区分。
		if (needsSeparator && !leadingBlank) return originalBlock;
		// 用户已有前导空行时，它本身足以分隔段落，不再额外添加结构空行。
		return preferTwoColumnBlock([`- ${time}${id}${headerSuffix}`, ...lines.map(indentMemoContinuationLine)], text, expectedBlockId, originalBlock);
	}
}

function hasInlineParagraph(content: string): boolean {
	return content.split("\n")[0]?.trim().length > 0 && !/^ {0,3}(?:\[\^[^\]]+\]:|\$\$|%%)/u.test(content)
		&& parseMemoMarkdown(content).topNode.firstChild?.name === "Paragraph";
}

function contentAnchor(content: string, time: string): MemoBlockAnchor | null {
	if (!content.includes("^")) return null;
	const lines = splitMarkdownLines(content);
	const inline = hasInlineParagraph(content) && findLeadingParagraphAnchor(content) === null
		&& !/^\^[A-Za-z0-9-]+[\t ]*$/u.test(lines[0]);
	// 此 probe 只决定输入正文中的原生候选，不消费最终序列化结果。
	return findMemoBlockAnchor(inline
		? [`-   ${time} ${lines[0]}`, ...lines.slice(1).map(line => `\t${line}`)].join("\n")
		: [`-   ${time}`, "\t", ...lines.map(line => `\t${line}`)].join("\n"));
}

function sameAnchors(actual: Record<string, number>, expected: Record<string, number>): boolean {
	const keys = Object.keys(actual);
	return keys.length === Object.keys(expected).length && keys.every(id => actual[id] === expected[id]);
}

function preferTwoColumnBlock(lines: string[], content: string, blockId: string | null, originalBlock: string): string {
	const parsed = parseDiaryMemoBlock(lines, 0);
	// 解码、完整范围及锚点必须一致；歧义空白和真实 Tab 差异继续使用安全表示。
	if (parsed?.content !== content || parsed.blockId !== blockId || parsed.endLine !== lines.length - 1) return originalBlock;
	const candidate = lines.join("\n");
	if (content.includes("\t")) {
		// Tab 只在结构缩进等上下文按四列停靠；比较实际渲染，同时检查代码的字面空白。
		// 普通文本和围栏中的字面 Tab 不因其字符类型单独退回四列。
		if (tabComparisonMarkdown.render(candidate) !== tabComparisonMarkdown.render(originalBlock)) return originalBlock;
	}
	return candidate;
}
