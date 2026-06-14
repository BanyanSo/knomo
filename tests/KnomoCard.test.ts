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

test("card content CSS justifies CJK cards while list items inherit the card alignment", async () => {
	const css = await readFile(resolve(process.cwd(), "styles.css"), "utf8");

	assert.match(getStyleRule(css, ".knomo-plugin .knomo-card-content"), /text-align:\s*start;/);
	assert.match(getStyleRule(css, ".knomo-plugin .knomo-card.is-cjk-content .knomo-card-content"), /text-align:\s*justify;/);
	assert.match(getStyleRule(css, ".knomo-plugin .knomo-card.is-cjk-content .knomo-card-content"), /text-align-last:\s*start;/);
	assert.equal(css.includes("text-justify"), false);
	assert.doesNotMatch(getCjkSelectors(css), /\bli\b/);
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
		/width:\s*100vw;[\s\S]*height:\s*100vh;[\s\S]*height:\s*100dvh;[\s\S]*border-radius:\s*0;/,
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

test("image preview modal keeps mobile gestures isolated and preloads adjacent images", async () => {
	const modalSource = await readFile(resolve(process.cwd(), "src/ui/KnomoImagePreviewModal.ts"), "utf8");

	assert.match(modalSource, /toggleClass\("knomo-image-preview-backdrop--mobile", Platform\.isMobile\)/);
	assert.match(modalSource, /if \(event\.target === this\.stageEl\)/);
	assert.match(modalSource, /if \(event\.touches\.length !== 1\)/);
	assert.match(modalSource, /const TOUCH_EDGE_GUARD = 24;/);
	assert.match(modalSource, /suppressStageClickUntil/);
	assert.match(modalSource, /preloadedImageUrls\.has\(image\.url\)/);
	assert.match(modalSource, /this\.preloadAdjacentImages\(\);/);
	assert.match(modalSource, /t\("image\.loadFailed"\)/);
});

test("card images load as memo-card tasks without changing the initial batch size", async () => {
	const source = await readFile(resolve(process.cwd(), "src/ui/KnomoView.ts"), "utf8");
	const renderImagesMethod = getMethodSource(source, "renderMemoCardImages");
	const renderMethod = getMethodSource(source, "renderMemoCardImage");

	assert.match(source, /const CARD_BATCH_SIZE = 50;/);
	assert.match(renderMethod, /loading:\s*"lazy"/);
	assert.match(renderMethod, /decoding:\s*"async"/);
	assert.match(renderMethod, /if \(image\.isRemote\)/);
	assert.match(renderMethod, /imageEl\.setAttr\("fetchpriority", "low"\)/);
	assert.match(renderImagesMethod, /queue\.observe/);
	assert.match(renderImagesMethod, /targetEl:\s*imagesEl/);
	assert.match(renderImagesMethod, /images:\s*loadItems/);
	assert.doesNotMatch(renderMethod, /createEl\("img",\s*\{\s*attr:\s*\{[^}]*\bsrc:/s);
	assert.doesNotMatch(source, /cardImageLoadQueue\.setPaused/);
	assert.doesNotMatch(source, /requestIdleCallback|CARD_IMAGE_IDLE_TIMEOUT_MS/);
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
	const source = await readFile(resolve(process.cwd(), "src/ui/KnomoView.ts"), "utf8");

	assert.match(source, /this\.prepareInternalLinks\(container, memo\.dailyRef\.path\);/);
	assert.match(source, /event\.preventDefault\(\);\s*await this\.app\.workspace\.openLinkText\(linktext, sourcePath, Keymap\.isModEvent\(event\)\);/);
	assert.match(source, /imageEl\.setAttr\("loading", "lazy"\);/);
	assert.match(source, /tagEl\.setAttr\("data-tag", tag\);/);
	assert.match(source, /tagEl\.setAttr\("data-tag-key", tagKey\);/);
});

test("desktop save clears the rendered reference and edit state", async () => {
	const source = await readFile(resolve(process.cwd(), "src/ui/KnomoView.ts"), "utf8");
	const saveMethod = getMethodSource(source, "saveInput");
	const desktopSaveBranch = saveMethod.slice(saveMethod.indexOf("} else {", saveMethod.indexOf("if (isMobileSave)")));

	assert.match(desktopSaveBranch, /this\.syncComposerMode\(\);/);
	assert.match(desktopSaveBranch, /this\.updateCancelEditButtonState\(\);/);
});

test("task checkbox handling stays delegated and does not enter composer edit flow", async () => {
	const source = await readFile(resolve(process.cwd(), "src/ui/KnomoView.ts"), "utf8");
	const changeMethod = getMethodSource(source, "handleTaskCheckboxChange");
	const clickMethod = getMethodSource(source, "handleTaskCheckboxClick");
	const savedMethod = getMethodSource(source, "handleTaskMemoSaved");

	assert.match(source, /this\.registerDomEvent\(this\.cardFlowEl, "change", \(event\) => \{/);
	assert.match(source, /this\.registerDomEvent\(this\.mobileSearchResultsEl, "change", \(event\) => \{/);
	assert.match(source, /input\.setAttr\("data-knomo-task-index", String\(taskIndex\)\);/);
	assert.match(source, /input\.setAttr\("data-task", renderedMarker\);/);
	assert.match(changeMethod, /if \(!event\.isTrusted\) \{/);
	assert.match(changeMethod, /event\.stopPropagation\(\);/);
	assert.match(changeMethod, /replaceMarkdownTaskMarkerByIndex\(latestContent, taskIndex, marker\);/);
	assert.match(changeMethod, /this\.memoTaskUpdateCoordinator\.enqueue\(memo, nextContent\);/);
	assert.match(clickMethod, /event\.stopPropagation\(\);/);
	assert.doesNotMatch(savedMethod, /syncTaskCheckboxesForMemo/);
	assert.doesNotMatch(changeMethod, /preventDefault\(/);
	assert.doesNotMatch(changeMethod, /openComposer|startEditing|inputEl\.value|draftContent/);
});

test("mobile memo hydration reads memo indexes without restoring startup scans", async () => {
	const source = await readFile(resolve(process.cwd(), "src/ui/KnomoView.ts"), "utf8");
	const renderMethod = getMethodSource(source, "render");
	const initialLoadMethod = getMethodSource(source, "loadInitialMobileMemos");
	const hydrationMethod = getMethodSource(source, "hydrateMobileMemos");
	const ensureMethod = getMethodSource(source, "ensureAllMemosLoaded");
	const sidebarMethod = getMethodSource(source, "requestMobileMemoHydrationForSidebar");
	const deferSidebarMethod = getMethodSource(source, "deferMobileMemoHydrationForSidebar");

	assert.match(source, /this\.scheduleMobileMemoHydration\(\);/);
	assert.match(source, /this\.requestMobileMemoHydrationForSidebar\(\);/);
	assert.match(source, /this\.requestMobileMemoHydrationForCardFlow\(\);/);
	assert.match(renderMethod, /void this\.loadInitialMobileMemos\(\);/);
	assert.doesNotMatch(renderMethod, /await this\.reloadMemos\(false\);/);
	assert.match(initialLoadMethod, /await this\.syncOrchestrator\.listRecentMemos\(\);/);
	assert.match(initialLoadMethod, /runId !== this\.mobileMemoHydrateRunId/);
	assert.match(hydrationMethod, /this\.syncOrchestrator\.listMemoIndexPeriods\(\);/);
	assert.match(hydrationMethod, /this\.syncOrchestrator\.listMemosInPeriods\(\[period\]\);/);
	assert.doesNotMatch(hydrationMethod, /scanRecentDailyMemos|scanDailyMemos|reloadMemos\(true\)/);
	assert.match(ensureMethod, /Platform\.isMobile && !forceReload/);
	assert.match(sidebarMethod, /this\.mobileMemoHydrateFastMode = true;/);
	assert.match(deferSidebarMethod, /this\.containerEl\.win\.setTimeout/);
	assert.match(deferSidebarMethod, /this\.requestMobileMemoHydrationForSidebar\(\);/);
});

test("mobile memo hydration compares only the rendered card window", async () => {
	const source = await readFile(resolve(process.cwd(), "src/ui/KnomoView.ts"), "utf8");
	const hydrationMethod = getMethodSource(source, "hydrateMobileMemos");

	assert.match(hydrationMethod, /const renderedCardCount = this\.getRenderedCardCount\(\);/);
	assert.match(hydrationMethod, /this\.getVisibleCardFlowStateKey\(renderedCardCount\)/);
	assert.doesNotMatch(hydrationMethod, /this\.getCardFlowStateKey\(\)/);
});

test("ordinary card-flow renders preserve existing cards and image queue state", async () => {
	const source = await readFile(resolve(process.cwd(), "src/ui/KnomoView.ts"), "utf8");
	const renderMethod = getMethodSource(source, "renderCardFlow");

	assert.doesNotMatch(renderMethod, /cardImageLoadQueue\.clear\(\)/);
	assert.doesNotMatch(renderMethod, /cardFlowEl\.empty\(\)/);
	assert.doesNotMatch(renderMethod, /renderGeneration \+ 1/);
	assert.match(source, /private forceRebuildCardFlow\(/);
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

test("memo delete mutations increment the trash count only once", async () => {
	const source = await readFile(resolve(process.cwd(), "src/ui/KnomoView.ts"), "utf8");
	const mutationMethod = getMethodSource(source, "applyMemoMutation");

	assert.match(mutationMethod, /const wasAlreadyDeleted = this\.deletedMemoIds\.has\(mutation\.memo\.id\);/);
	assert.match(mutationMethod, /if \(!wasAlreadyDeleted\) \{\s*this\.trashCount \+= 1;\s*\}/);
});

test("purging a memo refreshes every open view", async () => {
	const source = await readFile(resolve(process.cwd(), "src/ui/KnomoView.ts"), "utf8");
	const trashActionMethod = getMethodSource(source, "handleTrashAction");

	assert.match(
		trashActionMethod,
		/await this\.syncOrchestrator\.purgeDeletedMemo\(memo\.id\);[\s\S]*await this\.onForceRefreshViews\(\);/,
	);
	assert.doesNotMatch(trashActionMethod, /void this\.refreshTrashCount\(false\);/);
});

async function renderMemoCard(contentSnapshot: string, preview?: MemoCardPreview): Promise<{
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
		getA11yId: (id) => `a11y-${id}`,
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
	return asyncStart === -1 ? source.indexOf(`\n\t${methodName}(`) : asyncStart;
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
