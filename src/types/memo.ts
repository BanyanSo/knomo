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

export interface DailyRef {
	path: string;
	heading: string | null;
	sectionType?: DailyRefSectionType;
	lineNumberHint: number | null;
}
