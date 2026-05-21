export interface TagQueryRange {
	from: number;
	to: number;
	query: string;
}

export interface TextReplacement {
	value: string;
	cursor: number;
}

export function getHashInsertionText(value: string, cursor: number): string {
	if (cursor <= 0) {
		return "#";
	}
	const previousChar = value.charAt(cursor - 1);
	return /\s/.test(previousChar) ? "#" : " #";
}

export function getTagQueryAtCursor(value: string, cursor: number): TagQueryRange | null {
	if (cursor < 0 || cursor > value.length) {
		return null;
	}
	let hashIndex = cursor - 1;
	while (hashIndex >= 0) {
		const char = value.charAt(hashIndex);
		if (char === "#") {
			break;
		}
		if (char === "]" || /\s/.test(char)) {
			return null;
		}
		hashIndex -= 1;
	}
	if (hashIndex < 0 || !isTagStart(value, hashIndex)) {
		return null;
	}
	return {
		from: hashIndex,
		to: cursor,
		query: value.slice(hashIndex + 1, cursor),
	};
}

export function replaceTagQueryWithSuggestion(value: string, range: TagQueryRange, tag: string): TextReplacement {
	const normalizedTag = tag.replace(/^#/, "");
	const replacement = `#${normalizedTag}`;
	return {
		value: `${value.slice(0, range.from)}${replacement}${value.slice(range.to)}`,
		cursor: range.from + replacement.length,
	};
}

function isTagStart(value: string, hashIndex: number): boolean {
	if (hashIndex === 0) {
		return true;
	}
	return /[\s([{]/.test(value.charAt(hashIndex - 1));
}
