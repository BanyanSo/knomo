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
	const restoreRows = stubSettingRows(Setting);
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
	} finally { Setting.prototype.addButton = original; restoreRows(); dom.window.close(); }
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
	const restoreRows = stubSettingRows(Setting);
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
		assert.equal(controls[order.indexOf(preferences.order[0]) * 3 + 1].disabled, true);
		controls[visible].click(false);
		resolveSave(); await flush();
		assert.equal(controls[visible].value, false);
	} finally {
		Setting.prototype.addButton = originalButton; Setting.prototype.addToggle = originalToggle; restoreRows(); dom.window.close();
	}
});

function stubSettingRows(Setting: typeof import("obsidian").Setting): () => void {
	const descriptor = Object.getOwnPropertyDescriptor(Setting.prototype, "settingEl");
	const rows = new WeakMap<object, HTMLElement>();
	Object.defineProperty(Setting.prototype, "settingEl", { configurable: true, get(this: { containerEl: HTMLElement }) {
		let el = rows.get(this);
		if (!el) { el = this.containerEl.createDiv({ cls: "setting-item" }); rows.set(this, el); }
		return el;
	} });
	return () => { if (descriptor) Object.defineProperty(Setting.prototype, "settingEl", descriptor); else Reflect.deleteProperty(Setting.prototype, "settingEl"); };
}

test("toolbar visibility, order and reset preserve mounted controls, scroll and focus after saves", async () => {
	await ensureObsidianStub();
	const { KnomoSettingTab } = await import("../src/ui/KnomoSettingTab");
	const { Setting } = await import("obsidian");
	const dom = new JSDOM("<body class='is-mobile'><div id='scroller'><div id='row'></div></div><button id='outside'>Outside</button></body>");
	const scroller = dom.window.document.getElementById("scroller")!;
	Object.assign(dom.window.HTMLElement.prototype, {
		createEl(this: HTMLElement, tag: string) { return this.appendChild(this.ownerDocument.createElement(tag)); },
		createDiv(this: HTMLElement, options: { cls: string }) { const el = this.ownerDocument.createElement("div"); el.className = options.cls; return this.appendChild(el); },
		addClass(this: HTMLElement, cls: string) { this.classList.add(cls); },
		empty(this: HTMLElement) {
			this.replaceChildren();
			// 模拟真实浏览器在列表被清空时收缩滚动范围。
			if (this.classList.contains("knomo-toolbar-settings")) scroller.scrollTop = 0;
		},
	});
	type StubSetting = InstanceType<typeof Setting> & { containerEl: HTMLElement };
	const rows = new WeakMap<object, HTMLElement>();
	const row = (setting: StubSetting) => {
		let el = rows.get(setting);
		if (!el) { el = setting.containerEl.createDiv({ cls: "setting-item" }); rows.set(setting, el); }
		return el;
	};
	const keys = ["settingEl", "setClass", "setName", "addToggle", "addButton"];
	const descriptors = keys.map(key => [key, Object.getOwnPropertyDescriptor(Setting.prototype, key)] as const);
	Object.defineProperty(Setting.prototype, "settingEl", { configurable: true, get(this: StubSetting) { return row(this); } });
	Setting.prototype.setClass = function(name) { row(this as StubSetting).classList.add(name); return this; };
	Setting.prototype.setName = function(name) { row(this as StubSetting).setAttribute("aria-label", typeof name === "string" ? name : name.textContent ?? ""); return this; };
	for (const [method, toggle] of [["addToggle", true], ["addButton", false]] as const) {
		Object.defineProperty(Setting.prototype, method, { configurable: true, writable: true, value(this: StubSetting, configure: (component: unknown) => void) {
			const el = row(this).createEl(toggle ? "div" : "button");
			el.tabIndex = 0;
			if (toggle) el.setAttribute("role", "switch");
			let disabled = false, value = false, change = (_value: boolean) => {}, click = () => {};
			const component = {
				setDisabled(next: boolean) { disabled = next; if (!toggle) (el as HTMLButtonElement).disabled = next; return this; },
				setValue(next: boolean) { value = next; el.setAttribute("aria-checked", String(next)); return this; },
				setIcon(icon: string) { el.dataset.icon = icon; return this; }, setTooltip() { return this; },
				setButtonText(text: string) { el.textContent = text; return this; },
				onChange(callback: typeof change) { change = callback; return this; }, onClick(callback: typeof click) { click = callback; return this; },
			};
			el.addEventListener("click", () => { if (disabled) return; if (toggle) { component.setValue(!value); change(value); } else click(); });
			configure(component); return this;
		} });
	}
	let preferences = normalizeComposerToolbar(undefined);
	let resolveSave = () => {}, rejectSave = (_error: Error) => {};
	const service = {
		getSettings: () => ({ composerToolbar: preferences }),
		updateSettings: ({ composerToolbar }: { composerToolbar: typeof preferences }) => new Promise<void>((resolve, reject) => {
			resolveSave = () => { preferences = composerToolbar; resolve(); }; rejectSave = reject;
		}),
	};
	const flush = async () => { await Promise.resolve(); await Promise.resolve(); };
	try {
		const tab = Object.assign(Object.create(KnomoSettingTab.prototype), { toolbarExpanded: true, settingsService: service });
		tab.renderToolbarSetting({ settingEl: dom.window.document.getElementById("row") });
		const container = dom.window.document.querySelector<HTMLElement>(".knomo-toolbar-settings")!;
		const originalRows = [...container.querySelectorAll<HTMLElement>(".knomo-toolbar-item")];
		const byAction = new Map(preferences.order.map((action, index) => [action, originalRows[index]!]));
		const bold = byAction.get("bold")!.querySelector<HTMLElement>('[role="switch"]')!;
		scroller.scrollTop = 880;
		bold.focus(); bold.click(); resolveSave(); await flush();
		assert.equal(byAction.get("bold")!.querySelector('[role="switch"]'), bold);
		assert.ok(bold.isConnected, "保存不应替换原开关节点");
		assert.equal(scroller.scrollTop, 880);
		assert.equal(dom.window.document.activeElement, bold);
		assert.equal(bold.getAttribute("aria-checked"), "true");
		bold.click();
		scroller.scrollTop = 640;
		const outside = dom.window.document.getElementById("outside")!;
		outside.focus(); rejectSave(new Error("save failed")); await flush();
		assert.equal(bold.getAttribute("aria-checked"), "true");
		assert.equal(scroller.scrollTop, 640);
		assert.equal(dom.window.document.activeElement, outside);
		const up = byAction.get("highlight")!.querySelector<HTMLButtonElement>('[data-icon="arrow-up"]')!;
		up.focus(); up.click(); resolveSave(); await flush();
		assert.equal(scroller.scrollTop, 640);
		assert.equal(dom.window.document.activeElement, up);
		assert.deepEqual([...container.querySelectorAll(".knomo-toolbar-item")], preferences.order.map(action => byAction.get(action)));
		const reset = container.querySelector<HTMLButtonElement>(".knomo-toolbar-reset button")!;
		reset.focus(); reset.click(); resolveSave(); await flush();
		assert.equal(scroller.scrollTop, 640);
		assert.equal(dom.window.document.activeElement, reset);
		assert.deepEqual([...container.querySelectorAll(".knomo-toolbar-item")], originalRows);
		assert.equal(bold.getAttribute("aria-checked"), "false");
		assert.equal(originalRows[0]!.querySelector<HTMLButtonElement>('[data-icon="arrow-up"]')!.disabled, true);
		assert.equal(originalRows.at(-1)!.querySelector<HTMLButtonElement>('[data-icon="arrow-down"]')!.disabled, true);
	} finally {
		for (const [key, descriptor] of descriptors) { if (descriptor) Object.defineProperty(Setting.prototype, key, descriptor); else Reflect.deleteProperty(Setting.prototype, key); }
		dom.window.close();
	}
});
