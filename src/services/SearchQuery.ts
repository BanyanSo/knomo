import type { ParsedSearch, SearchDate, SearchInputRange, SearchParseError } from "../types/search";
import { normalizeSearchText } from "../utils/searchText";

interface Token extends SearchInputRange { value: string; phrase: boolean }
type DatePart = { granularity: "day" | "month" | "year"; fromDate: string; toDate: string }
	| { granularity: "month-day"; fromMonthDay: string; toMonthDay: string };
type DateToken = { status: "text" | "incomplete" | "invalid" } | { status: "date"; value: DatePart };

// 只解析用户输入；CatalogQuery.text 的内部调用始终是明确文字，不经此入口猜测日期。
export function parseSearchInput(input: string): ParsedSearch {
	const result: ParsedSearch = { status: "empty", terms: [], date: null, dateRange: null };
	const tokens: Token[] = [];
	const fail = (error: SearchParseError, incomplete = false): ParsedSearch => ({
		...result, status: incomplete ? "incomplete" : "invalid", error
	});
	let at = 0;
	while (at < input.length) {
		if (/\s/u.test(input.charAt(at))) { at++; continue; }
		const from = at, opening = input.charAt(at).normalize("NFKC");
		// 引号仅为数字日期提供文字转义，普通文字沿用连续文本匹配。
		if (opening === '"' || opening === "“") {
			const closing = opening === "“" ? "”" : '"';
			let close = at + 1;
			while (close < input.length && input.charAt(close).normalize("NFKC") !== closing) close++;
			if (close === input.length) close = -1;
			const value = normalizeSearchText(input.slice(at + 1, close < 0 ? input.length : close));
			if (/^[\d\s~至-]+$/u.test(value)) {
				if (close < 0) return fail("unclosed-quote", true);
				if (close + 1 === input.length || /\s/u.test(input.charAt(close + 1))) {
					at = close + 1;
					tokens.push({ from, to: at, phrase: true, value });
					continue;
				}
			}
		}
		while (at < input.length && !/\s/u.test(input.charAt(at))) at++;
		tokens.push({ from, to: at, phrase: false, value: normalizeSearchText(input.slice(from, at)) });
	}
	for (let i = 0; i < tokens.length; i++) {
		const token = tokens[i];
		if (token.phrase) {
			if (token.value) { result.terms.push(token.value); }
			continue;
		}
		let candidate = token.value, end = i;
		if (!/[~至]/u.test(candidate) && tokens[i + 1] && !tokens[i + 1].phrase && /^[~至]/u.test(tokens[i + 1].value)) {
			candidate += tokens[++end].value;
		}
		if (/[~至]$/u.test(candidate) && tokens[end + 1] && !tokens[end + 1].phrase) candidate += tokens[++end].value;
		const parts = candidate.split(/[~至]/u);
		const left = parseDateToken(parts[0]), right = parts.length > 1 ? parseDateToken(parts[parts.length - 1]) : null;
		let date: SearchDate | null = null;
		let range: SearchInputRange = { from: token.from, to: token.to };
		if (parts.length > 1 && (left.status !== "text" || right?.status !== "text")) {
			range = { from: token.from, to: tokens[end].to };
			if (parts.length !== 2) return fail("invalid-range-endpoint");
			if (!parts[0] || !parts[1] || left.status === "incomplete" || right?.status === "incomplete") return fail("unfinished-range", true);
			if (left.status === "invalid" || right?.status === "invalid") return fail("invalid-date");
			if (left.status !== "date" || right?.status !== "date") return fail("invalid-range-endpoint");
			if (left.value.granularity !== right.value.granularity) return fail("mixed-range");
			if (left.value.granularity === "month-day" && right.value.granularity === "month-day") {
				date = { kind: "month-day", fromMonthDay: left.value.fromMonthDay, toMonthDay: right.value.toMonthDay };
			} else if (left.value.granularity !== "month-day" && right.value.granularity !== "month-day") {
				if (left.value.fromDate > right.value.toDate) return fail("reversed-range");
				date = { kind: "range", granularity: left.value.granularity, fromDate: left.value.fromDate, toDate: right.value.toDate };
			}
			i = end;
		} else {
			const single = parseDateToken(token.value);
			if (single.status === "incomplete") return fail("unfinished-date", true);
			if (single.status === "invalid") return fail("invalid-date");
			if (single.status === "date") {
				const part = single.value;
				date = part.granularity === "month-day"
					? { kind: "month-day", fromMonthDay: part.fromMonthDay, toMonthDay: part.toMonthDay }
					: { kind: "range", granularity: part.granularity, fromDate: part.fromDate, toDate: part.toDate };
			}
		}
		if (date) {
			if (result.date) return fail("multiple-dates");
			result.date = date;
			result.dateRange = range;
		} else if (token.value) {
			result.terms.push(token.value);
		}
	}
	const text = normalizeSearchText(result.terms.join(" "));
	result.terms = text ? [text] : [];
	result.status = result.terms.length > 0 || result.date !== null ? "valid" : "empty";
	return result;
}

function parseDateToken(value: string): DateToken {
	const full = /^(\d{4})(\d{2})(\d{2})$/u.exec(value) ?? /^(\d{4})-(\d{2})-(\d{2})$/u.exec(value);
	if (full) {
		const year = Number(full[1]), month = Number(full[2]), day = Number(full[3]);
		if (year < 1000 || !validMonthDay(month, day, year)) return { status: "invalid" };
		const date = `${full[1]}-${full[2]}-${full[3]}`;
		return { status: "date", value: { granularity: "day", fromDate: date, toDate: date } };
	}
	const month = /^(\d{4})(\d{2})$/u.exec(value) ?? /^(\d{4})-(\d{2})$/u.exec(value);
	if (month) {
		const year = Number(month[1]), number = Number(month[2]);
		if (year < 1000 || number < 1 || number > 12) return { status: "invalid" };
		const prefix = `${month[1]}-${month[2]}`;
		return { status: "date", value: { granularity: "month", fromDate: prefix + "-01", toDate: prefix + "-" + String(daysInMonth(year, number)).padStart(2, "0") } };
	}
	const monthDay = /^(\d{2})-(\d{2})$/u.exec(value) ?? (/^\d{4}$/u.test(value) ? [value, value.slice(0, 2), value.slice(2)] : null);
	if (monthDay && validMonthDay(Number(monthDay[1]), Number(monthDay[2]), 2000)) {
		const day = `${monthDay[1]}-${monthDay[2]}`;
		return { status: "date", value: { granularity: "month-day", fromMonthDay: day, toMonthDay: day } };
	}
	if (/^\d{4}$/u.test(value) && Number(value) >= 1900 && Number(value) <= 2099) {
		return { status: "date", value: { granularity: "year", fromDate: value + "-01-01", toDate: value + "-12-31" } };
	}
	if (/^\d{2}-\d{2}$/u.test(value)) return { status: "invalid" };
	if (/^\d{4}-(?:\d{0,2}(?:-\d{0,1})?)?$/u.test(value) || /^\d{2}-\d?$/u.test(value)) return { status: "incomplete" };
	return { status: "text" };
}

function validMonthDay(month: number, day: number, year: number): boolean {
	return month >= 1 && month <= 12 && day >= 1 && day <= daysInMonth(year, month);
}

function daysInMonth(year: number, month: number): number {
	return month === 2 ? (year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28)
		: [4, 6, 9, 11].includes(month) ? 30 : 31;
}
