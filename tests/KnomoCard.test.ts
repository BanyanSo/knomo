import test from "node:test";
import assert from "node:assert/strict";
import { dirname, resolve } from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";

import type { MemoRecord } from "../src/types/memo";
import type { MemoCardPreview } from "../src/ui/MemoCardPreview";

test("adds is-cjk-content to long Chinese memo cards", async () => {
	const { card, queued, content } = await renderMemoCard("## 标题\n这是一段**中文 Memo**，包含[[页面|内部链接]]和 #标签，用来验证卡片级判断。");

	assert.equal(card.hasClass("is-cjk-content"), true);
	assert.equal(queued?.container, content?.asHtml());
});

test("adds is-cjk-content when Chinese text includes a few English technical words", async () => {
	const { card } = await renderMemoCard("今天排查 MarkdownRenderer render queue 的表现，确认中文正文仍然应该两端对齐。");

	assert.equal(card.hasClass("is-cjk-content"), true);
});

test("does not add is-cjk-content to English memo cards", async () => {
	const { card } = await renderMemoCard("This memo is mostly English with MarkdownRenderer, CSS, and several technical notes.");

	assert.equal(card.hasClass("is-cjk-content"), false);
});

test("does not add is-cjk-content to short Chinese memo cards below the threshold", async () => {
	const { card } = await renderMemoCard("中文太短");

	assert.equal(card.hasClass("is-cjk-content"), false);
});

test("memo card body queues preview text instead of the raw content snapshot", async () => {
	const { queued } = await renderMemoCard("raw ![[image.png]]", {
		text: "raw",
		images: [
			{
				raw: "![[image.png]]",
				path: "image.png",
				isRemote: false,
				unresolved: true,
			},
		],
	});

	assert.equal(queued?.previewText, "raw");
});

test("image-only memo cards do not render an empty card content container", async () => {
	const { body, content, images } = await renderMemoCard("![[image.png]]", {
		text: "",
		images: [
			{
				raw: "![[image.png]]",
				path: "image.png",
				isRemote: false,
				unresolved: true,
			},
		],
	});

	assert.notEqual(body, null);
	assert.equal(content, null);
	assert.notEqual(images, null);
});

test("memo card action menu includes open daily in the requested order", async () => {
	await ensureObsidianStub();
	const { renderKnomoMemoCard } = await import("../src/ui/KnomoCard");
	const root = new TestElement("div");

	renderKnomoMemoCard(root.asHtml(), makeMemo(), {
		generation: 7,
		renderIndex: 0,
		includeActions: true,
		randomCard: false,
		activeMenuMemoId: null,
		deletedMemoIds: new Set(),
		formatDisplayTime: (value) => value,
		formatSettingsText: (value) => value,
		getMarkdownPriority: () => "normal" as const,
		getMemoCardPreview: (memo) => ({ text: memo.contentSnapshot, images: [] }),
		queueMemoMarkdown: () => undefined,
		renderMemoCardImages: () => undefined,
		queueSourceReferenceMarkdown: () => undefined,
	});

	const actions = root.findAll("[data-memo-action]");
	assert.deepEqual(actions.map((action) => action.getAttr("data-memo-action")), [
		"edit",
		"reference",
		"open-daily",
		"copy-text",
		"copy-link",
		"delete",
	]);
	assert.equal(root.find("[data-memo-action='open-daily']")?.getText(), "Open daily note");
	assert.equal(root.find(".knomo-card-word-count")?.getText(), "Words: 1");
	assert.equal(root.find(".knomo-card-actions")?.getText().endsWith("DeleteWords: 1"), true);
	const card = root.find("article");
	assert.equal(card?.getAttr("data-memo-card-open"), null);
	assert.equal(card?.getAttr("tabindex"), null);
	const timeButton = root.find("[data-memo-time-open='daily']");
	assert.equal(timeButton?.getText(), "2026-06-02T00:00:00+08:00");
	assert.equal(timeButton?.getAttr("aria-label"), "Open daily note");
	assert.equal(timeButton?.getAttr("data-memo-id"), "memo-1");
	assert.equal(timeButton?.getAttr("data-random-reunion-card"), null);
});

test("random memo card keeps random review marking on the time opener", async () => {
	await ensureObsidianStub();
	const { renderKnomoMemoCard } = await import("../src/ui/KnomoCard");
	const root = new TestElement("div");

	renderKnomoMemoCard(root.asHtml(), makeMemo({ id: "random-1" }), {
		generation: 7,
		renderIndex: 0,
		includeActions: false,
		randomCard: true,
		activeMenuMemoId: null,
		deletedMemoIds: new Set(),
		formatDisplayTime: (value) => value,
		formatSettingsText: (value) => value,
		getMarkdownPriority: () => "normal" as const,
		getMemoCardPreview: (memo) => ({ text: memo.contentSnapshot, images: [] }),
		queueMemoMarkdown: () => undefined,
		renderMemoCardImages: () => undefined,
		queueSourceReferenceMarkdown: () => undefined,
	});

	const card = root.find("article");
	const timeButton = root.find("[data-memo-time-open='daily']");
	assert.equal(card?.getAttr("data-random-reunion-card"), null);
	assert.equal(timeButton?.getAttr("data-memo-id"), "random-1");
	assert.equal(timeButton?.getAttr("data-random-reunion-card"), "true");
});

test("trash memo cards do not get daily note card-open attributes", async () => {
	await ensureObsidianStub();
	const { renderKnomoTrashMemoCard } = await import("../src/ui/KnomoCard");
	const root = new TestElement("div");

	renderKnomoTrashMemoCard(root.asHtml(), makeMemo({ status: "deleted" }), {
		generation: 7,
		renderIndex: 0,
		busyAction: null,
		formatDisplayTime: (value) => value,
		formatOptionalTime: (value) => value ?? "",
		formatDeleteSource: (value) => value,
		formatSettingsText: (value) => value,
		getMarkdownPriority: () => "normal" as const,
		getMemoCardPreview: (memo) => ({ text: memo.contentSnapshot, images: [] }),
		queueMemoMarkdown: () => undefined,
		renderMemoCardImages: () => undefined,
	});

	const card = root.find("article");
	assert.equal(card?.getAttr("data-memo-card-open"), null);
	assert.equal(card?.getAttr("data-random-reunion-card"), null);
	assert.equal(card?.getAttr("tabindex"), null);
	assert.equal(root.find("[data-memo-time-open='daily']"), null);
});

test("card content CSS justifies CJK cards while list items inherit the card alignment", async () => {
	const css = await readFile(resolve(process.cwd(), "styles.css"), "utf8");

	assert.match(getStyleRule(css, ".knomo-plugin .knomo-card-content"), /text-align:\s*start;/);
	assert.match(getStyleRule(css, ".knomo-plugin .knomo-card.is-cjk-content .knomo-card-content"), /text-align:\s*justify;/);
	assert.match(getStyleRule(css, ".knomo-plugin .knomo-card.is-cjk-content .knomo-card-content"), /text-align-last:\s*start;/);
	assert.equal(css.includes("text-justify"), false);
	assert.doesNotMatch(getCjkSelectors(css), /\bli\b/);
});

test("memo card time opener CSS expands the hit target without changing text width", async () => {
	const css = await readFile(resolve(process.cwd(), "styles.css"), "utf8");
	const rule = getStyleRule(css, ".knomo-plugin .knomo-card-time[data-memo-time-open=\"daily\"]");
	const interactiveRule = getStyleRule(
		css,
		".knomo-plugin:not(.is-layout-mobile) .knomo-card-time[data-memo-time-open=\"daily\"]:hover,\n.knomo-plugin .knomo-card-time[data-memo-time-open=\"daily\"]:focus,\n.knomo-plugin .knomo-card-time[data-memo-time-open=\"daily\"]:focus-visible,\n.knomo-plugin .knomo-card-time[data-memo-time-open=\"daily\"]:active",
	);

	assert.doesNotMatch(css, /\.knomo-card\[data-memo-card-open="daily"\]/);
	assert.match(rule, /height:\s*var\(--knomo-touch-target\);/);
	assert.match(rule, /min-height:\s*var\(--knomo-touch-target\);/);
	assert.match(rule, /margin:\s*-14px 0;/);
	assert.match(rule, /padding:\s*0;/);
	assert.match(rule, /cursor:\s*pointer;/);
	assert.doesNotMatch(rule, /width:\s*100%/);
	assert.match(interactiveRule, /color:\s*var\(--text-muted\);/);
	assert.match(interactiveRule, /background:\s*transparent;/);
	assert.doesNotMatch(css, /\.knomo-card\[data-random-reunion-card="true"\]\s*\{[^}]*cursor:/s);
});

test("card menu button expands hit target without changing the layout footprint", async () => {
	const css = await readFile(resolve(process.cwd(), "styles.css"), "utf8");
	const match = css.match(/\/\* Card menu button \*\/[\s\S]*?\.knomo-plugin \.knomo-card-menu\s*\{([^}]*)\}/);
	if (match === null) {
		throw new Error("Expected card menu button CSS rule");
	}
	const rule = match[1];

	assert.match(rule, /width:\s*var\(--knomo-touch-target\);/);
	assert.match(rule, /min-width:\s*var\(--knomo-touch-target\);/);
	assert.match(rule, /height:\s*var\(--knomo-touch-target\);/);
	assert.match(rule, /min-height:\s*var\(--knomo-touch-target\);/);
	assert.match(rule, /margin:\s*-11px -10px;/);
	assert.match(rule, /padding:\s*0;/);
	assert.doesNotMatch(css, /\.knomo-card-menu svg\s*\{/);
	const interactiveRule = getStyleRule(
		css,
		".knomo-plugin .knomo-card-menu:hover,\n.knomo-plugin .knomo-card-menu:focus,\n.knomo-plugin .knomo-card-menu:focus-visible,\n.knomo-plugin .knomo-card-menu:active,\n.knomo-plugin .knomo-card-menu[aria-expanded=\"true\"]",
	);
	assert.match(interactiveRule, /color:\s*var\(--text-muted\);/);
	assert.match(interactiveRule, /background:\s*transparent;/);
	assert.doesNotMatch(css, /\.knomo-card-menu[^{]*\{[^}]*background:\s*var\(--knomo-row-hover\)/s);
});

test("card word count keeps the menu width and uses the card time font size", async () => {
	const css = await readFile(resolve(process.cwd(), "styles.css"), "utf8");
	const menuRule = getStyleRule(css, ".knomo-plugin .knomo-card-actions");
	const wordCountRule = getStyleRule(css, ".knomo-plugin .knomo-card-word-count");

	assert.match(menuRule, /width:\s*118px;/);
	assert.match(wordCountRule, /border-top:\s*var\(--border-width\) solid var\(--knomo-soft-border\);/);
	assert.match(wordCountRule, /font-size:\s*var\(--knomo-card-time-font-size\);/);
	assert.match(wordCountRule, /overflow-wrap:\s*anywhere;/);
	assert.match(wordCountRule, /text-align:\s*right;/);
});

test("mobile composer layers above the mobile search page and suggestions", async () => {
	const css = await readFile(resolve(process.cwd(), "styles.css"), "utf8");

	assert.match(getStyleRule(css, ".knomo-plugin .knomo-mobile-search-page"), /z-index:\s*9990;/);
	assert.match(getStyleRule(css, ".knomo-mobile-composer-layer"), /z-index:\s*10000;/);
	assert.match(getStyleRule(css, ".knomo-tag-suggest-popover"), /z-index:\s*var\(--knomo-suggest-z-index,\s*10020\);/);
	assert.match(getStyleRule(css, ".knomo-link-suggest-popover"), /z-index:\s*var\(--knomo-suggest-z-index,\s*10020\);/);
});

test("card content CSS keeps mixed lists compact and task checkboxes aligned", async () => {
	const css = await readFile(resolve(process.cwd(), "styles.css"), "utf8");

	assert.match(getStyleRule(css, ".knomo-plugin .knomo-card-content :is(ul, ol)"), /margin-block-start:\s*0;/);
	assert.match(getStyleRule(css, ".knomo-plugin .knomo-card-content :is(ul, ol)"), /margin-block-end:\s*0;/);
	assert.match(getStyleRule(css, ".knomo-plugin .knomo-card-content li"), /margin-block-start:\s*0;/);
	assert.match(getStyleRule(css, ".knomo-plugin .knomo-card-content li"), /margin-block-end:\s*0;/);
	assert.match(
		getStyleRule(css, ".knomo-plugin .knomo-card-content .task-list-item-checkbox,\n.knomo-plugin .knomo-card-content .knomo-task-checkbox"),
		/vertical-align:\s*middle;/,
	);
});

test("card image CSS keeps thumbnails lightweight and the modal touch area mobile-safe", async () => {
	const css = await readFile(resolve(process.cwd(), "styles.css"), "utf8");

	assert.match(getStyleRule(css, ".knomo-plugin .knomo-card-images--single"), /width:\s*min\(50%, 360px\);/);
	assert.match(getStyleRule(css, ".knomo-plugin .knomo-card-images--grid"), /height:\s*136px;/);
	assert.match(getStyleRule(css, ".knomo-plugin .knomo-card-images"), /gap:\s*4px;/);
	assert.match(getStyleRule(css, ".knomo-plugin .knomo-card-image-item"), /border-radius:\s*2px;/);
	assert.match(getStyleRule(css, ".knomo-plugin .knomo-card-image-button"), /justify-content:\s*flex-start;/);
	assert.match(getStyleRule(css, ".knomo-plugin .knomo-card-image-button"), /background:\s*transparent;/);
	assert.match(getStyleRule(css, ".knomo-plugin .knomo-card-image-button"), /--no-tooltip:\s*true;/);
	assert.match(getStyleRule(css, ".knomo-plugin .knomo-card-images--grid .knomo-card-image-button img"), /object-fit:\s*cover;/);
	assert.match(
		getStyleRule(css, ".knomo-plugin .knomo-card-images--single .knomo-card-image-button img"),
		/object-position:\s*left center;/,
	);
	assert.doesNotMatch(getStyleRule(css, ".knomo-plugin .knomo-card-image-button img"), /opacity:/);
	assert.doesNotMatch(getStyleRule(css, ".knomo-plugin .knomo-card-image-button img"), /transition:\s*opacity/);
	assert.doesNotMatch(css, /\.knomo-card-image-item\.is-loaded/);
	assert.doesNotMatch(css, /\.knomo-card-images--single[^{}]*\{[^}]*aspect-ratio:/s);
	assert.match(
		getStyleRule(
			css,
			".knomo-plugin.is-layout-mobile .knomo-card-images--single .knomo-card-image-button,\n\t.knomo-plugin.is-layout-mobile .knomo-card-images--single .knomo-card-image-button img",
		),
		/height:\s*auto;/,
	);
	assert.match(
		getStyleRule(
			css,
			".knomo-plugin.is-layout-mobile .knomo-card-images--single .knomo-card-image-button,\n\t.knomo-plugin.is-layout-mobile .knomo-card-images--single .knomo-card-image-button img",
		),
		/max-height:\s*180px;/,
	);
	assert.match(
		getStyleRule(
			css,
			".knomo-plugin .knomo-card-images--single .knomo-card-image-button,\n\t.knomo-plugin .knomo-card-images--single .knomo-card-image-button img",
		),
		/height:\s*auto;[\s\S]*max-height:\s*180px;/,
	);
	assert.match(getStyleRule(css, ".knomo-image-preview-stage"), /object-fit:\s*contain;|touch-action:\s*pan-y;/);
	assert.match(getStyleRule(css, ".knomo-image-preview-img"), /object-fit:\s*contain;/);
	assert.match(getStyleRule(css, ".knomo-image-preview-modal"), /background:\s*rgba\(0,\s*0,\s*0,\s*0\.82\);/);
	assert.match(
		getStyleRule(css, ".knomo-image-preview-modal"),
		/--knomo-image-preview-control-background:\s*rgba\(0,\s*0,\s*0,\s*0\.72\);/,
	);
	assert.match(getStyleRule(css, ".knomo-image-preview-modal .modal-close-button"), /display:\s*none;/);
	assert.match(getStyleRule(css, ".knomo-image-preview-modal .modal-title"), /opacity:\s*0;/);
	assert.doesNotMatch(getStyleRule(css, ".knomo-image-preview-modal .modal-title"), /clip-path:/);
	assert.match(
		getStyleRule(css, ".knomo-image-preview-modal .knomo-image-preview-close,\n.knomo-image-preview-modal .knomo-image-preview-nav"),
		/background:\s*var\(--knomo-image-preview-control-background\);/,
	);
	assert.match(getStyleRule(css, ".knomo-image-preview-footer"), /justify-content:\s*center;/);
	assert.match(getStyleRule(css, ".knomo-image-preview-counter"), /color:\s*var\(--knomo-image-preview-control-foreground\);/);
	assert.match(
		getStyleRule(css, ".knomo-image-preview-backdrop--mobile .knomo-image-preview-modal"),
		/width:\s*100vw;[\s\S]*height:\s*100vh;[\s\S]*min-height:\s*100vh;[\s\S]*border-radius:\s*0;/,
	);
	assert.match(
		css,
		/@supports\s*\(height:\s*100dvh\)\s*\{[\s\S]*height:\s*100dvh;[\s\S]*min-height:\s*100dvh;/,
	);
	assert.match(
		getStyleRule(css, ".knomo-image-preview-backdrop--mobile .knomo-image-preview-stage"),
		/calc\(12px \+ env\(safe-area-inset-right,\s*0px\)\)[\s\S]*calc\(12px \+ env\(safe-area-inset-left,\s*0px\)\)/,
	);
	assert.match(
		getStyleRule(css, ".knomo-image-preview-backdrop--mobile .knomo-image-preview-nav"),
		/opacity:\s*0\.6;/,
	);
});

test("image preview modal omits tooltips, original-file actions, and single-image navigation", async () => {
	const viewSource = await readFile(resolve(process.cwd(), "src/ui/KnomoView.ts"), "utf8");
	const modalSource = await readFile(resolve(process.cwd(), "src/ui/KnomoImagePreviewModal.ts"), "utf8");

	assert.doesNotMatch(modalSource, /modalEl\.setAttr\("aria-label", t\("image\.previewLabel"\)\)/);
	assert.doesNotMatch(modalSource, /originalButtonEl|handleOpenOriginalClick|image\.openOriginal|image\.openExternal/);
	assert.match(modalSource, /if \(this\.images\.length > 1\) \{/);
	assert.match(viewSource, /"aria-label": t\("image\.previewLabel"\)/);
});

test("image preview modal keeps mobile gestures isolated and queues one adjacent image", async () => {
	const modalSource = await readFile(resolve(process.cwd(), "src/ui/KnomoImagePreviewModal.ts"), "utf8");

	assert.match(modalSource, /toggleClass\("knomo-image-preview-backdrop--mobile", Platform\.isMobile\)/);
	assert.match(modalSource, /if \(event\.target === this\.stageEl\)/);
	assert.match(modalSource, /if \(event\.touches\.length !== 1\)/);
	assert.match(modalSource, /const TOUCH_EDGE_GUARD = 24;/);
	assert.match(modalSource, /suppressStageClickUntil/);
	assert.match(modalSource, /preloadedImageUrls\.has\(image\.url\)/);
	assert.match(modalSource, /this\.preloadAdjacentImage\(stage\);/);
	assert.match(modalSource, /priority:\s*"high"/);
	assert.match(modalSource, /priority:\s*"low"/);
	assert.match(modalSource, /allowDisconnected:\s*true/);
	assert.match(modalSource, /t\("image\.loadFailed"\)/);
});

test("mobile card flow starts with 25 cards while desktop keeps 50", async () => {
	const source = await readFile(resolve(process.cwd(), "src/ui/KnomoView.ts"), "utf8");
	const renderImagesMethod = getMethodSource(source, "renderMemoCardImages");
	const renderMethod = getMethodSource(source, "renderMemoCardImage");

	assert.match(source, /const CARD_BATCH_SIZE = 50;/);
	assert.match(source, /const MOBILE_INITIAL_CARD_BATCH_SIZE = 25;/);
	assert.match(source, /Platform\.isMobile \? MOBILE_INITIAL_CARD_BATCH_SIZE : CARD_BATCH_SIZE/);
	assert.doesNotMatch(renderMethod, /loading:\s*"lazy"/);
	assert.match(renderMethod, /decoding:\s*"async"/);
	assert.match(renderMethod, /if \(image\.isRemote\)/);
	assert.match(renderMethod, /imageEl\.setAttr\("fetchpriority", "low"\)/);
	assert.doesNotMatch(renderMethod, /if \(Platform\.isMobile && !image\.isRemote\)/);
	assert.match(renderMethod, /const loadItem: CardImageLoadItem/);
	assert.match(renderMethod, /src:\s*image\.url/);
	assert.doesNotMatch(renderMethod, /releaseSlotAfterStart/);
	assert.match(renderImagesMethod, /cardImageLoadQueue\.observe/);
	assert.match(renderImagesMethod, /targetEl:\s*imagesEl/);
	assert.match(renderImagesMethod, /images:\s*loadItems/);
	assert.match(renderImagesMethod, /surface,/);
	assert.match(renderMethod, /priority:\s*index === 0 \? "high" : "low"/);
	assert.doesNotMatch(renderMethod, /createEl\("img",\s*\{\s*attr:\s*\{[^}]*\bsrc:/s);
	assert.match(source, /const MOBILE_CARD_IMAGE_LOAD_CONCURRENCY = 2;/);
	assert.match(source, /rootMargin:\s*Platform\.isMobile \? "280px 0px" : undefined/);
	assert.match(source, /scheduleStartTask:\s*Platform\.isMobile/);
	assert.match(source, /const MOBILE_INITIAL_SYNC_CARD_COUNT = 8;/);
	assert.match(source, /const MOBILE_CARD_FRAME_CHUNK_SIZE = 6;/);
	assert.match(source, /cardImageLoadQueue\.setPaused/);
	assert.match(source, /memoMarkdownRenderer\.setPaused/);
	assert.match(source, /if \(!Platform\.isMobile \|\| !this\.composerOpen\)/);
	assert.match(source, /this\.mobileCardFlowRenderPending = true/);
	assert.match(source, /if \(shouldRenderCardFlow\)/);
});

test("CJK card CSS keeps headings, code, and tables start-aligned", async () => {
	const css = await readFile(resolve(process.cwd(), "styles.css"), "utf8");
	const selectors = getCjkSelectors(css);
	const resetRule = getStyleRule(css, ".knomo-plugin .knomo-card.is-cjk-content .knomo-card-content table");

	for (const tagName of ["h1", "h2", "h3", "h4", "h5", "h6", "pre", "code", "table"]) {
		assert.match(selectors, new RegExp(`\\.knomo-card-content ${tagName}\\b`));
	}
	assert.match(resetRule, /text-align:\s*start;/);
});

test("memo markdown post-processing still keeps internal links, tags, and lazy images", async () => {
	const viewSource = await readFile(resolve(process.cwd(), "src/ui/KnomoView.ts"), "utf8");
	const rendererSource = await readFile(resolve(process.cwd(), "src/ui/MemoMarkdownRenderer.ts"), "utf8");

	assert.match(viewSource, /this\.memoMarkdownRenderer\.queueMemoMarkdown/);
	assert.match(viewSource, /this\.memoMarkdownRenderer\.queueSourceReferenceMarkdown/);
	assert.doesNotMatch(viewSource, /prepareMemoCardMarkdown\(previewText\)/);
	assert.match(rendererSource, /prepareMemoCardMarkdown\(previewText\)/);
	assert.match(rendererSource, /prepareInternalLinks\(container, memo\.dailyRef\.path\);/);
	assert.match(viewSource, /event\.preventDefault\(\);\s*await this\.app\.workspace\.openLinkText\(linktext, sourcePath, Keymap\.isModEvent\(event\)\);/);
	assert.match(rendererSource, /imageEl\.setAttr\("loading", "lazy"\);/);
	assert.match(rendererSource, /tagEl\.setAttr\("data-tag", tag\);/);
	assert.match(rendererSource, /tagEl\.setAttr\("data-tag-key", tagKey\);/);
});

test("desktop save clears the rendered reference and edit state", async () => {
	const source = await readFile(resolve(process.cwd(), "src/ui/KnomoView.ts"), "utf8");
	const saveMethod = getMethodSource(source, "saveInput");
	const desktopSaveBranch = saveMethod.slice(saveMethod.indexOf("} else {", saveMethod.indexOf("if (isMobileSave)")));

	assert.match(desktopSaveBranch, /this\.syncComposerMode\(\);/);
	assert.match(desktopSaveBranch, /this\.updateCancelEditButtonState\(\);/);
});

test("mobile cancel edit closes composer without changing reference clear", async () => {
	const source = await readFile(resolve(process.cwd(), "src/ui/KnomoView.ts"), "utf8");
	const cancelEditingMethod = getMethodSource(source, "cancelEditing");
	const mobileActionPointerMethod = getMethodSource(source, "handleMobileComposerActionPointerDown");
	const clearReferenceMethod = getMethodSource(source, "clearReference");

	assert.match(cancelEditingMethod, /this\.clearComposerMode\(\);[\s\S]*if \(this\.currentLayout === "mobile"\) \{\s*this\.closeMobileComposerKeepingDraft\(\);/);
	assert.match(mobileActionPointerMethod, /if \(action === "clear-reference"\) \{\s*this\.clearReference\(\);\s*\} else \{\s*this\.cancelEditing\(\);/);
	assert.doesNotMatch(clearReferenceMethod, /closeMobileComposerKeepingDraft|closeComposerKeepingDraft|cancelEditing|clearComposerMode/);
});

test("setting draft commits preserve newer edits while an older value is saving", async () => {
	const source = await readFile(resolve(process.cwd(), "src/ui/KnomoSettingTab.ts"), "utf8");
	const cases = [
		["commitDailyHeadingDraft", "dailyHeading"],
		["commitMonthlyMemoFileFormatDraft", "monthlyMemoFileFormat"],
		["commitMonthlyDateHeadingFormatDraft", "monthlyDateHeadingFormat"],
	] as const;

	for (const [methodName, key] of cases) {
		const method = getMethodSource(source, methodName);
		assert.match(method, new RegExp(`pendingSettingDrafts\\.get\\("${key}"\\) === value`));
		assert.match(method, new RegExp(`pendingSettingDrafts\\.delete\\("${key}"\\)`));
	}
});

test("task checkbox handling stays delegated and does not enter composer edit flow", async () => {
	const source = await readFile(resolve(process.cwd(), "src/ui/KnomoView.ts"), "utf8");
	const rendererSource = await readFile(resolve(process.cwd(), "src/ui/MemoMarkdownRenderer.ts"), "utf8");
	const changeMethod = getMethodSource(source, "handleTaskCheckboxChange");
	const clickMethod = getMethodSource(source, "handleTaskCheckboxClick");
	const savedMethod = getMethodSource(source, "handleTaskMemoSaved");

	assert.match(source, /this\.registerDomEvent\(this\.cardFlowEl, "change", \(event\) => \{/);
	assert.match(source, /this\.registerDomEvent\(this\.mobileSearchResultsEl, "change", \(event\) => \{/);
	assert.match(rendererSource, /input\.setAttr\("data-knomo-task-index", String\(taskIndex\)\);/);
	assert.match(rendererSource, /input\.setAttr\("data-task", renderedMarker\);/);
	assert.match(changeMethod, /if \(!event\.isTrusted\) \{/);
	assert.match(changeMethod, /event\.stopPropagation\(\);/);
	assert.match(changeMethod, /replaceMarkdownTaskMarkerByIndex\(latestContent, taskIndex, marker\);/);
	assert.match(changeMethod, /this\.memoTaskUpdateCoordinator\.enqueue\(memo, nextContent\);/);
	assert.match(changeMethod, /this\.memoMarkdownRenderer\.getTaskCheckboxInput\(event\.target\)/);
	assert.match(changeMethod, /this\.memoMarkdownRenderer\.applyTaskCheckboxDomState\(input, marker\);/);
	assert.match(clickMethod, /event\.stopPropagation\(\);/);
	assert.doesNotMatch(savedMethod, /syncTaskCheckboxesForMemo/);
	assert.doesNotMatch(changeMethod, /preventDefault\(/);
	assert.doesNotMatch(changeMethod, /openComposer|startEditing|inputEl\.value|draftContent/);
});

test("mobile memo hydration reads memo indexes without restoring startup scans", async () => {
	const viewSource = await readFile(resolve(process.cwd(), "src/ui/KnomoView.ts"), "utf8");
	const hydratorSource = await readFile(resolve(process.cwd(), "src/ui/MobileMemoHydrator.ts"), "utf8");
	const renderMethod = getMethodSource(viewSource, "render");
	const initialLoadMethod = getMethodSource(viewSource, "loadInitialMobileMemos");
	const hydrationMethod = getMethodSource(hydratorSource, "hydrate");
	const ensureMethod = getMethodSource(viewSource, "ensureAllMemosLoaded");
	const sidebarMethod = getMethodSource(hydratorSource, "requestSidebarHydration");
	const deferSidebarMethod = getMethodSource(hydratorSource, "deferSidebarHydration");

	assert.match(viewSource, /this\.mobileMemoHydrator\.schedule\(\);/);
	assert.match(viewSource, /this\.mobileMemoHydrator\.deferSidebarHydration\(\);/);
	assert.match(viewSource, /this\.mobileMemoHydrator\.requestCardFlowHydration\(\);/);
	assert.match(renderMethod, /void this\.loadInitialMobileMemos\(\);/);
	assert.doesNotMatch(renderMethod, /await this\.reloadMemos\(false\);/);
	assert.match(initialLoadMethod, /await this\.syncOrchestrator\.listRecentMemos\(\);/);
	assert.match(initialLoadMethod, /this\.mobileMemoHydrator\.isCurrentRun\(runId\)/);
	assert.match(hydrationMethod, /this\.options\.listMemoIndexPeriods\(\);/);
	assert.match(hydrationMethod, /this\.options\.listMemosInPeriods\(\[period\]\);/);
	assert.doesNotMatch(hydrationMethod, /scanRecentDailyMemos|scanDailyMemos|reloadMemos\(true\)/);
	assert.match(ensureMethod, /Platform\.isMobile && !forceReload/);
	assert.match(ensureMethod, /this\.mobileMemoHydrator\.accelerate\(\);/);
	assert.match(ensureMethod, /this\.mobileMemoHydrator\.start\(true\)/);
	assert.match(sidebarMethod, /this\.fastMode = true;/);
	assert.match(deferSidebarMethod, /this\.options\.scheduleTask/);
	assert.match(deferSidebarMethod, /this\.requestSidebarHydration\(\);/);
});

test("mobile memo hydration compares only the rendered card window", async () => {
	const viewSource = await readFile(resolve(process.cwd(), "src/ui/KnomoView.ts"), "utf8");
	const hydratorSource = await readFile(resolve(process.cwd(), "src/ui/MobileMemoHydrator.ts"), "utf8");
	const captureMethod = getMethodSource(viewSource, "captureMobileMemoHydrationRenderState");
	const commitMethod = getMethodSource(hydratorSource, "commitHydratedMemos");

	assert.match(commitMethod, /this\.options\.captureRenderState\(\)/);
	assert.match(captureMethod, /const renderedCardCount = this\.getRenderedCardCount\(\);/);
	assert.match(captureMethod, /this\.getVisibleCardFlowStateKey\(renderedCardCount\)/);
	assert.doesNotMatch(captureMethod, /this\.getCardFlowStateKey\(\)/);
});

test("all-memo filters keep one loading state until mobile hydration completes", async () => {
	const viewSource = await readFile(resolve(process.cwd(), "src/ui/KnomoView.ts"), "utf8");
	const css = await readFile(resolve(process.cwd(), "styles.css"), "utf8");
	const filteredRenderMethod = getMethodSource(viewSource, "renderFilteredListState");
	const loadingMethod = getMethodSource(viewSource, "renderAllMemosLoadingState");
	const errorMethod = getMethodSource(viewSource, "renderAllMemosLoadErrorState");
	const actionMethod = getMethodSource(viewSource, "handleAction");
	const periodHydratedMethod = getMethodSource(viewSource, "handleMobileMemoPeriodHydrated");
	const hydrationCompletedMethod = getMethodSource(viewSource, "handleMobileMemoHydrationCompleted");
	const failureBranch = viewSource.slice(
		viewSource.indexOf("onFailed: () =>"),
		viewSource.indexOf("onSidebarRequested:", viewSource.indexOf("onFailed: () =>")),
	);

	assert.match(filteredRenderMethod, /this\.renderAllMemosLoadingState\(\);/);
	assert.match(loadingMethod, /role:\s*"status"/);
	assert.match(loadingMethod, /"aria-live":\s*"polite"/);
	assert.match(loadingMethod, /"aria-atomic":\s*"true"/);
	assert.match(errorMethod, /setAttr\("role", "alert"\)/);
	assert.match(errorMethod, /"data-action":\s*"retry-all-memos"/);
	assert.match(actionMethod, /case "retry-all-memos":[\s\S]*this\.renderAllMemosLoadingState\(\);[\s\S]*await this\.ensureAllMemosLoaded\(\);/);
	assert.match(failureBranch, /this\.renderAllMemosLoadErrorState\(\);/);
	assert.doesNotMatch(failureBranch, /this\.renderCardFlow\(\);/);
	assert.match(periodHydratedMethod, /if \(this\.shouldDeferCardFlowForAllMemos\(\)\) \{\s*return;/);
	assert.match(hydrationCompletedMethod, /shouldRenderDeferredCardFlow/);
	assert.match(css, /\.knomo-plugin \.knomo-all-memos-retry\s*\{[^}]*margin-top:\s*var\(--size-4-2\);/s);
	assert.match(css, /\.knomo-plugin \.knomo-record-stats-retry,\s*\.knomo-plugin \.knomo-all-memos-retry\s*\{[^}]*min-height:\s*var\(--knomo-touch-target\);/s);
});

test("ordinary card-flow renders preserve existing cards and image queue state", async () => {
	const source = await readFile(resolve(process.cwd(), "src/ui/KnomoView.ts"), "utf8");
	const renderMethod = getMethodSource(source, "renderCardFlow");

	assert.doesNotMatch(renderMethod, /cardImageLoadQueue\.clear\(\)/);
	assert.doesNotMatch(renderMethod, /cardFlowEl\.empty\(\)/);
	assert.doesNotMatch(renderMethod, /renderGeneration \+ 1/);
	assert.match(source, /private forceRebuildCardFlow\(/);
});

test("view-scope card-flow renders reset the feed while content rebuilds preserve position", async () => {
	const source = await readFile(resolve(process.cwd(), "src/ui/KnomoView.ts"), "utf8");
	const renderMethod = getMethodSource(source, "renderCardFlow");
	const rebuildMethod = getMethodSource(source, "forceRebuildCardFlow");
	const filteredRenderMethod = getMethodSource(source, "renderFilteredListState");

	assert.match(renderMethod, /changeIntent === "view-scope-change"[\s\S]*this\.forceRebuildCardFlow\(changeIntent\);/);
	assert.match(rebuildMethod, /this\.getCardFlowScrollTop\(\) \?\? 0/);
	assert.match(rebuildMethod, /Math\.max\(this\.getInitialCardBatchSize\(\), this\.getRenderedCardCount\(\)\)/);
	assert.match(rebuildMethod, /this\.restoreCardFlowScrollTop\(0\);/);
	assert.match(rebuildMethod, /this\.cardFlowSentinel\.remove\(\);/);
	assert.match(rebuildMethod, /this\.cardFlowBatcher\.reset\(\);/);
	assert.match(filteredRenderMethod, /cardFlowChangeIntent: changeIntent/);
});

test("mobile search resets new result ranges and preserves content-refresh scroll", async () => {
	const source = await readFile(resolve(process.cwd(), "src/ui/KnomoView.ts"), "utf8");
	const queryMethod = getMethodSource(source, "queueMobileSearchQuery");
	const dateFilterMethod = getMethodSource(source, "setMobileSearchDateFilter");
	const renderMethod = getMethodSource(source, "renderMobileSearchResults");

	assert.match(queryMethod, /this\.mobileSearchVisibleCount = MOBILE_SEARCH_BATCH_SIZE;/);
	assert.match(queryMethod, /this\.getMobileSearchChangeIntent\(previousViewStateKey\)/);
	assert.match(dateFilterMethod, /this\.mobileSearchVisibleCount = MOBILE_SEARCH_BATCH_SIZE;/);
	assert.match(dateFilterMethod, /this\.getMobileSearchChangeIntent\(previousViewStateKey\)/);
	assert.match(renderMethod, /changeIntent === "view-scope-change" \? 0 : resultsEl\.scrollTop/);
	assert.match(renderMethod, /this\.restoreElementScrollTop\(resultsEl, scrollTop\);/);
});

test("mobile search is pre-mounted before synchronous focus so the mobile keyboard can open", async () => {
	const source = await readFile(resolve(process.cwd(), "src/ui/KnomoView.ts"), "utf8");
	const renderMethod = getMethodSource(source, "render");
	const openMethod = getMethodSource(source, "openMobileSearchPage");
	const syncMethod = getMethodSource(source, "syncMobileSearchPage");
	const focusMethod = getMethodSource(source, "focusMobileSearchInputNow");

	assert.match(renderMethod, /if \(Platform\.isMobile\) \{\s*this\.ensureMobileSearchPage\(\);\s*\}/);
	assert.match(openMethod, /this\.syncRootState\(\);[\s\S]*this\.focusMobileSearchInputNow\(\);/);
	assert.match(syncMethod, /this\.setMobileSearchPageActive\(true\);/);
	assert.match(focusMethod, /input\.focus\(\{ preventScroll: true \}\);/);
	assert.doesNotMatch(focusMethod, /requestAnimationFrame|setTimeout/);
});

test("mobile search keeps its focus layer fixed while its visual layers slide", async () => {
	const css = await readFile(resolve(process.cwd(), "styles.css"), "utf8");
	const pageRule = getStyleRule(css, ".knomo-plugin .knomo-mobile-search-page");
	const surfaceRule = getStyleRule(css, ".knomo-plugin .knomo-mobile-search-surface");
	const contentRule = getStyleRule(css, ".knomo-plugin .knomo-mobile-search-content");
	const inputRule = getStyleRule(css, ".knomo-plugin .knomo-mobile-search-wrap .knomo-search-input");

	assert.doesNotMatch(pageRule, /visibility:\s*hidden/);
	assert.doesNotMatch(pageRule, /transform:/);
	assert.match(pageRule, /pointer-events:\s*none;/);
	assert.match(surfaceRule, /transform:\s*translateX\(100%\);/);
	assert.match(surfaceRule, /transition:\s*transform var\(--knomo-transition-panel\);/);
	assert.match(contentRule, /transform:\s*translateX\(100%\);/);
	assert.match(contentRule, /transition:\s*transform var\(--knomo-transition-panel\);/);
	assert.match(inputRule, /box-shadow:\s*none;/);
	assert.match(inputRule, /transition:\s*none;/);
	assert.match(inputRule, /-webkit-tap-highlight-color:\s*transparent;/);
});

test("memo writes apply local mutations instead of refreshing every open view", async () => {
	const source = await readFile(resolve(process.cwd(), "src/ui/KnomoView.ts"), "utf8");
	const saveMethod = getMethodSource(source, "saveInput");
	const deleteMethod = getMethodSource(source, "handleMemoAction");

	assert.match(saveMethod, /this\.applyMemoMutation\(/);
	assert.match(saveMethod, /this\.onMemoMutation\(/);
	assert.doesNotMatch(saveMethod, /onMemosChanged/);
	assert.match(deleteMethod, /this\.applyMemoMutation\(/);
	assert.doesNotMatch(deleteMethod, /onMemosChanged/);
});

test("open daily memo action reads the existing daily ref and opens through the helper", async () => {
	const source = await readFile(resolve(process.cwd(), "src/ui/KnomoView.ts"), "utf8");
	const memoActionMethod = getMethodSource(source, "handleMemoAction");

	assert.match(memoActionMethod, /action === "open-daily"/);
	assert.match(memoActionMethod, /this\.app\.vault\.getAbstractFileByPath\(memo\.dailyRef\.path\)/);
	assert.match(
		memoActionMethod,
		/if \(shouldCloseMobileSearch\) \{\s*this\.closeMobileSearchPage\(\);\s*\}\s*this\.syncCardMenuState\(\);/,
	);
	assert.match(memoActionMethod, /if \(!\(file instanceof TFile\)\) \{\s*new Notice\(t\("error\.dailyNoteMissing"\)\);/);
	assert.match(memoActionMethod, /await openMemoDailyNoteInNewTab\(this\.app\.workspace, file, memo\.dailyRef\.lineNumberHint\);/);
});

test("mobile popover toggles keep card and scope menus mutually exclusive", async () => {
	const source = await readFile(resolve(process.cwd(), "src/ui/KnomoView.ts"), "utf8");
	const cardMenuMethod = getMethodSource(source, "toggleCardMenu");
	const scopeMenuMethod = getMethodSource(source, "toggleScopeMenu");
	const actionMethod = getMethodSource(source, "handleAction");

	assert.match(cardMenuMethod, /this\.scopeMenuOpen = false;/);
	assert.match(cardMenuMethod, /if \(this\.activeMenuMemoId === memoId\) \{\s*this\.closeCardMenu\(\);\s*return;\s*\}/);
	assert.match(cardMenuMethod, /this\.activeMenuMemoId = memoId;/);
	assert.match(cardMenuMethod, /this\.syncRootState\(\);/);
	assert.match(cardMenuMethod, /this\.syncCardMenuState\(\);/);
	assert.match(scopeMenuMethod, /this\.scopeMenuOpen = !this\.scopeMenuOpen;/);
	assert.match(scopeMenuMethod, /this\.closeCardMenu\(\);/);
	assert.match(scopeMenuMethod, /this\.syncRootState\(\);/);
	assert.match(scopeMenuMethod, /this\.syncCardMenuState\(\);/);
	assert.match(actionMethod, /case "toggle-card-menu":[\s\S]*this\.toggleCardMenu\(memoId\);/);
	assert.match(actionMethod, /case "toggle-scope-menu":[\s\S]*this\.toggleScopeMenu\(\);/);
});

test("card menu placement does not depend on its previous open direction", async () => {
	const source = await readFile(resolve(process.cwd(), "src/ui/KnomoView.ts"), "utf8");
	const syncMethod = getMethodSource(source, "syncCardMenuState");
	const positionMethod = getMethodSource(source, "positionOpenCardMenu");

	assert.ok(syncMethod.indexOf("this.positionOpenCardMenu(card)") < syncMethod.indexOf('card.toggleClass("is-menu-open", isOpen)'));
	assert.match(positionMethod, /const head = card\.find\("\.knomo-card-head"\);/);
	assert.match(positionMethod, /const menuHeight = actions\.offsetHeight;/);
	assert.match(positionMethod, /const spaceBelow = flowRect\.bottom - 8 - headRect\.bottom - 6;/);
	assert.match(positionMethod, /const spaceAbove = headRect\.top - flowRect\.top - 8 - 6;/);
	assert.match(positionMethod, /menuHeight > spaceBelow && spaceAbove > spaceBelow/);
	assert.doesNotMatch(positionMethod, /actions\.getBoundingClientRect\(\)/);
});

test("open popups consume outside card interactions before running card actions", async () => {
	const source = await readFile(resolve(process.cwd(), "src/ui/KnomoView.ts"), "utf8");
	const rootPointerDownMethod = getMethodSource(source, "handleRootPointerDown");
	const rootClickMethod = getMethodSource(source, "handleRootClick");
	const guardMethod = getMethodSource(source, "handleOpenPopupOutsideEvent");
	const consumeMethod = getMethodSource(source, "consumeSuppressedOpenPopupDismissClick");
	const popupMethod = getMethodSource(source, "isTargetInOpenPopup");
	const triggerMethod = getMethodSource(source, "isOpenPopupTrigger");
	const closePopupsMethod = getMethodSource(source, "closeOpenPopups");
	const scopeGuardMethod = getMethodSource(source, "isTargetInOpenScopeMenu");
	const closeMethod = getMethodSource(source, "closeCardMenu");
	const blurMethod = getMethodSource(source, "blurCardMenuButton");
	const syncCardMenuMethod = getMethodSource(source, "syncCardMenuState");
	const markdownClickMethod = getMethodSource(source, "handleMarkdownInternalLinkClick");
	const checkboxClickMethod = getMethodSource(source, "handleTaskCheckboxClick");
	const checkboxChangeMethod = getMethodSource(source, "handleTaskCheckboxChange");

	assert.match(rootPointerDownMethod, /this\.currentLayout !== "mobile"/);
	assert.match(rootPointerDownMethod, /this\.handleOpenPopupOutsideEvent\(event, event\.target, true\);/);
	assert.ok(rootClickMethod.indexOf("this.consumeSuppressedOpenPopupDismissClick(event)") < rootClickMethod.indexOf("const imageTrigger"));
	assert.ok(rootClickMethod.indexOf("this.handleOpenPopupOutsideEvent(event, target, false)") < rootClickMethod.indexOf("route.type === \"memo-card-open\""));
	assert.match(markdownClickMethod, /this\.consumeSuppressedOpenPopupDismissClick\(event\)/);
	assert.match(markdownClickMethod, /this\.handleOpenPopupOutsideEvent\(event, event\.target, false\)/);
	assert.match(checkboxClickMethod, /this\.consumeSuppressedOpenPopupDismissClick\(event\)/);
	assert.match(checkboxClickMethod, /this\.handleOpenPopupOutsideEvent\(event, event\.target, false\)/);
	assert.match(checkboxChangeMethod, /this\.suppressNextOpenPopupDismissClick/);
	assert.match(checkboxChangeMethod, /this\.handleOpenPopupOutsideEvent\(event, event\.target, false\)/);
	assert.match(guardMethod, /this\.hasOpenPopup\(\)/);
	assert.match(guardMethod, /this\.isTargetInOpenPopup\(element\)/);
	assert.match(guardMethod, /this\.closeOpenPopups\(\);/);
	assert.match(guardMethod, /this\.markSuppressNextOpenPopupDismissClick\(\);/);
	assert.match(guardMethod, /this\.shouldPreserveDefaultForPopupDismiss\(element\)/);
	assert.match(consumeMethod, /this\.getEventElement\(event\.target\)/);
	assert.match(consumeMethod, /target\?\.closest\("\[data-memo-time-open='daily'\]"\)/);
	assert.match(consumeMethod, /memoTimeButton\?\.instanceOf\(HTMLElement\)/);
	assert.match(consumeMethod, /memoTimeButton\.blur\(\);/);
	assert.match(popupMethod, /this\.isOpenPopupTrigger\(target\)/);
	assert.match(triggerMethod, /\.knomo-card-menu/);
	assert.match(triggerMethod, /toggle-card-menu/);
	assert.match(triggerMethod, /toggle-scope-menu/);
	assert.match(closePopupsMethod, /this\.closeCardMenu\(\);/);
	assert.match(closePopupsMethod, /this\.scopeMenuOpen = false;/);
	assert.match(closePopupsMethod, /this\.syncRootState\(\);/);
	assert.match(scopeGuardMethod, /this\.scopeMenuOpen/);
	assert.match(scopeGuardMethod, /\.knomo-scope-popover/);
	assert.match(scopeGuardMethod, /toggle-scope-menu/);
	assert.match(closeMethod, /const memoId = this\.activeMenuMemoId;/);
	assert.match(closeMethod, /this\.blurCardMenuButton\(memoId\);/);
	assert.match(blurMethod, /card\.find\("\.knomo-card-menu"\)\?\.blur\(\);/);
	assert.doesNotMatch(syncCardMenuMethod, /toggleClass\("is-menu-above", false\)/);
});

test("mobile search edit and reference actions keep the search page open under composer", async () => {
	const source = await readFile(resolve(process.cwd(), "src/ui/KnomoView.ts"), "utf8");
	const memoActionMethod = getMethodSource(source, "handleMemoAction");
	const openDailyBranch = memoActionMethod.slice(memoActionMethod.indexOf("action === \"open-daily\""));
	const startEditingMethod = getMethodSource(source, "startEditing");
	const startReferenceMethod = getMethodSource(source, "startReferenceMemo");
	const closeMobileComposerMethod = getMethodSource(source, "closeMobileComposerKeepingDraft");

	assert.doesNotMatch(source, /hideMobileSearchPageForComposer|restoreMobileSearchAfterComposerClose|openMobileSearchPage\(false\)/);
	assert.match(memoActionMethod, /if \(action === "edit"\) \{[\s\S]*this\.startEditing\(memo\);/);
	assert.match(memoActionMethod, /action === "reference"[\s\S]*this\.startReferenceMemo/);
	assert.match(openDailyBranch, /if \(shouldCloseMobileSearch\) \{\s*this\.closeMobileSearchPage\(\);/);
	assert.doesNotMatch(startEditingMethod, /closeMobileSearchPage|mobileSearchPageOpen = false|resetMobileSearchState/);
	assert.doesNotMatch(startReferenceMethod, /closeMobileSearchPage|mobileSearchPageOpen = false|resetMobileSearchState/);
	assert.doesNotMatch(closeMobileComposerMethod, /closeMobileSearchPage|mobileSearchPageOpen = false|resetMobileSearchState/);
});

test("memo time clicks open daily notes with default pane behavior and random review marking after success", async () => {
	const source = await readFile(resolve(process.cwd(), "src/ui/KnomoView.ts"), "utf8");
	const controllerSource = await readFile(resolve(process.cwd(), "src/ui/RandomReunionController.ts"), "utf8");
	const clickMethod = getMethodSource(source, "handleRootClick");
	const keydownMethod = getMethodSource(source, "handleRootKeydown");
	const openMethod = getMethodSource(source, "openMemoCardDailyNote");
	const markReviewedMethod = getMethodSource(controllerSource, "markReviewedAfterOpen");

	assert.match(clickMethod, /route\.type === "memo-card-open"/);
	assert.match(clickMethod, /await this\.openMemoCardDailyNote\(route\.memoId, route\.randomReunion\);/);
	assert.match(keydownMethod, /getMemoCardOpenRoute\(target\)/);
	assert.match(keydownMethod, /await this\.openMemoCardDailyNote\(memoCardOpenRoute\.memoId, memoCardOpenRoute\.randomReunion\);/);
	assert.match(openMethod, /await openMemoDailyNoteDefault\(this\.app\.workspace, memo\);/);
	assert.match(
		openMethod,
		/await openMemoDailyNoteDefault\(this\.app\.workspace, memo\);[\s\S]*if \(markRandomReunionReviewed\) \{[\s\S]*await this\.randomReunionController\.markReviewedAfterOpen\(memo\.id\);/,
	);
	assert.match(markReviewedMethod, /await this\.options\.markRandomReunionReviewed\(memoId\);/);
});

test("memo delete mutations increment the trash count only once", async () => {
	const viewSource = await readFile(resolve(process.cwd(), "src/ui/KnomoView.ts"), "utf8");
	const controllerSource = await readFile(resolve(process.cwd(), "src/ui/TrashMemoController.ts"), "utf8");
	const mutationMethod = getMethodSource(viewSource, "applyMemoMutation");
	const recordDeletedMethod = getMethodSource(controllerSource, "recordDeletedMemo");

	assert.match(mutationMethod, /this\.trashMemoController\.recordDeletedMemo\(mutation\.memo\.id\);/);
	assert.match(recordDeletedMethod, /if \(this\.deletedMemoIds\.has\(memoId\)\) \{\s*return;\s*\}/);
	assert.match(recordDeletedMethod, /this\.deletedMemoIds\.add\(memoId\);\s*this\.trashCount \+= 1;/);
});

test("record statistics reuse one preparation request and skip unchanged renders", async () => {
	const source = await readFile(resolve(process.cwd(), "src/ui/KnomoView.ts"), "utf8");
	const prepareMethod = getMethodSource(source, "prepareRecordStats");
	const renderMethod = getMethodSource(source, "renderRecordStatsPage");

	assert.match(prepareMethod, /if \(this\.recordStatsRequestPromise !== null\) \{\s*return this\.recordStatsRequestPromise;/);
	assert.match(renderMethod, /this\.recordStatsRenderedKey === renderKey/);
	assert.doesNotMatch(source, /recordStatsLoadingPromise/);
});

test("purging a memo refreshes every open view", async () => {
	const viewSource = await readFile(resolve(process.cwd(), "src/ui/KnomoView.ts"), "utf8");
	const controllerSource = await readFile(resolve(process.cwd(), "src/ui/TrashMemoController.ts"), "utf8");
	const trashActionMethod = getMethodSource(controllerSource, "handleTrashAction");

	assert.match(
		trashActionMethod,
		/await this\.options\.purgeDeletedMemo\(memo\.id\);[\s\S]*await this\.options\.forceRefreshViews\(\);/,
	);
	assert.match(viewSource, /await this\.trashMemoController\.handleTrashAction\(dispatch\.action, memo\);/);
	assert.doesNotMatch(trashActionMethod, /refreshTrashCount/);
});

async function renderMemoCard(
	contentSnapshot: string,
	preview?: MemoCardPreview,
): Promise<{
	card: TestElement;
	body: TestElement | null;
	content: TestElement | null;
	images: TestElement | null;
	queued: { container: HTMLElement; memo: MemoRecord; previewText: string } | null;
}> {
	await ensureObsidianStub();
	const { renderKnomoMemoCard } = await import("../src/ui/KnomoCard");
	const root = new TestElement("div");
	const memo = makeMemo({ contentSnapshot });
	let queued: { container: HTMLElement; memo: MemoRecord; previewText: string } | null = null;

	renderKnomoMemoCard(root.asHtml(), memo, {
		generation: 7,
		renderIndex: 0,
		includeActions: false,
		randomCard: false,
		activeMenuMemoId: null,
		deletedMemoIds: new Set(),
		formatDisplayTime: (value) => value,
		formatSettingsText: (value) => value,
		getMarkdownPriority: () => "normal" as const,
		getMemoCardPreview: (queuedMemo) => preview ?? { text: queuedMemo.contentSnapshot, images: [] },
		queueMemoMarkdown: (queuedMemo, container, _generation, _priority, previewText) => {
			queued = { container, memo: queuedMemo, previewText };
		},
		renderMemoCardImages: (container, _memo, images) => {
			if (images.length > 0) {
				container.createDiv({ cls: "knomo-card-images" });
			}
		},
		queueSourceReferenceMarkdown: () => {
			throw new Error("Unexpected source reference render");
		},
	});

	const card = root.find("article");
	if (card === null) {
		throw new Error("Expected memo card to render");
	}
	return {
		card,
		body: root.find(".knomo-card-body"),
		content: root.find(".knomo-card-content"),
		images: root.find(".knomo-card-images"),
		queued,
	};
}

function getStyleRule(css: string, selector: string): string {
	const pattern = new RegExp(`${escapeRegExp(selector)}\\s*\\{([^}]*)\\}`, "s");
	const match = css.match(pattern);
	if (match === null) {
		throw new Error(`Expected CSS rule for ${selector}`);
	}
	return match[1];
}

function getCjkSelectors(css: string): string {
	const selectors: string[] = [];
	const pattern = /([^{}]+)\{[^{}]*\}/g;
	let match: RegExpExecArray | null = pattern.exec(css);
	while (match !== null) {
		if (match[1].includes(".is-cjk-content")) {
			selectors.push(match[1].trim());
		}
		match = pattern.exec(css);
	}
	return selectors.join("\n");
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function getMethodSource(source: string, methodName: string): string {
	const start = getMethodStart(source, methodName);
	if (start === -1) {
		throw new Error(`Expected method ${methodName}`);
	}
	const nextMethod = source.indexOf("\n\tprivate ", start + 1);
	return nextMethod === -1 ? source.slice(start) : source.slice(start, nextMethod);
}

function getMethodStart(source: string, methodName: string): number {
	const start = source.indexOf(`private ${methodName}(`);
	if (start !== -1) {
		return start;
	}
	const asyncStart = source.indexOf(`private async ${methodName}(`);
	if (asyncStart !== -1) {
		return asyncStart;
	}
	const publicAsyncStart = source.indexOf(`\n\tasync ${methodName}(`);
	return publicAsyncStart === -1 ? source.indexOf(`\n\t${methodName}(`) : publicAsyncStart;
}

async function ensureObsidianStub(): Promise<void> {
	const stubPath = resolve(__dirname, "../node_modules/obsidian/index.js");
	await mkdir(dirname(stubPath), { recursive: true });
	await writeFile(
		stubPath,
		[
			"class TFile {}",
			"class TFolder { constructor() { this.children = []; } }",
			"const Vault = { recurseChildren() {} };",
			"const normalizePath = (value) => value.replace(/\\\\/g, '/').replace(/\\/+/g, '/').replace(/^\\//, '').replace(/\\/$/, '');",
			"function setIcon(el, icon) { if (el && typeof el.setAttr === 'function') el.setAttr('data-icon', icon); return el; }",
			"function addIcon() {}",
			"let languageValue = 'en';",
			"function getLanguage() { return languageValue; }",
			"getLanguage.set = (value) => { languageValue = value; };",
			"let localeValue = 'en';",
			"const moment = (date = new Date()) => ({ format: () => date.toISOString().slice(0, 10) });",
			"moment.locale = (value) => { if (typeof value === 'string') localeValue = value; return localeValue; };",
			"module.exports = { TFile, TFolder, Vault, normalizePath, setIcon, addIcon, getLanguage, moment };",
		].join("\n"),
	);
}

interface CreateElementOptions {
	cls?: string;
	text?: string;
	attr?: Record<string, string>;
}

class TestElement {
	private readonly children: TestElement[] = [];
	private readonly classes = new Set<string>();
	private readonly attrs = new Map<string, string>();
	private text = "";

	constructor(private readonly tagName: string) {}

	asHtml(): HTMLElement {
		return this as unknown as HTMLElement;
	}

	createDiv(options: CreateElementOptions = {}): TestElement {
		return this.createEl("div", options);
	}

	createSpan(options: CreateElementOptions = {}): TestElement {
		return this.createEl("span", options);
	}

	createEl(tagName: string, options: CreateElementOptions = {}): TestElement {
		const child = new TestElement(tagName);
		if (options.cls !== undefined) {
			for (const cls of options.cls.split(/\s+/)) {
				if (cls.length > 0) {
					child.addClass(cls);
				}
			}
		}
		if (options.text !== undefined) {
			child.setText(options.text);
		}
		for (const [key, value] of Object.entries(options.attr ?? {})) {
			child.setAttr(key, value);
		}
		this.children.push(child);
		return child;
	}

	setText(value: string): void {
		this.text = value;
	}

	getText(): string {
		return this.text + this.children.map((child) => child.getText()).join("");
	}

	setAttr(key: string, value: string): void {
		this.attrs.set(key, value);
	}

	getAttr(key: string): string | null {
		return this.attrs.get(key) ?? null;
	}

	addClass(cls: string): void {
		this.classes.add(cls);
	}

	hasClass(cls: string): boolean {
		return this.classes.has(cls);
	}

	find(selector: string): TestElement | null {
		return this.findAll(selector)[0] ?? null;
	}

	findAll(selector: string): TestElement[] {
		const result: TestElement[] = [];
		for (const child of this.children) {
			child.collect(selector, result);
		}
		return result;
	}

	private collect(selector: string, result: TestElement[]): void {
		if (this.matches(selector)) {
			result.push(this);
		}
		for (const child of this.children) {
			child.collect(selector, result);
		}
	}

	private matches(selector: string): boolean {
		if (selector.startsWith(".")) {
			return this.classes.has(selector.slice(1));
		}
		const attrMatch = selector.match(/^\[([^=\]]+)(?:='([^']*)')?\]$/);
		if (attrMatch !== null) {
			const value = this.attrs.get(attrMatch[1]);
			return attrMatch[2] === undefined ? value !== undefined : value === attrMatch[2];
		}
		return this.tagName === selector;
	}
}

function makeMemo(overrides: Partial<MemoRecord> = {}): MemoRecord {
	return {
		id: "memo-1",
		createdAt: "2026-06-02T00:00:00+08:00",
		updatedAt: "2026-06-02T00:00:00+08:00",
		contentSnapshot: "memo",
		contentHash: "hash",
		status: "active",
		syncStatus: "synced",
		source: "plugin_input",
		version: 1,
		tags: [],
		links: [],
		images: [],
		references: [],
		sourceMemoId: null,
		issue: null,
		lastMarkdownSyncAt: null,
		lastMarkdownSyncSource: null,
		dailyRef: {
			path: "Daily/2026-06-02.md",
			heading: null,
			lastKnownBlock: "",
			lastKnownHash: "",
			lineNumberHint: null,
			lastSyncedAt: null,
		},
		monthlyRef: {
			path: "Knomo/2026-06.md",
			dateHeading: "2026-06-02",
			lastKnownBlock: "",
			lastKnownHash: "",
			lineNumberHint: null,
			lastSyncedAt: null,
		},
		...overrides,
	};
}
