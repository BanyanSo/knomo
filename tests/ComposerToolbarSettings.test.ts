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
		createEl(this: HTMLElement, tag: string) { return this.appendChild(this.ownerDocument.createElement(tag)); },
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
			const details = row.querySelector("details")!;
			assert.equal(row.querySelectorAll("details").length, 1);
			assert.ok(details.querySelector("summary > .setting-item-info"));
			assert.equal(details.open, i > 0);
			if (i === 0) {
				details.querySelector("summary")!.click();
				assert.equal(details.open, true);
			}
		}
		row.querySelector("summary")!.click();
		assert.equal(row.querySelector("details")!.open, false);
	} finally { Setting.prototype.addButton = original; dom.window.close(); }
});

test("toolbar locks visibility, ordering and reset until save settles and recovers after failure", async () => {
	await ensureObsidianStub();
	const { KnomoSettingTab } = await import("../src/ui/KnomoSettingTab");
	const { Setting } = await import("obsidian");
	const dom = new JSDOM("<div id='row'></div>");
	Object.assign(dom.window.HTMLElement.prototype, {
		createEl(this: HTMLElement, tag: string) { return this.appendChild(this.ownerDocument.createElement(tag)); },
		addClass(this: HTMLElement, cls: string) { this.classList.add(cls); },
		empty(this: HTMLElement) { this.replaceChildren(); controls = []; },
		createDiv(this: HTMLElement, options: { cls: string }) {
			const child = this.ownerDocument.createElement("div"); child.className = options.cls; this.appendChild(child); return child;
		},
	});
	let controls: Control[] = [];
	class Control {
		disabled = false;
		value = false;
		callback: (value: boolean) => void = () => undefined;
		setDisabled(value: boolean) { this.disabled = value; return this; }
		setValue(value: boolean) { this.value = value; return this; }
		setIcon() { return this; }
		setTooltip() { return this; }
		setButtonText() { return this; }
		onChange(callback: (value: boolean) => void) { this.callback = callback; return this; }
		onClick(callback: () => void) { this.callback = callback; return this; }
		click(value = false) { if (!this.disabled) { this.value = value; this.callback(value); } }
	}
	const originalButton = Setting.prototype.addButton, originalToggle = Setting.prototype.addToggle;
	const add = function(this: InstanceType<typeof Setting>, callback: (control: never) => unknown) {
		const control = new Control(); controls.push(control); callback(control as never); return this;
	};
	Setting.prototype.addButton = add;
	Setting.prototype.addToggle = add;
	let preferences = normalizeComposerToolbar(undefined);
	let resolveSave: () => void = () => undefined, rejectSave: (error: Error) => void = () => undefined;
	let saves = 0;
	const service = {
		getSettings: () => ({ composerToolbar: preferences }),
		updateSettings: ({ composerToolbar }: { composerToolbar: typeof preferences }) => {
			saves++;
			return new Promise<void>((resolve, reject) => {
				resolveSave = () => { preferences = composerToolbar; resolve(); };
				rejectSave = reject;
			});
		},
	};
	const flush = async () => { await Promise.resolve(); await Promise.resolve(); };
	try {
		(KnomoSettingTab.prototype as unknown as { renderToolbarSetting(this: unknown, setting: unknown): void })
			.renderToolbarSetting.call({ settingsService: service }, { settingEl: dom.window.document.getElementById("row") });
		const details = dom.window.document.querySelector("details")!;
		assert.equal(details.open, false);
		details.querySelector("summary")!.click();
		const bold = preferences.order.indexOf("bold") * 3, highlight = preferences.order.indexOf("highlight") * 3;
		controls[bold].click(true);
		assert.ok(controls.every(control => control.disabled));
		controls[highlight].click(true);
		controls[1 * 3 + 1].click();
		controls.at(-1)!.click();
		assert.equal(saves, 1);
		resolveSave(); await flush();
		assert.equal(details.open, true);
		assert.equal(controls[bold].value, true);
		assert.equal(controls[highlight].value, false);
		controls[highlight].click(true);
		resolveSave(); await flush();
		assert.equal(preferences.hidden.includes("bold"), false);
		assert.equal(preferences.hidden.includes("highlight"), false);
		const order = [...preferences.order];
		controls[4].click();
		controls[7].click();
		assert.equal(saves, 3);
		resolveSave(); await flush();
		assert.deepEqual(preferences.order.slice(0, 2), [order[1], order[0]]);
		const visible = controls.findIndex((control, index) => index % 3 === 0 && control.value);
		controls[visible].click(false);
		details.querySelector("summary")!.click();
		rejectSave(new Error("save failed")); await flush();
		assert.equal(details.open, false);
		assert.equal(controls[visible].disabled, false);
		assert.equal(controls[visible].value, true);
		assert.equal(controls[1].disabled, true);
		controls[visible].click(false);
		resolveSave(); await flush();
		assert.equal(controls[visible].value, false);
	} finally {
		Setting.prototype.addButton = originalButton; Setting.prototype.addToggle = originalToggle; dom.window.close();
	}
});
