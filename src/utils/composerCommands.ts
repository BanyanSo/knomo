import { scanComposerSyntax } from "./composerSyntax";

export type ComposerCommand = "bold" | "highlight" | "link" | "task" | "bullet" | "ordered";
export interface ComposerEdit { value: string; anchor: number; head: number }
export type ComposerCommandResult = { type: "changed"; edit: ComposerEdit } | { type: "unchanged" | "unavailable" };
interface Edit { from: number; to: number; insert: string }

export function runComposerCommand(value: string, anchor: number, head: number, command: ComposerCommand): ComposerCommandResult {
	const from = Math.min(anchor, head), to = Math.max(anchor, head);
	const syntax = scanComposerSyntax(value);
	const intersects = (a: number, b: number) => from === to ? from >= a && from <= b : from < b && to > a;
	if (syntax.protectedRanges.some(range => intersects(range.from, range.to))) return { type: "unavailable" };
	const edits: Edit[] = [];
	let selection: { from: number; to: number } | null = null;
	if (command === "link") {
		if (syntax.ranges.some(r => r.kind === "link" && intersects(r.from, r.to))) return { type: "unchanged" };
		if (from === to) {
			// 产品文档中的竖线表示光标位置，不是 alias 分隔符。
			edits.push({ from, to, insert: "[[]]" });
			selection = { from: from + 2, to: from + 2 };
		} else {
			const selected = value.slice(from, to);
			if (/[\n\r\[\]|#^\\!*=`<>]/u.test(selected) || !selected.trim()) return { type: "unavailable" };
			const start = from + selected.length - selected.trimStart().length;
			const end = to - selected.length + selected.trimEnd().length;
			edits.push({ from: start, to: start, insert: "[[" }, { from: end, to: end, insert: "]]" });
			selection = { from: start + 2, to: end + 2 };
		}
	} else if (command === "bold" || command === "highlight") {
		const delimiter = command === "bold" ? "**" : "==";
		if (from === to) {
			if (syntax.ranges.some(r => r.kind === command && intersects(r.from, r.to))
				|| value.slice(from - 2, from + 2) === delimiter + delimiter) return { type: "unchanged" };
			edits.push({ from, to, insert: delimiter + delimiter });
			selection = { from: from + 2, to: from + 2 };
		} else {
			const multiline = value.slice(from, to).includes("\n");
			const parts: { from: number; to: number; formatted: boolean; outerFrom: number; outerTo: number }[] = [];
			let offset = from === 0 ? 0 : value.lastIndexOf("\n", from - 1) + 1;
			while (offset < to) {
				const lineEnd = value.indexOf("\n", offset);
				const end = lineEnd < 0 ? value.length : lineEnd;
				let start = Math.max(from, offset), finish = Math.min(to, end);
				if (multiline) {
					const prefix = /^[\t ]*(?:(?:[-*+]|\d+[.)])\s+(?:\[[^\]]\]\s+)?)?/u.exec(value.slice(offset, end))![0];
					start = Math.max(start, offset + prefix.length);
					while (start < finish && /\s/u.test(value[start])) start++;
					while (finish > start && /\s/u.test(value[finish - 1])) finish--;
				}
				if (start < finish) {
					const matching = syntax.ranges.filter(r => r.kind === command && start < r.to && finish > r.from);
					const exact = matching.find(r => start === r.from && finish === r.to || start === r.contentFrom && finish === r.contentTo);
					if (matching.length && !exact) return { type: "unavailable" };
					if (!exact && value.slice(start, finish).includes(delimiter)) return { type: "unavailable" };
					parts.push({ from: exact?.contentFrom ?? start, to: exact?.contentTo ?? finish,
						formatted: !!exact, outerFrom: exact?.from ?? start, outerTo: exact?.to ?? finish });
				}
				if (end >= to) break;
				offset = end + 1;
			}
			if (!parts.length) return { type: "unavailable" };
			const remove = parts.every(p => p.formatted);
			for (const part of parts) {
				if (remove) edits.push({ from: part.outerFrom, to: part.from, insert: "" }, { from: part.to, to: part.outerTo, insert: "" });
				else if (!part.formatted) edits.push({ from: part.from, to: part.from, insert: delimiter }, { from: part.to, to: part.to, insert: delimiter });
			}
			if (!multiline) {
				const part = parts[0];
				selection = remove ? { from: part.outerFrom, to: part.outerTo - 4 } : { from: part.from + 2, to: part.to + 2 };
			}
		}
	} else {
		let offset = from === 0 ? 0 : value.lastIndexOf("\n", from - 1) + 1;
		let number = 1;
		while (offset <= to) {
			if (offset === to && from !== to) break;
			const newline = value.indexOf("\n", offset);
			const end = newline < 0 ? value.length : newline;
			const line = value.slice(offset, end);
			if (line.trim() || from === to) {
				const prefix = /^([\t ]*)(?:(?:[-*+]|\d+[.)])\s+(\[[^\]]\]\s*)?)?/u.exec(line)!;
				if (!(command === "task" && prefix[2])) {
					const marker = command === "task" ? "- [ ] " : command === "bullet" ? "- " : `${number}. `;
					edits.push({ from: offset + prefix[1].length, to: offset + prefix[0].length, insert: marker });
				}
				number++;
			}
			if (end >= to) break;
			offset = end + 1;
		}
	}
	if (!edits.length) return { type: "unchanged" };
	edits.sort((a, b) => a.from - b.from);
	let next = value;
	for (const edit of [...edits].reverse()) next = next.slice(0, edit.from) + edit.insert + next.slice(edit.to);
	if (next === value) return { type: "unchanged" };
	const map = (pos: number, side: number) => {
		let delta = 0;
		for (const edit of edits) {
			if (pos < edit.from || pos === edit.from && side < 0) break;
			if (pos <= edit.to) return edit.from + delta + (side > 0 ? edit.insert.length : 0);
			delta += edit.insert.length - (edit.to - edit.from);
		}
		return pos + delta;
	};
	const start = selection?.from ?? map(from, 1), end = selection?.to ?? map(to, from === to ? 1 : -1);
	return { type: "changed", edit: { value: next, anchor: anchor <= head ? start : end, head: anchor <= head ? end : start } };
}
