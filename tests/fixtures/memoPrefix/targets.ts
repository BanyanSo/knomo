// 方案 25 类目标布局的固定 raw；独立于历史快照和测试运行时的 writer。
export const memoPrefixTargets = [
	{
		"category": "01",
		"name": "plain",
		"raw": "- 12:34:56 plain text",
		"anchoredRaw": "- 12:34:56 plain text ^memo-anchor"
	},
	{
		"category": "02",
		"name": "quote",
		"raw": "- 12:34:56\n  > quote",
		"anchoredRaw": "- 12:34:56 ^memo-anchor\n  > quote"
	},
	{
		"category": "03",
		"name": "nested-list",
		"raw": "- 12:34:56\n  - parent\n    - child",
		"anchoredRaw": "- 12:34:56 ^memo-anchor\n  - parent\n    - child"
	},
	{
		"category": "04",
		"name": "tasks",
		"raw": "- 12:34:56\n  - [ ] task\n    - [x] nested",
		"anchoredRaw": "- 12:34:56 ^memo-anchor\n  - [ ] task\n    - [x] nested"
	},
	{
		"category": "05",
		"name": "atx",
		"raw": "- 12:34:56\n  # Heading\n  \n  text",
		"anchoredRaw": "- 12:34:56 ^memo-anchor\n  # Heading\n  \n  text"
	},
	{
		"category": "06",
		"name": "fence",
		"raw": "- 12:34:56\n  ```md\n  - 08:00 fake\n  ```",
		"anchoredRaw": "- 12:34:56 ^memo-anchor\n  ```md\n  - 08:00 fake\n  ```"
	},
	{
		"category": "07",
		"name": "prose-tab",
		"raw": "- 12:34:56 first\tsecond",
		"anchoredRaw": "- 12:34:56 first\tsecond ^memo-anchor"
	},
	{
		"category": "08",
		"name": "literal-tab-fence",
		"raw": "- 12:34:56\n  ```md\n  \tcode\n  ```",
		"anchoredRaw": "- 12:34:56 ^memo-anchor\n  ```md\n  \tcode\n  ```"
	},
	{
		"category": "09",
		"name": "tab-list",
		"raw": "- 12:34:56\n  -\tparent\n  \t- child",
		"anchoredRaw": "- 12:34:56 ^memo-anchor\n  -\tparent\n  \t- child"
	},
	{
		"category": "10",
		"name": "multiline",
		"raw": "- 12:34:56 first  \n  second\\\n  third",
		"anchoredRaw": "- 12:34:56 first  \n  second\\\n  third ^memo-anchor"
	},
	{
		"category": "11",
		"name": "prose-table",
		"raw": "- 12:34:56 intro\n  \n  | A | B |\n  | --- | --- |\n  | C | D |",
		"anchoredRaw": "- 12:34:56 intro ^memo-anchor\n  \n  | A | B |\n  | --- | --- |\n  | C | D |"
	},
	{
		"category": "12",
		"name": "table",
		"raw": "-   12:34:56\n\t\n\t| A | B |\n\t| --- | --- |\n\t| C | D |",
		"anchoredRaw": "-   12:34:56 ^memo-anchor\n\t\n\t| A | B |\n\t| --- | --- |\n\t| C | D |"
	},
	{
		"category": "13",
		"name": "indented-code",
		"raw": "-   12:34:56\n\t\n\t    code",
		"anchoredRaw": "-   12:34:56 ^memo-anchor\n\t\n\t    code"
	},
	{
		"category": "14",
		"name": "setext",
		"raw": "-   12:34:56\n\t\n\tTitle\n\t===",
		"anchoredRaw": "-   12:34:56 ^memo-anchor\n\t\n\tTitle\n\t==="
	},
	{
		"category": "15",
		"name": "ordered-three",
		"raw": "-   12:34:56\n\t\n\t3. first\n\t4. second",
		"anchoredRaw": "-   12:34:56 ^memo-anchor\n\t\n\t3. first\n\t4. second"
	},
	{
		"category": "16",
		"name": "dash-rule",
		"raw": "-   12:34:56\n\t\n\t---\n\t\n\tafter",
		"anchoredRaw": "-   12:34:56 ^memo-anchor\n\t\n\t---\n\t\n\tafter"
	},
	{
		"category": "17",
		"name": "custom-html",
		"raw": "-   12:34:56\n\t\n\t<custom>\n\tbody\n\t</custom>",
		"anchoredRaw": "-   12:34:56 ^memo-anchor\n\t\n\t<custom>\n\tbody\n\t</custom>"
	},
	{
		"category": "18",
		"name": "anchored-quote",
		"raw": "- 12:34:56\n  > [!note]\n  > quote",
		"anchoredRaw": "- 12:34:56 ^memo-anchor\n  > [!note]\n  > quote"
	},
	{
		"category": "19",
		"name": "anchored-tasks",
		"raw": "- 12:34:56\n  - [ ] task\n    - [x] nested",
		"anchoredRaw": "- 12:34:56 ^memo-anchor\n  - [ ] task\n    - [x] nested"
	},
	{
		"category": "20",
		"name": "child-anchor",
		"raw": "- 12:34:56 intro\n  \n  - child ^child-anchor",
		"anchoredRaw": "- 12:34:56 intro ^memo-anchor\n  \n  - child ^child-anchor"
	},
	{
		"category": "21",
		"name": "trailing-spaces",
		"raw": "- 12:34:56 first\n  second  ",
		"anchoredRaw": "- 12:34:56 first\n  second   ^memo-anchor"
	},
	{
		"category": "22",
		"name": "tab-quote-code",
		"raw": "-   12:34:56\n\t>\t\tcode",
		"anchoredRaw": "-   12:34:56 ^memo-anchor\n\t>\t\tcode"
	},
	{
		"category": "23",
		"name": "indented-tab-fence",
		"raw": "-   12:34:56\n\t   ```md\n\t\tcode\n\t   ```",
		"anchoredRaw": "-   12:34:56 ^memo-anchor\n\t   ```md\n\t\tcode\n\t   ```"
	},
	{
		"category": "24",
		"name": "leading-blank-table",
		"raw": "- 12:34:56\n  \n  | A | B |\n  | --- | --- |\n  | C | D |",
		"anchoredRaw": "- 12:34:56 ^memo-anchor\n  \n  | A | B |\n  | --- | --- |\n  | C | D |"
	},
	{
		"category": "25",
		"name": "references",
		"raw": "- 12:34:56 [[Other#^quote-of-the-day|原有别名]]\n  \n  - [ ] task",
		"anchoredRaw": "- 12:34:56 [[Other#^quote-of-the-day|原有别名]] ^memo-anchor\n  \n  - [ ] task"
	}
] as const;
