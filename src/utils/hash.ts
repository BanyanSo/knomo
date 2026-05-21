import { extractTrailingBlockId, findLastEffectiveLineIndex } from "./markdown";

export function hashText(value: string): string {
	let hash = 0x811c9dc5;
	for (let index = 0; index < value.length; index += 1) {
		hash ^= value.charCodeAt(index);
		hash = Math.imul(hash, 0x01000193);
	}
	return `fnv1a-${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

export function normalizeMemoContentForHash(content: string): string {
	const normalizedContent = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
	const lines = normalizedContent.split("\n");
	const firstLineBlockId = extractTrailingBlockId(lines[0] ?? "");
	if (firstLineBlockId.blockId !== null) {
		lines[0] = firstLineBlockId.text;
	}

	const lastEffectiveLineIndex = findLastEffectiveLineIndex(lines);
	if (lastEffectiveLineIndex !== -1) {
		const lastLineBlockId = extractTrailingBlockId(lines[lastEffectiveLineIndex]);
		if (lastLineBlockId.blockId !== null) {
			lines[lastEffectiveLineIndex] = lastLineBlockId.text;
		}
	}

	return lines.join("\n");
}

export function hashMemoContent(content: string): string {
	return hashText(normalizeMemoContentForHash(content));
}
