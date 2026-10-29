// B0：输入、Daily 原文、解析正文及块结构分别验收；空白均属于样例。
type MemoFixtureLayout = "inline" | "block" | "separated";
export interface MemoMarkdownConsistencyFixture {
	name: string;
	content: string;
	layout: MemoFixtureLayout;
	wide?: boolean;
	anchorLine?: number;
	anchoredWide?: boolean;
}

export const memoMarkdownConsistencyFixtures: readonly MemoMarkdownConsistencyFixture[] = [
	{ name: "prose", content: "first  \nsecond\\\nthird<br>fourth", layout: "inline", anchorLine: 2 },
	{ name: "ordinary-multiline", content: "first\nsecond", layout: "inline", anchorLine: 1 },
	{ name: "tabbed-prose", content: "first\n\tcontinued", layout: "inline", wide: true, anchorLine: 1 },
	{ name: "single-trailing-spaces", content: "last  ", layout: "inline", anchoredWide: true },
	{ name: "nonbreaking-space", content: "last\u00a0", layout: "inline", anchoredWide: true },
	{ name: "paragraph-trailing-spaces", content: "first  \nsecond \t\n\n", layout: "inline", wide: true, anchorLine: 1 },
	{ name: "quote", content: "> first\n> second", layout: "block" },
	{ name: "callout", content: "> [!note]- Title\n> body\n>\n> second", layout: "block" },
	...[1, 2, 3, 4, 5, 6].map(level => ({ name: `heading-${level}`, content: `${"#".repeat(level)} Heading`, layout: "block" as const })),
	{ name: "bullet-list", content: "- first\n  - nested\n- second", layout: "block" },
	{ name: "ordered-list", content: "3. first\n4. second", layout: "separated" },
	{ name: "ordered-one", content: "1. first\n2. second", layout: "block" },
	{ name: "task-list", content: "- [ ] first\n  continuation\n  - [x] nested", layout: "block" },
	{ name: "fence", content: "```md\n- 08:00 fake\n# example\n```\n\n", layout: "block" },
	{ name: "open-fence", content: "~~~js\nconst text = 1;", layout: "block" },
	{ name: "rule", content: "---\n\nafter", layout: "separated" },
	{ name: "star-rule", content: "***\n\nafter", layout: "block" },
	{ name: "setext", content: "Title\ncontinued title\n===", layout: "separated" },
	{ name: "table", content: "| A | B |\n| --- | --- |\n| C | D |", layout: "separated" },
	{ name: "indented-code", content: "    code\n\tsecond\n\n    third", layout: "separated" },
	{ name: "three-space-heading", content: "   # Heading", layout: "block" },
	{ name: "leading-trailing-blanks", content: "\n\nfirst\n\n\nlast  \n\n", layout: "separated" },
	{ name: "space-only-leading-line", content: "  \nfirst\n\t\nlast", layout: "separated" },
	{ name: "nested-blocks", content: "> - first\n>\n>   ```js\n>   x\n>   ```", layout: "block" },
	{ name: "prose-then-code", content: "intro\n\n```md\nliteral ^code", layout: "inline", wide: true },
	{ name: "prose-then-table", content: "intro\n\n| A | B |\n| --- | --- |\n| C | D |", layout: "inline", wide: true },
	{ name: "prose-then-list", content: "intro\n\n- first\n  - nested\n- second", layout: "inline", wide: true },
	{ name: "multiline-prose-then-code", content: "first\nsecond\n\n```md\nliteral ^code", layout: "inline", wide: true, anchorLine: 1 },
	{ name: "incomplete-heading", content: "#nospace\nplain", layout: "inline", anchorLine: 1 },
	{ name: "math", content: "$$\nx + y\n$$", layout: "block" },
	{ name: "comment", content: "%%\ncomment\n%%\nbody", layout: "block" },
	{ name: "html-block", content: "<div>\nbody\n</div>", layout: "block" },
	{ name: "custom-html", content: "<custom>\nbody\n</custom>", layout: "separated" },
];

export function expectedDailyMemo(fixture: MemoMarkdownConsistencyFixture, time: string, blockId: string | null = null): string {
	const lines = fixture.content.split("\n");
	const layout = fixture.layout;
	const wide = layout !== "inline" || fixture.wide === true || (blockId !== null && (lines.length > 1 || fixture.anchoredWide === true));
	const id = blockId === null ? "" : ` ^${blockId}`;
	const indent = (line: string) => `${wide ? "\t" : "  "}${line}`;
	if (layout === "inline" && blockId !== null) {
		const index = fixture.anchorLine ?? 0;
		lines[index] += id;
	}
	return layout === "inline"
		? [`-${wide ? "   " : " "}${time} ${lines[0]}`, ...lines.slice(1).map(indent)].join("\n")
		: [`-   ${time}${id}`, ...(layout === "separated" ? ["\t"] : []), ...lines.map(indent)].join("\n");
}
