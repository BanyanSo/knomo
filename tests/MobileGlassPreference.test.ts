import test from "node:test";
import assert from "node:assert/strict";
import { createMobilePopupFixture } from "./helpers/mobilePopupFixture";
import type { KnomoTagSuggest } from "../src/ui/KnomoTagSuggest";
import type { KnomoWikiLinkSuggest } from "../src/ui/KnomoWikiLinkSuggest";

test("detached tag and link surfaces initialize, update in place and release their owned preference", async () => {
	const f = await createMobilePopupFixture();
	try {
		const leaf = f.win.document.body.createDiv();
		leaf.appendChild(f.root);
		let reduced = true;
		const view = Object.assign(f.view as unknown as {
			syncReducedGlassEffects(): void;
			clearMobileGlassSurfaces(): void;
			tagSuggest: KnomoTagSuggest;
			wikiLinkSuggest: KnomoWikiLinkSuggest;
		}, {
			containerEl: leaf, rootEl: f.root,
			settingsService: { getSettings: () => ({ reduceGlassEffects: reduced }) },
			mobileComposerController: { getLayerEl: () => f.layer },
			getWikiLinkSourcePath: () => "Daily/2026-10-21.md",
		});
		Object.assign(view.tagSuggest, { vaultTagIndex: {
			getSnapshot: () => ({ status: "ready", revision: 1, suggestions: ["one", "two"] }),
		} });
		Object.assign((f.view as unknown as { app: { vault: object } }).app.vault, {
			getMarkdownFiles: () => [{ path: "Notes/Alpha.md", basename: "Alpha", extension: "md" }],
		});
		const input = f.view.inputEl;
		f.win.HTMLElement.prototype.scrollIntoView = () => undefined;
		f.win.HTMLElement.prototype.setCssProps = function(props: Record<string, string>) {
			for (const [name, value] of Object.entries(props)) this.style.setProperty(name, value);
		};
		for (const kind of ["tag", "link"] as const) {
			reduced = true;
			view.syncReducedGlassEffects();
			input.value = kind === "tag" ? "#one" : "[[Al]]";
			input.setSelectionRange(4, 4);
			input.composer.view.focus();
			if (kind === "tag") view.tagSuggest.open();
			else view.wikiLinkSuggest.openForCurrentRange();
			const selector = kind === "tag" ? ".knomo-tag-suggest-popover" : ".knomo-link-suggest-popover";
			const popup = f.win.document.querySelector<HTMLElement>(selector)!;
			assert.ok(popup, kind);
			assert.equal(leaf.contains(popup), false);
			assert.equal(popup.classList.contains("knomo-mobile-glass-surface"), true, `${kind}: creation registers the surface`);
			assert.equal(popup.classList.contains("knomo-reduce-glass"), true, `${kind}: initial preference`);
			const draft = input.value;
			for (const value of [false, true, false]) {
				reduced = value;
				view.syncReducedGlassEffects();
				assert.equal(popup.classList.contains("knomo-reduce-glass"), value, kind);
				assert.equal(f.win.document.querySelector(selector), popup, "setting changes retain popup DOM and selection");
				assert.equal(input.value, draft);
				assert.equal(input.selectionStart, 4);
				assert.equal(popup.querySelector('[role="option"][aria-selected="true"]')?.id, input.getAttribute("aria-activedescendant"));
			}
			if (kind === "tag") {
				assert.equal(popup.querySelectorAll('[role="option"]').length, 1, "single tag uses the same option contract");
				view.tagSuggest.close();
				input.value = "#"; input.setSelectionRange(1, 1); input.composer.view.focus(); view.tagSuggest.open();
				const multi = f.win.document.querySelector<HTMLElement>(selector)!;
				assert.equal(multi.querySelectorAll('[role="option"]').length, 2);
				view.tagSuggest.handleKeydown(new f.win.KeyboardEvent("keydown", { key: "ArrowDown" }));
				assert.equal(multi.querySelectorAll('[role="option"]')[1].getAttribute("aria-selected"), "true");
				view.tagSuggest.handleKeydown(new f.win.KeyboardEvent("keydown", { key: "Enter" }));
				assert.equal(input.value, "#two ");
				assert.equal(multi.classList.contains("knomo-mobile-glass-surface"), false, "selection releases the multi-option surface");
			} else view.wikiLinkSuggest.close();
			assert.equal(popup.isConnected, false);
			reduced = true; view.syncReducedGlassEffects();
			assert.equal(popup.classList.contains("knomo-reduce-glass"), false, "closed surface no longer receives updates");
			assert.equal(popup.classList.contains("knomo-mobile-glass-surface"), false);
		}
		input.value = "[[Al]]"; input.setSelectionRange(4, 4); view.wikiLinkSuggest.openForCurrentRange();
		const retained = view.wikiLinkSuggest.getPopoverForTest()!;
		view.clearMobileGlassSurfaces();
		assert.equal(retained.classList.contains("knomo-mobile-glass-surface"), false, "view cleanup releases any remaining surface");
		for (const el of [leaf, f.root, f.layer]) assert.equal(el.classList.contains("knomo-reduce-glass"), false);
	} finally { f.close(); }
});

test("glass preference updates the leaf, page and body Composer in place without changing the draft", async () => {
	const f = await createMobilePopupFixture();
	try {
		const leaf = f.win.document.body.createDiv();
		leaf.appendChild(f.root);
		let reduced = true;
		const navbarPreferences: boolean[] = [];
		const view = Object.assign(f.view as unknown as { syncReducedGlassEffects(): void }, {
			containerEl: leaf, rootEl: f.root,
			settingsService: { getSettings: () => ({ reduceGlassEffects: reduced }) },
			mobileComposerController: { getLayerEl: () => f.layer },
			mobileNavbarCompactController: { syncGlassPreference: () => { navbarPreferences.push(reduced); } },
		});
		const input = f.view.inputEl;
		const draft = input.value;
		for (const value of [true, false, true]) {
			reduced = value;
			view.syncReducedGlassEffects();
			for (const el of [leaf, f.root, f.layer]) assert.equal(el.classList.contains("knomo-reduce-glass"), value);
			assert.equal(f.view.inputEl, input);
			assert.equal(input.value, draft);
			assert.equal(leaf.contains(f.layer), false, "body 浮层独立获得偏好");
		}
		assert.deepEqual(navbarPreferences, [true, false, true], "设置变化同步通知宿主导航栏");
	} finally { f.close(); }
});
