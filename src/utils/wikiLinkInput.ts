export interface WikiLinkRange {
	from: number;
	to: number;
	queryFrom: number;
	queryTo: number;
	query: string;
	hasClosing: boolean;
}

export interface WikiLinkFileLike {
	path: string;
	basename: string;
}

export interface WikiLinkSuggestionMatch<TFile extends WikiLinkFileLike> {
	file: TFile;
	path: string;
	basename: string;
	showPath: boolean;
}

export interface TextReplacement {
	value: string;
	cursor: number;
}

const HALF_WIDTH_TRIGGER = "[[";
const FULL_WIDTH_TRIGGER = "【【";
const WIKI_LINK_OPEN = "[[";
const WIKI_LINK_CLOSE = "]]";
const DEFAULT_WIKI_LINK_SUGGESTION_LIMIT = 10;

export function completeWikiLinkTriggerAtCursor(value: string, cursor: number): TextReplacement | null {
	if (cursor < 2 || cursor > value.length) {
		return null;
	}
	const trigger = value.slice(cursor - 2, cursor);
	if (trigger !== HALF_WIDTH_TRIGGER && trigger !== FULL_WIDTH_TRIGGER) {
		return null;
	}
	if (value.slice(cursor, cursor + 2) === WIKI_LINK_CLOSE) {
		return null;
	}
	const from = cursor - 2;
	return {
		value: `${value.slice(0, from)}${WIKI_LINK_OPEN}${WIKI_LINK_CLOSE}${value.slice(cursor)}`,
		cursor: from + WIKI_LINK_OPEN.length,
	};
}

export function getWikiLinkRangeAtCursor(value: string, cursor: number): WikiLinkRange | null {
	if (cursor < 0 || cursor > value.length) {
		return null;
	}
	const lineStart = value.lastIndexOf("\n", Math.max(0, cursor - 1)) + 1;
	const lineEndIndex = value.indexOf("\n", cursor);
	const lineEnd = lineEndIndex === -1 ? value.length : lineEndIndex;
	const searchFrom = Math.max(lineStart, cursor - 1);
	const openIndex = value.lastIndexOf(WIKI_LINK_OPEN, searchFrom);
	if (openIndex < lineStart || openIndex >= cursor) {
		return null;
	}
	const closeIndex = value.indexOf(WIKI_LINK_CLOSE, openIndex + WIKI_LINK_OPEN.length);
	if (closeIndex !== -1 && closeIndex < cursor) {
		return null;
	}
	const hasClosing = closeIndex !== -1 && closeIndex <= lineEnd;
	const queryFrom = openIndex + WIKI_LINK_OPEN.length;
	const queryTo = hasClosing ? closeIndex : cursor;
	return {
		from: openIndex,
		to: hasClosing ? closeIndex + WIKI_LINK_CLOSE.length : cursor,
		queryFrom,
		queryTo,
		query: value.slice(queryFrom, queryTo),
		hasClosing,
	};
}

export function replaceWikiLinkRangeWithLinktext(value: string, range: WikiLinkRange, linktext: string): TextReplacement {
	const replacement = `${WIKI_LINK_OPEN}${linktext}${WIKI_LINK_CLOSE}`;
	return {
		value: `${value.slice(0, range.from)}${replacement}${value.slice(range.to)}`,
		cursor: range.from + replacement.length,
	};
}

export function getWikiLinkFileSuggestions<TFile extends WikiLinkFileLike>(
	files: TFile[],
	query: string,
	limit = DEFAULT_WIKI_LINK_SUGGESTION_LIMIT,
): Array<WikiLinkSuggestionMatch<TFile>> {
	const normalizedQuery = query.trim().toLocaleLowerCase();
	const ranked: Array<{ file: TFile; rank: number; path: string; basename: string }> = [];
	for (const file of files) {
		const path = file.path;
		const basename = file.basename;
		const rank = getWikiLinkMatchRank(basename, path, normalizedQuery);
		if (rank !== null) {
			ranked.push({ file, rank, path, basename });
		}
	}
	ranked.sort((first, second) => {
		if (first.rank !== second.rank) {
			return first.rank - second.rank;
		}
		const basenameCompare = first.basename.localeCompare(second.basename);
		if (basenameCompare !== 0) {
			return basenameCompare;
		}
		return first.path.localeCompare(second.path);
	});
	const limited = ranked.slice(0, Math.max(0, limit));
	const basenameCounts = new Map<string, number>();
	for (const item of limited) {
		const key = item.basename.toLocaleLowerCase();
		basenameCounts.set(key, (basenameCounts.get(key) ?? 0) + 1);
	}
	return limited.map((item) => ({
		file: item.file,
		path: item.path,
		basename: item.basename,
		showPath: item.path.includes("/") || (basenameCounts.get(item.basename.toLocaleLowerCase()) ?? 0) > 1,
	}));
}

export function isKnomoInternalWikiLinkCandidate(path: string): boolean {
	const segments = path.toLocaleLowerCase().split("/");
	return segments.some((segment) => segment === "_knomo-data" || segment === "_knomo-system"
		|| segment === "indexes" || segment === "backups");
}

function getWikiLinkMatchRank(basename: string, path: string, query: string): number | null {
	if (query.length === 0) {
		return 10;
	}
	const normalizedBasename = basename.toLocaleLowerCase();
	const normalizedPath = path.toLocaleLowerCase();
	if (normalizedBasename === query) {
		return 0;
	}
	if (normalizedBasename.startsWith(query)) {
		return 1;
	}
	if (normalizedBasename.includes(query)) {
		return 2;
	}
	if (normalizedPath.startsWith(query)) {
		return 3;
	}
	if (normalizedPath.includes(query)) {
		return 4;
	}
	return null;
}
