import type { CatalogQueryFilter } from "../types/catalog";
import type { ParsedSearch, SearchDate, SearchInputRange } from "../types/search";
import { parseSearchInput } from "../services/SearchQuery";
import { getCatalogQueryKey, narrowCatalogQuery } from "../services/SearchMatching";
import { formatDatePart } from "../utils/date";
import type { SearchSourceContext } from "./SearchSourceScope";
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
	dateRange?: SearchInputRange;
	dateFallback?: true;
}

interface SearchResultContext {
	source: SearchSourceContext;
	sourceFilter: CatalogQueryFilter;
	today: Date;
	relationRevision?: number;
	favoriteRevision?: number;
}

export interface AcceptedSearch extends AppliedSearch {
	key: string;
	filter: CatalogQueryFilter;
	catalogRevision: number;
	coverageKey: string;
	draftVersion: number;
	source?: SearchSourceContext;
	searchDate: SearchDate | null;
	dateConflict: boolean;
	relationRevision?: number;
	favoriteRevision?: number;
}


export class SearchSession {
	draft: SearchDraft = { text: "", selectionStart: 0, selectionEnd: 0, composing: false, parsed: parseSearchInput("") };
	applied: AppliedSearch = { input: "", terms: [], date: null, dateOrigin: null, shortcut: null };
	version = 0;
	requestStatus: "idle" | "pending" | "ready" | "failed" = "idle";
	result: AcceptedSearch | null = null;

	get hasConditions(): boolean { return this.applied.terms.length > 0 || this.applied.dateOrigin !== null; }
	get canRewrite(): boolean { return !this.draft.composing; }

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
			dateRange: parsed.dateRange ?? undefined,
			dateFallback: parsed.dateFallback,
		};
		return true;
	}

	toggleShortcut(filter: SearchDateFilter): boolean {
		if (!this.canRewrite) return false;
		const previous = this.applied.shortcut;
		if (this.draft.parsed.dateRange) this.removeDateRange(this.draft.parsed.dateRange);
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
		const date = this.getSearchDate(today);
		return narrowCatalogQuery({ ...source,
			...(this.hasConditions ? { textTerms: this.applied.terms } : {}),
			...(date === null ? {} : { searchDate: date }),
		});
	}

	private getSearchDate(today: Date): SearchDate | null {
		return this.applied.shortcut === null ? this.applied.date : getSearchShortcutDate(this.applied.shortcut, today);
	}

	beginRequest(): void { this.requestStatus = "pending"; }
	commitResult(filter: CatalogQueryFilter, catalogRevision: number, coverageKey: string, context?: SearchResultContext): void {
		const searchDate = this.getSearchDate(context?.today ?? new Date());
		const source = context?.sourceFilter ?? {};
		const { fromDate, toDate, logicalDates, monthDay, dayOfMonth, excludeDate } = source;
		this.result = {
			...this.applied, filter, catalogRevision, coverageKey, key: getCatalogQueryKey(filter), draftVersion: this.version,
			source: context?.source, searchDate, relationRevision: context?.relationRevision, favoriteRevision: context?.favoriteRevision,
			// 仅从日期约束证明冲突，避免把其他筛选导致的零条提示为日期不重叠。
			dateConflict: searchDate !== null && narrowCatalogQuery({
				fromDate, toDate, logicalDates, monthDay, dayOfMonth, excludeDate, searchDate,
			}).matchNone === true,
		};
		this.requestStatus = "ready";
	}

	canApplyDateAction(result = this.result): boolean {
		return result?.dateOrigin === "input" && result.dateRange !== undefined
			&& result === this.result && this.requestStatus === "ready" && this.canRewrite
			&& result.draftVersion === this.version && result.input === this.draft.text;
	}

	searchDateAsText(): boolean {
		const result = this.result;
		if (!result?.dateRange || !this.canApplyDateAction(result)) return false;
		const { from, to } = result.dateRange;
		const { text } = this.draft;
		this.updateDraft(text.slice(0, from) + '"' + text.slice(from, to) + '"' + text.slice(to), to + 2);
		return this.submit();
	}

	private removeDateRange({ from, to }: SearchInputRange): void {
		const draft = this.draft;
		let text = draft.text.slice(0, from) + draft.text.slice(to);
		const shift = (position: number) => position <= from ? position : position < to ? from : position - (to - from);
		const leading = /^\s*/u.exec(text)?.[0].length ?? 0;
		text = text.trim();
		const fit = (position: number) => Math.max(0, Math.min(text.length, shift(position) - leading));
		this.updateDraft(text, fit(draft.selectionStart), fit(draft.selectionEnd));
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
