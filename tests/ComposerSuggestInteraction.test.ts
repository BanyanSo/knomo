import test from "node:test";
import assert from "node:assert/strict";
import { redo, undo, undoDepth } from "@codemirror/commands";
import type { TFile } from "obsidian";
import type { KnomoTagSuggest } from "../src/ui/KnomoTagSuggest";
import type { KnomoWikiLinkSuggest } from "../src/ui/KnomoWikiLinkSuggest";
import { createMobilePopupFixture } from "./helpers/mobilePopupFixture";
import { ComposerSaveShortcutController } from "../src/ui/ComposerSaveShortcutController";

async function fixture(kind: "tag" | "link", mobile = true) {
	const f = await createMobilePopupFixture();
	Object.assign(f.view, { composerSaveShortcutController: new ComposerSaveShortcutController() });
	if (!mobile) {
		Object.assign(f.view, { currentLayout: "desktop-wide" });
		f.layer.classList.remove("knomo-mobile-composer-layer", "is-layout-mobile");
		f.layer.classList.add("is-layout-desktop-wide");
	}
	const view = f.view as unknown as { tagSuggest: KnomoTagSuggest; wikiLinkSuggest: KnomoWikiLinkSuggest;
		app: { vault: object; metadataCache: object }; getWikiLinkSourcePath: () => string };
	const names = ["Alpha", "Beta", "Delta", "Epsilon", "Gamma", "Iota", "Kappa", "Lambda", "Omega", "Theta"];
	const files = names.map(basename => ({ basename, path: `Notes/${basename}.md`, extension: "md" }) as TFile);
	Object.assign(view.tagSuggest, { vaultTagIndex: { watchSuggestions: () => () => {}, getSnapshot: () => ({ status: "ready", revision: 1, suggestions: names.map(name => name.toLowerCase()) }) } });
	Object.assign(view.app.vault, { getMarkdownFiles: () => files });
	view.app.metadataCache = {
		fileToLinktext: (file: TFile) => file.basename,
		getFirstLinkpathDest: (text: string) => files.find(file => file.basename === text) ?? null,
	};
	view.getWikiLinkSourcePath = () => "Daily/2026-10-21.md";
	f.win.HTMLElement.prototype.scrollIntoView = () => undefined;
	f.win.HTMLElement.prototype.setCssProps = function(props: Record<string, string>) {
		for (const [key, value] of Object.entries(props)) this.style.setProperty(key, value);
	};
	const input = f.view.inputEl;
	const suggest = kind === "tag" ? view.tagSuggest : view.wikiLinkSuggest;
	const initial = kind === "tag" ? "prefix #" : "prefix [[]]";
	const open = () => {
		input.composer.setSaving(false);
		input.composer.reset(initial);
		const cursor = kind === "tag" ? initial.length : initial.length - 2;
		input.setSelectionRange(cursor, cursor);
		input.composer.view.focus();
		if (kind === "tag") view.tagSuggest.open(); else view.wikiLinkSuggest.openForCurrentRange();
		const popup = f.win.document.querySelector<HTMLElement>(kind === "tag" ? ".knomo-tag-suggest-popover" : ".knomo-link-suggest-popover")!;
		assert.ok(popup);
		const list = popup.querySelector<HTMLElement>(":scope > .suggestion")!;
		assert.ok(list, "原生外壳必须包含独立滚动列表");
		const rows = Array.from(list.children) as HTMLElement[];
		Object.defineProperty(list, "clientHeight", { configurable: true, value: 88 });
		for (const [index, row] of rows.entries()) Object.defineProperties(row, {
			offsetTop: { configurable: true, value: index * 44 }, offsetHeight: { configurable: true, value: 44 },
			clientHeight: { configurable: true, value: 44 },
		});
		return { popup, list, rows };
	};
	const key = (key: string, options: KeyboardEventInit = {}) => {
		const event = new f.win.KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...options });
		input.dispatchEvent(event);
		input.dispatchEvent(new f.win.KeyboardEvent("keyup", { key, bubbles: true, ...options }));
		return event.defaultPrevented;
	};
	return { ...f, input, suggest, initial, open, key };
}

for (const method of ["Enter", "mouse", "touch", "Tab"] as const) test(`tag: ${method} keeps the completed tag cursor on its line`, async () => {
	const f = await fixture("tag", method === "touch");
	const initial = "今天 #al";
	const completed = "今天 #alpha";
	try {
		for (const [suffix, confirmedSuffix] of [
			["\n下一行", " \n下一行"], ["\n", " \n"], ["\n\n下一行", " \n\n下一行"], [" \n下一行", " \n下一行"],
			[" 正文", " 正文"], ["\t正文", "\t正文"], ["正文", " 正文"], ["", " "],
		] as const) {
			f.input.composer.reset(initial + suffix);
			f.input.setSelectionRange(initial.length, initial.length);
			f.input.composer.view.focus();
			(f.suggest as KnomoTagSuggest).open();
			const row = f.win.document.querySelector<HTMLElement>(".knomo-tag-suggest-popover .suggestion-item")!;
			assert.equal(row.textContent, "alpha");
			if (method === "Enter" || method === "Tab") assert.equal(f.key(method), true);
			else if (method === "mouse") {
				for (const type of ["pointerdown", "mousedown", "pointerup"]) {
					const event = new f.win.MouseEvent(type, { bubbles: true, cancelable: true, button: 0 });
					Object.defineProperties(event, { pointerType: { value: "mouse" }, pointerId: { value: 1 } });
					row.dispatchEvent(event);
				}
				await f.click(row);
			} else {
				const touch = (type: "touchstart" | "touchend") => {
					const point = { identifier: 1, clientX: 20, clientY: 20, target: row };
					const event = new f.win.Event(type, { bubbles: true, cancelable: true });
					Object.defineProperties(event, { touches: { value: type === "touchstart" ? [point] : [] }, changedTouches: { value: [point] } });
					row.dispatchEvent(event);
				};
				f.pointer(row, "pointerdown");
				touch("touchstart");
				f.pointer(row, "pointerup");
				touch("touchend");
				await f.click(f.input);
			}
			const expected = completed + (method === "Tab" ? suffix : confirmedSuffix);
			const cursor = completed.length + (method === "Tab" ? 0 : 1);
			assert.equal(f.input.value, expected, JSON.stringify(suffix));
			assert.equal(f.input.selectionStart, cursor, JSON.stringify(suffix));
			assert.equal(f.input.selectionEnd, cursor);
			assert.equal(f.win.document.activeElement, f.input);
			assert.equal(f.win.document.querySelector(".knomo-tag-suggest-popover") !== null, method === "Tab");
			assert.equal(undoDepth(f.input.composer.view.state), 1);
			assert.equal(undo(f.input.composer.view), true);
			assert.equal(f.input.value, initial + suffix);
			assert.equal(f.input.selectionStart, initial.length);
			assert.equal(redo(f.input.composer.view), true);
			assert.equal(f.input.value, expected);
			assert.equal(f.input.selectionStart, cursor);
		}
	} finally { f.close(); }
});

for (const mobile of [false, true]) test(`tag/${mobile ? "mobile" : "desktop"}: published candidates refresh without input and reject removed selections`, async () => {
	const f = await fixture("tag", mobile);
	const listeners = new Set<() => void>();
	let tags = ["alpha", "beta", "gamma"];
	const publish = (next: string[]) => { tags = next; for (const listener of [...listeners]) listener(); };
	Object.assign(f.suggest, { vaultTagIndex: {
		getSnapshot: () => ({ status: "ready", revision: 1, suggestions: tags }),
		watchSuggestions: (listener: () => void) => { listeners.add(listener); return () => listeners.delete(listener); },
	} });
	try {
		f.input.composer.reset("#"); f.input.composer.view.focus();
		(f.suggest as KnomoTagSuggest).open();
		f.key("ArrowDown");
		const oldList = f.win.document.querySelector<HTMLElement>(".knomo-suggest-list")!;
		oldList.scrollTop = 32;
		publish(["beta", "gamma"]);
		const list = f.win.document.querySelector<HTMLElement>(".knomo-suggest-list")!;
		assert.deepEqual(Array.from(list.children, row => row.textContent), ["beta", "gamma"]);
		assert.equal(list.querySelector(".is-selected")?.textContent, "beta");
		assert.equal(list.scrollTop, 32);
		publish(["gamma"]);
		(f.suggest as KnomoTagSuggest).selectSuggestion({ tag: "beta", result: null });
		assert.equal(f.input.value, "#", "旧事件不能选择已移除候选");
		f.key("Enter");
		assert.equal(f.input.value, "#gamma ");
		assert.equal(listeners.size, 0);
		publish(["later"]);
		assert.equal(f.win.document.querySelector(".knomo-tag-suggest-popover"), null);
	} finally { f.close(); }
});

test("tag: unexpected build rejection retains usable rows and retries only in a new session", async () => {
	const f = await fixture("tag");
	let requests = 0;
	let status = "building";
	let revision = 1;
	Object.assign(f.suggest, { vaultTagIndex: {
		getSnapshot: () => ({ status, revision, suggestions: ["alpha"] }),
		watchSuggestions: () => () => {},
		ensureReady: async () => {
			if (++requests === 1) { status = "idle"; throw new Error("unexpected build failure"); }
			status = "ready"; revision++;
		},
	} });
	try {
		f.input.composer.reset("#"); f.input.composer.view.focus();
		(f.suggest as KnomoTagSuggest).open();
		for (let i = 0; i < 5; i++) await Promise.resolve();
		assert.equal(f.win.document.querySelector(".suggestion-item")?.textContent, "alpha");
		for (let i = 0; i < 5; i++) (f.suggest as KnomoTagSuggest).refresh();
		assert.equal(requests, 1);
		f.suggest.close(); (f.suggest as KnomoTagSuggest).open();
		for (let i = 0; i < 5; i++) await Promise.resolve();
		assert.equal(requests, 2);
		f.key("Enter");
		assert.equal(f.input.value, "#alpha ");
	} finally { f.close(); }
});

for (const action of ["escape", "blur", "ime", "reset", "close", "destroy"] as const) test(`tag: publication cannot reopen after ${action}`, async () => {
	const f = await fixture("tag");
	const listeners = new Set<() => void>();
	let tags = ["alpha"];
	Object.assign(f.suggest, { vaultTagIndex: {
		getSnapshot: () => ({ status: "ready", revision: 1, suggestions: tags }),
		watchSuggestions: (listener: () => void) => { listeners.add(listener); return () => listeners.delete(listener); },
	} });
	try {
		f.open();
		const queued = [...listeners];
		if (action === "escape") f.key("Escape");
		if (action === "blur") { f.input.blur(); f.input.composer.view.focus(); }
		if (action === "ime") f.input.dispatchEvent(new f.win.CompositionEvent("compositionstart", { bubbles: true }));
		if (action === "reset") f.input.composer.reset("#");
		if (action === "close") f.suggest.close();
		if (action === "destroy") f.close();
		assert.equal(listeners.size, 0);
		tags = ["later"];
		for (const listener of queued) listener();
		if (action !== "destroy") assert.equal(f.win.document.querySelector(".knomo-tag-suggest-popover"), null);
	} finally { if (action !== "destroy") f.close(); }
});

test("tag: a real index updates an open empty session when exclusions change without typing", async () => {
	const f = await fixture("tag");
	const { VaultTagIndex } = await import("../src/services/VaultTagIndex");
	const { TFile } = await import("obsidian");
	const file = Object.assign(new TFile(), { path: "Monthly/a.md", extension: "md", stat: { mtime: 1 } });
	let rules: string[] = [];
	let activeRules: string[] = [];
	let unavailable = false;
	const callbacks = new Map<string, (...args: unknown[]) => void>();
	const on = (key: string, callback: (...args: unknown[]) => void) => { callbacks.set(key, callback); return {}; };
	const index = new VaultTagIndex({
		workspace: { containerEl: { win: f.win } },
		vault: { getConfig: () => { if (unavailable) throw new Error("rules unavailable"); return rules; }, getMarkdownFiles: () => [file], on, offref() {} },
		metadataCache: { on, getFileCache: () => ({ allTags: ["#Current"] }),
			updateUserIgnoreFilters: () => { activeRules = [...rules]; },
			isUserIgnored: (path: string) => activeRules.some(rule => path.startsWith(rule)),
		},
	} as never);
	index.load();
	Object.assign(f.suggest, { vaultTagIndex: index });
	try {
		f.input.composer.reset("#"); f.input.composer.view.focus();
		(f.suggest as KnomoTagSuggest).open();
		await index.ensureReady(); await Promise.resolve();
		assert.equal(f.win.document.querySelector(".suggestion-item")?.textContent, "Current");
		const originalList = f.win.document.querySelector(".knomo-suggest-list");
		unavailable = true; callbacks.get("config-changed")!("userIgnoreFilters");
		await index.ensureReady();
		assert.equal(index.getSnapshot().exclusionState, "degraded");
		assert.equal(f.win.document.querySelector(".knomo-suggest-list"), originalList);
		unavailable = false;
		rules = ["Monthly/"]; callbacks.get("config-changed")!("userIgnoreFilters");
		await index.ensureReady();
		assert.equal(f.win.document.querySelector(".knomo-tag-suggest-popover"), null);
		rules = []; callbacks.get("config-changed")!("userIgnoreFilters");
		await index.ensureReady();
		assert.equal(f.win.document.querySelector(".suggestion-item")?.textContent, "Current");
		assert.equal(f.input.value, "#");
		unavailable = true; callbacks.get("config-changed")!("userIgnoreFilters");
		await index.ensureReady();
		f.key("Enter");
		assert.equal(f.input.value, "#Current ", "降级候选仍可补全");
	} finally { f.close(); index.unload(); }
});

for (const mobile of [false, true]) for (const kind of ["tag", "link"] as const) {
	const context = `${mobile ? "mobile" : "desktop"}/${kind}`;
	test(`${context}: native list navigation and hover retain rows, scroll and editor focus`, async () => {
		const f = await fixture(kind, mobile);
		try {
			const { popup, list, rows } = f.open();
			assert.equal(rows.length, 10);
			assert.equal(popup.classList.contains("suggestion-container"), true);
			assert.equal(rows[0].classList.contains("suggestion-item"), true);
			if (kind === "link") assert.ok(rows[0].querySelector(".suggestion-content > .suggestion-title"));
			const selected = () => rows.findIndex(row => row.getAttribute("aria-selected") === "true");
			for (const [key, index] of [["End", 9], ["Home", 0], ["PageDown", 1], ["PageDown", 3], ["PageUp", 2], ["Home", 0], ["ArrowUp", 9], ["ArrowDown", 0]] as const) {
				assert.equal(f.key(key), true, key);
				assert.equal(selected(), index, key);
				assert.equal(list.children[index], rows[index], "导航不能重建行 DOM");
				assert.equal(popup.scrollTop, 0, "只滚动内层列表");
			}
			const hover = new f.win.MouseEvent("pointermove", { bubbles: true });
			Object.defineProperties(hover, { pointerType: { value: "mouse" }, pointerId: { value: 1 } });
			rows[4].dispatchEvent(hover);
			assert.equal(selected(), 4);
			assert.equal(f.input.getAttribute("aria-activedescendant"), rows[4].id);
			assert.equal(f.win.document.activeElement, f.input);
			for (const options of [{ shiftKey: true }, { altKey: true }, { ctrlKey: true }, { metaKey: true }, { isComposing: true }]) {
				assert.equal(f.suggest.handleKeydown(new f.win.KeyboardEvent("keydown", { key: "Enter", ...options })), false);
			}
			assert.equal(f.input.value, f.initial);
			const query = kind === "tag" ? "prefix #a" : "prefix [[a]]";
			const cursor = kind === "tag" ? query.length : query.length - 2;
			f.input.composer.apply({ value: query, anchor: cursor, head: cursor });
			const refreshed = f.win.document.querySelector<HTMLElement>(".knomo-native-suggest .knomo-suggest-list")!;
			assert.equal(refreshed.children[0].getAttribute("aria-selected"), "true", "新查询回到首项，避免沿用上一查询的索引");
		} finally { f.close(); }
	});

	test(`${context}: Tab continues completion, Enter finishes and Escape stays dismissed after keyup`, async () => {
		const f = await fixture(kind, mobile);
		try {
			f.open();
			assert.equal(f.key("Escape"), true);
			assert.equal(f.win.document.querySelector(".knomo-native-suggest"), null);
			f.open();
			assert.equal(f.key("Tab"), true);
			assert.equal(f.input.value, kind === "tag" ? "prefix #alpha" : "prefix [[Alpha]]");
			assert.equal(f.input.selectionStart, kind === "tag" ? "prefix #alpha".length : "prefix [[Alpha".length);
			assert.ok(f.win.document.querySelector(".knomo-native-suggest"));
			const historyAfterTab = undoDepth(f.input.composer.view.state);
			assert.equal(f.key("Enter"), true);
			assert.equal(f.input.value, kind === "tag" ? "prefix #alpha " : "prefix [[Alpha]]");
			assert.equal(f.input.selectionStart, f.input.value.length);
			if (kind === "link") assert.equal(undoDepth(f.input.composer.view.state), historyAfterTab, "仅移动光标不增加撤销记录");
			assert.equal(f.win.document.querySelector(".knomo-native-suggest"), null);
			assert.equal(f.win.document.activeElement, f.input);
		} finally { f.close(); }
	});

	test(`${context}: mouse confirmation commits once and retains input focus`, async () => {
		const f = await fixture(kind, mobile);
		try {
			const { rows } = f.open();
			const row = rows[1];
			for (const type of ["pointerdown", "mousedown", "pointerup"] as const) {
				const event = new f.win.MouseEvent(type, { bubbles: true, cancelable: true, button: 0 });
				Object.defineProperties(event, { pointerType: { value: "mouse" }, pointerId: { value: 1 } });
				row.dispatchEvent(event);
				if (type !== "pointerup") assert.equal(event.defaultPrevented, true);
			}
			await f.click(row);
			await f.click(row);
			assert.equal(f.input.value, kind === "tag" ? "prefix #beta " : "prefix [[Beta]]");
			assert.equal(undoDepth(f.input.composer.view.state), 1);
			assert.equal(f.win.document.activeElement, f.input);
			assert.equal(f.win.document.querySelector(".knomo-native-suggest"), null);
		} finally { f.close(); }
	});

	if (mobile) test(`${context}: taps commit once; swipes, scrolls, cancellation and stale gestures never commit`, async () => {
		const f = await fixture(kind);
		try {
			for (const invalid of ["swipe", "scroll", "cancel", "multitouch", "selection", "composition", "readonly", "reset"]) {
				const { list, rows } = f.open();
				const row = rows[0];
				f.pointer(row, "pointerdown");
				if (invalid === "swipe") f.pointer(row, "pointermove", { x: 50 });
				if (invalid === "scroll") { list.scrollTop = 24; list.dispatchEvent(new f.win.Event("scroll")); }
				if (invalid === "cancel") f.pointer(row, "pointercancel");
				if (invalid === "multitouch") f.pointer(row, "pointerdown", { id: 2 });
				if (invalid === "selection") f.input.setSelectionRange(0, 0);
				if (invalid === "composition") f.input.dispatchEvent(new f.win.CompositionEvent("compositionstart", { bubbles: true }));
				if (invalid === "readonly") f.input.composer.setSaving(true);
				if (invalid === "reset") f.input.composer.reset("new draft");
				f.pointer(row, "pointerup");
				await f.click(row);
				assert.equal(f.input.value, invalid === "reset" ? "new draft" : f.initial, invalid);
				assert.equal(undoDepth(f.input.composer.view.state), 0, invalid);
				if (invalid === "composition") {
					f.input.dispatchEvent(new f.win.CompositionEvent("compositionend", { bubbles: true }));
					await new Promise(resolve => f.win.setTimeout(resolve, 70));
				}
			}
			const { rows } = f.open();
			const target = rows[0].firstElementChild ?? rows[0];
			f.pointer(target, "pointerdown");
			f.pointer(target, "pointerup");
			await f.click(target);
			await f.click(f.input);
			assert.equal(f.input.value, kind === "tag" ? "prefix #alpha " : "prefix [[Alpha]]");
			assert.equal(undoDepth(f.input.composer.view.state), 1);
			assert.equal(f.win.document.querySelector(".knomo-native-suggest"), null);
			assert.equal(f.win.document.activeElement, f.input);
		} finally { f.close(); }
	});
}
