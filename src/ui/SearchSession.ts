import type { CatalogQueryFilter } from "../types/catalog";
import type { ParsedSearch, SearchDate, SearchInputRange } from "../types/search";
import { parseSearchInput } from "../services/SearchQuery";
import { getCatalogQueryKey, narrowCatalogQuery } from "../services/SearchMatching";
import { formatDatePart } from "../utils/date";
import type { SearchDateFilter } from "./viewFilters";

export interface SearchDraft {
	text: string;
	selectionStart: number;
	selectionEnd: number;
	composing: boolean;
	parsed: ParsedSearch;
}
export interface AppliedSearch {
	input: string;
	terms: readonly string[];
	date: SearchDate | null;
	dateOrigin: "input" | "shortcut" | null;
	shortcut: SearchDateFilter | null;
}

export class SearchSession {
	draft: SearchDraft = { text: "", selectionStart: 0, selectionEnd: 0, composing: false, parsed: parseSearchInput("") };
	applied: AppliedSearch = { input: "", terms: [], date: null, dateOrigin: null, shortcut: null };
	version = 0;
	requestStatus: "idle" | "pending" | "ready" | "failed" = "idle";
	result: { key: string; filter: CatalogQueryFilter; input: string; shortcut: SearchDateFilter | null; catalogRevision: number; coverageKey: string } | null = null;

	get hasConditions(): boolean { return this.applied.terms.length > 0 || this.applied.dateOrigin !== null; }
	get canRewrite(): boolean { return !this.draft.composing && (this.draft.parsed.status === "empty" || this.draft.parsed.status === "valid"); }

	updateDraft(text: string, start = text.length, end = start): boolean {
		const changed = text !== this.draft.text;
		this.draft.selectionStart = start;
		this.draft.selectionEnd = end;
		if (changed) {
			this.version++;
			this.draft.text = text;
			if (!this.draft.composing) this.draft.parsed = parseSearchInput(text);
		}
		return changed;
	}

	beginComposition(): void { this.version++; this.draft.composing = true; }
	endComposition(text: string, start = text.length, end = start): void {
		this.draft.composing = false;
		this.updateDraft(text, start, end);
		this.draft.parsed = parseSearchInput(text);
	}

	submit(): boolean {
		if (!this.canRewrite) return false;
		const parsed = this.draft.parsed;
		const keepShortcut = parsed.date === null && this.applied.dateOrigin === "shortcut";
		this.applied = {
			input: this.draft.text, terms: parsed.terms,
			date: parsed.date, dateOrigin: parsed.date !== null ? "input" : keepShortcut ? "shortcut" : null,
			shortcut: keepShortcut ? this.applied.shortcut : null,
		};
		return true;
	}

	toggleShortcut(filter: SearchDateFilter): boolean {
		if (!this.canRewrite) return false;
		const previous = this.applied.shortcut;
		if (this.draft.parsed.dateRange) this.rewrite([this.draft.parsed.dateRange]);
		this.submit();
		this.applied.date = null;
		this.applied.shortcut = previous === filter ? null : filter;
		this.applied.dateOrigin = this.applied.shortcut === null ? null : "shortcut";
		this.version++;
		return true;
	}

	close(): void { this.version++; }
	reset(): void {
		this.version++;
		this.draft = { text: "", selectionStart: 0, selectionEnd: 0, composing: false, parsed: parseSearchInput("") };
		this.applied = { input: "", terms: [], date: null, dateOrigin: null, shortcut: null };
		this.result = null;
		this.requestStatus = "idle";
	}

	getFilter(source: CatalogQueryFilter = {}, today = new Date()): CatalogQueryFilter {
		const date = this.applied.dateOrigin === "shortcut" && this.applied.shortcut !== null
			? getSearchShortcutDate(this.applied.shortcut, today) : this.applied.date;
		return narrowCatalogQuery({ ...source,
			...(this.hasConditions ? { textTerms: this.applied.terms } : {}),
			...(date === null ? {} : { searchDate: date }),
		});
	}

	beginRequest(): void { this.requestStatus = "pending"; }
	commitResult(filter: CatalogQueryFilter, catalogRevision: number, coverageKey: string): void {
		this.result = { filter, input: this.applied.input, shortcut: this.applied.shortcut, key: getCatalogQueryKey(filter), catalogRevision, coverageKey };
		this.requestStatus = "ready";
	}

	private rewrite(ranges: readonly SearchInputRange[]): void {
		let text = this.draft.text;
		let start = this.draft.selectionStart, end = this.draft.selectionEnd;
		for (const range of [...ranges].sort((a, b) => b.from - a.from)) {
			text = text.slice(0, range.from) + text.slice(range.to);
			const shift = (position: number) => position <= range.from ? position : position < range.to ? range.from : position - (range.to - range.from);
			start = shift(start); end = shift(end);
		}
		const leading = /^\s*/u.exec(text)?.[0].length ?? 0;
		text = text.trim();
		this.updateDraft(text, Math.max(0, Math.min(text.length, start - leading)), Math.max(0, Math.min(text.length, end - leading)));
	}
}

export function getSearchShortcutDate(filter: SearchDateFilter, today: Date): SearchDate {
	const day = new Date(today.getFullYear(), today.getMonth(), today.getDate());
	const add = (date: Date, amount: number) => new Date(date.getFullYear(), date.getMonth(), date.getDate() + amount);
	let from = day, to = day;
	if (filter === "last-7") from = add(day, -6);
	else if (filter === "last-30") from = add(day, -29);
	else if (filter === "month") from = new Date(day.getFullYear(), day.getMonth(), 1);
	else if (filter === "last-month") {
		from = new Date(day.getFullYear(), day.getMonth() - 1, 1);
		to = new Date(day.getFullYear(), day.getMonth(), 0);
	} else {
		const monday = add(day, -(day.getDay() + 6) % 7);
		from = filter === "last-week" ? add(monday, -7) : monday;
		if (filter === "last-week") to = add(monday, -1);
	}
	return { kind: "range", granularity: "day", fromDate: formatDatePart(from), toDate: formatDatePart(to) };
}
