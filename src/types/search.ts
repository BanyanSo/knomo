// 搜索日期与来源日期分别保存，最终查询始终取交集。
export type SearchDate =
	| { kind: "range"; fromDate: string; toDate: string; granularity: "day" | "month" | "year" }
	| { kind: "month-day"; fromMonthDay: string; toMonthDay: string };

export interface SearchInputRange {
	from: number;
	to: number;
}

export interface ParsedSearch {
	status: "empty" | "valid";
	terms: string[];
	date: SearchDate | null;
	dateRange: SearchInputRange | null;
}
