import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { MemoFocusRestore, MemoReadingPosition, type MountedMemoCard } from "../src/ui/MemoReadingContinuity";
import { createReferenceMemo } from "./helpers/referenceMemo";

function fixture() {
	const dom = new JSDOM("<main></main><input>", { pretendToBeVisual: true });
	const root = dom.window.document.querySelector("main")!;
	root.scrollTop = 500;
	root.getBoundingClientRect = () => ({ top: 0, bottom: 200 }) as DOMRect;
	dom.window.document.hasFocus = () => true;
	const card = (index: number, revision = 0, text = `memo ${index}`): MountedMemoCard => {
		const memo = createReferenceMemo();
		memo.id = `${revision}-${index}`; memo.catalog!.renderKey = memo.id; memo.contentSnapshot = text;
		const node = dom.window.document.createElement("article");
		node.innerHTML = '<button class="knomo-card-menu">Menu</button>';
		let y = index * 100 + 390;
		node.getBoundingClientRect = () => ({ top: y - root.scrollTop, bottom: y + 100 - root.scrollTop }) as DOMRect;
		Object.assign(node, { move: (position: number) => { y = position; } });
		root.append(node); return { memo, card: node };
	};
	return { dom, root, card, move: (card: HTMLElement, y: number) => (card as HTMLElement & { move: (y: number) => void }).move(y) };
}

test("删除阅读卡后邻卡使用自己的旧偏移，顶部仍留在顶部", () => {
	const h = fixture();
	try {
		const before = [0, 1, 2, 3].map(index => h.card(index)), reading = new MemoReadingPosition(h.root, before);
		before[1].card.remove(); h.move(before[2].card, 490); h.move(before[3].card, 590);
		reading.restore([before[0], before[2], before[3]], new Map([[before[1].memo.id, null]]));
		assert.equal(h.root.scrollTop, 400, "邻卡回到原 90px 偏移，而不是被删卡的 -10px");
		h.root.scrollTop = 0;
		const top = new MemoReadingPosition(h.root, [before[0], before[2]]);
		h.root.scrollTop = 20; top.restore([before[0], before[2]]);
		assert.equal(h.root.scrollTop, 0);
	} finally { h.dom.window.close(); }
});

test("外部全换键只按可比较布局补偿，重排、重复与仅同条数均退回原位置", () => {
	for (const mode of ["grow", "reorder", "duplicate", "replace-all", "replace-time"] as const) {
		const h = fixture();
		try {
			const before = [0, 1, 2, 3].map(index => h.card(index));
			if (mode === "duplicate") before[2].memo.contentSnapshot = before[1].memo.contentSnapshot;
			const reading = new MemoReadingPosition(h.root, before);
			for (const item of before) item.card.remove();
			const after = [0, 1, 2, 3].map(index => h.card(index, 1,
				mode === "replace-all" ? `new ${index}` : before[index].memo.contentSnapshot));
			after[0].memo.contentSnapshot = "longer text";
			if (mode === "reorder") [after[1], after[3]] = [after[3], after[1]];
			if (mode === "replace-time") after[0].memo.createdAt = "2026-10-16T10:00";
			for (const [index, item] of after.entries()) h.move(item.card, index * 100 + 550);
			reading.restore(after, undefined, true);
			assert.equal(h.root.scrollTop, mode === "grow" ? 660 : 500, mode);
		} finally { h.dom.window.close(); }
	}
});

test("可信映射才接续菜单焦点，全换键回到中立区，输入及另一页焦点优先", () => {
	for (const mode of ["mapped", "external", "input", "other-page", "composition", "window-blur"] as const) {
		const h = fixture();
		try {
			const before = h.card(1);
			before.card.querySelector<HTMLButtonElement>("button")!.focus();
			const focus = new MemoFocusRestore(h.root, [before], true);
			before.card.remove();
			const after = h.card(1, 1), input = h.dom.window.document.querySelector("input")!;
			if (mode === "input") { input.focus(); input.blur(); }
			if (mode === "other-page") input.focus();
			if (mode === "composition") h.root.dispatchEvent(new h.dom.window.CompositionEvent("compositionstart", { bubbles: true }));
			if (mode === "window-blur") h.dom.window.document.hasFocus = () => false;
			focus.restore([after], mode === "mapped" ? new Map([[before.memo.id, after.memo]]) : undefined);
			focus.dispose();
			const active = h.dom.window.document.activeElement;
			assert.equal(active, mode === "mapped" ? after.card.querySelector("button")
				: mode === "external" ? h.root : mode === "other-page" ? input : h.dom.window.document.body, mode);
			assert.equal(h.root.hasAttribute("tabindex"), false, "中立落点不增加常驻 Tab 停靠点");
		} finally { h.dom.window.close(); }
	}
});
