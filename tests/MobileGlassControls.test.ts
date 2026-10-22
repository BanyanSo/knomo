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
   --text-normal:#222; --text-muted:#666; --text-on-accent:#fff; --background-modifier-border:#ccc; }
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

test("mobile Glass segments share selected, pressed and focus surfaces while Navbar preserves host material", { skip: !process.env.KNOMO_LAYOUT_PLAYWRIGHT }, async () => {
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
				<nav class="mobile-navbar knomo-mobile-navbar-compact"><button type="button" data-action="host-menu">Menu</button></nav></body>`);
			const context = `${theme}/${accent}/manual=${manual}/system=${system}`;
			const tracks = page.locator(".knomo-time-buoy-tabs, .knomo-record-stats-view-controls");
			const surfaces = await tracks.evaluateAll((elements: HTMLElement[]) => elements.map(el => {
				const style = getComputedStyle(el);
				return { role: el.getAttribute("role"), image: style.backgroundImage, filter: style.backdropFilter, shadow: style.boxShadow, borderWidth: style.borderTopWidth,
					buttons: [...el.querySelectorAll("button")].map(button => {
						const paint = getComputedStyle(button);
						return { selected: button.getAttribute(el.getAttribute("role") === "tablist" ? "aria-selected" : "aria-pressed"),
							active: button.classList.contains("is-active"), width: button.offsetWidth, height: button.offsetHeight,
							image: paint.backgroundImage, background: paint.backgroundColor, shadow: paint.boxShadow, filter: paint.backdropFilter };
					}) };
			}));
			assert.deepEqual(surfaces.map((surface: { role: string }) => surface.role), ["tablist", "group"], context);
			for (const surface of surfaces) {
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
						assert.notEqual(button.background, "rgba(0, 0, 0, 0)", `${context}: selection is not conveyed by text alone`);
					}
					else { assert.equal(button.image, "none", context); assert.equal(button.background, "rgba(0, 0, 0, 0)", context); }
				}
			}
			assert.equal(surfaces[0].buttons[0].background, surfaces[1].buttons[0].background, `${context}: same selected material`);
			await page.evaluate(() => {
				document.body.addEventListener("click", event => {
					const target = (event.target as HTMLElement).closest<HTMLButtonElement>("button[data-action]");
					if (target) target.dataset.calls = String(Number(target.dataset.calls ?? 0) + 1);
				});
			});
			const inactive = tracks.first().locator("button").nth(1);
			await inactive.tap();
			assert.equal(await inactive.getAttribute("data-calls"), "1", `${context}: native action is reachable once`);
			// Chromium 的触摸反馈在 touchend 后短暂保留，等待实际绘制状态恢复，避免读取中间帧。
			await page.waitForFunction(() => getComputedStyle(document.querySelectorAll(".knomo-time-buoy-tab")[1]).backgroundColor === "rgba(0, 0, 0, 0)", undefined, { timeout: 3000 });
			assert.equal(await inactive.evaluate((el: HTMLElement) => getComputedStyle(el).backgroundColor), "rgba(0, 0, 0, 0)", `${context}: touch leaves no hover fill`);
			await inactive.focus();
			await page.keyboard.down("Space");
			const focus = await inactive.evaluate((el: HTMLElement) => {
				const style = getComputedStyle(el);
				return { width: style.outlineWidth, offset: style.outlineOffset, shadow: style.boxShadow };
			});
			assert.equal(focus.width, "2px", context);
			assert.equal(focus.offset, "-2px", context);
			assert.equal(focus.shadow, "none", context);
			await page.keyboard.up("Space");
			const navbar = page.locator(".mobile-navbar");
			const navPaint = await navbar.evaluate((el: HTMLElement) => {
				const style = getComputedStyle(el);
				const edge = (pseudo: string) => {
					const paint = getComputedStyle(el, pseudo);
					return [paint.content, paint.backgroundColor, paint.backgroundImage, paint.border, paint.boxShadow, paint.backdropFilter];
				};
				return { color: style.backgroundColor, filter: style.backdropFilter, image: style.backgroundImage, radius: style.borderRadius,
					shadow: style.boxShadow, border: style.border, before: edge("::before"), after: edge("::after") };
			});
			assert.equal(navPaint.color, theme === "theme-dark" ? "rgb(32, 32, 32)" : "rgb(255, 255, 255)", `${context}: host background is untouched`);
			assert.equal(navPaint.filter, "blur(7px)", `${context}: host filter is neither removed nor duplicated`);
			assert.match(navPaint.image, /90deg/, `${context}: host gradient is untouched`);
			assert.equal(navPaint.shadow, "rgb(255, 0, 0) 0px 0px 2px 0px", `${context}: no Knomo rim or shadow`);
			await page.evaluate(() => document.body.classList.remove("knomo-mobile-navbar-compact-active"));
			const hostPaint = await navbar.evaluate((el: HTMLElement) => {
				const paint = (pseudo?: string) => {
					const style = getComputedStyle(el, pseudo);
					return [style.backgroundColor, style.backgroundImage, style.border, style.boxShadow, style.backdropFilter];
				};
				return [paint(), paint("::before"), paint("::after")];
			});
			await page.evaluate(() => document.body.classList.add("knomo-mobile-navbar-compact-active"));
			assert.deepEqual(await navbar.evaluate((el: HTMLElement) => {
				const paint = (pseudo?: string) => {
					const style = getComputedStyle(el, pseudo);
					return [style.backgroundColor, style.backgroundImage, style.border, style.boxShadow, style.backdropFilter];
				};
				return [paint(), paint("::before"), paint("::after")];
			}), hostPaint, `${context}: host surface and both edge pseudo-elements survive Knomo activation`);
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
