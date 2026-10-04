import type { CatalogCoverage } from "../types/catalog";
import type { TimeBuoyCursor, TimeBuoyIndexEntry, TimeBuoyPageRequest } from "../types/timeBuoy";

export function getTimeBuoyTabDates(dates: readonly string[], request: Pick<TimeBuoyPageRequest, "tab" | "today">): string[] {
	return [...new Set(dates.filter((date) => request.tab === "today" ? date === request.today
		: request.tab === "upcoming" ? date > request.today : date < request.today))].sort();
}

// 只保留当前页和一个探测项的轻量索引；正文仅在选页后读取。
export class TimeBuoyPageSelection {
	readonly items: TimeBuoyCursor[] = [];
	readonly invalidated: boolean;
	readonly limit: number;
	constructor(private readonly request: TimeBuoyPageRequest, private readonly revision: number, private readonly coverage: CatalogCoverage,
		private readonly compareObservationKeys = (left: string, right: string) => right.localeCompare(left)) {
		this.limit = Math.max(1, Math.min(150, Math.trunc(request.limit)));
		const cursor = request.cursor;
		this.invalidated = cursor != null && (cursor.catalogRevision !== revision || cursor.today !== request.today
			|| cursor.tab !== request.tab || cursor.coverageKey !== JSON.stringify(coverage));
	}

	add(entry: TimeBuoyIndexEntry): void {
		const dates = getTimeBuoyTabDates(entry.timeBuoyDates, this.request);
		if (dates.length === 0) return;
		const item: TimeBuoyCursor = {
			catalogRevision: this.revision, coverageKey: JSON.stringify(this.coverage),
			today: this.request.today, tab: this.request.tab,
			primaryTargetDate: this.request.tab === "past" ? dates[dates.length - 1] : dates[0],
			createdAtKey: entry.createdAtKey, observationKey: entry.observationKey,
		};
		if (this.request.cursor != null && this.compare(item, this.request.cursor) <= 0) return;
		let low = 0, high = this.items.length;
		while (low < high) {
			const middle = (low + high) >>> 1;
			if (this.compare(this.items[middle], item) < 0) low = middle + 1;
			else high = middle;
		}
		if (low > this.limit) return;
		this.items.splice(low, 0, item);
		if (this.items.length > this.limit + 1) this.items.pop();
	}

	get nextCursor(): TimeBuoyCursor | null {
		return this.items.length > this.limit ? this.items[this.limit - 1] : null;
	}

	private compare(left: TimeBuoyCursor, right: TimeBuoyCursor): number {
		const dateOrder = this.request.tab === "upcoming"
			? left.primaryTargetDate.localeCompare(right.primaryTargetDate)
			: right.primaryTargetDate.localeCompare(left.primaryTargetDate);
		return dateOrder || right.createdAtKey.localeCompare(left.createdAtKey)
			|| this.compareObservationKeys(left.observationKey, right.observationKey);
	}
}
