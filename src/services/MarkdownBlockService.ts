import { findLastEffectiveLineIndex, indentMemoContinuationLine, splitMarkdownLines } from "../utils/markdown";

// 构造写入 Daily 的 Memo Markdown 块。
export class MarkdownBlockService {
	buildMemoBlock(content: string, time: string): string {
		const lines = splitMarkdownLines(content);
		if (shouldDetachFirstContentLine(lines[0] ?? "")) {
			return [`- ${time}`, ...lines.map((line) => indentMemoContinuationLine(line))].join("\n");
		}
		const firstLine = lines[0] ?? "";
		const blockLines = [`- ${time} ${firstLine}`];
		for (const line of lines.slice(1)) {
			blockLines.push(indentMemoContinuationLine(line));
		}
		return blockLines.join("\n");
	}

	buildMemoBlockWithBlockId(content: string, time: string, blockId: string | null): string {
		const block = this.buildMemoBlock(content, time);
		if (blockId === null) {
			return block;
		}

		const lines = splitMarkdownLines(block);
		const targetLineIndex = findLastEffectiveLineIndex(lines);
		if (targetLineIndex === -1) {
			return block;
		}
		lines[targetLineIndex] = `${lines[targetLineIndex]} ^${blockId}`;
		return lines.join("\n");
	}
}

function shouldDetachFirstContentLine(line: string): boolean {
	return /^(\s*)(?:[-*+]\s+|\d+[.)]\s+)/.test(line);
}
