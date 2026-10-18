import assert from "node:assert/strict";
import { JSDOM, VirtualConsole } from "jsdom";
import type { MemoViewItem } from "../../src/types/memoView";
import type { ComposerInput } from "../../src/ui/ComposerEditor";
import type { KnomoUserActionController } from "../../src/ui/KnomoUserActionController";
import { KnomoPopupState } from "../../src/ui/KnomoPopupState";
import { KnomoViewStateController } from "../../src/ui/KnomoViewStateController";
import { ensureObsidianStub } from "./obsidianStub";

export type MobilePopupAction = "save-input" | "cancel-edit" | "clear-reference";
export type MobilePopupKind = "scope" | "card";

export const mobilePopupText = {
	createDraft: "创建草稿：保留这段正文与选区。",
	editDraft: "编辑中的 Memo：取消手势不应丢失这些修改。",
	reference: "> 引用原文：保留引用，直到用户明确清除。",
};

interface FixtureView {
	composerEl: HTMLElement;
	inputEl: ComposerInput;
	sendButtonEl: HTMLButtonElement;
	cancelEditButtonEl: HTMLButtonElement;
	referencePreviewEl: HTMLElement;
	editingMemo: MemoViewItem | null;
	quoteReferenceText: string | null;
	quoteMarkdownText: string | null;
	composerOpen: boolean;
	isSaving: boolean;
	userActionController: KnomoUserActionController;
	wikiLinkSuggest: { destroy: () => void };
	renderComposer: (container: HTMLElement) => void;
	createUserActionController: () => KnomoUserActionController;
	handleRootPointerDown: (event: PointerEvent) => void;
	handleRootClick: (event: MouseEvent) => Promise<void>;
	clearReference: () => void;
	cancelEditing: () => void;
	updateSendButtonState: () => void;
	updateCancelEditButtonState: () => void;
}

// 使用实际渲染器、Composer 接线和根路由；仅隔离宿主、持久化和无关 UI 刷新。
export async function createMobilePopupFixture(action: MobilePopupAction = "save-input") {
	await ensureObsidianStub();
	const { KnomoView } = await import("../../src/ui/KnomoView");
	const { renderComposerReferencePreview } = await import("../../src/ui/KnomoComposer");
	const { renderKnomoScopePopover } = await import("../../src/ui/KnomoHeaderSearch");
	const { renderKnomoMemoCard } = await import("../../src/ui/KnomoCard");
	const errors: Error[] = [];
	const virtualConsole = new VirtualConsole();
	virtualConsole.on("jsdomError", error => errors.push(error));
	const dom = new JSDOM("<!doctype html><body></body>", { pretendToBeVisual: true, virtualConsole });
	const win = dom.window;
	// JSDOM 不实现原生窗口激活；各焦点用例独立控制 document.hasFocus。
	win.focus = () => {};
	Object.assign(win.HTMLElement.prototype, {
		createEl(this: HTMLElement, tag: string, options: { cls?: string; text?: string; attr?: Record<string, string> } = {}) {
			const element = this.ownerDocument.createElement(tag);
			if (options.cls) element.className = options.cls;
			if (options.text) element.textContent = options.text;
			for (const [key, value] of Object.entries(options.attr ?? {})) element.setAttribute(key, value);
			return this.appendChild(element);
		},
		createDiv(this: HTMLElement, options?: { cls?: string; text?: string; attr?: Record<string, string> }) { return this.createEl("div", options); },
		createSpan(this: HTMLElement, options?: { cls?: string; text?: string; attr?: Record<string, string> }) { return this.createEl("span", options); },
		setAttr(this: HTMLElement, key: string, value: string) { this.setAttribute(key, value); },
		getAttr(this: HTMLElement, key: string) { return this.getAttribute(key); },
		setAttrs(this: HTMLElement, attrs: Record<string, string>) { for (const [key, value] of Object.entries(attrs)) this.setAttribute(key, value); },
		setText(this: HTMLElement, text: string) { this.textContent = text; },
		empty(this: HTMLElement) { this.replaceChildren(); },
		addClass(this: HTMLElement, cls: string) { this.classList.add(cls); },
		removeClass(this: HTMLElement, cls: string) { this.classList.remove(cls); },
		toggleClass(this: HTMLElement, cls: string, force: boolean) { this.classList.toggle(cls, force); },
		detach(this: HTMLElement) { this.remove(); },
	});
	Object.assign(win.Node.prototype, { instanceOf(this: Node, constructor: typeof Node) { return this instanceof constructor; } });
	win.Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
	win.Range.prototype.getBoundingClientRect = () => new win.DOMRect();
	const previous = new Map<string, PropertyDescriptor | undefined>();
	for (const name of ["window", "document", "Node", "Element", "HTMLElement", "HTMLInputElement", "Window", "MutationObserver", "getComputedStyle", "requestAnimationFrame", "cancelAnimationFrame", "createSpan", "createFragment"]) {
		previous.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
		const source = name === "createSpan" ? () => win.document.createElement("span")
			: name === "createFragment" ? () => win.document.createDocumentFragment()
			: name === "window" ? win : (win as unknown as Record<string, unknown>)[name];
		Object.defineProperty(globalThis, name, { configurable: true, writable: true, value: typeof source === "function" && ["getComputedStyle", "requestAnimationFrame", "cancelAnimationFrame"].includes(name) ? source.bind(win) : source });
	}
	const cleanups: Array<() => void> = [];
	const scope = {
		register: (cleanup: () => void) => cleanups.push(cleanup),
		registerEvent: () => undefined,
		registerDomEvent(target: EventTarget, type: string, listener: EventListener, options?: AddEventListenerOptions | boolean) {
			target.addEventListener(type, listener, options);
			cleanups.push(() => target.removeEventListener(type, listener, options));
		},
	};
	const root = win.document.body.createDiv({ cls: "knomo-plugin is-layout-mobile" });
	const layer = win.document.body.createDiv({ cls: "knomo-plugin is-layout-mobile knomo-mobile-composer-layer" });
	const popup = new KnomoPopupState(() => win as unknown as Window);
	const calls: string[] = [];
	const view = Object.assign(Object.create(KnomoView.prototype) as FixtureView, {
		containerEl: { doc: win.document }, popupState: popup, currentLayout: "mobile", composerOpen: true, isSaving: false,
		viewStateController: new KnomoViewStateController(), timeBuoyPickerState: null,
		catalogDesktopQueryRun: 0, catalogDesktopCountRun: 0,
		clearSearchDebounce: () => undefined, refreshCatalogActiveQuery: () => undefined,
		editingMemo: action === "cancel-edit" ? memo() : null,
		quoteReferenceText: action === "clear-reference" ? "[[Daily/2026-10-06#^p0-reference]]" : null,
		quoteMarkdownText: action === "clear-reference" ? mobilePopupText.reference : null,
		draftContent: action === "cancel-edit" ? mobilePopupText.editDraft : mobilePopupText.createDraft,
		draftImageLinks: [], suspendedCreate: { content: mobilePopupText.createDraft, imageLinks: [], anchor: 2, head: 4, scrollTop: 0, referenceText: null, markdownText: null },
		app: { vault: { on: () => ({}), getMarkdownFiles: () => [] } },
		settingsService: { getSettings: () => ({ timeBuoyEnabled: false }) },
		mobileComposerController: { getPhase: () => "open", isLayered: () => true, closeKeepingDraft: () => { view.composerOpen = false; } },
		getDailyNotesStatus: () => ({ enabled: true }),
		getRenderScope: () => scope, getA11yId: (name: string) => `p0-${name}`,
		createIconButton: (parent: HTMLElement, _icon: string, label: string, cls: string, name: string) => parent.createEl("button", { cls, attr: { type: "button", "aria-label": label, "data-action": name } }),
		createComposerImageController: () => ({ pending: false, dispose: () => undefined, cancelAll: () => undefined }),
		saveInput: async () => { calls.push("save-input"); },
		openMemoCardDailyNote: async () => { calls.push("open-daily"); },
		runMemoActionById: async (name: string) => { calls.push(name); },
		applyRestoredDraftSelection: () => undefined, scheduleLocalDraft: () => undefined,
		cancelPendingQuickCommand: () => undefined, closeTimeBuoyPicker: () => undefined,
		clearTagIndexWarmup: () => undefined, scheduleTagIndexWarmup: () => undefined,
		syncInputState: () => undefined, syncTagIndexInteraction: () => undefined,
		handleComposerInputFocus: () => undefined, handleComposerInputBlur: () => undefined,
		focusComposerInputNow: () => undefined, syncUiChrome: () => undefined,
		syncComposerMode: () => renderComposerReferencePreview(view.referencePreviewEl, view.quoteMarkdownText, { setTooltipIfDesktopOnly: () => undefined }),
		syncRootState: () => root.classList.toggle("is-scope-open", popup.scopeMenuOpen),
		syncCardMenuState: () => { for (const card of Array.from(root.querySelectorAll<HTMLElement>(".knomo-card"))) card.classList.toggle("is-menu-open", card.getAttr("data-memo-id") === popup.activeMenuMemoId); },
		blurCardMenuButton: () => undefined,
	});
	const clearReference = view.clearReference.bind(view);
	const cancelEditing = view.cancelEditing.bind(view);
	view.clearReference = () => { calls.push("clear-reference"); clearReference(); };
	view.cancelEditing = () => { calls.push("cancel-edit"); cancelEditing(); };
	view.userActionController = view.createUserActionController();
	// 根事件注册与 View 现有入口一致；Composer 的动作监听由 renderComposer 自行注册。
	scope.registerDomEvent(root, "pointerdown", event => view.handleRootPointerDown(event as PointerEvent), { capture: true });
	scope.registerDomEvent(root, "click", event => { void view.handleRootClick(event as MouseEvent).catch(error => errors.push(error)); });
	view.renderComposer(layer);
	view.updateCancelEditButtonState();
	renderComposerReferencePreview(view.referencePreviewEl, view.quoteMarkdownText, { setTooltipIfDesktopOnly: () => undefined });
	const scopeMenu = renderKnomoScopePopover(root, "knomo-scope-popover knomo-mobile-scope-popover");
	const card = renderKnomoMemoCard(root, memo(), {
		generation: 1, renderIndex: 0, includeActions: true, randomCard: false, activeMenuMemoId: null,
		formatDisplayTime: value => value, getMarkdownPriority: () => "normal",
		getMemoCardPreview: item => ({ text: item.contentSnapshot, images: [] }),
		queueMemoMarkdown: (_item, container, _generation, _priority, text) => container.setText(text),
		renderMemoCardImages: () => undefined, queueSourceReferenceMarkdown: () => undefined,
	});
	let hitTarget: Element = root;
	// 这里只模拟命中，不能用这些矩形证明浏览器布局或设备点击高度。
	win.document.elementFromPoint = (x, y) => x >= 0 && x < 120 && y >= 0 && y < 44 ? hitTarget : root;
	for (const button of Array.from(layer.querySelectorAll("button"))) button.getBoundingClientRect = () => new win.DOMRect(0, 0, 120, 44);
	const button = layer.querySelector<HTMLButtonElement>(`[data-action='${action}']`)!;
	const dailyButton = card.querySelector<HTMLButtonElement>("[data-memo-time-open='daily']")!;
	return {
		win, root, layer, view, popup, calls, button, dailyButton, scopeMenu, card,
		snapshot: () => ({ calls: [...calls], text: view.inputEl.value, editing: view.editingMemo?.id ?? null, reference: view.quoteReferenceText, composerOpen: view.composerOpen }),
		openPopup(kind: MobilePopupKind) {
			popup.scopeMenuOpen = kind === "scope";
			popup.activeMenuMemoId = kind === "card" ? "p0-memo" : null;
		},
		pointer(target: Element, type: string, options: { id?: number; x?: number; y?: number; primary?: boolean } = {}) {
			if (type === "pointerdown") hitTarget = target;
			const event = new win.MouseEvent(type, { bubbles: true, cancelable: true, clientX: options.x ?? 20, clientY: options.y ?? 20, button: 0, buttons: type === "pointerdown" || type === "pointermove" ? 1 : 0 });
			Object.defineProperties(event, { pointerId: { value: options.id ?? 1 }, pointerType: { value: "touch" }, isPrimary: { value: options.primary ?? true } });
			target.dispatchEvent(event);
		},
		async click(target: Element, detail = 1) {
			target.dispatchEvent(new win.MouseEvent("click", { bubbles: true, cancelable: true, detail, clientX: 20, clientY: 20 }));
			await Promise.resolve();
		},
		close() {
			view.wikiLinkSuggest.destroy();
			for (const cleanup of cleanups.reverse()) cleanup();
			popup.clearSuppressNextOpenPopupDismissClick();
			dom.window.close();
			for (const [name, descriptor] of previous) {
				if (descriptor) Object.defineProperty(globalThis, name, descriptor);
				else Reflect.deleteProperty(globalThis, name);
			}
			assert.deepEqual(errors, [], "DOM 事件异常不能伪装为交互回归失败");
		},
	};
}

function memo(): MemoViewItem {
	return {
		id: "p0-memo", createdAt: "2026-10-06T12:34", updatedAt: "2026-10-06T12:34",
		contentSnapshot: mobilePopupText.editDraft, contentHash: "p0-fixture", status: "active",
		tags: [], links: [], images: [], dailyRef: { path: "Daily/2026-10-06.md", heading: null, lineNumberHint: 0 },
	};
}
