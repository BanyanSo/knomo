// 历史 writer 与其相同提交的依赖生成后冻结；测试只读取字面 raw，不运行历史或当前生成器。
export const memoPrefixHistory = [
	{
		"sourceCommit": "06fd44f564b2e9ada0c0e9e5f857146e12c050cf",
		"samples": [
			{
				"category": "01",
				"name": "plain",
				"content": "plain text",
				"raw": "- 12:34:56 plain text",
				"anchoredRaw": "- 12:34:56 plain text ^memo-anchor"
			},
			{
				"category": "02",
				"name": "quote",
				"content": "> quote",
				"raw": "-   12:34:56\n\t> quote",
				"anchoredRaw": "-   12:34:56 ^memo-anchor\n\t> quote"
			},
			{
				"category": "03",
				"name": "nested-list",
				"content": "- parent\n  - child",
				"raw": "-   12:34:56\n\t- parent\n\t  - child",
				"anchoredRaw": "-   12:34:56 ^memo-anchor\n\t- parent\n\t  - child"
			},
			{
				"category": "04",
				"name": "tasks",
				"content": "- [ ] task\n  - [x] nested",
				"raw": "-   12:34:56\n\t- [ ] task\n\t  - [x] nested",
				"anchoredRaw": "-   12:34:56 ^memo-anchor\n\t- [ ] task\n\t  - [x] nested"
			},
			{
				"category": "05",
				"name": "atx",
				"content": "# Heading\n\ntext",
				"raw": "-   12:34:56\n\t# Heading\n\t\n\ttext",
				"anchoredRaw": "-   12:34:56 ^memo-anchor\n\t# Heading\n\t\n\ttext"
			},
			{
				"category": "06",
				"name": "fence",
				"content": "```md\n- 08:00 fake\n```",
				"raw": "-   12:34:56\n\t```md\n\t- 08:00 fake\n\t```",
				"anchoredRaw": "-   12:34:56 ^memo-anchor\n\t```md\n\t- 08:00 fake\n\t```"
			},
			{
				"category": "07",
				"name": "prose-tab",
				"content": "first\tsecond",
				"raw": "-   12:34:56 first\tsecond",
				"anchoredRaw": "-   12:34:56 first\tsecond ^memo-anchor"
			},
			{
				"category": "08",
				"name": "literal-tab-fence",
				"content": "```md\n\tcode\n```",
				"raw": "-   12:34:56\n\t```md\n\t\tcode\n\t```",
				"anchoredRaw": "-   12:34:56 ^memo-anchor\n\t```md\n\t\tcode\n\t```"
			},
			{
				"category": "09",
				"name": "tab-list",
				"content": "-\tparent\n\t- child",
				"raw": "-   12:34:56\n\t-\tparent\n\t\t- child",
				"anchoredRaw": "-   12:34:56 ^memo-anchor\n\t-\tparent\n\t\t- child"
			},
			{
				"category": "10",
				"name": "multiline",
				"content": "first  \nsecond\\\nthird",
				"raw": "- 12:34:56 first  \n  second\\\n  third",
				"anchoredRaw": "-   12:34:56 first  \n\tsecond\\\n\tthird ^memo-anchor"
			},
			{
				"category": "11",
				"name": "prose-table",
				"content": "intro\n\n| A | B |\n| --- | --- |\n| C | D |",
				"raw": "-   12:34:56 intro\n\t\n\t| A | B |\n\t| --- | --- |\n\t| C | D |",
				"anchoredRaw": "-   12:34:56 intro ^memo-anchor\n\t\n\t| A | B |\n\t| --- | --- |\n\t| C | D |"
			},
			{
				"category": "12",
				"name": "table",
				"content": "| A | B |\n| --- | --- |\n| C | D |",
				"raw": "-   12:34:56\n\t\n\t| A | B |\n\t| --- | --- |\n\t| C | D |",
				"anchoredRaw": "-   12:34:56 ^memo-anchor\n\t\n\t| A | B |\n\t| --- | --- |\n\t| C | D |"
			},
			{
				"category": "13",
				"name": "indented-code",
				"content": "    code",
				"raw": "-   12:34:56\n\t\n\t    code",
				"anchoredRaw": "-   12:34:56 ^memo-anchor\n\t\n\t    code"
			},
			{
				"category": "14",
				"name": "setext",
				"content": "Title\n===",
				"raw": "-   12:34:56\n\t\n\tTitle\n\t===",
				"anchoredRaw": "-   12:34:56 ^memo-anchor\n\t\n\tTitle\n\t==="
			},
			{
				"category": "15",
				"name": "ordered-three",
				"content": "3. first\n4. second",
				"raw": "-   12:34:56\n\t\n\t3. first\n\t4. second",
				"anchoredRaw": "-   12:34:56 ^memo-anchor\n\t\n\t3. first\n\t4. second"
			},
			{
				"category": "16",
				"name": "dash-rule",
				"content": "---\n\nafter",
				"raw": "-   12:34:56\n\t\n\t---\n\t\n\tafter",
				"anchoredRaw": "-   12:34:56 ^memo-anchor\n\t\n\t---\n\t\n\tafter"
			},
			{
				"category": "17",
				"name": "custom-html",
				"content": "<custom>\nbody\n</custom>",
				"raw": "-   12:34:56\n\t\n\t<custom>\n\tbody\n\t</custom>",
				"anchoredRaw": "-   12:34:56 ^memo-anchor\n\t\n\t<custom>\n\tbody\n\t</custom>"
			},
			{
				"category": "18",
				"name": "anchored-quote",
				"content": "> [!note]\n> quote",
				"raw": "-   12:34:56\n\t> [!note]\n\t> quote",
				"anchoredRaw": "-   12:34:56 ^memo-anchor\n\t> [!note]\n\t> quote"
			},
			{
				"category": "19",
				"name": "anchored-tasks",
				"content": "- [ ] task\n  - [x] nested",
				"raw": "-   12:34:56\n\t- [ ] task\n\t  - [x] nested",
				"anchoredRaw": "-   12:34:56 ^memo-anchor\n\t- [ ] task\n\t  - [x] nested"
			},
			{
				"category": "20",
				"name": "child-anchor",
				"content": "intro\n\n- child ^child-anchor",
				"raw": "-   12:34:56 intro\n\t\n\t- child ^child-anchor",
				"anchoredRaw": "-   12:34:56 intro ^memo-anchor\n\t\n\t- child ^child-anchor"
			},
			{
				"category": "21",
				"name": "trailing-spaces",
				"content": "first\nsecond  ",
				"raw": "- 12:34:56 first\n  second  ",
				"anchoredRaw": "-   12:34:56 first\n\tsecond   ^memo-anchor"
			},
			{
				"category": "22",
				"name": "tab-quote-code",
				"content": ">\t\tcode",
				"raw": "-   12:34:56\n\t>\t\tcode",
				"anchoredRaw": "-   12:34:56 ^memo-anchor\n\t>\t\tcode"
			},
			{
				"category": "23",
				"name": "indented-tab-fence",
				"content": "   ```md\n\tcode\n   ```",
				"raw": "-   12:34:56\n\t   ```md\n\t\tcode\n\t   ```",
				"anchoredRaw": "-   12:34:56 ^memo-anchor\n\t   ```md\n\t\tcode\n\t   ```"
			},
			{
				"category": "24",
				"name": "leading-blank-table",
				"content": "\n| A | B |\n| --- | --- |\n| C | D |",
				"raw": "-   12:34:56\n\t\n\t\n\t| A | B |\n\t| --- | --- |\n\t| C | D |",
				"anchoredRaw": "-   12:34:56 ^memo-anchor\n\t\n\t\n\t| A | B |\n\t| --- | --- |\n\t| C | D |"
			},
			{
				"category": "25",
				"name": "references",
				"content": "[[Other#^quote-of-the-day|原有别名]]\n\n- [ ] task",
				"raw": "-   12:34:56 [[Other#^quote-of-the-day|原有别名]]\n\t\n\t- [ ] task",
				"anchoredRaw": "-   12:34:56 [[Other#^quote-of-the-day|原有别名]] ^memo-anchor\n\t\n\t- [ ] task"
			}
		]
	},
	{
		"sourceCommit": "74aa77c8cafedd4259fab282695a446922dbbe07",
		"samples": [
			{
				"category": "01",
				"name": "plain",
				"content": "plain text",
				"raw": "- 12:34:56 plain text",
				"anchoredRaw": "- 12:34:56 plain text ^memo-anchor"
			},
			{
				"category": "02",
				"name": "quote",
				"content": "> quote",
				"raw": "- 12:34:56\n  > quote",
				"anchoredRaw": "-   12:34:56 ^memo-anchor\n\t> quote"
			},
			{
				"category": "03",
				"name": "nested-list",
				"content": "- parent\n  - child",
				"raw": "- 12:34:56\n  - parent\n    - child",
				"anchoredRaw": "-   12:34:56 ^memo-anchor\n\t- parent\n\t  - child"
			},
			{
				"category": "04",
				"name": "tasks",
				"content": "- [ ] task\n  - [x] nested",
				"raw": "- 12:34:56\n  - [ ] task\n    - [x] nested",
				"anchoredRaw": "-   12:34:56 ^memo-anchor\n\t- [ ] task\n\t  - [x] nested"
			},
			{
				"category": "05",
				"name": "atx",
				"content": "# Heading\n\ntext",
				"raw": "- 12:34:56\n  # Heading\n  \n  text",
				"anchoredRaw": "-   12:34:56 ^memo-anchor\n\t# Heading\n\t\n\ttext"
			},
			{
				"category": "06",
				"name": "fence",
				"content": "```md\n- 08:00 fake\n```",
				"raw": "- 12:34:56\n  ```md\n  - 08:00 fake\n  ```",
				"anchoredRaw": "-   12:34:56 ^memo-anchor\n\t```md\n\t- 08:00 fake\n\t```"
			},
			{
				"category": "07",
				"name": "prose-tab",
				"content": "first\tsecond",
				"raw": "- 12:34:56 first\tsecond",
				"anchoredRaw": "- 12:34:56 first\tsecond ^memo-anchor"
			},
			{
				"category": "08",
				"name": "literal-tab-fence",
				"content": "```md\n\tcode\n```",
				"raw": "- 12:34:56\n  ```md\n  \tcode\n  ```",
				"anchoredRaw": "-   12:34:56 ^memo-anchor\n\t```md\n\t\tcode\n\t```"
			},
			{
				"category": "09",
				"name": "tab-list",
				"content": "-\tparent\n\t- child",
				"raw": "- 12:34:56\n  -\tparent\n  \t- child",
				"anchoredRaw": "-   12:34:56 ^memo-anchor\n\t-\tparent\n\t\t- child"
			},
			{
				"category": "10",
				"name": "multiline",
				"content": "first  \nsecond\\\nthird",
				"raw": "- 12:34:56 first  \n  second\\\n  third",
				"anchoredRaw": "- 12:34:56 first  \n  second\\\n  third ^memo-anchor"
			},
			{
				"category": "11",
				"name": "prose-table",
				"content": "intro\n\n| A | B |\n| --- | --- |\n| C | D |",
				"raw": "- 12:34:56 intro\n  \n  | A | B |\n  | --- | --- |\n  | C | D |",
				"anchoredRaw": "- 12:34:56 intro ^memo-anchor\n  \n  | A | B |\n  | --- | --- |\n  | C | D |"
			},
			{
				"category": "12",
				"name": "table",
				"content": "| A | B |\n| --- | --- |\n| C | D |",
				"raw": "-   12:34:56\n\t\n\t| A | B |\n\t| --- | --- |\n\t| C | D |",
				"anchoredRaw": "-   12:34:56 ^memo-anchor\n\t\n\t| A | B |\n\t| --- | --- |\n\t| C | D |"
			},
			{
				"category": "13",
				"name": "indented-code",
				"content": "    code",
				"raw": "-   12:34:56\n\t\n\t    code",
				"anchoredRaw": "-   12:34:56 ^memo-anchor\n\t\n\t    code"
			},
			{
				"category": "14",
				"name": "setext",
				"content": "Title\n===",
				"raw": "-   12:34:56\n\t\n\tTitle\n\t===",
				"anchoredRaw": "-   12:34:56 ^memo-anchor\n\t\n\tTitle\n\t==="
			},
			{
				"category": "15",
				"name": "ordered-three",
				"content": "3. first\n4. second",
				"raw": "-   12:34:56\n\t\n\t3. first\n\t4. second",
				"anchoredRaw": "-   12:34:56 ^memo-anchor\n\t\n\t3. first\n\t4. second"
			},
			{
				"category": "16",
				"name": "dash-rule",
				"content": "---\n\nafter",
				"raw": "-   12:34:56\n\t\n\t---\n\t\n\tafter",
				"anchoredRaw": "-   12:34:56 ^memo-anchor\n\t\n\t---\n\t\n\tafter"
			},
			{
				"category": "17",
				"name": "custom-html",
				"content": "<custom>\nbody\n</custom>",
				"raw": "-   12:34:56\n\t\n\t<custom>\n\tbody\n\t</custom>",
				"anchoredRaw": "-   12:34:56 ^memo-anchor\n\t\n\t<custom>\n\tbody\n\t</custom>"
			},
			{
				"category": "18",
				"name": "anchored-quote",
				"content": "> [!note]\n> quote",
				"raw": "- 12:34:56\n  > [!note]\n  > quote",
				"anchoredRaw": "-   12:34:56 ^memo-anchor\n\t> [!note]\n\t> quote"
			},
			{
				"category": "19",
				"name": "anchored-tasks",
				"content": "- [ ] task\n  - [x] nested",
				"raw": "- 12:34:56\n  - [ ] task\n    - [x] nested",
				"anchoredRaw": "-   12:34:56 ^memo-anchor\n\t- [ ] task\n\t  - [x] nested"
			},
			{
				"category": "20",
				"name": "child-anchor",
				"content": "intro\n\n- child ^child-anchor",
				"raw": "-   12:34:56 intro\n\t\n\t- child ^child-anchor",
				"anchoredRaw": "-   12:34:56 intro ^memo-anchor\n\t\n\t- child ^child-anchor"
			},
			{
				"category": "21",
				"name": "trailing-spaces",
				"content": "first\nsecond  ",
				"raw": "- 12:34:56 first\n  second  ",
				"anchoredRaw": "-   12:34:56 first\n\tsecond   ^memo-anchor"
			},
			{
				"category": "22",
				"name": "tab-quote-code",
				"content": ">\t\tcode",
				"raw": "-   12:34:56\n\t>\t\tcode",
				"anchoredRaw": "-   12:34:56 ^memo-anchor\n\t>\t\tcode"
			},
			{
				"category": "23",
				"name": "indented-tab-fence",
				"content": "   ```md\n\tcode\n   ```",
				"raw": "-   12:34:56\n\t   ```md\n\t\tcode\n\t   ```",
				"anchoredRaw": "-   12:34:56 ^memo-anchor\n\t   ```md\n\t\tcode\n\t   ```"
			},
			{
				"category": "24",
				"name": "leading-blank-table",
				"content": "\n| A | B |\n| --- | --- |\n| C | D |",
				"raw": "- 12:34:56\n  \n  | A | B |\n  | --- | --- |\n  | C | D |",
				"anchoredRaw": "-   12:34:56 ^memo-anchor\n\t\n\t\n\t| A | B |\n\t| --- | --- |\n\t| C | D |"
			},
			{
				"category": "25",
				"name": "references",
				"content": "[[Other#^quote-of-the-day|原有别名]]\n\n- [ ] task",
				"raw": "- 12:34:56 [[Other#^quote-of-the-day|原有别名]]\n  \n  - [ ] task",
				"anchoredRaw": "- 12:34:56 [[Other#^quote-of-the-day|原有别名]] ^memo-anchor\n  \n  - [ ] task"
			}
		]
	}
] as const;
