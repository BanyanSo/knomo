import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { measureSuggestionContentWidth } from "../src/ui/composerSuggestPosition";

for (const selector of ["suggestion-item", "knomo-link-suggest-item"]) {
	for (const fail of [false, true]) test(`${selector}: measure after all nodes are attached and always clean up (failure=${fail})`, () => {
		const dom = new JSDOM("<body><input><div id='popup'></div></body>");
		const win = dom.window;
		Object.assign(win.HTMLElement.prototype, {
			instanceOf(this: HTMLElement, type: typeof HTMLElement) { return this instanceof type; },
			addClass(this: HTMLElement, name: string) { this.classList.add(name); },
			detach(this: HTMLElement) { this.remove(); },
		});
		const container = win.document.getElementById("popup")!;
		container.style.padding = "0 3px"; container.style.border = "1px solid";
		for (const width of [20, 60, 40]) {
			const item = container.appendChild(win.document.createElement("div"));
			item.className = selector; item.dataset.width = String(width);
		}
		let reads = 0;
		win.HTMLElement.prototype.getBoundingClientRect = function () {
			if (this.classList.contains("knomo-suggest-measure-item")) {
				assert.equal(this.parentElement?.children.length, 3, "读取尺寸前应已挂载全部候选");
				reads++;
				if (fail) throw new Error("measurement failed");
			}
			return new win.DOMRect(0, 0, Number(this.dataset.width ?? 0), 20);
		};
		try {
			const measure = () => measureSuggestionContentWidth(win.document.querySelector("input")!, container, `.${selector}`);
			if (fail) assert.throws(measure, /measurement failed/);
			else { assert.equal(measure(), 70); assert.equal(reads, 3); }
			assert.equal(win.document.querySelector(".knomo-suggest-measure-host"), null);
			assert.equal(container.children.length, 3);
		} finally { dom.window.close(); }
	});
}
