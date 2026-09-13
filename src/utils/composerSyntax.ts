import { parser } from "@lezer/markdown";

export interface ComposerSyntaxRange {
	kind: "bold" | "highlight" | "link" | "task" | "bullet" | "ordered";
	from: number;
	to: number;
	contentFrom: number;
	contentTo: number;
}
export interface SourceRange { from: number; to: number }

export function scanComposerSyntax(text: string): { ranges: ComposerSyntaxRange[]; protectedRanges: SourceRange[] } {
	const ranges: ComposerSyntaxRange[] = [];
	const protectedRanges: SourceRange[] = [];
	const listMarkers = new Set<number>();
	parser.parse(text).iterate({ enter(node) {
		if (node.name === "ListMark") listMarkers.add(node.from);
		if (["FencedCode", "CodeBlock", "InlineCode", "HTMLBlock", "HTMLTag"].includes(node.name)) {
			protectedRanges.push({ from: node.from, to: node.to });
			return false;
		}
		if (node.name === "StrongEmphasis" && text.slice(node.from, node.from + 2) === "**"
			&& text.slice(node.to - 2, node.to) === "**") {
			ranges.push({ kind: "bold", from: node.from, to: node.to, contentFrom: node.from + 2, contentTo: node.to - 2 });
		}
	} });
	const blocked = (from: number, to: number) => protectedRanges.some(range => from < range.to && to > range.from);
	const escaped = (at: number) => {
		let count = 0;
		while (at > 0 && text[--at] === "\\") count++;
		return count % 2 === 1;
	};
	// 高级链接与 Embed 也作为命令屏障保留，不能被普通链接按钮拆改。
	for (const match of matches(text, /!?\[\[[^\n]*?\]\]/gu)) {
		const from = match.index!;
		const to = from + match[0].length;
		if (escaped(from) || blocked(from, to)) continue;
		const raw = match[0];
		if (!raw.startsWith("!") && /^\[\[[^\[\]|#^\\]+\]\]$/u.test(raw) && raw.slice(2, -2).trim()) {
			ranges.push({ kind: "link", from, to, contentFrom: from + 2, contentTo: to - 2 });
		} else protectedRanges.push({ from, to });
	}
	for (const match of matches(text, /==([^=\n]+)==/gu)) {
		const from = match.index!;
		const to = from + match[0].length;
		if (escaped(from) || escaped(to - 2) || blocked(from, to) || !match[1].trim() || text[from - 1] === "=" || text[to] === "=") continue;
		ranges.push({ kind: "highlight", from, to, contentFrom: from + 2, contentTo: to - 2 });
	}
	for (const match of matches(text, /^[\t ]*(?:[-*+] |\d+[.)] )/gmu)) {
		const from = match.index! + (match[0].match(/^[\t ]*/u)?.[0].length ?? 0);
		if (!listMarkers.has(from)) continue;
		if (blocked(from, from + match[0].trimStart().length)) continue;
		const tail = text.slice(from);
		const task = /^- \[(?: |x)\] /u.exec(tail);
		// 其他 Task 仍可编辑，但不退化为一个普通 bullet 装饰。
		if (!task && /^(?:[-*+] |\d+[.)] )\[[^\]]*\]/u.test(tail)) continue;
		const length = task?.[0].length ?? match[0].trimStart().length;
		const kind = task ? "task" : /^\d/u.test(tail) ? "ordered" : "bullet";
		ranges.push({ kind, from, to: from + length, contentFrom: from + length, contentTo: from + length });
	}
	// 已识别的高级链接、Embed 内部不再显示其他格式；交错范围保留源码。
	const ordered = ranges.filter(range => !protectedRanges.some(block => block.from <= range.from && block.to >= range.to))
		.sort((a, b) => a.from - b.from || b.to - a.to);
	const stack: ComposerSyntaxRange[] = [];
	const crossed = new Set<ComposerSyntaxRange>();
	for (const range of ordered) {
		while (stack.length && stack[stack.length - 1].to <= range.from) stack.pop();
		for (const outer of stack) {
			if (outer.to < range.to) { crossed.add(outer); crossed.add(range); }
		}
		stack.push(range);
	}
	return { ranges: ordered.filter(range => !crossed.has(range)), protectedRanges };
}

export function revealComposerRange(range: ComposerSyntaxRange, selection: readonly SourceRange[]): boolean {
	return selection.some(s => s.from === s.to
		? s.from >= range.from && s.from <= range.to
		: s.from < range.to && s.to > range.from);
}

function matches(text: string, expression: RegExp): RegExpExecArray[] {
	const result: RegExpExecArray[] = [];
	let match: RegExpExecArray | null;
	while ((match = expression.exec(text)) !== null) result.push(match);
	return result;
}
