import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { buildCatalogObservation } from "../src/services/MemoCatalogService";
import { mapSearchText, renderSearchHits, clearSearchHits, splitSearchGraphemes } from "../src/ui/SearchHitRenderer";
import type { MemoViewItem } from "../src/types/memoView";
import type { MemoObservation } from "../src/types/catalog";

function environment(html: string) {
	const dom = new JSDOM(html);
	const helperDocument = dom.window.document.implementation.createHTMLDocument("helper window");
	const previous = Object.getOwnPropertyDescriptor(globalThis, "createEl");
	Object.defineProperty(globalThis, "createEl", { configurable: true, writable: true,
		value: (tag: string) => helperDocument.createElement(tag) });
	return { window: dom.window, close() {
		dom.window.close();
		if (previous) Object.defineProperty(globalThis, "createEl", previous);
		else Reflect.deleteProperty(globalThis, "createEl");
	} };
}

function memo(content: string): MemoViewItem {
	const observation = buildCatalogObservation({ sourcePath: "Daily.md", logicalDate: "2026-10-09", section: null, time: "09:00", content,
		tags: [], links: [], images: [], tasks: [], timeBuoyDates: [], contentHash: "original", rawBlockHash: "raw",
		sourceRevision: "original", startLine: 1, endLine: 4, occurrenceIndex: 0, occurrenceCount: 1, existingBlockId: null } as MemoObservation);
	return { id: "one", contentSnapshot: content, contentHash: "original", createdAt: "2026-10-09T09:00", updatedAt: "", status: "active",
		tags: [], links: [], images: [], dailyRef: { path: "Daily.md", heading: null, lineNumberHint: 1 }, catalog: { observation } as NonNullable<MemoViewItem["catalog"]> };
}

test("NFKC、组合字符、全角和折叠空白都映射回原始字素", () => {
	const text = "Ａﬃe\u0301\t  😀";
	const mapped = mapSearchText(text)!;
	assert.equal(mapped.text, "affié 😀");
	assert.deepEqual(mapped.ranges[1], mapped.ranges[3]);
	assert.equal(text.slice(mapped.ranges[4].from, mapped.ranges[4].to), "e\u0301");
});

test("跨格式短语只包裹文字，链接、任务与复制用的原正文保持原样；清除移除旧高亮", () => {
	const dom = environment('<article><div class="knomo-card-body"><div class="knomo-card-content"><p>今天<strong>完成</strong><a href="Target">项目</a><input type="checkbox"></p></div></div></article>');
	try {
		const target = dom.window.document.querySelector<HTMLElement>(".knomo-card-content")!;
		const item = memo("今天**完成**[项目](Target)");
		const link = target.querySelector("a"), checkbox = target.querySelector("input");
		renderSearchHits(target, item, { textTerms: ["今天完成项目"] });
		assert.equal(target.querySelectorAll("mark").length, 3);
		assert.ok([...target.querySelectorAll("mark")].every(mark => mark.ownerDocument === target.ownerDocument));
		assert.equal(target.querySelector("a"), link);
		assert.equal(target.querySelector("input"), checkbox);
		assert.equal(item.contentSnapshot, "今天**完成**[项目](Target)");
		assert.equal(target.querySelector("a")!.getAttribute("href"), "Target");
		renderSearchHits(target, item, { searchDate: { kind: "range", granularity: "day", fromDate: "2026-10-09", toDate: "2026-10-09" } });
		assert.equal(target.querySelectorAll("mark").length, 0);
		assert.equal(target.textContent, "今天完成项目");
	} finally { dom.close(); }
});

test("预览外、路径和其他字段命中不增加摘要或解释；只高亮当前可见正文", () => {
	const full = "开头".repeat(100) + "👨‍👩‍👧‍👦".repeat(5) + "项目复盘";
	assert.equal(splitSearchGraphemes(full).filter(part => part.text.includes("\u200d")).every(part => part.text === "👨‍👩‍👧‍👦"), true);
	const dom = environment('<div class="knomo-card-body"><div class="knomo-card-content"><p>开头开头</p></div></div>');
	try {
		const body = dom.window.document.querySelector<HTMLElement>(".knomo-card-body")!;
		const target = body.querySelector<HTMLElement>(".knomo-card-content")!;
		const original = body.innerHTML;
		renderSearchHits(target, memo(full), { textTerms: ["项目复盘"] });
		assert.equal(body.innerHTML, original);
		const item = memo("可见别名");
		item.catalog!.observation.linkTargets = ["hidden-path"];
		renderSearchHits(target, item, { textTerms: ["hidden-path"] });
		assert.equal(body.innerHTML, original);
		clearSearchHits(target);
		assert.equal(body.innerHTML, original);
	} finally { dom.close(); }
});
