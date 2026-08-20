export type MemoStatus = "active" | "deleted" | "error";
export type DailyRefSectionType = "heading" | "root";
export type MemoImageSyntax = "obsidian_embed" | "markdown_image";
export type MemoLinkSyntax = "wiki_link" | "markdown_link" | "url";

export interface MemoImageRef {
	path: string;
	altText: string;
	syntax: MemoImageSyntax;
}

export interface MemoLinkRef {
	target: string;
	displayText: string | null;
	syntax: MemoLinkSyntax;
}

export interface MemoReference {
	memoId: string;
	referenceText: string;
}

export interface DailyRef {
	path: string;
	heading: string | null;
	sectionType?: DailyRefSectionType;
	lineNumberHint: number | null;
}

export interface ParsedMemoBlock {
	startLine: number;
	endLine: number;
	rawBlock: string;
	time: string;
	content: string;
	contentHash: string;
	blockId: string | null;
	tags: string[];
	links: MemoLinkRef[];
	images: MemoImageRef[];
}
