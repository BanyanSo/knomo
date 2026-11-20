import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { renderSettings } from "./helpers/renderSettingsFixture";

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
