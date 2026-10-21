import test from "node:test";
import assert from "node:assert/strict";
import { createMobilePopupFixture } from "./helpers/mobilePopupFixture";

test("glass preference updates the leaf, page and body Composer in place without changing the draft", async () => {
	const f = await createMobilePopupFixture();
	try {
		const leaf = f.win.document.body.createDiv();
		leaf.appendChild(f.root);
		let reduced = true;
		const view = Object.assign(f.view as unknown as { syncReducedGlassEffects(): void }, {
			containerEl: leaf, rootEl: f.root,
			settingsService: { getSettings: () => ({ reduceGlassEffects: reduced }) },
			mobileComposerController: { getLayerEl: () => f.layer },
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
	} finally { f.close(); }
});
