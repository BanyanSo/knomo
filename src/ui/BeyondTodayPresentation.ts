import type { MemoViewItem } from "../types/memoView";
import { formatTimeBuoyDate, isValidTimeBuoyDate } from "../utils/timeBuoyDate";

export interface BeyondTodayContext {
	today: string;
	year: number;
	month: number;
	previousMonth: string;
}

export interface BeyondTodayGroup {
	key: string;
	year: string;
	period: "firstQuarter" | "secondQuarter" | "firstHalf" | "secondHalf";
}

export function createBeyondTodayContext(date: Date): BeyondTodayContext {
	const year = date.getFullYear();
	const month = date.getMonth() + 1;
	return {
		today: formatTimeBuoyDate(date), year, month,
		previousMonth: `${String(month === 1 ? year - 1 : year).padStart(4, "0")}-${String(month === 1 ? 12 : month - 1).padStart(2, "0")}`,
	};
}

export function getBeyondTodayGroup(memo: MemoViewItem, context: BeyondTodayContext): BeyondTodayGroup | null {
	const date = memo.catalog?.observation?.logicalDate;
	if (!date || !isValidTimeBuoyDate(date) || date.slice(0, 7) >= context.previousMonth) return null;
	const year = date.slice(0, 4);
	const month = Number(date.slice(5, 7));
	const period = Number(year) === context.year && context.month <= 7
		? (month <= 3 ? "firstQuarter" : "secondQuarter")
		: (month <= 6 ? "firstHalf" : "secondHalf");
	return { key: `${year}:${period}`, year, period };
}

// 沿已显示的有序前缀推导边界，分页和渲染分片都延续同一上下文。
export class BeyondTodayDecorations {
	private previousKey: string | null = null;
	constructor(private readonly context: BeyondTodayContext | null) {}

	next(memo: MemoViewItem): BeyondTodayGroup | null {
		if (this.context === null) return null;
		const group = getBeyondTodayGroup(memo, this.context);
		if (group === null || group.key === this.previousKey) return null;
		this.previousKey = group.key;
		return group;
	}
}
