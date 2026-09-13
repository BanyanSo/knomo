import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { createMemoRenderPlaceholders } from "../src/ui/MemoRenderPlaceholder";
import type { MemoViewItem } from "../src/types/memoView";

test("revision 更新时复用静态显示，不转移旧句柄且同文卡片独立", () => {
	const dom = new JSDOM("<body></body>");
	const card = () => { const el = dom.window.document.createElement("div"); el.innerHTML = '<div class="knomo-card-content"></div>'; return el; };
	const old = card();
	old.firstElementChild!.innerHTML = '<ul><li><input type="checkbox" data-knomo-memo-id="old">same</li></ul>';
	const memo = { id: "old", contentSnapshot: "- [ ] same", dailyRef: { path: "Daily.md" } } as MemoViewItem;
	const seed = createMemoRenderPlaceholders([{ memo, card: old }]);
	const first = card(), second = card();
	seed({ ...memo, id: "new-1" }, first);
	seed({ ...memo, id: "new-2" }, second);
	assert.equal(first.textContent, "same");
	assert.equal(second.textContent, "same");
	assert.notEqual(first.firstElementChild!.firstElementChild, second.firstElementChild!.firstElementChild);
	assert.equal(first.querySelector("[data-knomo-memo-id]"), null);
	assert.equal(first.querySelector("input")!.disabled, true);
	assert.ok(first.querySelector("[inert]"));
	assert.equal(old.querySelector("input")!.disabled, false);
	for (const different of [{ ...memo, contentSnapshot: "changed" }, { ...memo, dailyRef: { ...memo.dailyRef, path: "Other.md" } }]) {
		const target = card(); seed(different, target); assert.equal(target.textContent, "");
	}
	const ready = card(); ready.firstElementChild!.textContent = "fresh";
	seed(memo, ready); assert.equal(ready.textContent, "fresh");
	dom.window.close();
});
