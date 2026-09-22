import { parser, Strikethrough, Table } from "@lezer/markdown";
import type { Tree, TreeFragment } from "@lezer/common";
import { memoTagRanges, memoUrlRanges } from "./markdown";

export interface SourceRange { from: number; to: number }
export interface ComposerSyntaxRange extends SourceRange {
	kind: "bold" | "italic" | "strike" | "code" | "highlight" | "link" | "markdown-link" | "url" | "tag" | "task" | "bullet" | "ordered";
	contentFrom: number;
	contentTo: number;
	markers: SourceRange[];
	separators: SourceRange[];
	parent: number;
	target?: SourceRange;
	escapes?: SourceRange[];
	list?: { container: number; item: SourceRange; content: SourceRange; depth: number; source: string; display: number };
	task?: { from: number; state: string };
}
export interface ComposerContext extends SourceRange { type: string; parent: number; sourceFirst: boolean }
export interface ComposerSyntax {
	tree: Tree;
	ranges: ComposerSyntaxRange[];
	contexts: ComposerContext[];
	sourceRanges: SourceRange[];
	// 命令屏障独立于显示支持：可显示链接仍不可被格式按钮拆改。
	protectedRanges: SourceRange[];
	proseLines: SourceRange[];
}
export const composerParser = parser.configure([Table, Strikethrough]);
const overlaps = (a: SourceRange, b: SourceRange) => a.from < b.to && a.to > b.from;
const contains = (a: SourceRange, b: SourceRange) => a.from <= b.from && a.to >= b.to;
const sourceTypes = /^(?:ATXHeading\d|SetextHeading\d|Blockquote|FencedCode|CodeBlock|HTMLBlock|HTMLTag|Table|LinkReference|Image|Autolink|HorizontalRule)$/u;

// 合并隔离区后做二分查找，避免长 Memo 每个 token/行都扫描全文区间。
function rangeLookup(ranges: readonly SourceRange[]): (range: SourceRange) => boolean {
	const merged: SourceRange[] = [];
	for (const range of [...ranges].sort((a, b) => a.from - b.from || b.to - a.to)) {
		const last = merged[merged.length - 1];
		if (last && range.from <= last.to) last.to = Math.max(last.to, range.to);
		else merged.push({ from: range.from, to: range.to });
	}
	return range => {
		let low = 0, high = merged.length;
		while (low < high) { const mid = (low + high) >>> 1; if (merged[mid].to <= range.from) low = mid + 1; else high = mid; }
		return low < merged.length && overlaps(merged[low], range);
	};
}

export function scanComposerSyntax(text: string, fragments: readonly TreeFragment[] = []): ComposerSyntax {
	const contexts: ComposerContext[] = [];
	const sourceRanges: SourceRange[] = [];
	const protectedRanges: SourceRange[] = [];
	const candidates: ComposerSyntaxRange[] = [];
	const stack: number[] = [];
	const tree = composerParser.parse(text, fragments);
	tree.iterate({
		enter(node) {
			const parent = stack[stack.length - 1] ?? -1;
			const sourceFirst = sourceTypes.test(node.name) || (parent >= 0 && contexts[parent].sourceFirst);
			if (sourceFirst && (parent < 0 || !contexts[parent].sourceFirst)) sourceRanges.push({ from: node.from, to: node.to });
			stack.push(contexts.length);
			contexts.push({ type: node.name, from: node.from, to: node.to, parent, sourceFirst });
		},
		leave() { stack.pop(); },
	});
	const escaped = (at: number) => {
		let count = 0;
		while (at > 0 && text[--at] === "\\") count++;
		return count % 2 === 1;
	};
	const contextAt = (range: SourceRange) => {
		let low = 0, high = contexts.length;
		while (low < high) { const mid = (low + high) >>> 1; if (contexts[mid].from <= range.from) low = mid + 1; else high = mid; }
		let parent = Math.max(0, low - 1);
		while (parent > 0 && !contains(contexts[parent], range)) parent = contexts[parent].parent;
		return parent;
	};
	const inlineEnd = (from: number, to: number) => {
		let parent = contextAt({ from, to: from + 1 });
		while (parent > 0) {
			const node = contexts[parent];
			if (["StrongEmphasis", "Emphasis", "Strikethrough"].includes(node.type)) {
				const ids = children.get(parent) ?? [];
				const closing = contexts[ids[ids.length - 1]];
				if (closing) return Math.min(to, closing.from);
			}
			parent = node.parent;
		}
		return to;
	};
	const add = (kind: ComposerSyntaxRange["kind"], from: number, to: number, contentFrom: number, contentTo: number, parent: number) => {
		const range: ComposerSyntaxRange = { kind, from, to, contentFrom, contentTo, parent,
			markers: [{ from, to: contentFrom }, { from: contentTo, to }].filter(r => r.from < r.to), separators: [] };
		candidates.push(range);
		return range;
	};
	const children = new Map<number, number[]>();
	contexts.forEach((node, i) => { const items = children.get(node.parent) ?? []; items.push(i); children.set(node.parent, items); });
	// 脚注不属于 CommonMark 的完整块语法；将已知定义及续行统一隔离。
	for (const node of contexts) {
		if (node.type !== "LinkReference" || !text.slice(node.from, node.to).startsWith("[^")) continue;
		let item = node.parent;
		while (item >= 0 && contexts[item].type !== "ListItem") item = contexts[item].parent;
		if (item >= 0) { sourceRanges.push(contexts[item]); continue; }
		let to = node.to;
		let afterBlank = false;
		while (to < text.length) {
			const next = text.indexOf("\n", to);
			if (next < 0) break;
			const end = text.indexOf("\n", next + 1);
			const lineEnd = end < 0 ? text.length : end;
			const line = text.slice(next + 1, lineEnd);
			if (afterBlank && line.trim() && !/^(?: {4}|\t)/u.test(line)) break;
			if (!line.trim()) afterBlank = true;
			to = lineEnd;
		}
		sourceRanges.push({ from: node.from, to });
	}
	const listNumbers = new Map<number, number>();
	const taskPrefixes: SourceRange[] = [];
	for (let i = 0; i < contexts.length; i++) {
		const node = contexts[i];
		if (node.sourceFirst) continue;
		const parts = (children.get(i) ?? []).map(id => contexts[id]);
		if (node.type === "ListItem") {
			const marker = parts.find(p => p.type === "ListMark");
			if (!marker) continue;
			const source = text.slice(marker.from, marker.to);
			const ordered = contexts[node.parent].type === "OrderedList";
			const display = listNumbers.get(node.parent) ?? (ordered ? parseInt(source, 10) : 0);
			listNumbers.set(node.parent, display + 1);
			const separator = /^[\t ]*/u.exec(text.slice(marker.to))![0];
			const start = marker.to + separator.length;
			const task = /^\[([^\]\r\n]*)\](?=[\t \r\n]|$)/u.exec(text.slice(start));
			if (task && !/^[ xX]$/u.test(task[1])) { sourceRanges.push(node); continue; }
			const taskEnd = task ? start + task[0].length : start;
			const end = taskEnd + (task ? /^[\t ]*/u.exec(text.slice(taskEnd))![0].length : 0);
			const range = add(task ? "task" : ordered ? "ordered" : "bullet", marker.from, end, end, end, i);
			range.markers = [{ from: marker.from, to: marker.to }];
			range.separators = [{ from: marker.to, to: start }];
			let depth = 0;
			for (let p = node.parent; p >= 0; p = contexts[p].parent) if (/^(Bullet|Ordered)List$/u.test(contexts[p].type)) depth++;
			range.list = { container: node.parent, item: { from: node.from, to: node.to }, content: { from: end, to: node.to }, depth, source, display };
			if (task) {
				range.markers.push({ from: start, to: taskEnd });
				range.separators.push({ from: taskEnd, to: end });
				range.task = { from: start + 1, state: task[1] };
				taskPrefixes.push({ from: start, to: taskEnd });
			}
		} else if (["StrongEmphasis", "Emphasis", "Strikethrough", "InlineCode"].includes(node.type)) {
			const marks = parts.filter(p => /Mark$/u.test(p.type));
			if (marks.length < 2) continue;
			const kind = node.type === "StrongEmphasis" ? "bold" : node.type === "Emphasis" ? "italic" : node.type === "Strikethrough" ? "strike" : "code";
			add(kind, node.from, node.to, marks[0].to, marks[marks.length - 1].from, i);
			if (kind === "code") protectedRanges.push(node);
		}
	}
	// Obsidian 扩展在同一上下文中识别；代码/HTML 内的符号不是扩展入口。
	const codeRanges = contexts.filter(n => /^(InlineCode|FencedCode|CodeBlock|HTMLBlock|HTMLTag)$/u.test(n.type));
	const originalBlocked = rangeLookup([...sourceRanges, ...codeRanges]);
	const extensionSources: SourceRange[] = [];
	const blocked = (range: SourceRange) => originalBlocked(range) || extensionSources.some(r => overlaps(r, range));
	const linkContexts = rangeLookup(contexts.filter(n => n.type === "Link"));
	for (const match of matches(text, /%%|\$\$|\$(?![\s$])/gu)) {
		const from = match.index;
		if (escaped(from) || blocked({ from, to: from + match[0].length }) || linkContexts({ from, to: from + match[0].length })) continue;
		const delimiter = match[0];
		let end = text.indexOf(delimiter, from + delimiter.length);
		while (end >= 0 && escaped(end)) end = text.indexOf(delimiter, end + delimiter.length);
		const paragraph = contexts.find(n => n.type === "Paragraph" && n.from <= from && n.to >= from);
		if (delimiter === "$" && (end < 0 || text.slice(from, end).includes("\n"))) end = -1;
		const to = end >= 0 ? end + delimiter.length : delimiter === "$" ? paragraph?.to ?? text.length : text.length;
		extensionSources.push({ from: end < 0 && delimiter === "$" ? paragraph?.from ?? from : from, to });
	}
	const links: SourceRange[] = [];
	let wikiUntil = -1;
	for (const match of matches(text, /!?\[\[/gu)) {
		const from = match.index;
		if (escaped(from) || blocked({ from, to: from + match[0].length }) || from < wikiUntil) continue;
		const close = text.indexOf("]]", from + match[0].length);
		const lineEnd = text.indexOf("\n", from);
		if (close < 0 || lineEnd >= 0 && close > lineEnd) {
			const parent = contexts.find(n => n.type === "Paragraph" && n.from <= from && n.to > from);
			extensionSources.push(parent ?? { from, to: lineEnd < 0 ? text.length : lineEnd });
			continue;
		}
		const to = close + 2;
		wikiUntil = to;
		const raw = text.slice(from + match[0].length, close);
		const pipe = raw.indexOf("|");
		links.push({ from, to });
		if (match[0].startsWith("!") || !raw.trim() || /[[\]\\]/u.test(raw)
			|| pipe >= 0 && (!raw.slice(0, pipe).trim() || !raw.slice(pipe + 1).trim() || raw.indexOf("|", pipe + 1) >= 0)) {
			extensionSources.push({ from, to }); continue;
		}
		const link = add("link", from, to, pipe < 0 ? from + 2 : from + 3 + pipe, close, contextAt({ from, to }));
		link.markers = [{ from, to: from + 2 }, { from: close, to }];
		link.target = { from: from + 2, to: pipe < 0 ? close : from + 2 + pipe };
		if (pipe >= 0) link.separators = [{ from: from + 2 + pipe, to: from + 3 + pipe }];
		if (pipe >= 0 || /[#^]/u.test(raw)) protectedRanges.push({ from, to });
	}
	// Wiki alias 是字面文本；内部形似 HTML 的字符不是另一个语法节点。
	const wikiLabels = rangeLookup(candidates.filter(r => r.kind === "link").map(r => ({ from: r.contentFrom, to: r.contentTo })));
	const htmlTags = contexts.filter(n => n.type === "HTMLTag" && !wikiLabels(n));
	for (let i = sourceRanges.length - 1; i >= 0; i--) {
		const source = sourceRanges[i];
		if (contexts.some(n => n.type === "HTMLTag" && n.from === source.from && n.to === source.to)
			&& candidates.some(r => r.kind === "link" && r.contentFrom <= source.from && r.contentTo >= source.to)) sourceRanges.splice(i, 1);
	}
	for (let i = 0; i < htmlTags.length; i++) {
		const node = htmlTags[i];
		const opening = /^<([A-Za-z][\w-]*)(?:\s[^>]*)?>$/u.exec(text.slice(node.from, node.to));
		if (!opening || /^(?:br|hr|img|input|wbr|meta|link)$/iu.test(opening[1])) continue;
		let depth = 1, end = -1;
		for (let j = i + 1; j < htmlTags.length; j++) {
			const raw = text.slice(htmlTags[j].from, htmlTags[j].to);
			if (new RegExp(`^<${opening[1]}(?:\\s[^>]*)?>$`, "iu").test(raw)) depth++;
			if (new RegExp(`^<\\/${opening[1]}\\s*>$`, "iu").test(raw) && --depth === 0) { end = htmlTags[j].to; break; }
		}
		const paragraph = contexts.find(n => n.type === "Paragraph" && contains(n, node));
		extensionSources.push(end >= 0 ? { from: node.from, to: end } : paragraph ?? node);
	}
	const wikiBlocked = rangeLookup(links);
	const taskBlocked = rangeLookup(taskPrefixes);
	for (let i = 0; i < contexts.length; i++) {
		const node = contexts[i];
		if (node.type !== "Link" || blocked(node) || wikiBlocked(node) || taskBlocked(node)) continue;
		const parts = (children.get(i) ?? []).map(id => contexts[id]);
		const url = parts.find(p => p.type === "URL");
		const marks = parts.filter(p => p.type === "LinkMark");
		const raw = text.slice(node.from, node.to);
		if (url && marks.length === 4 && marks[0].to < marks[1].from && !/[\r\n]/u.test(raw) && !parts.some(p => !["LinkMark", "URL", "Escape"].includes(p.type))) {
			const link = add("markdown-link", node.from, node.to, marks[0].to, marks[1].from, i);
			link.markers = marks.map(p => ({ from: p.from, to: p.to }));
			link.target = { from: url.from, to: url.to };
			link.escapes = parts.filter(p => p.type === "Escape" && p.from < link.contentTo).map(p => ({ from: p.from, to: p.from + 1 }));
		} else {
			// 已有 label 后的未闭合 target 边界不可靠，保护整个所在段落。
			const paragraph = text[node.to] === "(" ? contexts.find(n => n.type === "Paragraph" && contains(n, node)) : null;
			extensionSources.push(paragraph ?? node);
		}
		protectedRanges.push(node);
		links.push(node);
	}
	sourceRanges.push(...extensionSources);
	const sourceBlocked = rangeLookup(sourceRanges);
	const linksBlocked = rangeLookup(links);
	// 裸 URL 优先于 inline 扩展，不能把 URL target 内的符号再解释为格式。
	const urls = memoUrlRanges(text).map(r => ({ from: r.from, to: inlineEnd(r.from, r.to) }))
		.filter(r => !escaped(r.from) && !originalBlocked(r) && !sourceBlocked(r) && !linksBlocked(r));
	const urlsBlocked = rangeLookup(urls);
	for (const url of urls) { add("url", url.from, url.to, url.from, url.to, contextAt(url)); protectedRanges.push(url); }
	for (const match of matches(text, /==([^=\n]+)==/gu)) {
		const from = match.index, to = from + match[0].length;
		if (escaped(from) || escaped(to - 2) || originalBlocked({ from, to }) || sourceBlocked({ from, to }) || !match[1].trim() || text[from - 1] === "=" || text[to] === "=") continue;
		add("highlight", from, to, from + 2, to - 2, contextAt({ from, to }));
	}
	for (const tag of memoTagRanges(text)) {
		if (!escaped(tag.from) && !originalBlocked(tag) && !sourceBlocked(tag) && !linksBlocked(tag) && !urlsBlocked(tag)) {
			const to = inlineEnd(tag.from, tag.to);
			add("tag", tag.from, to, tag.from, to, contextAt({ from: tag.from, to }));
		}
	}
	// 保护边界的任何交叠均禁止隐藏；合法 inline 包含关系仍可保留。
	const isolated = candidates.filter(r => ["code", "link", "markdown-link", "url"].includes(r.kind)).sort((a, b) => a.from - b.from || b.to - a.to);
	const isolatedSet = new Set(isolated);
	const isolatedBlocked = rangeLookup(isolated);
	const visibleIsolated: ComposerSyntaxRange[] = [];
	for (const range of isolated) if (!visibleIsolated.length || !contains(visibleIsolated[visibleIsolated.length - 1], range)) visibleIsolated.push(range);
	const ordinary = candidates.filter(r => !isolatedSet.has(r) && !sourceBlocked(r));
	const ordered = ordinary.filter(r => !isolatedBlocked(r)
		|| isolated.filter(s => overlaps(s, r)).every(s => r.contentFrom <= s.from && r.contentTo >= s.to))
		.concat(visibleIsolated.filter(r => !sourceBlocked(r))).sort((a, b) => a.from - b.from || b.to - a.to);
	const active: ComposerSyntaxRange[] = [];
	const crossed = new Set<ComposerSyntaxRange>();
	for (const range of ordered) {
		while (active.length && active[active.length - 1].to <= range.from) active.pop();
		for (const outer of active) if (outer.to < range.to) { crossed.add(outer); crossed.add(range); }
		active.push(range);
	}
	for (const range of crossed) sourceRanges.push(range);
	const finalBlocked = rangeLookup(sourceRanges);
	const ranges = ordered.filter(r => !finalBlocked(r));
	protectedRanges.push(...sourceRanges);
	const proseLines: SourceRange[] = [];
	const unsafeLine = rangeLookup([...sourceRanges, ...ranges.filter(r => ["code", "url"].includes(r.kind))]);
	for (const node of contexts) {
		if (node.type !== "Paragraph" || node.sourceFirst) continue;
		let inList = false;
		for (let p = node.parent; p >= 0; p = contexts[p].parent) if (contexts[p].type === "ListItem") inList = true;
		if (inList) continue;
		let from = node.from === 0 ? 0 : text.lastIndexOf("\n", node.from - 1) + 1;
		while (from < node.to) {
			const newline = text.indexOf("\n", from);
			const to = newline < 0 ? text.length : newline;
			const line = { from, to };
			if (!unsafeLine(line)) proseLines.push(line);
			from = to + 1;
		}
	}
	return { tree, ranges, contexts, sourceRanges, protectedRanges, proseLines };
}

export function revealComposerRange(range: ComposerSyntaxRange, selection: readonly SourceRange[]): boolean {
	if (range.kind === "url" || range.kind === "tag") return false;
	return selection.some(s => range.list
		? range.markers.some(marker => s.from === s.to ? s.from > marker.from && s.from <= marker.to : overlaps(s, marker))
		: s.from === s.to ? s.from >= range.from && s.from <= range.to : overlaps(s, range));
}

function matches(text: string, expression: RegExp): RegExpExecArray[] {
	const result: RegExpExecArray[] = [];
	let match: RegExpExecArray | null;
	while ((match = expression.exec(text)) !== null) result.push(match);
	return result;
}
