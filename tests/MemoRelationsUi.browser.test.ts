import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

import { fixture, settle, setupMemoRelationsTestWindow } from "./helpers/memoRelationsUiFixture";

setupMemoRelationsTestWindow();

test("关联详情在中英文、主题强调色及窄屏大字体下保持标题和返回按钮可见", { skip: !process.env.KNOMO_LAYOUT_PLAYWRIGHT }, async () => {
	const h = await fixture();
	const { chromium } = require(process.env.KNOMO_LAYOUT_PLAYWRIGHT!);
	const browser = await chromium.launch({ headless: true, channel: process.env.KNOMO_LAYOUT_BROWSER || "msedge" });
	try {
		const { translate } = await import("../src/i18n");
		const [a] = await h.seed("A.md", "- 10:00 A ^a\n");
		await h.page.open(a);
		h.page.el!.classList.add("has-host-header");
		const subjectCard = h.page.el!.querySelector<HTMLElement>(".knomo-relations-subject .knomo-card")!;
		const cardHead = subjectCard.createDiv({ cls: "knomo-card-head" });
		cardHead.createSpan({ cls: "knomo-card-time", text: "10:00" });
		cardHead.appendChild(subjectCard.querySelector(".knomo-card-menu")!);
		subjectCard.prepend(cardHead);
		const css = readFileSync("styles.css", "utf8");
		const page = await browser.newPage();
		for (const locale of ["zh-CN", "en"] as const) for (const theme of ["theme-light", "theme-dark", "theme-custom"]) {
			for (const width of [320, 390, 768, 1024]) for (const font of [14, 22]) {
				h.page.el!.querySelector(".knomo-relations-section-header h3")!.textContent = translate(locale, "relations.current");
				h.page.el!.querySelector(".knomo-relations-back")!.setAttribute("aria-label", translate(locale, "relations.backList"));
				h.page.el!.querySelector("h3[tabindex]")!.textContent = translate(locale, "relations.referrers", { count: 10000 });
				await page.setViewportSize({ width, height: 800 });
				await page.setContent(`<style>
					* { box-sizing:border-box; }
					body { margin:0; font:${font}px/1.5 Arial; --font-ui-small:${font}px; --font-ui-medium:${font}px;
						--size-4-2:8px; --h3-line-height:1.3;
						--text-normal:#222; --text-muted:#666; --text-accent:#6340c2; --interactive-accent:#6340c2;
						--background-primary:#fff; --background-secondary:#eee; --background-modifier-hover:rgba(127,127,127,.14); }
					.theme-dark { --text-normal:#eee; --text-muted:#bbb; --text-accent:#b19afa; --background-primary:#202020; }
					.theme-custom { font-family:Georgia; --h3-line-height:1.5; --text-accent:#00756b; --background-primary:#f8f2e7; }
					h3 { line-height:var(--h3-line-height); }
					button { font:inherit; }
					${css}
				</style><body class="${theme}"><main class="knomo-plugin has-memo-relations is-record-stats is-sidebar-collapsed ${width < 768 ? "is-layout-mobile" : width < 1024 ? "is-layout-desktop-narrow" : "is-layout-desktop-wide"}"
					style="display:block;width:100%;height:100vh;--knomo-text-ui-base:${font}px">
					<div class="knomo-topbar"><button class="knomo-record-stats-back">Back</button></div>
					<div class="knomo-compact-header"><button class="knomo-record-stats-back">Back</button></div>
					${h.page.el!.outerHTML}<span class="fixture-accent" style="color:var(--text-accent)"></span>
					<div class="knomo-recent-flow-decoration knomo-recent-flow-date"><span>Today</span></div>
				</main></body>`);
				await page.mouse.move(0, 0);
				const actual = await page.evaluate(() => {
					const relationPage = document.querySelector<HTMLElement>(".knomo-relations-page")!;
					const header = relationPage.querySelector<HTMLElement>(".knomo-relations-header")!;
					const row = relationPage.querySelector<HTMLElement>(".knomo-relations-section-header")!;
					const title = row.querySelector("h3")!;
					const back = row.querySelector<HTMLButtonElement>("button")!;
					const listTitle = relationPage.querySelector<HTMLElement>("h3[tabindex]")!;
					const cardMenu = relationPage.querySelector<HTMLElement>(".knomo-relations-subject .knomo-card-menu")!;
					const textLeft = (el: HTMLElement) => {
						const range = document.createRange(); range.selectNodeContents(el);
						return range.getBoundingClientRect().left;
					};
					const reference = document.querySelector<HTMLButtonElement>(".knomo-topbar .knomo-record-stats-back")!;
					const appearance = (el: HTMLElement) => {
						const style = getComputedStyle(el);
						return [style.padding, style.borderWidth, style.borderRadius, style.color, style.backgroundColor, style.boxShadow, style.cursor];
					};
					const resting = appearance(back), referenceResting = appearance(reference);
					const rect = back.getBoundingClientRect();
					const rowRect = row.getBoundingClientRect(), titleRect = title.getBoundingClientRect();
					const menuRect = cardMenu.getBoundingClientRect(), listStyle = getComputedStyle(listTitle);
					const subjectCard = cardMenu.closest<HTMLElement>(".knomo-card")!, subjectRect = subjectCard.getBoundingClientRect();
					const hit = document.elementFromPoint(rect.x + rect.width / 2, rect.bottom - 1);
					const cardHit = document.elementFromPoint(rect.x + rect.width / 2, subjectRect.top + 1);
					back.focus();
					const focused = appearance(back);
					// 移动布局会隐藏桌面标题栏，临时移出后才能比较其真实聚焦样式。
					const referenceParent = reference.parentElement!;
					relationPage.parentElement!.appendChild(reference);
					reference.style.display = "inline-flex"; reference.focus();
					const referenceFocused = appearance(reference);
					reference.style.removeProperty("display"); referenceParent.appendChild(reference); back.focus();
					const focusedSurface = getComputedStyle(back, "::before");
					return { headerHeight: header.getBoundingClientRect().height, overflow: relationPage.scrollWidth > relationPage.clientWidth,
						rowOverflow: row.scrollWidth > row.clientWidth, buttonWidth: rect.width, buttonHeight: rect.height,
						buttonRight: rect.right, titleRight: title.getBoundingClientRect().right, buttonLeft: rect.left,
						currentSpacing: [titleRect.top - rowRect.top, rowRect.bottom - titleRect.bottom],
						listSpacing: [listStyle.paddingTop, listStyle.paddingBottom, listStyle.marginTop, listStyle.marginBottom],
						subjectGap: listTitle.getBoundingClientRect().top - subjectRect.bottom,
						leftOffsets: [textLeft(title), textLeft(listTitle), textLeft(document.querySelector<HTMLElement>(".knomo-recent-flow-date")!)],
						buttonCenterOffset: rect.y + rect.height / 2 - titleRect.y - titleRect.height / 2,
						buttonMenuCenterOffset: rect.x + rect.width / 2 - menuRect.x - menuRect.width / 2,
						buttonWithinHeader: rect.top >= rowRect.top && rect.bottom <= rowRect.bottom,
						buttonHit: hit?.closest(".knomo-relations-back") === back, cardHit: cardHit?.closest(".knomo-card") === subjectCard,
						focusSurface: [focusedSurface.width, focusedSurface.height, focusedSurface.backgroundColor, focusedSurface.pointerEvents],
						colors: [...relationPage.querySelectorAll("h3")].map(el => getComputedStyle(el).color),
						accent: getComputedStyle(document.querySelector(".fixture-accent")!).color,
						resting, referenceResting, focusedAppearance: focused, referenceFocused,
						outline: getComputedStyle(back).outlineStyle, outlineOffset: getComputedStyle(back).outlineOffset, focused: document.activeElement === back,
						hostBacksHidden: [...document.querySelectorAll(".knomo-record-stats-back")].every(el => getComputedStyle(el).display === "none") };
				});
				const context = JSON.stringify({ locale, theme, width, font, actual });
				assert.equal(actual.headerHeight, 0, context);
				assert.equal(actual.overflow || actual.rowOverflow, false, context);
				assert.ok(Math.abs(actual.currentSpacing[0] - (width < 768 ? 8 : 10)) < 0.1, context);
				assert.ok(Math.abs(actual.currentSpacing[1] - 8) < 0.1, context);
				assert.deepEqual(actual.listSpacing, ["10px", "8px", "0px", "0px"], context);
				assert.equal(actual.subjectGap, 8, context);
				assert.ok(actual.leftOffsets.every((left: number) => Math.abs(left - actual.leftOffsets[2]) < 0.1), context);
				assert.deepEqual(actual.colors, [actual.accent, actual.accent], context);
				if (width < 768) {
					assert.equal(actual.buttonWidth, 0, context);
					assert.equal(actual.buttonHeight, 0, context);
					continue;
				}
				const buttonSize = 32;
				assert.equal(actual.buttonWidth, buttonSize, context);
				assert.equal(actual.buttonHeight, buttonSize, context);
				assert.deepEqual(actual.resting, actual.referenceResting, context);
				assert.equal(actual.focusedAppearance[3], actual.referenceFocused[3], context);
				assert.equal(actual.focusedAppearance[4], "rgba(0, 0, 0, 0)", context);
				assert.deepEqual(actual.focusSurface, ["28px", "28px", actual.referenceFocused[4], "none"], context);
				assert.ok(actual.buttonRight <= width && actual.titleRight <= actual.buttonLeft, context);
				assert.ok(Math.abs(actual.buttonCenterOffset) < 0.1 && Math.abs(actual.buttonMenuCenterOffset) < 0.1, context);
				assert.equal(actual.buttonWithinHeader && actual.buttonHit && actual.cardHit, true, context);
				assert.equal(actual.outlineOffset, "-4px", context);
				assert.equal(actual.focused && actual.outline === "solid" && actual.hostBacksHidden, true, context);
				await page.locator(".knomo-relations-back").hover();
				const hovered = await page.locator(".knomo-relations-back").evaluate((button: HTMLElement) => {
					const surface = getComputedStyle(button, "::before");
					return [getComputedStyle(button).backgroundColor, surface.width, surface.height, surface.backgroundColor];
				});
				assert.deepEqual(hovered, ["rgba(0, 0, 0, 0)", "28px", "28px", actual.referenceFocused[4]], context);
			}
		}
	} finally { await browser.close(); h.close(); }
});

test("被引用行刷新在宿主禁用样式下保持相同文字外观", { skip: !process.env.KNOMO_LAYOUT_PLAYWRIGHT }, async () => {
	const h = await fixture(true);
	const { chromium } = require(process.env.KNOMO_LAYOUT_PLAYWRIGHT!);
	const browser = await chromium.launch({ headless: true, channel: process.env.KNOMO_LAYOUT_BROWSER || "msedge" });
	try {
		const { createMemoRenderPlaceholders } = await import("../src/ui/MemoRenderPlaceholder");
		const before = await h.seed("D.md", "- 10:00 target ^a\n- 11:00 被引用的摘要 ref [[#^a]]\n- 12:00 other\n");
		const memo = await h.memo(before[0]);
		const card = h.host.createEl("article", { cls: "knomo-card" });
		h.cards!.observe(card, memo); await settle(); await settle();
		const initial = card.outerHTML;
		const seed = createMemoRenderPlaceholders([{ memo, card }]);
		const after = await h.seed("D.md", "- 10:00 target ^a\n- 11:00 被引用的摘要 ref [[#^a]]\n- 12:00 edited\n");
		h.cards!.release(card); card.remove();
		const next = h.host.createEl("article", { cls: "knomo-card" });
		const current = await h.memo(after[0]); seed(current, next);
		const pending = next.outerHTML;
		h.cards!.observe(next, current); await settle(); await settle();
		const ready = next.outerHTML;
		const page = await browser.newPage();
		const css = readFileSync("styles.css", "utf8");
		for (const theme of ["theme-light", "theme-dark", "theme-custom"]) for (const width of [320, 1024]) {
			await page.setViewportSize({ width, height: 300 });
			await page.setContent(`<style>
				body { margin:0; font:14px/1.5 Arial; --text-faint:#777; --text-muted:#555; --font-normal:400; background:#fff; }
				.theme-dark { --text-faint:#aaa; --text-muted:#ccc; background:#222; }
				.theme-custom { --text-faint:#876548; --text-muted:#654321; font-family:Georgia; background:#f8f2e7; }
				button { font:inherit; } button:disabled { opacity:0.4; }
				${css}
			</style><body class="${theme}"><main id="fixture" class="knomo-plugin" style="display:block;width:100%;--knomo-text-meta:14px"></main></body>`);
			await page.mouse.move(0, 299);
			const appearances = [], pixels = [];
			for (const html of [initial, pending, ready]) {
				await page.evaluate((value: string) => { document.getElementById("fixture")!.innerHTML = value; }, html);
				appearances.push(await page.locator(".knomo-referrer-preview").evaluate((button: HTMLElement) => {
					const style = getComputedStyle(button), rect = button.getBoundingClientRect();
					return [style.opacity, style.color, style.fontFamily, style.fontSize, style.fontWeight, style.lineHeight, rect.width, rect.height];
				}));
				pixels.push(await page.locator(".knomo-memo-referrers").screenshot());
			}
			const context = JSON.stringify({ theme, width, appearances });
			assert.deepEqual(appearances[1], appearances[0], context);
			assert.deepEqual(appearances[2], appearances[0], context);
			assert.ok(pixels[0].equals(pixels[1]) && pixels[0].equals(pixels[2]), context);
		}
	} finally { await browser.close(); h.close(); }
});
