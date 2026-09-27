import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import { ensureObsidianStub } from "./helpers/obsidianStub";
import { DEFAULT_KNOMO_SETTINGS } from "../src/settings/defaults";

// 由真实设置渲染器生成页面，只替换宿主组件；不手写待测设置行。
async function renderSettings(locale: "zh-CN" | "en") {
	await ensureObsidianStub();
	const { Setting } = await import("obsidian");
	const { KnomoSettingTab } = await import("../src/ui/KnomoSettingTab");
	const i18n = await import("../src/i18n");
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

test("real settings renderers retain all controls and separate the Monthly retry from its toggle", async () => {
	await renderSettings("zh-CN");
	await renderSettings("en");
});

// 可选真实浏览器检查：指定已安装的 Playwright 模块路径，无需给插件添加运行时依赖。
test("settings geometry across host directions, widths and font sizes", { skip: !process.env.KNOMO_LAYOUT_PLAYWRIGHT }, async () => {
	const { chromium } = require(process.env.KNOMO_LAYOUT_PLAYWRIGHT!);
	const browser = await chromium.launch({ channel: process.env.KNOMO_LAYOUT_BROWSER || "msedge", headless: true });
	try {
		const page = await browser.newPage();
		const css = readFileSync(process.env.KNOMO_LAYOUT_CSS || "styles.css", "utf8");
		const hostCss = process.env.KNOMO_LAYOUT_HOST_CSS ? readFileSync(process.env.KNOMO_LAYOUT_HOST_CSS, "utf8") : "";
		const baseline = `
			* { box-sizing: border-box; }
			html { height:auto; overflow:visible; }
			:root { --size-4-1:4px; --size-4-2:8px; --size-4-3:12px; --size-4-4:16px; --size-4-6:24px; --size-4-10:40px; }
			body { margin:0; padding:16px; height:auto; overflow:auto; contain:none; font-family:Arial,sans-serif; }
			.modal { position:relative; inset:auto; transform:none; width:100%; max-width:none; height:auto; max-height:none; padding:0; border:0; display:block; overflow:visible; }
			.modal { container-type:inline-size; }
			.setting-item { display:flex; align-items:center; padding:16px 0; border-bottom:1px solid #ddd; }
			.setting-item-info { flex:1 1 auto; margin-right:16px; }
			.setting-item-description { color:#666; font-size:.875em; }
			.setting-item-control { display:flex; flex:1 0 auto; align-items:center; justify-content:flex-end; gap:8px; }
			.setting-item-control > * { font:inherit; }
			button,input,select { font:inherit; padding:8px; }
			.checkbox-container { width:50px; height:30px; flex:none; border-radius:20px; background:#aaa; }
			.checkbox-container.is-enabled { background:#299e91; }
			.knomo-toolbar-settings { padding-inline:16px; }
			/* 宿主按设置容器宽度触发，不能只缩小浏览器 viewport。 */
			@container (max-width:400px) {
				.setting-item:not(:is(.mod-toggle,.mod-navigable,.mod-action,.setting-item-heading)) .setting-item-control { width:100%; justify-content:flex-start; }
			}
		`;
		let cases = 0;
		for (const locale of ["zh-CN", "en"] as const) {
			const html = await renderSettings(locale);
			for (const mobile of [false, true]) for (const width of [280, 360, 430, 760]) for (const fontSize of [16, 22]) for (const column of [false, true]) for (const controlColumn of [false, true]) {
				await page.setViewportSize({ width, height: 900 });
				// 模拟宿主的纵向控制区及移动端拉伸按钮，保留实际插件 CSS 的覆盖顺序。
				const host = `.setting-item { flex-direction:${column ? "column" : "row"}; }
					.setting-item-control { flex-direction:${controlColumn ? "column" : "row"}; }
					${mobile ? ".is-mobile .setting-item-control { width:100%; justify-content:flex-start; } .is-mobile .setting-item-control > button { flex:1 1 auto; width:100%; }" : ""}`;
				await page.setContent(`<style>${hostCss}${baseline}${host}${css}</style><body class="theme-light ${mobile ? "is-mobile is-phone" : ""}" style="font-size:${fontSize}px"><div class="modal mod-settings">${html}</div></body>`);
				const errors: string[] = await page.evaluate(() => {
					const errors: string[] = [];
					const rect = (el: Element) => el.getBoundingClientRect();
					const rightAligned = (child: Element, parent: Element, name: string) => {
						const style = getComputedStyle(parent);
						const inset = parseFloat(style.paddingRight) + parseFloat(style.borderRightWidth);
						if (Math.abs(rect(child).right - rect(parent).right + inset) > 1) errors.push(name + " not right aligned");
					};
					for (const row of document.querySelectorAll(".knomo-settings-toggle-row")) {
						const toggle = row.querySelector(".checkbox-container")!;
						rightAligned(toggle, row, "toggle");
						if (rect(row.querySelector(".setting-item-info")!).right > rect(toggle).left) errors.push("toggle overlaps text");
						const retry = row.querySelector(":scope > button");
						if (retry && rect(retry).top < rect(toggle).bottom) errors.push("retry overlaps toggle");
					}
					let previous: number[] | undefined;
					for (const row of document.querySelectorAll(".knomo-toolbar-item")) {
						const controls = row.querySelector(".setting-item-control")!;
						rightAligned(controls, row, "toolbar");
						const positions = Array.from(controls.children).map(el => rect(el).left);
						if (previous && positions.some((left, i) => Math.abs(left - previous![i]) > 1)) errors.push("toolbar columns drift");
						previous = positions;
						for (const button of controls.querySelectorAll("button")) if (rect(button).width !== 44 || rect(button).height !== 44) errors.push("arrow size");
					}
					for (const row of document.querySelectorAll(".knomo-settings-value-row")) rightAligned(row.querySelector(".setting-item-control")!, row, "value");
					for (const el of document.querySelectorAll<HTMLElement>(".setting-item, .setting-item-control > *, .knomo-settings-row-action")) {
						if (rect(el).right > window.innerWidth || rect(el).left < 0 || el.scrollWidth > el.clientWidth + 1) errors.push("overflow: " + el.className);
					}
					for (const row of document.querySelectorAll(".setting-item")) {
						const info = row.querySelector(":scope > .setting-item-info");
						const control = row.querySelector(":scope > .setting-item-control");
						if (!info || !control || !rect(info).width || !rect(control).width) continue;
						const a = rect(info), b = rect(control);
						if (Math.min(a.right, b.right) - Math.max(a.left, b.left) > 1 && Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 1) errors.push("overlap: " + row.className);
					}
					return errors;
				});
				assert.deepEqual(errors, [], JSON.stringify({ locale, mobile, width, fontSize, column, controlColumn, errors }));
				if (process.env.KNOMO_LAYOUT_SCREENSHOT && locale === "zh-CN" && mobile && width === 430 && fontSize === 16 && column && controlColumn) {
					await page.screenshot({ path: process.env.KNOMO_LAYOUT_SCREENSHOT, fullPage: true });
				}
				cases++;
			}
		}
		assert.equal(cases, 128);
	} finally { await browser.close(); }
});
