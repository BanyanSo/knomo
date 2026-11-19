import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { ensureObsidianStub } from "./obsidianStub";
import { DEFAULT_KNOMO_SETTINGS } from "../../src/settings/defaults";

export async function renderSettings(locale: "zh-CN" | "en") {
	await ensureObsidianStub();
	const { Setting } = await import("obsidian");
	const { KnomoSettingTab } = await import("../../src/ui/KnomoSettingTab");
	const i18n = await import("../../src/i18n");
	const originalTranslate = i18n.t;
	i18n.t = (key, params) => i18n.translate(locale, key, params);
	const dom = new JSDOM("<div class='knomo-settings-page'></div>");
	const proto = dom.window.HTMLElement.prototype;
	Object.assign(proto, {
		createEl(this: HTMLElement, tag: string, options: { cls?: string; text?: string; attr?: Record<string, string> } = {}) {
			const el = this.ownerDocument.createElement(tag);
			if (options.cls) el.className = options.cls;
			if (options.text) el.textContent = options.text;
			for (const [key, value] of Object.entries(options.attr ?? {})) el.setAttribute(key, value);
			return this.appendChild(el);
		},
		createDiv(this: HTMLElement, options?: { cls?: string }) { return this.createEl("div", options); },
		createSpan(this: HTMLElement, options?: { text?: string }) { return this.createEl("span", options); },
		addClass(this: HTMLElement, ...names: string[]) { this.classList.add(...names); },
		setText(this: HTMLElement, text: string) { this.textContent = text; },
		setAttr(this: HTMLElement, name: string, value: string) { this.setAttribute(name, value); },
		setAttrs(this: HTMLElement, attributes: Record<string, string>) { for (const [name, value] of Object.entries(attributes)) this.setAttribute(name, value); },
		toggleClass(this: HTMLElement, name: string, value: boolean) { this.classList.toggle(name, value); },
		empty(this: HTMLElement) { this.replaceChildren(); },
	});
	type StubSetting = InstanceType<typeof Setting> & { containerEl: HTMLElement };
	const rows = new WeakMap<object, HTMLElement>();
	const row = (setting: StubSetting) => {
		let el = rows.get(setting);
		if (!el) {
			el = setting.containerEl.createDiv({ cls: "setting-item" });
			el.createDiv({ cls: "setting-item-info" }).innerHTML = "<div class='setting-item-name'></div><div class='setting-item-description'></div>";
			el.createDiv({ cls: "setting-item-control" });
			rows.set(setting, el);
		}
		return el;
	};
	const overrides = {
		setName(this: StubSetting, text: string) { row(this).querySelector(".setting-item-name")!.textContent = text; return this; },
		setDesc(this: StubSetting, text: string) { row(this).querySelector(".setting-item-description")!.textContent = text; return this; },
		setClass(this: StubSetting, name: string) { row(this).classList.add(name); return this; },
		setHeading(this: StubSetting) { row(this).classList.add("setting-item-heading"); return this; },
	};
	const keys = [...Object.keys(overrides), "settingEl", "infoEl", "controlEl", "addButton", "addToggle", "addDropdown", "addText"];
	const descriptors = keys.map(key => [key, Object.getOwnPropertyDescriptor(Setting.prototype, key)] as const);
	Object.assign(Setting.prototype, overrides);
	for (const [key, selector] of [["settingEl", null], ["infoEl", ".setting-item-info"], ["controlEl", ".setting-item-control"]] as const) {
		Object.defineProperty(Setting.prototype, key, { configurable: true, get(this: StubSetting) { return selector ? row(this).querySelector(selector) : row(this); } });
	}
	for (const [method, tag, cls] of [["addButton", "button", ""], ["addToggle", "div", "checkbox-container"], ["addText", "input", ""], ["addDropdown", "select", "dropdown"]] as const) {
		Object.defineProperty(Setting.prototype, method, { configurable: true, writable: true, value(this: StubSetting, configure: (component: unknown) => void) {
			const el = this.controlEl.createEl(tag, { cls });
			if (tag === "input") (el as HTMLInputElement).type = "text";
			const component = {
				buttonEl: el, inputEl: el,
				setValue(value: string | boolean) { if (typeof value === "boolean") el.classList.toggle("is-enabled", value); else (el as HTMLInputElement).value = value; return this; },
				setButtonText(text: string) { el.textContent = text; return this; },
				setIcon(icon: string) { el.textContent = icon === "arrow-up" ? "↑" : "↓"; return this; },
				setTooltip(text: string) { el.setAttribute("aria-label", text); return this; },
				setDisabled(value: boolean) { (el as HTMLButtonElement).disabled = value; return this; },
				setPlaceholder(text: string) { (el as HTMLInputElement).placeholder = text; return this; },
				addOption(value: string, text: string) { el.createEl("option", { text, attr: { value } }); return this; },
				onClick(callback: () => void) { el.addEventListener("click", callback); return this; },
				onChange() { return this; },
			};
			configure(component); return this;
		} });
	}
	try {
		const tab = Object.create(KnomoSettingTab.prototype);
		let excludeFailure = false;
		Object.assign(tab, {
			pluginVersion: "1.12.5", toolbarExpanded: true, pendingSettingDrafts: new Map(),
			settingsService: {
				getSettings: () => DEFAULT_KNOMO_SETTINGS,
				validateMonthlyMemoFileFormat: () => true,
				hasMonthlyExcludeInitializationFailure: () => excludeFailure,
			},
		});
		const page = dom.window.document.querySelector<HTMLElement>(".knomo-settings-page")!;
		for (const method of ["renderRecordSettings", "renderArchiveSettings", "renderAboutSettings"]) {
			tab[method](page.createDiv({ cls: "knomo-settings-panel" }));
		}
		const attention = page.createDiv({ cls: "knomo-settings-attention" });
		tab.renderAttentionSetting("catalog", new Setting(attention));
		excludeFailure = true;
		const failed = new Setting(page.createDiv({ cls: "knomo-settings-panel" })).setName("Monthly / 重试");
		tab.renderMonthlyExcludeSetting(failed);
		// 补齐 SettingGroup 的宿主包装，供实际宿主 CSS 的后代选择器使用。
		for (const list of page.querySelectorAll(".setting-items")) {
			const group = dom.window.document.createElement("div");
			group.className = "setting-group";
			list.before(group); group.appendChild(list);
		}
		assert.equal(page.querySelectorAll(".knomo-toolbar-item").length, DEFAULT_KNOMO_SETTINGS.composerToolbar.order.length);
		assert.equal(failed.controlEl.querySelectorAll("button").length, 0);
		assert.equal(failed.settingEl.querySelectorAll(":scope > button").length, 1);
		assert.equal(page.querySelectorAll(".knomo-settings-value-row a").length, 6);
		assert.equal(attention.querySelectorAll("button").length, 2);
		return page.outerHTML;
	} finally {
		i18n.t = originalTranslate;
		for (const [key, descriptor] of descriptors) {
			if (descriptor) Object.defineProperty(Setting.prototype, key, descriptor);
			else Reflect.deleteProperty(Setting.prototype, key);
		}
		dom.window.close();
	}
}
