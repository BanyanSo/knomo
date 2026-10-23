import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { build } from "esbuild";

// 代表性宿主规则自包含，故意保留候选内边距/行间距和菜单装饰以检验覆盖边界。
const hostFixture = `
 * { box-sizing:border-box; }
 body { margin:0; font:16px/1.5 Arial; --background-primary:#fff; --background-secondary:#ededed;
   --knomo-app-background-primary:var(--background-primary); --knomo-app-background-secondary:var(--background-secondary);
   --background-modifier-border:#ccc; --background-modifier-hover:rgba(0,0,0,.08); --interactive-accent:#7852c9;
   --interactive-accent-hover:#6945ba; --text-normal:#222; --text-muted:#666; --text-faint:#888; --text-on-accent:#fff;
   --suggestion-background:var(--background-secondary); --suggestion-backdrop-filter:none; --font-ui-medium:16px;
   --size-2-1:2px; --size-4-1:4px; --size-4-2:8px; --size-4-8:32px; --border-width:1px; --radius-l:12px; --radius-xl:16px; color:var(--text-normal); }
 body.theme-dark { --background-primary:#202020; --background-secondary:#303030; --background-modifier-border:#555;
   --background-modifier-hover:rgba(255,255,255,.08); --text-normal:#eee; --text-muted:#aaa; }
 .suggestion-container { display:flex; flex-direction:column; padding:var(--fixture-suggest-padding, 0px); border:var(--border-width) solid var(--background-modifier-border); border-radius:var(--fixture-suggest-radius, 12px);
   background:var(--suggestion-background);
   backdrop-filter:var(--suggestion-backdrop-filter); box-shadow:0 8px 20px rgba(0,0,0,.2); }
 body.is-mobile { --suggestion-backdrop-filter:blur(8px); }
 .is-mobile .suggestion-container { background:color-mix(in srgb, var(--suggestion-background) 80%, transparent); }
 .suggestion { overflow-y:auto; padding:var(--fixture-list-padding, 6px); }
 .suggestion-item { font-size:var(--font-ui-medium); padding:8px 12px; margin-bottom:1px; border-radius:10px; }
 .suggestion-item.is-selected { background:var(--background-modifier-hover); }
 .suggestion-item.mod-complex { display:flex; align-items:baseline; justify-content:space-between; }
 .suggestion-content { display:flex; flex-direction:column; overflow:hidden; margin-inline-end:auto; }
 .suggestion-title { overflow-wrap:break-word; }
 .suggestion-note { font-size:.8em; color:var(--text-muted); overflow-wrap:break-word; }
  .menu { padding:6px; border:1px solid red; border-radius:12px; background:var(--background-secondary); box-shadow:0 0 2px red;
    backdrop-filter:var(--fixture-menu-filter, none); background-image:var(--fixture-menu-image, none); }
 .menu-item { padding:8px; }
 .fixture-mask { position:fixed; inset:0; background:rgba(0,0,0,.48); }
 .fixture-content { height:100vh; background:repeating-linear-gradient(0deg, #aaa 0 10px, #777 10px 20px); }
 .fixture-composer .knomo-composer-editor { min-height:76px; }
 .fixture-composer button:focus-visible { outline:2px solid var(--interactive-accent); outline-offset:-2px; }
`;

function markup(reduced: boolean, mobile = true): string {
	const preference = reduced ? "knomo-reduce-glass" : "";
	const surface = `knomo-mobile-glass-surface ${preference}`;
	const mobileClass = mobile ? "knomo-suggest-mobile" : "";
	const tagMobileClass = mobile ? "knomo-tag-suggest-mobile" : "";
	return `<div class="fixture-content"></div><div class="fixture-mask"></div>
	 <div class="workspace-leaf-content ${preference}" data-type="knomo-view">
	  <div class="view-header"><button class="view-action">Menu</button></div>
	  <button class="knomo-mobile-create-fab" aria-label="Create" style="--knomo-mobile-create-fab-bottom:198px"><svg width="24" height="24"><path d="M12 4V20M4 12H20" stroke="currentColor"/></svg></button>
	 </div>
	 <div id="single" class="suggestion-container knomo-native-suggest knomo-tag-suggest-popover ${tagMobileClass} ${mobileClass} ${surface}" style="left:16px;top:120px;--knomo-suggest-width:180px" role="listbox">
	  <div class="suggestion knomo-suggest-list"><div class="suggestion-item is-selected" role="option" aria-selected="true"><span>#one</span></div></div>
	 </div>
	 <div id="multi" class="suggestion-container knomo-native-suggest knomo-tag-suggest-popover ${tagMobileClass} ${mobileClass} ${surface}" style="left:16px;top:200px;--knomo-suggest-width:180px" role="listbox">
	  <div class="suggestion knomo-suggest-list"><div class="suggestion-item" role="option" aria-selected="false"><span>#one</span></div><div class="suggestion-item is-selected" role="option" aria-selected="true"><span>#two</span></div></div>
	 </div>
	 <div id="link" class="suggestion-container knomo-native-suggest knomo-link-suggest-popover ${mobileClass} ${surface}" style="--knomo-suggest-left:206px;--knomo-suggest-top:120px;--knomo-suggest-width:168px" role="listbox">
	  <div class="suggestion knomo-suggest-list"><div class="suggestion-item mod-complex knomo-link-suggest-item is-selected" role="option" aria-selected="true"><div class="suggestion-content"><div class="suggestion-title knomo-link-suggest-title">Alpha</div><div class="suggestion-note knomo-link-suggest-path">Notes/Alpha.md</div></div></div></div>
	 </div>
  <div id="owned-menu" class="menu knomo-mobile-menu knomo-mobile-menu-scope"><div class="menu-item mod-checked">All</div></div>
  <div id="card-menu" class="menu knomo-mobile-menu knomo-mobile-menu-card"><div class="menu-item">More</div></div>
	 <div id="host-menu" class="menu"><div class="menu-item">Host</div></div>
	 <div class="knomo-plugin is-layout-mobile ${preference}"><div id="picker" class="knomo-time-buoy-picker is-mobile is-open">Date
	  <div class="knomo-time-buoy-picker-grid">${Array.from({ length: 35 }, (_, index) => `<button class="knomo-time-buoy-picker-day ${index === 0 ? "is-today" : ""}" ${index === 1 ? "disabled" : ""}>${index % 31 + 1}</button>`).join("")}</div></div></div>
	 <div class="fixture-composer knomo-plugin is-layout-mobile knomo-mobile-composer-layer is-active is-open ${preference}"><div class="knomo-mobile-composer-stage"><div class="knomo-mobile-composer-content"><div class="knomo-composer"><div class="knomo-composer-editor">Readable draft</div>
	  <button class="knomo-send-button" aria-label="Send"><svg><path d="M4 12H20" stroke="currentColor"/></svg></button></div></div></div></div>`;
}

function menuShellStyles(elements: HTMLElement[]) {
	return elements.map(el => {
		const style = getComputedStyle(el);
		return {
			background: style.backgroundColor, image: style.backgroundImage, border: style.border,
			radius: style.borderRadius, padding: style.padding, shadow: style.boxShadow,
			filter: style.backdropFilter, webkitFilter: style.getPropertyValue("-webkit-backdrop-filter"),
			color: style.color, font: style.fontFamily, size: style.fontSize, weight: style.fontWeight,
			lineHeight: style.lineHeight, opacity: style.opacity,
		};
	});
}

test("contrast preferences make owned glass solid without changing host menus", { skip: !process.env.KNOMO_LAYOUT_PLAYWRIGHT }, async () => {
	const { chromium } = require(process.env.KNOMO_LAYOUT_PLAYWRIGHT!);
	const browser = await chromium.launch({ headless: true });
	try {
		const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
		for (const theme of ["theme-light", "theme-dark"]) for (const forcedColors of ["none", "active"]) {
			await page.emulateMedia({ contrast: "more", forcedColors });
			await page.setContent(`<style>${hostFixture}${readFileSync("styles.css", "utf8")}</style><body class="is-mobile is-phone ${theme}">${markup(false)}</body>`);
			for (const selector of ["#single", "#picker", ".view-header"]) {
				const paint = await page.locator(selector).evaluate((el: HTMLElement) => {
					const s = getComputedStyle(el, el.classList.contains("view-header") ? "::before" : null);
					return { filter: s.backdropFilter };
				});
				assert.equal(paint.filter, "none", `${theme}/${forcedColors}/${selector}: contrast removes blur`);
			}
			assert.equal(await page.locator("#picker").evaluate((el: HTMLElement) => getComputedStyle(el).backgroundImage), "none");
			const menus = await page.locator("#owned-menu, #card-menu, #host-menu").evaluateAll(menuShellStyles);
			assert.deepEqual(menus[0], menus[2], `${theme}/${forcedColors}: scope shell follows the host`);
			assert.deepEqual(menus[1], menus[2], `${theme}/${forcedColors}: card shell follows the host`);
			if (forcedColors === "none") {
				assert.equal(await page.locator("#picker").evaluate((el: HTMLElement) => getComputedStyle(el).backgroundColor), theme === "theme-light" ? "rgb(255, 255, 255)" : "rgb(32, 32, 32)");
				assert.equal(await page.locator("#host-menu").evaluate((el: HTMLElement) => getComputedStyle(el).borderTopColor), "rgb(255, 0, 0)");
			}
		}
	} finally { await browser.close(); }
});

test("mobile date grid keeps separate 44px touch targets inside a narrow viewport", { skip: !process.env.KNOMO_LAYOUT_PLAYWRIGHT }, async () => {
	const { chromium } = require(process.env.KNOMO_LAYOUT_PLAYWRIGHT!);
	const browser = await chromium.launch({ headless: true });
	try {
		const page = await browser.newPage();
		for (const width of [320, 350, 390, 844]) for (const fontSize of [16, 32]) {
			await page.setViewportSize({ width, height: 844 });
			await page.setContent(`<style>${hostFixture}${readFileSync("styles.css", "utf8")}</style><body class="is-mobile is-phone theme-light">${markup(false)}</body>`);
			await page.locator(".knomo-time-buoy-picker-day").evaluateAll((days: HTMLElement[], size: number) => days.forEach(day => { day.style.fontSize = `${size}px`; }), fontSize);
			const geometry = await page.locator(".knomo-time-buoy-picker-grid").evaluate((el: HTMLElement) => {
				const frame = el.getBoundingClientRect();
				return { left: frame.left, right: frame.right, cells: [...el.children].map(child => {
					const rect = child.getBoundingClientRect();
					return { left: rect.left, right: rect.right, width: rect.width, height: rect.height };
				}) };
			});
			for (const [index, cell] of geometry.cells.entries()) {
				assert.ok(cell.width >= 44 && cell.height >= 44, `${width}/${fontSize}/${index}: full touch target`);
				assert.ok(cell.left >= geometry.left - 1 && cell.right <= geometry.right + 1, `${width}/${fontSize}/${index}: target stays within the calendar`);
				if (index % 7 > 0) assert.ok(cell.left >= geometry.cells[index - 1].right - 0.1, `${width}/${fontSize}/${index}: neighboring dates do not share a touch area`);
			}
		}
	} finally { await browser.close(); }
});

test("mobile candidates and menus follow native material while the date picker retains glass", { skip: !process.env.KNOMO_LAYOUT_PLAYWRIGHT }, async () => {
	const { chromium } = require(process.env.KNOMO_LAYOUT_PLAYWRIGHT!);
	const browser = await chromium.launch({ headless: true });
	try {
		const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
		const cdp = await page.context().newCDPSession(page);
		const css = readFileSync("styles.css", "utf8");
		for (const theme of ["theme-light", "theme-dark"]) for (const nativeGlass of [false, true]) for (const manual of [false, true]) for (const system of ["no-preference", "reduce"]) {
			await cdp.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-transparency", value: system }, { name: "prefers-reduced-motion", value: "reduce" }] });
			const nativeStyle = nativeGlass ? "--fixture-menu-filter:blur(4px);--fixture-menu-image:linear-gradient(120deg, rgba(255, 255, 255, .2), transparent);" : "";
			await page.setContent(`<style>${hostFixture}${css}</style><body class="is-mobile is-phone ${theme}" style="${nativeStyle}">${markup(manual)}</body>`);
			const context = `${theme}/nativeGlass=${nativeGlass}/manual=${manual}/system=${system}`;
			const solid = manual || system === "reduce";
			const menus = await page.locator("#owned-menu, #card-menu, #host-menu").evaluateAll(menuShellStyles);
			assert.deepEqual(menus[0], menus[2], `${context}: scope shell follows the host`);
			assert.deepEqual(menus[1], menus[2], `${context}: card shell follows the host`);
			assert.equal(menus[2].filter, nativeGlass ? "blur(4px)" : "none", `${context}: host material is retained independently of Knomo preferences`);
			const surfaces = await page.locator("#single, #multi, #link, #picker").evaluateAll((elements: HTMLElement[]) => elements.map(el => {
				const style = getComputedStyle(el);
				const canvas = document.createElement("canvas"), ctx = canvas.getContext("2d")!;
				ctx.fillStyle = style.backgroundColor; ctx.fillRect(0, 0, 1, 1);
				return { background: style.backgroundColor, alpha: ctx.getImageData(0, 0, 1, 1).data[3], image: style.backgroundImage,
					border: style.border, shadow: style.boxShadow, filter: style.backdropFilter, opacity: style.opacity, color: style.color };
			}));
			for (const [index, surface] of surfaces.entries()) {
				const native = index < 3;
				assert.equal(surface.background, surfaces[native ? 0 : 3].background, context);
				if (solid || native) assert.equal(surface.alpha, solid ? 255 : 204, context);
				else assert.ok(surface.alpha >= 204 && surface.alpha <= 230, `${context}: owned glass retains a readable tint while revealing the background`);
				assert.equal(surface.image === "none", native || solid, `${context}: only enhanced owned shells carry a sheen`);
				assert.equal(surface.border, surfaces[native ? 0 : 3].border, context);
				assert.equal(surface.shadow, surfaces[native ? 0 : 3].shadow, context);
				if (solid || native) assert.equal(surface.filter, solid ? "none" : "blur(8px)", context);
				else assert.match(surface.filter, /blur\([\d.]+px\)/, `${context}: one native backdrop filter on the owned shell`);
				assert.equal(surface.opacity, "1", `${context}: foreground is never faded`);
			}
			for (const id of ["single", "multi"]) {
				const rows = await page.locator(`#${id}`).evaluate((el: HTMLElement) => {
					const outer = el.getBoundingClientRect();
					const frame = getComputedStyle(el), list = el.querySelector<HTMLElement>(".suggestion")!, inset = getComputedStyle(list);
					const border = parseFloat(frame.borderTopWidth);
					const items = Array.from(list.children, child => {
						const rect = child.getBoundingClientRect(), style = getComputedStyle(child);
						return { top: rect.top, bottom: rect.bottom, height: rect.height, radius: style.borderRadius, shadow: style.boxShadow, margin: parseFloat(style.marginBottom),
							selected: child.getAttribute("aria-selected"), background: style.backgroundColor };
					});
					return { top: outer.top + border + parseFloat(frame.paddingTop) + parseFloat(inset.paddingTop), bottom: outer.bottom - border - parseFloat(frame.paddingBottom) - parseFloat(inset.paddingBottom), items };
				});
				assert.equal(rows.items[0].top, rows.top, context);
				const last = rows.items.at(-1)!;
				assert.equal(last.bottom + last.margin, rows.bottom, `${context}/${id}: original frame insets`);
				assert.equal(last.margin, 1, `${context}: native row margin stays inside the list inset`);
				for (const item of rows.items) {
					assert.ok(item.height >= 44, context);
					assert.equal(item.radius, "10px", `${context}: host row radius is retained`);
					assert.equal(item.shadow, "none", context);
				}
				if (id === "multi") {
					assert.equal(rows.items[0].bottom + rows.items[0].margin, rows.items[1].top, `${context}: multi-row spacing is retained`);
					assert.equal(rows.items[0].background, "rgba(0, 0, 0, 0)", context);
					assert.notEqual(rows.items[1].background, rows.items[0].background, context);
				}
			}
			assert.equal(await page.locator("#link > .suggestion").evaluate((el: HTMLElement) => getComputedStyle(el).padding), "6px", `${context}: native link list inset`);
			assert.equal(await page.locator("#link [role=option]").evaluate((el: HTMLElement) => getComputedStyle(el).borderRadius), "10px", `${context}: native link row radius`);
			assert.equal(await page.locator("#host-menu").evaluate((el: HTMLElement) => getComputedStyle(el).boxShadow), "rgb(255, 0, 0) 0px 0px 2px 0px", `${context}: unowned menu is untouched`);
			const grid = page.locator(".knomo-time-buoy-picker-grid");
			assert.equal(await grid.evaluate((el: HTMLElement) => getComputedStyle(el).backgroundColor), theme === "theme-dark" ? "rgb(32, 32, 32)" : "rgb(255, 255, 255)", `${context}: calendar content stays solid behind the glass shell`);
			assert.equal(await grid.locator(":disabled").evaluate((el: HTMLElement) => getComputedStyle(el).opacity), "1", `${context}: disabled dates use color without reducing foreground opacity`);
			assert.notEqual(await grid.locator(".is-today").evaluate((el: HTMLElement) => getComputedStyle(el).boxShadow), "none", `${context}: today remains marked in both materials`);
		}
		const retained = await page.locator("#single").elementHandle();
		await page.locator(".knomo-reduce-glass").evaluateAll((elements: HTMLElement[]) => elements.forEach(el => el.classList.remove("knomo-reduce-glass")));
		for (const system of ["no-preference", "reduce", "no-preference"]) {
			await cdp.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-transparency", value: system }] });
			assert.equal(await retained.evaluate((el: HTMLElement) => el === document.getElementById("single")), true, "system changes retain the open popup");
			assert.equal(await retained.evaluate((el: HTMLElement) => getComputedStyle(el).backdropFilter), system === "reduce" ? "none" : "blur(8px)");
			assert.equal(await page.locator("#picker").evaluate((el: HTMLElement) => getComputedStyle(el).backgroundImage === "none"), system === "reduce", "open date picker follows system changes");
			const menus = await page.locator("#owned-menu, #card-menu, #host-menu").evaluateAll(menuShellStyles);
			assert.deepEqual(menus[0], menus[2], `${system}: open scope shell follows the host`);
			assert.deepEqual(menus[1], menus[2], `${system}: open card shell follows the host`);
		}
	} finally { await browser.close(); }
});

test("desktop and mobile candidate frames, row styles and measurement insets follow the native host theme", { skip: !process.env.KNOMO_LAYOUT_PLAYWRIGHT }, async () => {
	const { chromium } = require(process.env.KNOMO_LAYOUT_PLAYWRIGHT!);
	const browser = await chromium.launch({ headless: true });
	const bundle = await build({
		stdin: { contents: 'export { measureSuggestionContentWidth, measureSuggestionContentHeight } from "./src/ui/composerSuggestPosition";', resolveDir: process.cwd(), loader: "ts" },
		bundle: true, write: false, format: "iife", globalName: "CandidateMeasurements",
	});
	try {
		const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
		for (const mobile of [false, true]) for (const theme of ["theme-light", "theme-dark"]) for (const padding of [0, 6]) for (const border of [1, 2]) {
			await page.setContent(`<style>${hostFixture}${readFileSync("styles.css", "utf8")}</style><body class="${mobile ? "is-mobile is-phone" : ""} ${theme}" style="--fixture-suggest-padding:${padding}px;--fixture-suggest-radius:16px;--border-width:${border}px">${markup(false, mobile)}</body>`);
			await page.addScriptTag({ content: bundle.outputFiles[0].text });
			const result = await page.evaluate(() => {
				Object.assign(HTMLElement.prototype, {
					addClass(this: HTMLElement, name: string) { this.classList.add(name); },
					detach(this: HTMLElement) { this.remove(); },
				});
				Object.assign(Node.prototype, { instanceOf(this: Node, type: typeof HTMLElement) { return this instanceof type; } });
				const measure = (window as unknown as { CandidateMeasurements: {
					measureSuggestionContentWidth(input: HTMLElement, popup: HTMLElement, selector: string): number;
					measureSuggestionContentHeight(input: HTMLElement, popup: HTMLElement, selector: string): number;
				} }).CandidateMeasurements;
				return ["single", "multi", "link"].map(id => {
					const popup = document.getElementById(id)!;
					const selector = id === "link" ? ".knomo-link-suggest-item" : ".suggestion-item";
					const metrics = () => {
						const style = getComputedStyle(popup), rect = popup.getBoundingClientRect();
						return { frame: [rect.x, rect.y, rect.width, style.padding, style.border, style.borderRadius, style.fontSize],
							height: rect.height, measuredWidth: measure.measureSuggestionContentWidth(popup, popup, selector),
							measuredHeight: measure.measureSuggestionContentHeight(popup, popup, selector),
							rows: Array.from(popup.querySelectorAll<HTMLElement>(selector), row => {
								const s = getComputedStyle(row), r = row.getBoundingClientRect();
								return [r.x, r.y, r.width, r.height, s.padding, s.border, s.borderRadius, s.fontSize, s.lineHeight];
							}),
							selection: getComputedStyle(popup.querySelector('[aria-selected="true"]')!).backgroundColor,
						};
					};
					const reference = popup.cloneNode(true) as HTMLElement;
					for (const element of [reference, ...Array.from(reference.querySelectorAll("*"))]) {
						for (const name of Array.from(element.classList)) if (name.startsWith("knomo-")) element.classList.remove(name);
						element.removeAttribute("id");
					}
					popup.after(reference);
					const nativeStyle = (el: Element) => {
						const s = getComputedStyle(el);
						return [s.padding, s.border, s.borderRadius, s.backgroundColor, s.boxShadow, s.fontSize, s.fontWeight, s.lineHeight, s.color];
					};
					const native = { frame: nativeStyle(reference), list: nativeStyle(reference.querySelector(".suggestion")!),
						rows: Array.from(reference.querySelectorAll(".suggestion-item"), nativeStyle) };
					const actual = { frame: nativeStyle(popup), list: nativeStyle(popup.querySelector(".suggestion")!),
						rows: Array.from(popup.querySelectorAll(".suggestion-item"), nativeStyle) };
					reference.remove();
					// 材质生命周期标记不得覆盖原生几何，参考样式自包含且不依赖本地宿主快照。
					popup.classList.remove("knomo-mobile-glass-surface");
					const before = metrics();
					popup.classList.add("knomo-mobile-glass-surface");
					const after = metrics();
					return { id, before, after, native, actual };
				});
			});
			for (const { id, before, after, native, actual } of result) {
				const context = `${mobile ? "mobile" : "desktop"}/${theme}/padding=${padding}/border=${border}/${id}`;
				assert.deepEqual(after.frame, before.frame, `${context}: frame and insets`);
				assert.deepEqual(after.rows, before.rows, `${context}: row size and rounding`);
				assert.equal(after.measuredWidth, before.measuredWidth, `${context}: adaptive width`);
				assert.equal(after.selection, before.selection, `${context}: original selection paint`);
				assert.deepEqual(actual, native, `${context}: frame, list and row styles match native elements`);
				assert.equal(after.height, before.height, `${context}: owned material marker cannot alter native height`);
				assert.equal(after.measuredHeight, before.measuredHeight, `${context}: automatic height stays unchanged`);
				if (!mobile && id !== "link") assert.equal(after.rows[0][3], 40, `${context}: desktop uses native row height without the mobile touch floor`);
			}
			assert.equal(await page.locator(".knomo-suggest-measure-host").count(), 0, "measurement clones are cleaned");
		}
	} finally { await browser.close(); }
});

test("mobile primary actions keep tint on press and preserve disabled, saving, focus and layout", { skip: !process.env.KNOMO_LAYOUT_PLAYWRIGHT }, async () => {
	const { chromium } = require(process.env.KNOMO_LAYOUT_PLAYWRIGHT!);
	const browser = await chromium.launch({ headless: true });
	try {
		const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
		const cdp = await page.context().newCDPSession(page);
		await cdp.send("DOM.enable");
		await cdp.send("CSS.enable");
		for (const theme of ["theme-light", "theme-dark"]) for (const manual of [false, true]) for (const system of ["no-preference", "reduce"]) {
			await cdp.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-transparency", value: system }, { name: "prefers-reduced-motion", value: "reduce" }] });
			await page.setContent(`<style>${hostFixture}${readFileSync("styles.css", "utf8")}</style><body class="is-mobile is-phone ${theme}">${markup(manual)}</body>`);
			await page.locator("#single, #multi, #link, #owned-menu, #card-menu, #host-menu, #picker").evaluateAll((elements: HTMLElement[]) => elements.forEach(el => el.remove()));
			const context = `${theme}/manual=${manual}/system=${system}`;
			const paint = () => page.evaluate(() => [".knomo-mobile-create-fab", ".knomo-send-button"].map((selector, index) => {
				const el = document.querySelector<HTMLElement>(selector)!, style = getComputedStyle(el, index ? "::before" : undefined);
				const ctx = document.createElement("canvas").getContext("2d")!;
				ctx.fillStyle = style.backgroundColor; ctx.fillRect(0, 0, 1, 1);
				return { background: style.backgroundColor, alpha: ctx.getImageData(0, 0, 1, 1).data[3], filter: style.backdropFilter, image: style.backgroundImage,
					opacity: getComputedStyle(el).opacity, iconOpacity: getComputedStyle(el.querySelector("svg")!).opacity };
			}));
			const normal = await paint();
			assert.equal(normal[0].background, normal[1].background, context);
			for (const surface of normal) {
				assert.equal(surface.alpha, manual || system === "reduce" ? 255 : 224, context);
				assert.equal(surface.filter, "none", context);
				assert.equal(surface.opacity, "1", context);
				assert.equal(surface.iconOpacity, "1", context);
				assert.equal(surface.image === "none", manual || system === "reduce", `${context}: solid preferences suppress the sheen without hiding the foreground`);
			}
			// 同屏比较时让新建按钮避开面板；实际停靠位置由已有布局回归覆盖。
			// 用浏览器引擎模拟按下伪类；实际点击、触摸取消另由交互回归覆盖。
			for (const selector of [".knomo-mobile-create-fab", ".knomo-send-button"]) {
				await page.keyboard.press("Tab"); await page.locator(selector).focus();
				assert.equal(await page.locator(selector).evaluate((el: HTMLElement) => el.matches(":focus-visible")), true, context);
				const pseudo = selector === ".knomo-send-button" ? "::before" : undefined;
				const shadow = await page.locator(selector).evaluate((el: HTMLElement, pseudo?: string) => getComputedStyle(el, pseudo).boxShadow, pseudo);
				const { root } = await cdp.send("DOM.getDocument");
				const { nodeId } = await cdp.send("DOM.querySelector", { nodeId: root.nodeId, selector });
				await cdp.send("CSS.forcePseudoState", { nodeId, forcedPseudoClasses: ["active"] });
				assert.deepEqual(await paint(), normal, `${context}: press keeps the same color and alpha`);
				assert.notEqual(await page.locator(selector).evaluate((el: HTMLElement, pseudo?: string) => getComputedStyle(el, pseudo).boxShadow, pseudo), shadow, `${context}: pressed feedback is painted`);
				await cdp.send("CSS.forcePseudoState", { nodeId, forcedPseudoClasses: [] });
			}
			const send = page.locator(".knomo-send-button");
			await page.keyboard.press("Tab"); await send.focus();
			const geometry = () => page.locator(".fixture-composer, .knomo-composer-editor, .knomo-send-button").evaluateAll((elements: HTMLElement[]) => elements.map(el => {
				const r = el.getBoundingClientRect(); return [r.x, r.y, r.width, r.height];
			}));
			const before = await geometry();
			assert.equal(await send.evaluate((el: HTMLElement) => getComputedStyle(el).outlineWidth), "2px", context);
			await send.evaluate((el: HTMLButtonElement) => { el.disabled = true; });
			assert.equal(await send.evaluate((el: HTMLElement) => getComputedStyle(el, "::before").backgroundImage), "none", context);
			assert.equal(await send.evaluate((el: HTMLElement) => getComputedStyle(el, "::before").boxShadow), "none", context);
			assert.deepEqual(await geometry(), before, context);
			await send.evaluate((el: HTMLButtonElement) => el.classList.add("is-saving"));
			assert.equal(await send.evaluate((el: HTMLElement) => getComputedStyle(el).cursor), "progress", context);
			assert.equal(await send.evaluate((el: HTMLElement) => getComputedStyle(el, "::before").backgroundImage), "none", context);
			assert.equal((await paint())[1].alpha, 255, context);
			assert.deepEqual(await geometry(), before, context);
		}
		// 按压只缩放装饰底层；减少动态效果时保留即时阴影反馈，停用收缩。
		await cdp.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "no-preference" }] });
		const send = page.locator(".knomo-send-button");
		await send.evaluate((el: HTMLButtonElement) => { el.disabled = false; el.classList.remove("is-saving"); });
		const controlGeometry = () => send.evaluate((el: HTMLElement) => [el, el.querySelector("svg")!].map(node => {
			const rect = node.getBoundingClientRect(); return [rect.x, rect.y, rect.width, rect.height];
		}));
		const stationary = await controlGeometry();
		const { root } = await cdp.send("DOM.getDocument");
		const { nodeId } = await cdp.send("DOM.querySelector", { nodeId: root.nodeId, selector: ".knomo-send-button" });
		await cdp.send("CSS.forcePseudoState", { nodeId, forcedPseudoClasses: ["active"] });
		await page.waitForFunction(() => new DOMMatrixReadOnly(getComputedStyle(document.querySelector(".knomo-send-button")!, "::before").transform).a < 0.97);
		assert.deepEqual(await controlGeometry(), stationary, "press does not move the icon or shrink the hit area");
		await page.emulateMedia({ reducedMotion: "reduce" });
		await page.waitForFunction(() => matchMedia("(prefers-reduced-motion: reduce)").matches
			&& getComputedStyle(document.querySelector(".knomo-send-button")!, "::before").transitionDuration === "0s");
		assert.equal(await send.evaluate((el: HTMLElement) => new DOMMatrixReadOnly(getComputedStyle(el, "::before").transform).a), 1, "reduced motion stops the decorative contraction");
		await cdp.send("CSS.forcePseudoState", { nodeId, forcedPseudoClasses: [] });
		// 关闭增强分支模拟能力不足：既不要求本机浏览器卸载特性，也不依赖宿主快照。
		for (const missing of ["color-mix", "backdrop-filter"]) {
			await cdp.send("Emulation.setEmulatedMedia", { features: [] });
			await page.setContent(`<style id="material">${hostFixture}${readFileSync("styles.css", "utf8")}</style><body class="is-mobile is-phone theme-light">${markup(false)}</body>`);
			await page.evaluate((feature: string) => {
				const sheet = (document.getElementById("material") as HTMLStyleElement).sheet!;
				for (let i = sheet.cssRules.length - 1; i >= 0; i--) {
					const rule = sheet.cssRules[i];
					if (rule instanceof CSSSupportsRule && rule.conditionText.includes(feature)) sheet.deleteRule(i);
				}
			}, missing);
			// 菜单与候选框已交由宿主绘制；此处只关闭 Knomo 自己的增强材质分支。
			for (const selector of ["#picker", ".view-header::before"]) {
				const pseudo = selector.includes("::before");
				const fallback = await page.locator(pseudo ? ".view-header" : selector).evaluate((el: HTMLElement, pseudo: boolean) => {
					const style = getComputedStyle(el, pseudo ? "::before" : undefined);
					return { filter: style.backdropFilter, background: style.backgroundColor, image: style.backgroundImage };
				}, pseudo);
				assert.equal(fallback.filter, "none", `${missing}/${selector}`);
				if (!pseudo) {
					assert.equal(fallback.background, "rgb(255, 255, 255)", `${missing}/${selector}: stable fallback`);
					assert.equal(fallback.image, "none", `${missing}/${selector}: unsupported enhancement leaves a solid shell`);
				}
				else assert.match(fallback.image, /rgb\(237, 237, 237\)/, `${missing}: opaque header gradient`);
			}
			const menus = await page.locator("#owned-menu, #card-menu, #host-menu").evaluateAll(menuShellStyles);
			assert.deepEqual(menus[0], menus[2], `${missing}: scope shell follows the host`);
			assert.deepEqual(menus[1], menus[2], `${missing}: card shell follows the host`);
		}
	} finally { await browser.close(); }
});
