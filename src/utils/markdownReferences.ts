import type { MemoLinkSyntax } from "../types/memo";

export interface MarkdownReference {
	startOffset?: number;
	raw: string;
	target: string;
	displayText: string | null;
	syntax: MemoLinkSyntax;
	valid: boolean;
}

// 保留原文；仅提取正文链接，代码、注释和图片不构成 Memo backlink。
export function parseMarkdownReferences(content: string): MarkdownReference[] {
	const result: MarkdownReference[] = [];
	let fence: string | null = null;
	let offset = 0;
	for (const line of content.replace(/<!--[\s\S]*?-->/gu, (value) => value.replace(/[^\r\n]/gu, " ")).split(/\n/u)) {
		const lineOffset = offset;
		offset += line.length + 1;
		const marker = /^\s*(`{3,}|~{3,})/u.exec(line)?.[1];
		if (marker !== undefined) { fence = fence === null ? marker[0] : fence === marker[0] ? null : fence; continue; }
		if (fence !== null) continue;
		const text = line.replace(/(`+)[\s\S]*?\1/gu, (value) => " ".repeat(value.length));
		const pattern = /(!?\[\[([^\]]+)\]\])|(!?\[([^\]]*)\]\()/gu;
		let match: RegExpExecArray | null;
		while ((match = pattern.exec(text)) !== null) {
			if (match[1] !== undefined) {
				if (match[1].startsWith("!") && !/#(?:\^|%5[eE])/u.test(match[2])) continue;
				const [target, ...alias] = match[2].split("|");
				result.push({ startOffset: lineOffset + match.index, raw: match[0], target, displayText: alias.length ? alias.join("|") : null, syntax: "wiki_link", valid: target.length > 0 });
				continue;
			}
			let end = pattern.lastIndex;
			let depth = 1;
			let angled = false;
			let quote = "";
			for (; end < text.length; end++) {
				const char = text[end];
				if (char === "\\") { end++; continue; }
				if (quote) { if (char === quote) quote = ""; continue; }
				if ((char === '"' || char === "'") && /\s/u.test(text[end - 1] ?? "")) { quote = char; continue; }
				if (char === "<") angled = true;
				if (char === ">") angled = false;
				if (!angled && char === "(") depth++;
				if (!angled && char === ")" && --depth === 0) break;
			}
			const raw = line.slice(match.index, Math.min(end + 1, line.length));
			const destination = text.slice(pattern.lastIndex, end).trim();
			const targetMatch = /^(?:<([^<>]*)>|((?:\\.|[^\s])+?))(?:\s+(?:"[^"]*"|'[^']*'|\([^)]*\)))?$/u.exec(destination);
			pattern.lastIndex = end + 1;
			if (match[3].startsWith("!")) continue;
			result.push({ startOffset: lineOffset + match.index, raw, target: (targetMatch?.[1] ?? targetMatch?.[2] ?? destination).replace(/\\([\\()[\]<> ])/gu, "$1"),
				displayText: match[4], syntax: "markdown_link", valid: depth === 0 && targetMatch !== null });
		}
	}
	return result;
}
