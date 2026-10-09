import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { bindSearchInput } from "../src/ui/SearchInputBinding";
import { SearchSession } from "../src/ui/SearchSession";

function inputHarness() {
	const dom = new JSDOM("<input type='search'>");
	const input = dom.window.document.querySelector("input")!;
	const session = new SearchSession();
	const queued: string[] = [];
	let closed = 0;
	bindSearchInput({
		input, session,
		registerDomEvent: (target, type, listener) => target.addEventListener(type, listener as EventListener),
		onDraftChanged: () => {},
		onQueue: () => { queued.push(session.draft.text); },
		onClose: () => { closed++; session.close(); },
	});
	const key = (name: string, options: KeyboardEventInit = {}) => {
		const event = new dom.window.KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true, ...options });
		input.dispatchEvent(event); return event;
	};
	const change = (text: string, composing = false) => {
		input.value = text;
		input.dispatchEvent(new dom.window.InputEvent("input", { bubbles: true, isComposing: composing }));
	};
	return { dom, input, session, queued, key, change, get closed() { return closed; } };
}

test("选字 Enter/Esc 保留给输入法，组合结束与最终 input 只排队一次", () => {
	const harness = inputHarness();
	const { dom, input, session, key, change, queued } = harness;
	let propagated = 0;
	input.parentElement!.addEventListener("keydown", () => { propagated++; });
	try {
		input.dispatchEvent(new dom.window.CompositionEvent("compositionstart", { bubbles: true }));
		change("zhong", true);
		assert.equal(key("Enter", { isComposing: true }).defaultPrevented, false);
		assert.equal(key("Escape", { keyCode: 229 }).defaultPrevented, false);
		assert.equal(harness.closed, 0);
		assert.equal(propagated, 0);
		assert.deepEqual(queued, []);
		input.value = "中文";
		input.dispatchEvent(new dom.window.CompositionEvent("compositionend", { bubbles: true }));
		change("中文");
		assert.equal(key("Enter").defaultPrevented, false);
		assert.deepEqual(queued, ["中文"]);
		assert.equal(session.applied.input, "");
		assert.equal(session.draft.composing, false);
		assert.equal(session.submit(), true);
		assert.equal(session.applied.input, "中文");
	} finally { dom.window.close(); }
});

test("普通 Enter 不新增提交；Esc 拦截原生清空且不提交非法日期", () => {
	const harness = inputHarness();
	const { session, key, change, input } = harness;
	try {
		change("项目 2026"); session.submit();
		change("2026-");
		key("Enter");
		assert.equal(session.applied.input, "项目 2026");
		const event = key("Escape");
		assert.equal(event.defaultPrevented, true);
		assert.equal(harness.closed, 1);
		assert.equal(input.value, "2026-");
		assert.equal(session.applied.input, "项目 2026");
	} finally { harness.dom.window.close(); }
});
