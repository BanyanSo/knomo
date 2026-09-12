import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { ensureObsidianStub } from "./helpers/obsidianStub";
import { normalizeComposerToolbar } from "../src/settings/composerToolbar";

test("repeated declarative toolbar renders replace owned content and preserve the setting row", async () => {
	await ensureObsidianStub();
	const { KnomoSettingTab } = await import("../src/ui/KnomoSettingTab");
	const { Setting } = await import("obsidian");
	const dom = new JSDOM("<div id='row'><div class='setting-item-info'>Toolbar</div></div>");
	const proto = dom.window.HTMLElement.prototype;
	Object.assign(proto, {
		addClass(this: HTMLElement, cls: string) { this.classList.add(cls); },
		empty(this: HTMLElement) { this.replaceChildren(); },
		createDiv(this: HTMLElement, options: { cls: string }) {
			const child = this.ownerDocument.createElement("div"); child.className = options.cls; this.appendChild(child); return child;
		},
	});
	const original = Setting.prototype.addButton;
	// 此测试只检验容器生命周期，按钮行为由工具栏命令测试覆盖。
	Setting.prototype.addButton = function () { return this; };
	try {
		const row = dom.window.document.getElementById("row")!;
		const renderer = KnomoSettingTab.prototype as unknown as {
			renderToolbarSetting(this: unknown, setting: unknown): void;
		};
		for (let i = 0; i < 6; i++) {
			renderer.renderToolbarSetting.call({ settingsService: { getSettings: () => ({ composerToolbar: normalizeComposerToolbar(undefined) }) } }, { settingEl: row });
			assert.equal(row.querySelectorAll(".knomo-toolbar-settings").length, 1);
			assert.equal(row.querySelector(".setting-item-info")?.textContent, "Toolbar");
		}
	} finally { Setting.prototype.addButton = original; dom.window.close(); }
});
