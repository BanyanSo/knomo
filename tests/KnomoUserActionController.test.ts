import test from "node:test";
import assert from "node:assert/strict";

import type { KnomoSimpleAction } from "../src/ui/KnomoActionDispatch";
import { KnomoUserActionController, type EscapeState } from "../src/ui/KnomoUserActionController";

test("root click dispatches search date filters to desktop or mobile search", async () => {
	const cleanup = installDomGlobals();
	try {
		const desktop = createHarness();
		await desktop.controller.handleRootClick(createMouseEvent(new TestElement("button", {
			attr: { "data-search-date": "week" },
		})));
		assert.deepEqual(desktop.calls, ["desktop-date:week"]);

		const mobile = createHarness({
			mobile: true,
			mobileSearchPageOpen: true,
		});
		await mobile.controller.handleRootClick(createMouseEvent(new TestElement("button", {
			attr: { "data-search-date": "month" },
		})));
		assert.deepEqual(mobile.calls, ["mobile-date:month"]);
	} finally {
		cleanup();
	}
});

test("root click preserves popup interception except sidebar layer actions", async () => {
	const cleanup = installDomGlobals();
	try {
		const suppressed = createHarness({ consumeSuppressed: true });
		await suppressed.controller.handleRootClick(createMouseEvent(new TestElement("button", {
			attr: { "data-action": "refresh" },
		})));
		assert.deepEqual(suppressed.calls, ["consume-popup"]);

		const outsideHandled = createHarness({ outsideHandled: true });
		await outsideHandled.controller.handleRootClick(createMouseEvent(new TestElement("button", {
			attr: { "data-action": "refresh" },
		})));
		assert.deepEqual(outsideHandled.calls, ["outside-popup:false"]);

		const drawer = createHarness({ consumeSuppressed: true, outsideHandled: true });
		await drawer.controller.handleRootClick(createMouseEvent(new TestElement("button", {
			attr: { "data-action": "open-drawer" },
		})));
		assert.deepEqual(drawer.calls, ["open-drawer", "defer-sidebar", "sync-chrome", "sync-card-menu"]);

		const sidebarToggle = createHarness({ outsideHandled: true });
		await sidebarToggle.controller.handleRootClick(createMouseEvent(new TestElement("button", {
			attr: { "data-action": "toggle-sidebar" },
		})));
		assert.deepEqual(sidebarToggle.calls, ["toggle-sidebar", "sync-chrome", "sync-card-menu"]);
	} finally {
		cleanup();
	}
});

test("sidebar layer interactions keep underlying popup chrome open", async () => {
	const cleanup = installDomGlobals();
	try {
		const closeDrawer = createHarness({ consumeSuppressed: true, outsideHandled: true });
		await closeDrawer.controller.handleRootClick(createMouseEvent(new TestElement("button", {
			attr: { "data-action": "close-drawer" },
		})));
		assert.deepEqual(closeDrawer.calls, ["close-drawer", "sync-chrome", "sync-card-menu"]);

		const drawerSidebar = createHarness({ drawerOpen: true, outsideHandled: true });
		const sidebar = new TestElement("aside", { cls: "knomo-sidebar" });
		const blankSidebarTarget = sidebar.createChild("div");
		await drawerSidebar.controller.handleRootClick(createMouseEvent(blankSidebarTarget));
		assert.deepEqual(drawerSidebar.calls, []);

		const drawerBackdrop = createHarness({ drawerOpen: true, outsideHandled: true });
		await drawerBackdrop.controller.handleRootClick(createMouseEvent(new TestElement("div", {
			cls: "knomo-drawer-backdrop",
		})));
		assert.deepEqual(drawerBackdrop.calls, []);
	} finally {
		cleanup();
	}
});

test("root click routes memo, trash, and generic actions", async () => {
	const cleanup = installDomGlobals();
	try {
		const actions = createHarness();
		await actions.controller.handleRootClick(createMouseEvent(new TestElement("button", {
			attr: { "data-memo-action": "edit", "data-memo-id": "memo-1" },
		})));
		await actions.controller.handleRootClick(createMouseEvent(new TestElement("button", {
			attr: { "data-trash-action": "restore", "data-memo-id": "memo-2" },
		})));
		await actions.controller.handleRootClick(createMouseEvent(new TestElement("button", {
			attr: { "data-action": "record-stats-filter-tag" },
		})));
		assert.deepEqual(actions.calls, [
			"memo:edit:memo-1",
			"trash:restore:memo-2",
			"record-tag",
		]);
	} finally {
		cleanup();
	}
});

test("mobile pointer down only intercepts popups on mobile layout", () => {
	const cleanup = installDomGlobals();
	try {
		const desktop = createHarness();
		desktop.controller.handleRootPointerDown(createPointerEvent(new TestElement("button")));
		assert.deepEqual(desktop.calls, []);

		const mobile = createHarness({ mobile: true });
		mobile.controller.handleRootPointerDown(createPointerEvent(new TestElement("button")));
		assert.deepEqual(mobile.calls, ["outside-popup:true"]);

		const mobileDrawerAction = createHarness({ mobile: true });
		mobileDrawerAction.controller.handleRootPointerDown(createPointerEvent(new TestElement("button", {
			attr: { "data-action": "open-drawer" },
		})));
		assert.deepEqual(mobileDrawerAction.calls, []);

		const mobileOpenDrawer = createHarness({ mobile: true, drawerOpen: true });
		const sidebar = new TestElement("aside", { cls: "knomo-sidebar" });
		mobileOpenDrawer.controller.handleRootPointerDown(createPointerEvent(sidebar.createChild("div")));
		assert.deepEqual(mobileOpenDrawer.calls, []);
	} finally {
		cleanup();
	}
});

test("Escape key keeps the legacy close priority", async () => {
	const cleanup = installDomGlobals();
	try {
		const mobileSearch = createHarness({
			escapeState: {
				mobileSearchPageOpen: true,
				composerOpen: true,
				editingOrQuoting: true,
				hasOpenChrome: true,
			},
		});
		const mobileSearchEvent = createKeyboardEvent("Escape");
		await mobileSearch.controller.handleRootKeydown(mobileSearchEvent);
		assert.deepEqual(mobileSearch.calls, ["close-mobile-search"]);
		assert.equal(mobileSearchEvent.defaultPrevented, true);

		const composer = createHarness({
			escapeState: {
				mobileSearchPageOpen: false,
				composerOpen: true,
				editingOrQuoting: true,
				hasOpenChrome: true,
			},
		});
		await composer.controller.handleRootKeydown(createKeyboardEvent("Escape"));
		assert.deepEqual(composer.calls, ["close-composer-draft"]);

		const editing = createHarness({
			escapeState: {
				mobileSearchPageOpen: false,
				composerOpen: false,
				editingOrQuoting: true,
				hasOpenChrome: true,
			},
		});
		await editing.controller.handleRootKeydown(createKeyboardEvent("Escape"));
		assert.deepEqual(editing.calls, ["cancel-editing-or-close"]);

		const chrome = createHarness({
			escapeState: {
				mobileSearchPageOpen: false,
				composerOpen: false,
				editingOrQuoting: false,
				hasOpenChrome: true,
			},
		});
		await chrome.controller.handleRootKeydown(createKeyboardEvent("Escape"));
		assert.deepEqual(chrome.calls, ["close-open-chrome"]);
	} finally {
		cleanup();
	}
});

test("keyboard opens memo cards and shortcut toggles the sidebar", async () => {
	const cleanup = installDomGlobals();
	try {
		const harness = createHarness();
		const timeButton = new TestElement("button", {
			attr: { "data-memo-time-open": "daily", "data-memo-id": "memo-1", "data-random-reunion-card": "true" },
		});
		const enterEvent = createKeyboardEvent("Enter", timeButton);
		await harness.controller.handleRootKeydown(enterEvent);
		assert.deepEqual(harness.calls, ["open-memo:memo-1:true"]);
		assert.equal(enterEvent.defaultPrevented, true);

		await harness.controller.handleRootKeydown(createKeyboardEvent("\\", new TestElement("button"), { ctrlKey: true }));
		assert.deepEqual(harness.calls, ["open-memo:memo-1:true", "toggle-sidebar"]);
	} finally {
		cleanup();
	}
});

test("handleAction dispatches every simple action to the expected view callbacks", async () => {
	const expectations: Record<KnomoSimpleAction, ActionExpectation> = {
		"toggle-card-menu": {
			memoId: "memo-1",
			expected: ["toggle-card:memo-1"],
		},
		"refresh-random-reunion": {
			expected: ["refresh-random"],
		},
		"load-more": {
			expected: ["hydrate"],
		},
		"load-more-mobile-search": {
			expected: ["load-more-mobile-search"],
		},
		"reset-list-state": {
			expected: ["reset-list"],
		},
		"close-mobile-search": {
			expected: ["close-mobile-search"],
		},
		"open-drawer": {
			overrides: { composerOpen: true },
			expected: ["close-composer-draft", "open-drawer", "defer-sidebar", "sync-chrome", "sync-card-menu"],
		},
		"close-drawer": {
			expected: ["close-drawer", "sync-chrome", "sync-card-menu"],
		},
		"toggle-scope-menu": {
			expected: ["toggle-scope", "sync-chrome", "sync-card-menu"],
		},
		"toggle-sidebar": {
			expected: ["toggle-sidebar", "sync-chrome", "sync-card-menu"],
		},
		"collapse-sidebar": {
			expected: ["collapse-sidebar", "sync-chrome", "sync-card-menu"],
		},
		refresh: {
			expected: ["refresh"],
		},
		"focus-stats": {
			expected: ["focus-stats", "sync-chrome", "sync-card-menu"],
		},
		"record-stats-back": {
			expected: ["record-back"],
		},
		"record-stats-previous": {
			expected: ["record-prev"],
		},
		"record-stats-next": {
			expected: ["record-next"],
		},
		"record-stats-retry": {
			expected: ["record-retry"],
		},
		"retry-time-buoy": {
			expected: ["time-buoy-retry"],
		},
		"rebuild-time-buoy": {
			expected: ["time-buoy-rebuild"],
		},
		"cancel-time-buoy-rebuild": {
			expected: ["time-buoy-cancel-rebuild"],
		},
		"time-buoy-tab-today": {
			expected: ["time-buoy-tab:today"],
		},
		"time-buoy-tab-upcoming": {
			expected: ["time-buoy-tab:upcoming"],
		},
		"time-buoy-tab-past": {
			expected: ["time-buoy-tab:past"],
		},
		"load-more-time-buoy-cards": {
			expected: ["time-buoy-more-cards"],
		},
		"open-time-buoy": {
			expected: ["time-buoy-open"],
		},
		"enable-time-buoy-intro": {
			expected: ["time-buoy-intro-enable"],
		},
		"dismiss-time-buoy-intro": {
			expected: ["time-buoy-intro-dismiss"],
		},
		"retry-all-memos": {
			overrides: { deferAllMemos: true },
			expected: ["all-memos-loading", "ensure-all-memos"],
		},
		"record-stats-view-week": {
			expected: ["record-view:week"],
		},
		"record-stats-view-month": {
			expected: ["record-view:month"],
		},
		"record-stats-view-year": {
			expected: ["record-view:year"],
		},
		"record-stats-filter-trend": {
			expected: ["record-trend"],
		},
		"record-stats-filter-hour": {
			expected: ["record-hour"],
		},
		"record-stats-filter-notes": {
			expected: ["record-metric:range"],
		},
		"record-stats-filter-with-tag": {
			expected: ["record-metric:with-tag"],
		},
		"record-stats-filter-no-tag": {
			expected: ["record-metric:no-tag"],
		},
		"record-stats-filter-with-image": {
			expected: ["record-metric:with-image"],
		},
		"record-stats-filter-tag": {
			expected: ["record-tag"],
		},
		"record-stats-filter-references": {
			expected: ["record-metric:references"],
		},
		"record-stats-filter-max-daily-notes": {
			expected: ["record-metric:max-daily-notes"],
		},
		"record-stats-filter-max-daily-words": {
			expected: ["record-metric:max-daily-words"],
		},
		"open-composer": {
			expected: ["open-composer"],
		},
		"close-composer": {
			expected: ["close-composer-confirm"],
		},
		"toggle-compact-search": {
			expected: ["toggle-compact", "sync-chrome", "sync-card-menu"],
		},
		"clear-reference": {
			expected: ["clear-reference"],
		},
		"cancel-edit": {
			expected: ["cancel-edit"],
		},
		"save-input": {
			expected: ["save-input"],
		},
	};

	for (const [action, expectation] of Object.entries(expectations) as Array<[KnomoSimpleAction, ActionExpectation]>) {
		const harness = createHarness(expectation.overrides);
		await harness.controller.handleAction(action, expectation.memoId ?? null, new TestElement("button").asElement() as HTMLElement);
		assert.deepEqual(harness.calls, expectation.expected, action);
	}
});

test("handleAction covers guarded and fallback action branches", async () => {
	const loadMore = createHarness({ cardFlowHasMore: true });
	await loadMore.controller.handleAction("load-more", null);
	assert.deepEqual(loadMore.calls, ["next-batch:7"]);

	const retryAllMemosBlocked = createHarness({ deferAllMemos: false });
	await retryAllMemosBlocked.controller.handleAction("retry-all-memos", null);
	assert.deepEqual(retryAllMemosBlocked.calls, []);

	const ignoredSave = createHarness({ ignoreMobileSave: true });
	await ignoredSave.controller.handleAction("save-input", null);
	assert.deepEqual(ignoredSave.calls, []);

	const handledComposerTool = createHarness({ composerToolHandled: true });
	await handledComposerTool.controller.handleAction("insert-tag", null);
	assert.deepEqual(handledComposerTool.calls, ["composer-tool:insert-tag"]);

	const fallbackComposerTool = createHarness({ composerToolHandled: false });
	await fallbackComposerTool.controller.handleAction("insert-image", null);
	assert.deepEqual(fallbackComposerTool.calls, ["composer-tool:insert-image"]);

	const unknown = createHarness();
	await unknown.controller.handleAction("not-a-knomo-action", null);
	assert.deepEqual(unknown.calls, ["render-ui"]);

	const none = createHarness();
	await none.controller.handleAction(null, null);
	assert.deepEqual(none.calls, []);
});

interface HarnessState {
	mobile: boolean;
	mobileSearchPageOpen: boolean;
	composerOpen: boolean;
	drawerOpen: boolean;
	cardFlowHasMore: boolean;
	deferAllMemos: boolean;
	ignoreMobileSave: boolean;
	composerToolHandled: boolean;
	consumeSuppressed: boolean;
	outsideHandled: boolean;
	escapeState: EscapeState;
}

interface ActionExpectation {
	memoId?: string | null;
	overrides?: Partial<HarnessState>;
	expected: string[];
}

function createHarness(overrides: Partial<HarnessState> = {}): {
	controller: KnomoUserActionController;
	calls: string[];
} {
	const calls: string[] = [];
	const state: HarnessState = {
		mobile: false,
		mobileSearchPageOpen: false,
		composerOpen: false,
		drawerOpen: false,
		cardFlowHasMore: false,
		deferAllMemos: false,
		ignoreMobileSave: false,
		composerToolHandled: true,
		consumeSuppressed: false,
		outsideHandled: false,
		escapeState: {
			mobileSearchPageOpen: false,
			composerOpen: false,
			editingOrQuoting: false,
			hasOpenChrome: false,
		},
		...overrides,
	};
	return {
		calls,
		controller: new KnomoUserActionController({
			isMobileLayout: () => state.mobile,
			isMobileSearchPageOpen: () => state.mobileSearchPageOpen,
			isComposerOpen: () => state.composerOpen,
			isDrawerOpen: () => state.drawerOpen,
			getRenderGeneration: () => 7,
			hasMoreCardFlowItems: () => state.cardFlowHasMore,
			shouldDeferCardFlowForAllMemos: () => state.deferAllMemos,
			shouldIgnoreMobileSaveInput: () => state.ignoreMobileSave,
			getEscapeState: () => state.escapeState,
			consumeSuppressedOpenPopupDismissClick: () => {
				if (state.consumeSuppressed) {
					calls.push("consume-popup");
					return true;
				}
				return false;
			},
			handleOpenPopupOutsideEvent: (_event, _target, suppressFollowingClick) => {
				if (state.outsideHandled || suppressFollowingClick) {
					calls.push(`outside-popup:${String(suppressFollowingClick)}`);
					return state.outsideHandled;
				}
				return false;
			},
			handleCardImageClick: () => calls.push("image"),
			toggleTagGroup: (tag) => calls.push(`tag-toggle:${tag}`),
			applyTagFilter: (tag, tagKey) => calls.push(`tag:${tag}:${tagKey}`),
			setSidebarNav: (nav) => calls.push(`nav:${nav}`),
			setTitleMode: (mode) => calls.push(`title:${mode}`),
			setSearchDateFilter: (filter) => calls.push(`desktop-date:${filter}`),
			setMobileSearchDateFilter: (filter) => calls.push(`mobile-date:${filter}`),
			runTrashAction: async (action, memoId) => {
				calls.push(`trash:${action}:${memoId ?? ""}`);
			},
			runMemoAction: async (action, memoId) => {
				calls.push(`memo:${action}:${memoId ?? ""}`);
			},
			shouldIgnoreHandledMobileToolClick: () => false,
			openMemoCardDailyNote: async (memoId, randomReunion) => {
				calls.push(`open-memo:${memoId}:${String(randomReunion)}`);
			},
			closeCardMenu: () => calls.push("close-card"),
			closeScopeMenu: () => calls.push("close-scope"),
			closeDesktopSearch: () => calls.push("close-desktop-search"),
			closeCompactSearch: () => calls.push("close-compact-search"),
			toggleCardMenu: (memoId) => calls.push(`toggle-card:${memoId ?? ""}`),
			refreshRandomReunion: async () => {
				calls.push("refresh-random");
			},
			renderNextCardBatch: (generation) => calls.push(`next-batch:${generation}`),
			requestCardFlowHydration: () => calls.push("hydrate"),
			loadMoreMobileSearchResults: () => calls.push("load-more-mobile-search"),
			resetToAllNotes: () => calls.push("reset-list"),
			closeMobileSearchPage: () => calls.push("close-mobile-search"),
			closeComposerKeepingDraft: () => calls.push("close-composer-draft"),
			openDrawer: () => calls.push("open-drawer"),
			closeDrawer: () => calls.push("close-drawer"),
			deferSidebarHydration: () => calls.push("defer-sidebar"),
			toggleScopeMenu: () => calls.push("toggle-scope"),
			toggleSidebar: () => calls.push("toggle-sidebar"),
			collapseSidebar: () => calls.push("collapse-sidebar"),
			handleManualRefresh: async () => {
				calls.push("refresh");
			},
			focusStats: () => calls.push("focus-stats"),
			returnFromRecordStats: () => calls.push("record-back"),
			goToPreviousRecordStatsPeriod: () => calls.push("record-prev"),
			goToNextRecordStatsPeriod: () => calls.push("record-next"),
			retryRecordStats: async () => {
				calls.push("record-retry");
			},
			retryTimeBuoy: async () => {
				calls.push("time-buoy-retry");
			},
			rebuildTimeBuoy: async () => {
				calls.push("time-buoy-rebuild");
			},
			cancelTimeBuoyRebuild: () => calls.push("time-buoy-cancel-rebuild"),
			setTimeBuoyTab: (tab) => calls.push(`time-buoy-tab:${tab}`),
			loadMoreTimeBuoyCards: () => calls.push("time-buoy-more-cards"),
			openTimeBuoy: () => calls.push("time-buoy-open"),
			enableTimeBuoyIntro: async () => {
				calls.push("time-buoy-intro-enable");
			},
			dismissTimeBuoyIntro: async () => {
				calls.push("time-buoy-intro-dismiss");
			},
			renderAllMemosLoadingState: () => calls.push("all-memos-loading"),
			ensureAllMemosLoaded: async () => {
				calls.push("ensure-all-memos");
			},
			setRecordStatsView: (view) => calls.push(`record-view:${view}`),
			openRecordStatsTrendFilter: () => calls.push("record-trend"),
			openRecordStatsHourFilter: () => calls.push("record-hour"),
			openRecordStatsMetricFilter: (type) => calls.push(`record-metric:${type}`),
			openRecordStatsTagFilter: () => calls.push("record-tag"),
			openComposer: () => calls.push("open-composer"),
			closeComposerWithConfirm: () => calls.push("close-composer-confirm"),
			toggleCompactSearch: () => calls.push("toggle-compact"),
			runComposerToolAction: (action) => {
				calls.push(`composer-tool:${action}`);
				return state.composerToolHandled;
			},
			clearReference: () => calls.push("clear-reference"),
			cancelEditing: () => calls.push("cancel-edit"),
			saveInput: async () => {
				calls.push("save-input");
			},
			renderUiState: () => calls.push("render-ui"),
			syncUiChrome: () => calls.push("sync-chrome"),
			syncCardMenuState: () => calls.push("sync-card-menu"),
			cancelEditingOrCloseComposer: () => calls.push("cancel-editing-or-close"),
			closeOpenChromeFromEscape: () => calls.push("close-open-chrome"),
		}),
	};
}

function createMouseEvent(target: TestElement): MouseEvent {
	return createEvent(target) as MouseEvent;
}

function createPointerEvent(target: TestElement): PointerEvent {
	return createEvent(target) as PointerEvent;
}

function createKeyboardEvent(
	key: string,
	target = new TestElement("button"),
	options: { ctrlKey?: boolean; metaKey?: boolean } = {},
): KeyboardEvent & { defaultPrevented: boolean } {
	return Object.assign(createEvent(target), {
		key,
		ctrlKey: options.ctrlKey ?? false,
		metaKey: options.metaKey ?? false,
	}) as KeyboardEvent & { defaultPrevented: boolean };
}

function createEvent(target: TestElement): Event & { defaultPrevented: boolean } {
	const event = {
		target: target.asElement(),
		defaultPrevented: false,
		preventDefault() {
			event.defaultPrevented = true;
		},
		stopPropagation() {},
		stopImmediatePropagation() {},
	};
	return event as unknown as Event & { defaultPrevented: boolean };
}

function installDomGlobals(): () => void {
	const globals = globalThis as unknown as { Element?: unknown; HTMLElement?: unknown };
	const previousElement = globals.Element;
	const previousHTMLElement = globals.HTMLElement;
	globals.Element = TestElement;
	globals.HTMLElement = TestElement;
	return () => {
		globals.Element = previousElement;
		globals.HTMLElement = previousHTMLElement;
	};
}

interface CreateElementOptions {
	cls?: string;
	attr?: Record<string, string>;
}

class TestElement {
	private readonly attrs = new Map<string, string>();
	private readonly classes = new Set<string>();
	private readonly children: TestElement[] = [];

	constructor(
		private readonly tagName: string,
		options: CreateElementOptions = {},
		private readonly parent: TestElement | null = null,
	) {
		for (const [key, value] of Object.entries(options.attr ?? {})) {
			this.setAttr(key, value);
		}
		if (options.cls !== undefined) {
			for (const cls of options.cls.split(/\s+/)) {
				if (cls.length > 0) {
					this.classes.add(cls);
				}
			}
		}
		this.parent?.children.push(this);
	}

	asElement(): Element {
		return this as unknown as Element;
	}

	createChild(tagName: string, options: CreateElementOptions = {}): TestElement {
		return new TestElement(tagName, options, this);
	}

	closest(selector: string): TestElement | null {
		let current: TestElement | null = this;
		while (current !== null) {
			if (selector.split(",").some((part) => current?.matches(part.trim()) === true)) {
				return current;
			}
			current = current.parent;
		}
		return null;
	}

	instanceOf(constructor: unknown): boolean {
		return typeof constructor === "function" && this instanceof constructor;
	}

	getAttr(key: string): string | null {
		return this.attrs.get(key) ?? null;
	}

	setAttr(key: string, value: string): void {
		this.attrs.set(key, value);
	}

	blur(): void {}

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
