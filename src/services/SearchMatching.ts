import type { CatalogObservation, CatalogQueryFilter } from "../types/catalog";
import type { SearchDate } from "../types/search";
import { normalizeSearchText } from "../utils/searchText";

export function getCatalogTextTerms(request: CatalogQueryFilter): string[] {
	return [...new Set([...(request.textTerms ?? []), ...(request.text === undefined ? [] : [request.text])]
		.map(normalizeSearchText).filter(Boolean))].sort();
}

function searchValues(observation: CatalogObservation): Array<readonly string[]> {
	return [
		observation.searchBody ?? [],
		observation.tags.map(normalizeSearchText),
		observation.linkTargets,
		observation.imagePaths,
	];
}

export function matchesSearchTerms(observation: CatalogObservation, terms: readonly string[]): boolean {
	if (terms.length === 0) return true;
	// 缓存升级期间旧投影不能充当新语义的匹配结果，亦不能用旧 posting 否决新正文。
	if (observation.searchBody === undefined) return false;
	const fields = searchValues(observation);
	return terms.every(term => fields.some(values => values.some(value => value.includes(term))));
}

export function matchesSearchDate(logicalDate: string, date: SearchDate | undefined): boolean {
	if (date === undefined) return true;
	if (date.kind === "range") return logicalDate >= date.fromDate && logicalDate <= date.toDate;
	const day = logicalDate.slice(5);
	return date.fromMonthDay <= date.toMonthDay
		? day >= date.fromMonthDay && day <= date.toMonthDay
		: day >= date.fromMonthDay || day <= date.toMonthDay;
}

// 只规范语义，不纳入输入写法、快捷来源、页大小与 cursor。
export function getCatalogQueryKey(input: CatalogQueryFilter): string {
	const request = narrowCatalogQuery(input);
	const value: Record<string, unknown> = { ...request };
	delete value.text;
	delete value.textTerms;
	delete value.limit;
	delete value.cursor;
	const terms = getCatalogTextTerms(request);
	if (terms.length > 0) value.textTerms = terms;
	for (const field of ["tags", "logicalDates", "sourcePaths"] as const) {
		const values = request[field];
		if (values !== undefined) value[field] = [...new Set(field === "tags" ? values.map(normalizeSearchText) : values)].sort();
	}
	if (request.linkTarget !== undefined) value.linkTarget = normalizeSearchText(request.linkTarget);
	if (request.imagePath !== undefined) value.imagePath = normalizeSearchText(request.imagePath);
	// 带年日期已规范成最终边界，来源或快捷入口不影响查询身份。
	if (request.searchDate?.kind === "range") delete value.searchDate;
	else if (request.searchDate) value.searchDate = { kind: "month-day", fromMonthDay: request.searchDate.fromMonthDay, toMonthDay: request.searchDate.toMonthDay };
	return JSON.stringify(Object.entries(value).filter(([, v]) => v !== undefined).sort(([a], [b]) => a.localeCompare(b)));
}

export function narrowCatalogQuery(request: CatalogQueryFilter): CatalogQueryFilter {
	const query = { ...request };
	if (query.searchDate?.kind === "range") {
		query.fromDate = query.fromDate === undefined ? query.searchDate.fromDate : maxDate(query.fromDate, query.searchDate.fromDate);
		query.toDate = query.toDate === undefined ? query.searchDate.toDate : minDate(query.toDate, query.searchDate.toDate);
	}
	if (query.logicalDates !== undefined) query.logicalDates = [...new Set(query.logicalDates)]
		.filter(date => (query.fromDate === undefined || date >= query.fromDate)
			&& (query.toDate === undefined || date <= query.toDate)
			&& (query.monthDay === undefined || date.slice(5) === query.monthDay)
			&& (query.dayOfMonth === undefined || date.slice(8) === query.dayOfMonth)
			&& date !== query.excludeDate && matchesSearchDate(date, query.searchDate)).sort();
	if (query.logicalDates?.length) {
		query.fromDate = query.fromDate === undefined ? query.logicalDates[0] : maxDate(query.fromDate, query.logicalDates[0]);
		const last = query.logicalDates[query.logicalDates.length - 1];
		query.toDate = query.toDate === undefined ? last : minDate(query.toDate, last);
	}
	if ((query.fromDate !== undefined && query.toDate !== undefined && query.fromDate > query.toDate)
		|| query.logicalDates?.length === 0 || query.sourcePaths?.length === 0
		|| (query.monthDay !== undefined && query.searchDate?.kind === "month-day" && !matchesSearchDate("2000-" + query.monthDay, query.searchDate))
		|| (query.fromDate === query.toDate && query.fromDate !== undefined
			&& (query.fromDate === query.excludeDate || !matchesSearchDate(query.fromDate, query.searchDate)
				|| (query.monthDay !== undefined && query.fromDate.slice(5) !== query.monthDay)
				|| (query.dayOfMonth !== undefined && query.fromDate.slice(8) !== query.dayOfMonth)))) query.matchNone = true;
	if (query.hasTag === false && query.tags?.length) query.matchNone = true;
	if (query.monthDay !== undefined && query.dayOfMonth !== undefined && query.monthDay.slice(3) !== query.dayOfMonth) query.matchNone = true;
	if (!query.matchNone && query.fromDate !== undefined && query.toDate !== undefined
		&& (query.monthDay !== undefined || query.dayOfMonth !== undefined || query.searchDate?.kind === "month-day")
		&& !containsPossibleDate(query)) query.matchNone = true;
	return query;
}


// 仅计算日历交集，不读取正文；固定月日或日号通常在几个周期内即可确定。
function containsPossibleDate(query: CatalogQueryFilter): boolean {
	const from = query.fromDate!, to = query.toDate!;
	for (let year = Number(from.slice(0, 4)); year <= Number(to.slice(0, 4)); year++) {
		const firstMonth = year === Number(from.slice(0, 4)) ? Number(from.slice(5, 7)) : 1;
		const lastMonth = year === Number(to.slice(0, 4)) ? Number(to.slice(5, 7)) : 12;
		for (let month = firstMonth; month <= lastMonth; month++) {
			if (query.monthDay !== undefined && Number(query.monthDay.slice(0, 2)) !== month) continue;
			const count = new Date(year, month, 0).getDate();
			const fixedDay = query.monthDay?.slice(3) ?? query.dayOfMonth;
			const firstDay = fixedDay === undefined ? 1 : Number(fixedDay);
			const lastDay = fixedDay === undefined ? count : firstDay;
			for (let day = firstDay; day <= lastDay && day <= count; day++) {
				const date = String(year).padStart(4, "0") + "-" + String(month).padStart(2, "0") + "-" + String(day).padStart(2, "0");
				if (date >= from && date <= to && date !== query.excludeDate && matchesSearchDate(date, query.searchDate)) return true;
			}
		}
	}
	return false;
}

function minDate(a: string, b: string): string { return a < b ? a : b; }
function maxDate(a: string, b: string): string { return a > b ? a : b; }

export function intersectCatalogFilters(left: CatalogQueryFilter, right: CatalogQueryFilter): CatalogQueryFilter {
	const result: CatalogQueryFilter = { ...left, ...right };
	if (left.fromDate !== undefined && right.fromDate !== undefined) result.fromDate = maxDate(left.fromDate, right.fromDate);
	if (left.toDate !== undefined && right.toDate !== undefined) result.toDate = minDate(left.toDate, right.toDate);
	if (left.tags && right.tags) result.tags = [...new Set([...left.tags, ...right.tags])];
	if (left.logicalDates && right.logicalDates) result.logicalDates = left.logicalDates.filter(date => right.logicalDates!.includes(date));
	if (left.sourcePaths && right.sourcePaths) result.sourcePaths = left.sourcePaths.filter(source => right.sourcePaths!.includes(source));
	for (const key of ["hasTask", "hasImage", "hasLink", "hasTag", "hasReference", "hour", "monthDay", "dayOfMonth"] as const) {
		if (left[key] !== undefined && right[key] !== undefined && left[key] !== right[key]) result.matchNone = true;
	}
	if (left.matchNone || right.matchNone) result.matchNone = true;
	return narrowCatalogQuery(result);
}
