import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import type { SelectedRecordStats } from "../src/services/RecordStatsService";
import { ensureObsidianStub } from "./helpers/obsidianStub";

// 使用真实页面生成控件，不把宿主快照或浏览器依赖变成项目的必需输入。
async function segmentHtml(): Promise<string> {
	await ensureObsidianStub();
	const { renderTimeBuoyPage } = await import("../src/ui/TimeBuoyPage");
	const { renderKnomoRecordStatsPage } = await import("../src/ui/KnomoRecordStatsPage");
	const dom = new JSDOM("<main></main>");
	Object.assign(dom.window.HTMLElement.prototype, {
		createEl(this: HTMLElement, tag: string, options: { cls?: string; text?: string; attr?: Record<string, string> } = {}) {
			const el = this.ownerDocument.createElement(tag);
			if (options.cls) el.className = options.cls;
			if (options.text) el.textContent = options.text;
			for (const [key, value] of Object.entries(options.attr ?? {})) el.setAttribute(key, value);
			return this.appendChild(el);
		},
		createDiv(this: HTMLElement, options?: DomElementInfo) { return this.createEl("div", options); },
		createSpan(this: HTMLElement, options?: DomElementInfo) { return this.createEl("span", options); },
		setAttr(this: HTMLElement, key: string, value: string) { this.setAttribute(key, value); },
		setCssProps(this: HTMLElement, props: Record<string, string>) { for (const [key, value] of Object.entries(props)) this.style.setProperty(key, value); },
		empty(this: HTMLElement) { this.replaceChildren(); },
		find(this: HTMLElement, selector: string) { return this.querySelector(selector); },
	});
	try {
		const root = dom.window.document.querySelector("main")!;
		renderTimeBuoyPage(root, {
			todayDate: "2026-10-20", todayRevision: 1, todayValid: true, todayError: null, loadingMore: false, nextCursor: null,
			loading: false, error: null, refreshError: null, complete: true, activeTab: "today", today: [], upcoming: [], past: [],
		}, { idPrefix: "glass-buoy" });
		const buoy = root.querySelector(".knomo-time-buoy-tabs")!.outerHTML;
		const selected: SelectedRecordStats = {
			startDate: "2026-10-19", endDateExclusive: "2026-10-26",
			overview: { memoCount: 1, wordCount: 4, recordDayCount: 1 },
			range: { memoCount: 1, wordCount: 4, recordDayCount: 1, referenceMemoCount: 0, taggedMemoCount: 0, untaggedMemoCount: 1,
				imageMemoCount: 0, maxDailyMemoCount: 1, maxDailyWordCount: 4, maxDailyMemoDates: ["2026-10-19"], maxDailyWordDates: ["2026-10-19"] },
			trend: [], activeHours: [], commonTags: [],
		};
		renderKnomoRecordStatsPage(root, {
			snapshot: { state: "ready", error: null, updating: false }, selected, view: "week", canAdvance: false, canRetreat: true,
			createHiddenText: (parent, id, text) => { parent.createSpan({ text, attr: { id } }); return id; },
		});
		return buoy + root.querySelector(".knomo-record-stats-view-controls")!.outerHTML;
	} finally { dom.window.close(); }
}

const hostFixture = `
 * { box-sizing:border-box; }
 body { display:block; margin:0; font:16px/1.5 Arial; --size-2-1:2px; --size-4-2:8px;
   --background-primary:#fff; --background-secondary:#ededed; --background-modifier-hover:rgba(0,0,0,.08);
   --text-normal:#222; --text-muted:#666; --text-on-accent:#fff; --interactive-accent:#7852c9; --background-modifier-border:#ccc; }
 body.theme-dark { --background-primary:#202020; --background-secondary:#303030; --text-normal:#eee; --text-muted:#aaa; --background-modifier-border:#555; }
 .fixture-root { display:block; height:auto; padding:12px; }
 .knomo-time-buoy-tabs, .knomo-record-stats-view-controls { margin-bottom:24px; }
 .mobile-navbar { position:fixed; bottom:12px; left:8px; width:280px; height:48px; border-radius:24px;
   background-color:var(--background-primary); background-image:linear-gradient(90deg, transparent, rgba(0,0,0,.02));
   backdrop-filter:blur(7px); box-shadow:0 0 2px red; }
 .mobile-navbar button { width:44px; height:44px; }
 .mobile-navbar::before { content:""; position:absolute; inset:0; pointer-events:none; border:1px solid rgba(255,255,255,.3); border-radius:inherit; }
 .mobile-navbar::after { content:""; position:absolute; inset:1px; pointer-events:none; border-radius:inherit;
   background:linear-gradient(180deg, rgba(255,255,255,.06), transparent); }
`;

test("forced colors preserve segment selection separately from keyboard focus", { skip: !process.env.KNOMO_LAYOUT_PLAYWRIGHT }, async () => {
	const { chromium } = require(process.env.KNOMO_LAYOUT_PLAYWRIGHT!);
	const browser = await chromium.launch({ headless: true });
	try {
		const page = await browser.newPage();
		const html = await segmentHtml();
		for (const mobile of [false, true]) {
			await page.emulateMedia({ forcedColors: "active", reducedMotion: "reduce" });
			await page.setContent(`<style>${hostFixture}${readFileSync("styles.css", "utf8")}</style><body class="theme-light ${mobile ? "is-mobile" : ""}"><main class="fixture-root knomo-plugin ${mobile ? "is-layout-mobile" : ""}">${html}</main></body>`);
			const selected = page.locator(".knomo-time-buoy-tab.is-active");
			assert.equal(await selected.evaluate((el: HTMLElement) => getComputedStyle(el).textDecorationLine), "underline", "selection survives removal of backgrounds and shadows");
			const inactive = page.locator(".knomo-time-buoy-tab").nth(1);
			await page.keyboard.press("Tab");
			await inactive.focus();
			assert.equal(await inactive.evaluate((el: HTMLElement) => getComputedStyle(el).outlineStyle), "solid");
			assert.equal(await inactive.evaluate((el: HTMLElement) => getComputedStyle(el).textDecorationLine), "none", "focus is not mistaken for selection");
		}
	} finally { await browser.close(); }
});

test("mobile segments retain their base styles while Navbar uses a uniform fill and restores the host", { skip: !process.env.KNOMO_LAYOUT_PLAYWRIGHT }, async () => {
	const { chromium } = require(process.env.KNOMO_LAYOUT_PLAYWRIGHT!);
	const html = await segmentHtml();
	const css = readFileSync(process.env.KNOMO_LAYOUT_CSS || "styles.css", "utf8");
	const host = process.env.KNOMO_LAYOUT_HOST_CSS ? readFileSync(process.env.KNOMO_LAYOUT_HOST_CSS, "utf8") : "";
	const browser = await chromium.launch({ channel: process.env.KNOMO_LAYOUT_BROWSER || "msedge", headless: true });
	try {
		const page = await browser.newPage({ viewport: { width: 320, height: 700 }, hasTouch: true });
		const cdp = await page.context().newCDPSession(page);
		for (const theme of ["theme-light", "theme-dark"]) for (const accent of ["#7852c9", "#ad591d"]) for (const manual of [false, true]) for (const system of ["no-preference", "reduce"]) {
			// 状态断言关闭过渡，减少动态适配在矩阵末尾另行核对。
			await cdp.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-transparency", value: system }, { name: "prefers-reduced-motion", value: "reduce" }] });
			await page.setContent(`<style>${host}${css}${hostFixture}</style><body class="is-mobile ${theme} knomo-mobile-navbar-compact-active knomo-mobile-navbar-floating" style="--interactive-accent:${accent}">
				<main class="fixture-root knomo-plugin is-layout-mobile ${manual ? "knomo-reduce-glass" : ""}">${html}</main>
				<div class="workspace-leaf-content ${manual ? "knomo-reduce-glass" : ""}" data-type="knomo-view" style="display:none"><div class="view-header"></div></div>
				<nav class="mobile-navbar knomo-mobile-navbar-compact ${manual ? "knomo-reduce-glass" : ""}"><button type="button" data-action="host-menu">Menu</button></nav></body>`);
			await page.mouse.move(319, 699);
			const context = `${theme}/${accent}/manual=${manual}/system=${system}`;
			const accentColor = `rgb(${[1, 3, 5].map(offset => parseInt(accent.slice(offset, offset + 2), 16)).join(", ")})`;
			const tracks = page.locator(".knomo-time-buoy-tabs, .knomo-record-stats-view-controls");
			const surfaces = await tracks.evaluateAll((elements: HTMLElement[]) => elements.map(el => {
				const style = getComputedStyle(el);
				return { role: el.getAttribute("role"), background: style.backgroundColor, image: style.backgroundImage, filter: style.backdropFilter, shadow: style.boxShadow, borderWidth: style.borderTopWidth,
					buttons: [...el.querySelectorAll("button")].map(button => {
						const paint = getComputedStyle(button);
						return { selected: button.getAttribute(el.getAttribute("role") === "tablist" ? "aria-selected" : "aria-pressed"),
							active: button.classList.contains("is-active"), width: button.offsetWidth, height: button.offsetHeight,
							image: paint.backgroundImage, background: paint.backgroundColor, color: paint.color, shadow: paint.boxShadow, filter: paint.backdropFilter };
					}) };
			}));
			assert.deepEqual(surfaces.map((surface: { role: string }) => surface.role), ["tablist", "group"], context);
			for (const surface of surfaces) {
				assert.equal(surface.background, "rgba(0, 0, 0, 0.08)", `${context}: tab track keeps its original background`);
				assert.equal(surface.image, "none", context);
				assert.equal(surface.filter, "none", context);
				assert.equal(surface.shadow, "none", `${context}: tab track has no decorative outline`);
				assert.equal(surface.borderWidth, "0px", `${context}: tab track has no border`);
				assert.equal(surface.buttons.length, 3, context);
				assert.equal(surface.buttons.filter((button: { active: boolean }) => button.active).length, 1, context);
				for (const button of surface.buttons) {
					assert.equal(button.selected, String(button.active), context);
					assert.ok(button.height >= 44, context);
					assert.ok(Math.abs(button.width - surface.buttons[0].width) <= 1, context);
					assert.equal(button.filter, "none", context);
					if (button.active) {
						assert.equal(button.image, "none", context);
						assert.equal(button.shadow, "none", `${context}: selected segment uses a fill without an outline or shadow`);
						assert.equal(button.background, accentColor, `${context}: selection uses the original theme accent`);
						assert.equal(button.color, "rgb(255, 255, 255)", `${context}: selected text keeps its original on-accent color`);
					}
					else { assert.equal(button.image, "none", context); assert.equal(button.background, "rgba(0, 0, 0, 0)", context); }
				}
			}
			assert.equal(surfaces[0].buttons[0].background, surfaces[1].buttons[0].background, `${context}: both pages keep the same selected color`);
			await page.evaluate(() => {
				document.body.addEventListener("click", event => {
					const target = (event.target as HTMLElement).closest<HTMLButtonElement>("button[data-action]");
					if (target) target.dataset.calls = String(Number(target.dataset.calls ?? 0) + 1);
				});
			});
			const navbar = page.locator(".mobile-navbar");
			const navPaint = await navbar.evaluate((el: HTMLElement) => {
				const style = getComputedStyle(el);
				const canvas = document.createElement("canvas");
				canvas.width = canvas.height = 1;
				const ctx = canvas.getContext("2d")!;
				ctx.fillStyle = style.backgroundColor;
				ctx.fillRect(0, 0, 1, 1);
				const alpha = ctx.getImageData(0, 0, 1, 1).data[3];
				const edge = (pseudo: string) => {
					const paint = getComputedStyle(el, pseudo);
					return [paint.content, paint.backgroundColor, paint.backgroundImage, paint.border, paint.boxShadow, paint.backdropFilter];
				};
				return { color: style.backgroundColor, alpha, filter: style.backdropFilter, image: style.backgroundImage, radius: style.borderRadius,
					shadow: style.boxShadow, border: style.border, before: edge("::before"), after: edge("::after") };
			});
			assert.equal(navPaint.filter, await page.locator(".view-header").evaluate((el: HTMLElement) => getComputedStyle(el).backdropFilter), `${context}: Header and Navbar share the filter`);
			assert.notEqual(navPaint.shadow, "rgb(255, 0, 0) 0px 0px 2px 0px", `${context}: only the Knomo contour is drawn`);
			for (const edge of [navPaint.before, navPaint.after]) {
				assert.equal(edge[0], "none", `${context}: host edge does not overlay the material`);
				assert.equal(edge[5], "none", `${context}: no second backdrop filter`);
			}
			assert.equal(navPaint.image, "none", `${context}: floating fill has no gradient`);
			const systemReduced = await page.evaluate(() => matchMedia("(prefers-reduced-transparency: reduce)").matches);
			if (manual || systemReduced) {
				assert.equal(navPaint.filter, "none", context);
				assert.equal(navPaint.color, theme === "theme-dark" ? "rgb(48, 48, 48)" : "rgb(237, 237, 237)", `${context}: opaque theme fallback`);
				assert.equal(navPaint.alpha, 255, context);
			} else {
				assert.equal(navPaint.filter, "blur(2px) saturate(1.1)", context);
				assert.equal(navPaint.alpha, 102, `${context}: uniform 40% opacity`);
			}
			await page.evaluate(() => document.body.classList.remove("knomo-mobile-navbar-compact-active"));
			const hostPaint = await navbar.evaluate((el: HTMLElement) => {
				const paint = (pseudo?: string) => {
					const style = getComputedStyle(el, pseudo);
					return [style.backgroundColor, style.backgroundImage, style.border, style.boxShadow, style.backdropFilter];
				};
				return [paint(), paint("::before"), paint("::after")];
			});
			assert.equal(hostPaint[0][4], "blur(7px)", `${context}: leaving Knomo restores the host filter`);
			assert.match(hostPaint[0][1], /90deg/, `${context}: leaving Knomo restores the host gradient`);
			assert.notEqual(await navbar.evaluate((el: HTMLElement) => getComputedStyle(el, "::after").content), "none", `${context}: leaving Knomo restores the native edge`);
			await page.evaluate(() => document.body.classList.add("knomo-mobile-navbar-compact-active"));
			assert.deepEqual(await navbar.evaluate((el: HTMLElement) => {
				const paint = (pseudo?: string) => {
					const style = getComputedStyle(el, pseudo);
					return [style.backgroundColor, style.backgroundImage, style.border, style.boxShadow, style.backdropFilter];
				};
				return [paint(), paint("::before"), paint("::after")];
			}), [[navPaint.color, navPaint.image, navPaint.border, navPaint.shadow, navPaint.filter], navPaint.before.slice(1), navPaint.after.slice(1)], `${context}: returning to Knomo restores its material`);
			await page.locator("[data-action=host-menu]").tap();
			assert.equal(await page.locator("[data-action=host-menu]").getAttribute("data-calls"), "1", context);
			await page.evaluate(() => document.body.classList.replace("knomo-mobile-navbar-floating", "knomo-mobile-navbar-fixed"));
			assert.equal(await navbar.evaluate((el: HTMLElement) => getComputedStyle(el).borderRadius), navPaint.radius, `${context}: fixed mode preserves the host contour`);
		}
		assert.equal(await page.locator(".knomo-time-buoy-tab").first().evaluate((el: HTMLElement) => getComputedStyle(el).transitionDuration), "0s");
		await page.emulateMedia({ reducedMotion: "no-preference" });
		assert.equal(await page.locator(".knomo-time-buoy-tab").first().evaluate((el: HTMLElement) => getComputedStyle(el).transitionDuration), "0.16s, 0.16s");
		// 长翻译和约 200% 字体下仍保留三列、最小热区，允许行高自然增长。
		await page.locator(".fixture-root button").evaluateAll((buttons: HTMLButtonElement[]) => buttons.forEach(button => {
			button.textContent = "LangeÜbersetzung 今天再次相遇";
			button.style.fontSize = "32px";
		}));
		assert.equal(await page.locator(".fixture-root button").evaluateAll((buttons: HTMLButtonElement[]) => buttons.every(button =>
			button.scrollWidth <= button.clientWidth + 1 && button.scrollHeight <= button.clientHeight + 1 && button.offsetHeight >= 44)), true);
		await page.evaluate(() => {
			document.body.classList.remove("is-mobile", "knomo-mobile-navbar-compact-active");
			document.querySelector(".fixture-root")!.classList.replace("is-layout-mobile", "is-layout-desktop-wide");
		});
		assert.equal(await page.locator(".knomo-time-buoy-tab.is-active").evaluate((el: HTMLElement) => getComputedStyle(el).backgroundImage), "none", "desktop keeps its existing selected surface");
		assert.equal(await page.locator(".knomo-time-buoy-tabs").evaluate((el: HTMLElement) => getComputedStyle(el).backgroundImage), "none", "desktop track is unchanged");
		assert.equal(await page.locator(".mobile-navbar").evaluate((el: HTMLElement) => getComputedStyle(el).boxShadow), "rgb(255, 0, 0) 0px 0px 2px 0px", "leaving Knomo restores the host decoration");
	} finally { await browser.close(); }
});

function readSegmentInteractionState(button: HTMLElement) {
	const style = getComputedStyle(button);
	const background = style.backgroundColor;
	const focused = document.activeElement;
	return {
		hover: button.matches(".knomo-time-buoy-tab:hover"), focusVisible: button.matches(".knomo-time-buoy-tab:focus-visible"), focused: focused === button,
		pressed: button.matches(".knomo-time-buoy-tab:active"), selected: button.getAttribute("aria-selected"),
		background, outlineWidth: style.outlineWidth, outlineOffset: style.outlineOffset, shadow: style.boxShadow,
		calls: Number(button.dataset.calls ?? 0), pointerType: button.dataset.pointerType ?? null,
		documentMode: document.compatMode,
		focusedElement: focused ? `${focused.tagName}#${focused.id}.${focused.className}` : null,
	};
}

for (const input of ["touch", "mouse", "keyboard"] as const) test(`移动分段控件 ${input} 独立验证激活、反馈与状态退出`, { skip: !process.env.KNOMO_LAYOUT_PLAYWRIGHT }, async () => {
	const { chromium } = require(process.env.KNOMO_LAYOUT_PLAYWRIGHT!);
	const browser = await chromium.launch({ channel: process.env.KNOMO_LAYOUT_BROWSER || "msedge", headless: true });
	const html = await segmentHtml();
	const css = readFileSync(process.env.KNOMO_LAYOUT_CSS || "styles.css", "utf8");
	const host = process.env.KNOMO_LAYOUT_HOST_CSS ? readFileSync(process.env.KNOMO_LAYOUT_HOST_CSS, "utf8") : "";
	try {
		for (const theme of ["theme-light", "theme-dark"]) {
			// 每种输入独立页面，避免上一轮键盘焦点和触摸悬停状态污染下一轮。
			const page = await browser.newPage({ viewport: { width: 320, height: 700 }, hasTouch: input !== "mouse", reducedMotion: "reduce" });
			let phase = "initial";
			const button = page.locator(".knomo-time-buoy-tab").nth(1);
			try {
				await page.setContent(`<!doctype html><style>${host}${css}${hostFixture}</style><body class="is-mobile ${theme}">
					<main class="fixture-root knomo-plugin is-layout-mobile">${html}</main>
					<button id="outside" type="button">Outside</button></body>`);
				await page.evaluate(() => {
					document.body.addEventListener("pointerdown", event => {
						const target = (event.target as HTMLElement).closest<HTMLElement>(".knomo-time-buoy-tab");
						if (target) target.dataset.pointerType = event.pointerType;
					});
					document.body.addEventListener("click", event => {
						const target = (event.target as HTMLElement).closest<HTMLElement>(".knomo-time-buoy-tab");
						if (target) target.dataset.calls = String(Number(target.dataset.calls ?? 0) + 1);
					});
				});
				const outside = page.locator("#outside");
				const assertState = async (expected: Partial<ReturnType<typeof readSegmentInteractionState>>) => {
					const state = await button.evaluate(readSegmentInteractionState) as ReturnType<typeof readSegmentInteractionState>;
					const actual = Object.fromEntries(Object.keys(expected).map(key => [key, state[key as keyof typeof state]]));
					assert.deepEqual(actual, expected, `${input}/${theme}/${phase}: ${JSON.stringify(state)}`);
				};
				await assertState({ hover: false, focusVisible: false, focused: false, selected: "false", calls: 0, background: "rgba(0, 0, 0, 0)" });
				if (input === "touch") {
					phase = "tap";
					await button.tap();
					phase = "tap release";
					// 浏览器可能在 click 后短暂保留触摸按压反馈，按实际状态等待释放。
					await page.waitForFunction((el: HTMLElement) => !el.matches(".knomo-time-buoy-tab:active"), await button.elementHandle(), { timeout: 3000 });
					await assertState({ calls: 1, pointerType: "touch", pressed: false, selected: "false" });
					const state = await button.evaluate(readSegmentInteractionState) as ReturnType<typeof readSegmentInteractionState>;
					await assertState({ background: state.hover || state.focusVisible ? "rgba(0, 0, 0, 0.08)" : "rgba(0, 0, 0, 0)" });
					phase = "tap outside";
					await outside.tap();
				} else if (input === "mouse") {
					phase = "hover";
					await button.hover();
					await assertState({ hover: true, focusVisible: false, focused: false, background: "rgba(0, 0, 0, 0.08)" });
					phase = "leave hover";
					await outside.hover();
					await assertState({ hover: false, focusVisible: false, focused: false, background: "rgba(0, 0, 0, 0)" });
					phase = "mouse click";
					await button.click();
					await assertState({ calls: 1, pointerType: "mouse", pressed: false, selected: "false" });
					phase = "click outside";
					await outside.click();
				} else {
					phase = "keyboard focus";
					await page.keyboard.press("Tab");
					// 非选中 tab 的 tabindex 为 -1；此处只验证键盘模式下的焦点样式，导航由生产交互测试覆盖。
					await button.focus();
					await assertState({ hover: false, focusVisible: true, focused: true, background: "rgba(0, 0, 0, 0.08)", outlineWidth: "2px", outlineOffset: "-2px", shadow: "none" });
					phase = "keyboard activation";
					await page.keyboard.press("Space");
					await assertState({ calls: 1, pointerType: null, focusVisible: true, focused: true, pressed: false, selected: "false" });
					phase = "pointer leaves while keyboard focus remains";
					await outside.hover();
					await assertState({ hover: false, focusVisible: true, focused: true, background: "rgba(0, 0, 0, 0.08)" });
					phase = "focus leaves";
					await outside.click();
				}
				await assertState({ hover: false, focusVisible: false, focused: false, pressed: false, calls: 1, background: "rgba(0, 0, 0, 0)" });
			} catch (error) {
				const state = await button.evaluate(readSegmentInteractionState).catch(() => null);
				throw Object.assign(new Error(`${input}/${theme}/${phase}: ${JSON.stringify(state)}`), { cause: error });
			} finally { await page.close(); }
		}
	} finally { await browser.close(); }
});

test("Navbar retains geometry and focus across capability and contrast fallbacks", { skip: !process.env.KNOMO_LAYOUT_PLAYWRIGHT }, async () => {
	const { chromium } = require(process.env.KNOMO_LAYOUT_PLAYWRIGHT!);
	const browser = await chromium.launch({ headless: true });
	const css = readFileSync("styles.css", "utf8");
	const host = process.env.KNOMO_LAYOUT_HOST_CSS ? readFileSync(process.env.KNOMO_LAYOUT_HOST_CSS, "utf8") : "";
	try {
		const page = await browser.newPage({ viewport: { width: 390, height: 844 }, hasTouch: true });
		const cdp = await page.context().newCDPSession(page);
		for (const theme of ["theme-light", "theme-dark"]) for (const mode of ["floating", "fixed"]) for (const fallback of ["color-mix", "backdrop-filter", "prefers-contrast", "forced-colors"]) {
			await cdp.send("Emulation.setEmulatedMedia", { features: [] });
			await page.setContent(`<style id="material">${host}${css}${hostFixture}</style><body class="is-mobile is-phone is-ios ${mode === "floating" ? "is-floating-nav" : ""} ${theme} knomo-mobile-navbar-compact-active knomo-mobile-navbar-${mode}">
				<nav class="mobile-navbar mod-raised knomo-mobile-navbar-compact"><button class="knomo-mobile-navbar-sidebar-action" aria-label="Menu">Menu</button></nav></body>`);
			const navbar = page.locator(".mobile-navbar");
			const geometry = await navbar.boundingBox();
			const button = navbar.locator("button");
			const hitArea = await button.boundingBox();
			if (fallback === "prefers-contrast" || fallback === "forced-colors") {
				await cdp.send("Emulation.setEmulatedMedia", { features: [{ name: fallback, value: fallback === "forced-colors" ? "active" : "more" }] });
			} else {
				// 仅关闭增强分支，宿主仍保留原滤镜，以验证降级不会漏回宿主材质。
				await page.evaluate((feature: string) => {
					const sheet = (document.getElementById("material") as HTMLStyleElement).sheet!;
					for (let i = sheet.cssRules.length - 1; i >= 0; i--) {
						const rule = sheet.cssRules[i];
						if (rule instanceof CSSSupportsRule && rule.conditionText.includes(feature)) sheet.deleteRule(i);
					}
				}, fallback);
			}
			const context = `${theme}/${mode}/${fallback}`;
			const paint = await navbar.evaluate((el: HTMLElement) => {
				const style = getComputedStyle(el);
				return { filter: style.backdropFilter, image: style.backgroundImage, color: style.backgroundColor, shadow: style.boxShadow, outline: style.outlineStyle };
			});
			assert.equal(paint.filter, "none", context);
			assert.deepEqual(await navbar.boundingBox(), geometry, `${context}: material does not resize or move the host`);
			assert.deepEqual(await button.boundingBox(), hitArea, `${context}: material preserves the touch target`);
			if (fallback === "forced-colors") {
				assert.equal(paint.image, "none", `${context}: system color surface`);
				assert.notEqual(paint.color, "rgba(0, 0, 0, 0)", `${context}: opaque system fallback`);
			}
			else if (mode === "floating") {
				assert.equal(paint.image, "none", `${context}: uniform fallback`);
				assert.equal(paint.color, theme === "theme-dark" ? "rgb(48, 48, 48)" : "rgb(237, 237, 237)", `${context}: opaque theme surface`);
			} else assert.ok(paint.image.includes(theme === "theme-dark" ? "rgb(48, 48, 48)" : "rgb(237, 237, 237)"), `${context}: opaque theme surface`);
			if (fallback === "prefers-contrast" || fallback === "forced-colors") {
				assert.equal(paint.shadow, "none", context);
				assert.equal(paint.outline, "solid", context);
			}
			await button.focus();
			await page.keyboard.press("ArrowRight");
			assert.equal(await button.evaluate((el: HTMLElement) => getComputedStyle(el).outlineWidth), "2px", `${context}: keyboard focus survives`);
		}
	} finally { await browser.close(); }
});
