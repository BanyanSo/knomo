import type { DailyRef, ParsedMemoBlock } from "../types/memo";
import { hashText } from "./hash";

export function buildDailyRef(
	path: string,
	heading: string | null,
	block: string | ParsedMemoBlock,
	lineNumberHint: number | null = null,
): DailyRef {
	const lastKnownBlock = typeof block === "string" ? block : block.rawBlock;
	return {
		path,
		heading,
		sectionType: heading === null ? "root" : "heading",
		lastKnownBlock,
		lastKnownHash: hashText(lastKnownBlock),
		lineNumberHint: typeof block === "string" ? lineNumberHint : block.startLine + 1,
		lastSyncedAt: new Date().toISOString(),
	};
}
