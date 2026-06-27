import { moment as obsidianMoment } from "obsidian";

interface DailyNotesPathConfig {
	folder: string | null;
	format: string;
}

type DateToken = "year4" | "year2" | "month" | "monthName" | "day";

interface DatePattern {
	regex: RegExp;
	tokens: DateToken[];
}

interface FormatToken {
	text: string;
	regex: string;
	dateToken: DateToken | null;
}

interface StrictMomentWithMonth {
	isValid: () => unknown;
	month: () => unknown;
}

interface StrictMomentWithDate {
	isValid: () => unknown;
	toDate: () => unknown;
}

const FORMAT_TOKENS: FormatToken[] = [
	{ text: "YYYY", regex: "(\\d{4})", dateToken: "year4" },
	{ text: "MMMM", regex: "([^/]+?)", dateToken: "monthName" },
	{ text: "MMM", regex: "([^/]+?)", dateToken: "monthName" },
	{ text: "MM", regex: "(0[1-9]|1[0-2])", dateToken: "month" },
	{ text: "Mo", regex: "([1-9]|1[0-2])(?:st|nd|rd|th|月)?", dateToken: "month" },
	{ text: "M", regex: "([1-9]|1[0-2])", dateToken: "month" },
	{ text: "DDDD", regex: "\\d{3}", dateToken: null },
	{ text: "DDD", regex: "\\d{1,3}", dateToken: null },
	{ text: "Do", regex: "([1-9]|[12]\\d|3[01])(?:st|nd|rd|th|日)?", dateToken: "day" },
	{ text: "DD", regex: "(0[1-9]|[12]\\d|3[01])", dateToken: "day" },
	{ text: "D", regex: "([1-9]|[12]\\d|3[01])", dateToken: "day" },
	{ text: "YY", regex: "(\\d{2})", dateToken: "year2" },
	{ text: "dddd", regex: "[^/]+?", dateToken: null },
	{ text: "ddd", regex: "[^/]+?", dateToken: null },
	{ text: "dd", regex: "[^/]+?", dateToken: null },
	{ text: "d", regex: "\\d", dateToken: null },
	{ text: "HH", regex: "\\d{2}", dateToken: null },
	{ text: "H", regex: "\\d{1,2}", dateToken: null },
	{ text: "hh", regex: "\\d{2}", dateToken: null },
	{ text: "h", regex: "\\d{1,2}", dateToken: null },
	{ text: "mm", regex: "\\d{2}", dateToken: null },
	{ text: "m", regex: "\\d{1,2}", dateToken: null },
	{ text: "ss", regex: "\\d{2}", dateToken: null },
	{ text: "s", regex: "\\d{1,2}", dateToken: null },
	{ text: "SSS", regex: "\\d{3}", dateToken: null },
	{ text: "SS", regex: "\\d{2}", dateToken: null },
	{ text: "S", regex: "\\d", dateToken: null },
	{ text: "A", regex: "[^/]+?", dateToken: null },
	{ text: "a", regex: "[^/]+?", dateToken: null },
	{ text: "ZZ", regex: "[+-]\\d{4}", dateToken: null },
	{ text: "Z", regex: "[+-]\\d{2}:?\\d{2}", dateToken: null },
	{ text: "WW", regex: "\\d{2}", dateToken: null },
	{ text: "W", regex: "\\d{1,2}", dateToken: null },
	{ text: "wo", regex: "\\d{1,2}(?:st|nd|rd|th)?", dateToken: null },
	{ text: "w", regex: "\\d{1,2}", dateToken: null },
	{ text: "E", regex: "\\d", dateToken: null },
	{ text: "e", regex: "\\d", dateToken: null },
];

const MONTH_NAMES = new Map<string, number>([
	["january", 1],
	["jan", 1],
	["february", 2],
	["feb", 2],
	["march", 3],
	["mar", 3],
	["april", 4],
	["apr", 4],
	["may", 5],
	["june", 6],
	["jun", 6],
	["july", 7],
	["jul", 7],
	["august", 8],
	["aug", 8],
	["september", 9],
	["sep", 9],
	["sept", 9],
	["october", 10],
	["oct", 10],
	["november", 11],
	["nov", 11],
	["december", 12],
	["dec", 12],
	["一月", 1],
	["二月", 2],
	["三月", 3],
	["四月", 4],
	["五月", 5],
	["六月", 6],
	["七月", 7],
	["八月", 8],
	["九月", 9],
	["十月", 10],
	["十一月", 11],
	["十二月", 12],
]);

export function matchesDailyNotePath(path: string, config: DailyNotesPathConfig): boolean {
	return parseDailyNoteDateFromPath(path, config) !== null;
}

export function parseDailyNoteDateFromPath(path: string, config: DailyNotesPathConfig): Date | null {
	const relativePath = getRelativeDailyStem(path, config.folder);
	if (relativePath === null) {
		return null;
	}
	const momentDate = parseDateWithObsidianMoment(relativePath, config.format);
	if (momentDate !== null) {
		return momentDate;
	}

	const pattern = buildDatePattern(config.format);
	const match = relativePath.match(pattern.regex);
	if (match === null) {
		return null;
	}

	let year: number | null = null;
	let month: number | null = null;
	let day: number | null = null;
	for (let index = 0; index < pattern.tokens.length; index += 1) {
		const value = Number(match[index + 1]);
		const token = pattern.tokens[index];
		if (token === "year4") {
			year = value;
		} else if (token === "year2") {
			year = 2000 + value;
		} else if (token === "month") {
			month = value;
		} else if (token === "monthName") {
			month = parseMonthName(match[index + 1]);
		} else if (token === "day") {
			day = value;
		}
	}

	if (year === null || month === null || day === null) {
		return null;
	}

	const date = new Date(year, month - 1, day);
	if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) {
		return null;
	}
	return date;
}

function getRelativeDailyStem(path: string, folder: string | null): string | null {
	const normalizedPath = stripMarkdownExtension(path.replace(/\\/g, "/").replace(/^\/+/, ""));
	const normalizedFolder = folder === null ? "" : folder.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
	if (normalizedFolder.length === 0) {
		return normalizedPath;
	}
	if (normalizedPath === normalizedFolder) {
		return null;
	}
	if (!normalizedPath.startsWith(`${normalizedFolder}/`)) {
		return null;
	}
	return normalizedPath.slice(normalizedFolder.length + 1);
}

function stripMarkdownExtension(path: string): string {
	return path.endsWith(".md") ? path.slice(0, -3) : path;
}

function buildDatePattern(format: string): DatePattern {
	const tokens: DateToken[] = [];
	let source = "";
	for (let index = 0; index < format.length;) {
		if (format[index] === "[") {
			const endIndex = format.indexOf("]", index + 1);
			if (endIndex !== -1) {
				source += escapeRegExp(format.slice(index + 1, endIndex));
				index = endIndex + 1;
				continue;
			}
		}
		if (format[index] === "\\" && index + 1 < format.length) {
			source += escapeRegExp(format[index + 1]);
			index += 2;
			continue;
		}
		const token = findFormatToken(format, index);
		if (token !== null) {
			source += token.regex;
			if (token.dateToken !== null) {
				tokens.push(token.dateToken);
			}
			index += token.text.length;
			continue;
		}
		source += escapeRegExp(format[index]);
		index += 1;
	}
	return {
		regex: new RegExp(`^${source}$`),
		tokens,
	};
}

function findFormatToken(format: string, index: number): FormatToken | null {
	return FORMAT_TOKENS.find((token) => format.startsWith(token.text, index)) ?? null;
}

function parseMonthName(value: string): number | null {
	const normalizedName = value.trim().toLowerCase().replace(/\.$/, "");
	const numericMonth = normalizedName.match(/^(\d{1,2})月$/)?.[1] ?? null;
	if (numericMonth !== null) {
		const parsedMonth = Number(numericMonth);
		return parsedMonth >= 1 && parsedMonth <= 12 ? parsedMonth : null;
	}
	const knownMonth = MONTH_NAMES.get(normalizedName);
	if (knownMonth !== undefined) {
		return knownMonth;
	}
	return parseLocalizedMonthName(value.trim());
}

function parseLocalizedMonthName(value: string): number | null {
	if (typeof obsidianMoment !== "function") {
		return null;
	}
	const parsed = (obsidianMoment as unknown as StrictMomentFactory)(value, ["MMMM", "MMM"], true);
	if (!isStrictMomentWithMonth(parsed)) {
		return null;
	}
	const isValid = parsed.isValid();
	if (typeof isValid !== "boolean" || !isValid) {
		return null;
	}
	const monthIndex = parsed.month();
	if (typeof monthIndex !== "number") {
		return null;
	}
	const month = monthIndex + 1;
	return month >= 1 && month <= 12 ? month : null;
}

type StrictMomentFactory = (input: string, formats: string | string[], strict: boolean) => unknown;

function parseDateWithObsidianMoment(value: string, format: string): Date | null {
	if (typeof obsidianMoment !== "function") {
		return null;
	}
	const parsed = (obsidianMoment as unknown as StrictMomentFactory)(value, format, true);
	if (!isStrictMomentWithDate(parsed)) {
		return null;
	}
	const isValid = parsed.isValid();
	if (typeof isValid !== "boolean" || !isValid) {
		return null;
	}
	const date: unknown = parsed.toDate();
	return date instanceof Date && !Number.isNaN(date.getTime()) ? date : null;
}

function isStrictMomentWithMonth(value: unknown): value is StrictMomentWithMonth {
	if (!isRecord(value)) {
		return false;
	}
	return isUnknownFunction(value.isValid) && isUnknownFunction(value.month);
}

function isStrictMomentWithDate(value: unknown): value is StrictMomentWithDate {
	if (!isRecord(value)) {
		return false;
	}
	return isUnknownFunction(value.isValid) && isUnknownFunction(value.toDate);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function isUnknownFunction(value: unknown): value is () => unknown {
	return typeof value === "function";
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
