import type { CatalogQueryFilter } from "../types/catalog";
import type { MemoViewItem } from "../types/memoView";
import { getCatalogTextTerms, matchesSearchTerms } from "../services/SearchMatching";
import { normalizeSearchText } from "../utils/searchText";

interface Grapheme { text: string; from: number; to: number }
interface NormalizedMap { text: string; ranges: Array<{ from: number; to: number }> }
interface TextRun { node: Text; from: number; to: number }

export function splitSearchGraphemes(text: string): Grapheme[] {
	const Segmenter = (Intl as unknown as { Segmenter?: new (locale?: string, options?: { granularity: string }) => {
		segment: (value: string) => Iterable<{ segment: string; index: number }>;
	} }).Segmenter;
	if (Segmenter) return [...new Segmenter(undefined, { granularity: "grapheme" }).segment(text)]
		.map(part => ({ text: part.segment, from: part.index, to: part.index + part.segment.length }));
	const parts: Grapheme[] = [];
	let offset = 0, regionalCount = 0;
	for (const char of text) {
		const regional = /[\u{1f1e6}-\u{1f1ff}]/u.test(char);
		const previous = parts[parts.length - 1];
		if (previous && (/\p{Mark}|\u200d|\ufe0f|[\u{1f3fb}-\u{1f3ff}]/u.test(char)
			|| previous.text.endsWith("\u200d") || (regional && regionalCount % 2 === 1))) {
			previous.text += char; previous.to += char.length;
		} else parts.push({ text: char, from: offset, to: offset + char.length });
		offset += char.length;
		regionalCount = regional ? regionalCount + 1 : 0;
	}
	return parts;
}

// 标准化索引映射回原始字素，扩展字符、组合字符及空白折叠都不能直接当 UTF-16 偏移。
export function mapSearchText(text: string): NormalizedMap | null {
	let normalized = "";
	const ranges: NormalizedMap["ranges"] = [];
	for (const part of splitSearchGraphemes(text)) {
		for (const char of part.text.normalize("NFKC").toLowerCase()) {
			if (/\s/u.test(char)) {
				if (!normalized || normalized.endsWith(" ")) continue;
				normalized += " "; ranges.push({ from: part.from, to: part.to });
			} else {
				normalized += char;
				for (let index = 0; index < char.length; index++) ranges.push({ from: part.from, to: part.to });
			}
		}
	}
	if (normalized.endsWith(" ")) { normalized = normalized.slice(0, -1); ranges.pop(); }
	return normalized === normalizeSearchText(text) ? { text: normalized, ranges } : null;
}

export function clearSearchHits(container: HTMLElement): void {
	const body = container.closest(".knomo-card-body") ?? container;
	body.querySelectorAll("mark.knomo-search-hit").forEach(mark => {
		const parent = mark.parentNode;
		while (mark.firstChild) parent?.insertBefore(mark.firstChild, mark);
		mark.remove(); parent?.normalize();
	});
}

export function renderSearchHits(container: HTMLElement, memo: MemoViewItem, filter: CatalogQueryFilter): void {
	clearSearchHits(container);
	if (!memo.catalog) return;
	const terms = getCatalogTextTerms(filter);
	const observation = memo.catalog.observation;
	if (!terms.length || !matchesSearchTerms(observation, terms)) return;
	const dom = collectVisibleText(container);
	const mapped = mapSearchText(dom.text);
	const ranges: Array<{ from: number; to: number }> = [];
	if (mapped && mapped.text) {
		// 只有可见文字整体能定位到同一个已命中正文值时，才允许映射；不跨字段或排除边界猜位置。
		observation.searchBody.forEach(value => {
			const start = value.indexOf(mapped.text);
			if (start < 0 || value.indexOf(mapped.text, start + 1) >= 0) return;
			for (const term of terms) {
				const from = value.indexOf(term), to = from + term.length;
				if (from < start || to > start + mapped.text.length) continue;
				const first = mapped.ranges[from - start], last = mapped.ranges[to - start - 1];
				if (first && last) { ranges.push({ from: first.from, to: last.to }); }
			}
		});
	}
	markTextRuns(dom.runs, ranges);
}

function collectVisibleText(container: HTMLElement): { text: string; runs: TextRun[] } {
	let text = "";
	const runs: TextRun[] = [];
	const visit = (node: Node) => {
		if (node.nodeType === 3) {
			const value = node.nodeValue ?? "";
			runs.push({ node: node as Text, from: text.length, to: text.length + value.length });
			text += value; return;
		}
		if (node.nodeType !== 1) return;
		const element = node as Element;
		if (element.matches("pre, script, style, img, [data-knomo-render-placeholder]")) { text += "\n"; return; }
		const block = element.matches("p, div, li, blockquote, h1, h2, h3, h4, h5, h6, tr, br");
		if (block) text += "\n";
		element.childNodes.forEach(visit);
		if (block) text += "\n";
	};
	container.childNodes.forEach(visit);
	return { text, runs };
}

function markTextRuns(runs: readonly TextRun[], ranges: readonly { from: number; to: number }[]): void {
	const merged: Array<{ from: number; to: number }> = [];
	for (const range of [...ranges].sort((a, b) => a.from - b.from)) {
		const previous = merged[merged.length - 1];
		if (previous && range.from <= previous.to) previous.to = Math.max(previous.to, range.to);
		else merged.push({ ...range });
	}
	for (const run of [...runs].reverse()) {
		for (const range of [...merged].reverse()) {
			const from = Math.max(run.from, range.from) - run.from;
			const to = Math.min(run.to, range.to) - run.from;
			if (to <= from) continue;
			const tail = run.node.splitText(to);
			const hit = run.node.splitText(from);
			const mark = hit.ownerDocument.createElement("mark");
			mark.className = "knomo-search-hit";
			hit.parentNode?.insertBefore(mark, hit); mark.appendChild(hit);
			// 保留原有元素，只包裹文字节点；链接与 checkbox 仍使用原绑定。
			if (!tail.data) tail.remove();
		}
	}
}
