import type { MemoViewItem } from "../types/memoView";
import { formatTimeBuoyDate } from "../utils/timeBuoyDate";
import { getMemoRenderKey } from "./MemoRenderRevision";

export type MemoTimePresentation = { mode: "full" } | { mode: "recent"; time: string; icon: string };
export type RecentDecoration = { kind: "date"; date: string; day: number } | { kind: "history" };

export function formatRecentCalendarDate(logicalDate: string, locale: "zh-CN" | "en"): string {
	const [year, month, day] = logicalDate.split("-").map(Number);
	const date = new Date(year, month - 1, day);
	if (locale === "zh-CN") {
		const calendar = new Intl.DateTimeFormat(locale, { month: "short", day: "numeric" }).format(date);
		const weekday = new Intl.DateTimeFormat(locale, { weekday: "short" }).format(date);
		return `${calendar} ${weekday}`;
	}
	return new Intl.DateTimeFormat(locale, { weekday: "short", month: "short", day: "numeric" }).format(date);
}

export interface RecentTimeFlowContext {
	enabled: boolean;
	dates: readonly string[];
	pinnedKeys: ReadonlySet<string>;
}

export function createRecentTimeFlowContext(now: Date, enabled: boolean, pinnedKeys: ReadonlySet<string>): RecentTimeFlowContext {
	return {
		enabled, pinnedKeys,
		dates: [0, 1, 2].map((offset) => formatTimeBuoyDate(new Date(now.getFullYear(), now.getMonth(), now.getDate() - offset))),
	};
}

export function getRecentMemoPresentation(memo: MemoViewItem, context: RecentTimeFlowContext): {
	time: MemoTimePresentation; day: number; history: boolean;
} {
	const full = { time: { mode: "full" } as MemoTimePresentation, day: -1, history: false };
	if (!context.enabled || context.pinnedKeys.has(getMemoRenderKey(memo))) return full;
	const observation = memo.catalog?.observation;
	if (!observation || !/^\d{4}-\d{2}-\d{2}$/u.test(observation.logicalDate)) return full;
	const day = context.dates.indexOf(observation.logicalDate);
	if (day < 0) return { ...full, history: observation.logicalDate < context.dates[2] };
	const time = /^([01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?$/u.exec(observation.time);
	return {
		day, history: false,
		time: time ? { mode: "recent", time: observation.time.slice(0, 5), icon: `knomo-clock-${Number(time[1]) % 12}` } : full.time,
	};
}

// 每个渲染 generation 维护一个可丢弃的前缀推导器，追加时不重新扫描历史。
export class RecentTimeFlowDecorations {
	private days = new Set<number>();
	private historyShown = false;
	constructor(private readonly context: RecentTimeFlowContext) {}
	next(memo: MemoViewItem): RecentDecoration | null {
		const item = getRecentMemoPresentation(memo, this.context);
		if (item.day >= 0 && !this.days.has(item.day)) {
			this.days.add(item.day);
			return { kind: "date", date: this.context.dates[item.day], day: item.day };
		}
		if (item.history && this.days.size > 0 && !this.historyShown) {
			this.historyShown = true;
			return { kind: "history" };
		}
		return null;
	}
}
