// 搜索日期与来源日期分别保存，最终查询始终取交集。
export type SearchDate =
	| { kind: "range"; fromDate: string; toDate: string; granularity: "day" | "month" | "year" }
	| { kind: "month-day"; fromMonthDay: string; toMonthDay: string };

export interface SearchInputRange {
	from: number;
	to: number;
}

export type SearchParseError =
	| "unclosed-quote"
	| "unfinished-date" | "unfinished-range" | "invalid-date"
	| "invalid-range-endpoint" | "mixed-range" | "reversed-range" | "multiple-dates";

export interface ParsedSearch {
	status: "empty" | "valid" | "incomplete" | "invalid";
	terms: string[];
	date: SearchDate | null;
	dateRange: SearchInputRange | null;
	error?: SearchParseError;
}
