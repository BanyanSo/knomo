import { Platform, setIcon } from "obsidian";
import type { EventRef, ItemView } from "obsidian";

import { KNOMO_SIDEBAR_MENU_ICON } from "../icons";

interface MobileNavbarCompactControllerOptions {
	isActive: () => boolean;
	isComposerOpen: () => boolean;
	toggleSidebar: () => void;
	openComposer: () => void;
}

type NavbarActionKey = "back" | "forward" | "quickSwitcher" | "newTab" | "tabs" | "menu";
type WindowWithMutationObserver = Window & {
	MutationObserver?: typeof MutationObserver;
};

interface ChromeEdgeInsets {
	left: number;
	right: number;
}

type MobileNavbarSelectorKey = "navbar" | "actions" | "topLeftChrome" | "topRightChrome" | "topChrome";

const MOBILE_NAVBAR_SELECTORS: Record<MobileNavbarSelectorKey, string[]> &
	Record<NavbarActionKey, string[]> = {
	navbar: [".mobile-navbar"],
	actions: [".mobile-navbar-actions", ".mobile-navbar"],
	topLeftChrome: [
		".workspace-leaf.mod-active .view-header .view-header-nav-buttons",
		".mod-active .view-header .view-header-nav-buttons",
		".view-header .view-header-nav-buttons",
	],
	topRightChrome: [
		".workspace-leaf.mod-active .view-header .view-actions",
		".mod-active .view-header .view-actions",
		".view-header .view-actions",
	],
	topChrome: [".workspace-leaf.mod-active .view-header", ".mod-active .view-header", ".view-header"],
	back: [".mobile-navbar-action-back"],
	forward: [".mobile-navbar-action-forward"],
	quickSwitcher: [".mobile-navbar-action-quick-switcher"],
	newTab: [".mobile-navbar-action-new-tab"],
	tabs: [".mobile-navbar-action-tabs"],
	menu: [".mobile-navbar-action-menu"],
};

const HIDDEN_NATIVE_ACTIONS: NavbarActionKey[] = ["back", "forward", "newTab"];
const RETAINED_NATIVE_ACTIONS: NavbarActionKey[] = ["quickSwitcher", "tabs", "menu"];

const BODY_ACTIVE_CLASS = "knomo-mobile-navbar-compact-active";
const BODY_FLOATING_CLASS = "knomo-mobile-navbar-floating";
const BODY_FIXED_CLASS = "knomo-mobile-navbar-fixed";
const NAVBAR_COMPACT_CLASS = "knomo-mobile-navbar-compact";
const NATIVE_HIDDEN_CLASS = "knomo-mobile-navbar-hidden";
const SIDEBAR_ACTION_CLASS = "knomo-mobile-navbar-sidebar-action";
const CREATE_BUTTON_CLASS = "knomo-mobile-create-fab";
const CREATE_BUTTON_HIDDEN_CLASS = "is-hidden";
const CREATE_BUTTON_SIZE = 60;
const CREATE_BUTTON_GAP = 8;
const MIN_COLLISION_GAP = 8;
const CHROME_EDGE_FALLBACK_INSET = 8;
const CHROME_EDGE_MAX_INSET = 72;
const STABILIZED_SYNC_DELAYS = [120, 320];
const NAVBAR_EDGE_LEFT_VAR = "--knomo-mobile-navbar-edge-left";
const NAVBAR_RESERVED_RIGHT_VAR = "--knomo-mobile-navbar-reserved-right";
const CREATE_BUTTON_RIGHT_VAR = "--knomo-mobile-create-fab-right";
const CREATE_BUTTON_BOTTOM_VAR = "--knomo-mobile-create-fab-bottom";

export class MobileNavbarCompactController {
	private started = false;
	private observer: MutationObserver | null = null;
	private syncFrameId: number | null = null;
	private sidebarButtonEl: HTMLButtonElement | null = null;
	private createButtonEl: HTMLButtonElement | null = null;
	private readonly eventRefs: EventRef[] = [];
	private readonly delayedSyncTimerIds = new Map<number, number>();
	private readonly debugMessages = new Set<string>();
	private stableEdgeInsets: ChromeEdgeInsets = {
		left: CHROME_EDGE_FALLBACK_INSET,
		right: CHROME_EDGE_FALLBACK_INSET,
	};
	private stableFloatingCreateButtonBottom = CREATE_BUTTON_SIZE + CREATE_BUTTON_GAP;
	private stableFixedCreateButtonBottom = CREATE_BUTTON_SIZE + CREATE_BUTTON_GAP;

	constructor(
		private readonly view: ItemView,
		private readonly options: MobileNavbarCompactControllerOptions,
	) {}

	start(): void {
		if (this.started) {
			return;
		}
		this.started = true;
		this.eventRefs.push(this.view.app.workspace.on("active-leaf-change", () => this.queueSyncCycle()));
		this.eventRefs.push(this.view.app.workspace.on("layout-change", () => this.queueSyncCycle()));
		this.view.registerDomEvent(this.doc, "visibilitychange", () => this.queueSyncCycle());
		this.view.registerDomEvent(this.win, "resize", () => this.queueSyncCycle());
		this.view.registerDomEvent(this.win, "orientationchange", () => this.queueSyncCycle());
		this.queueSyncCycle();
	}

	stop(): void {
		if (!this.started) {
			return;
		}
		this.started = false;
		this.disconnectObserver();
		this.clearSyncFrame();
		this.clearDelayedSyncs();
		for (const eventRef of this.eventRefs) {
			this.view.app.workspace.offref(eventRef);
		}
		this.eventRefs.length = 0;
		this.disable();
	}

	sync(): void {
		if (!this.shouldEnable()) {
			this.disable();
			return;
		}

		this.ensureObserver();
		const navbarEl = this.findNavbar();
		if (navbarEl === null) {
			this.recordDebugInfo("mobile navbar not found");
			this.cleanupRenderedState();
			this.scheduleStabilizedSyncs();
			return;
		}

		const body = this.doc.body;
		const floating = this.isFloatingNavbar(navbarEl);
		const edgeInsets = this.getChromeEdgeInsets(navbarEl);
		body.addClass(BODY_ACTIVE_CLASS);
		body.toggleClass(BODY_FLOATING_CLASS, floating);
		body.toggleClass(BODY_FIXED_CLASS, !floating);
		navbarEl.addClass(NAVBAR_COMPACT_CLASS);
		this.syncNavbarPlacement(navbarEl, floating, edgeInsets);

		this.hideNativeActions(navbarEl);
		this.syncSidebarButton(navbarEl);
		this.syncCreateButton(navbarEl, floating, edgeInsets);
	}

	private get doc(): Document {
		return this.view.containerEl.doc;
	}

	private get win(): Window {
		return this.view.containerEl.win;
	}

	private shouldEnable(): boolean {
		return this.started && Platform.isMobile && this.options.isActive();
	}

	private queueSyncCycle(): void {
		this.syncSoon();
		this.scheduleStabilizedSyncs();
	}

	private syncSoon(): void {
		if (!this.started || this.syncFrameId !== null) {
			return;
		}
		this.syncFrameId = this.win.requestAnimationFrame(() => {
			this.syncFrameId = null;
			this.sync();
		});
	}

	private clearSyncFrame(): void {
		if (this.syncFrameId === null) {
			return;
		}
		this.win.cancelAnimationFrame(this.syncFrameId);
		this.syncFrameId = null;
	}

	private scheduleStabilizedSyncs(): void {
		if (!this.started) {
			return;
		}
		for (const delay of STABILIZED_SYNC_DELAYS) {
			if (this.delayedSyncTimerIds.has(delay)) {
				continue;
			}
			const timerId = this.win.setTimeout(() => {
				this.delayedSyncTimerIds.delete(delay);
				this.syncSoon();
			}, delay);
			this.delayedSyncTimerIds.set(delay, timerId);
		}
	}

	private clearDelayedSyncs(): void {
		for (const timerId of this.delayedSyncTimerIds.values()) {
			this.win.clearTimeout(timerId);
		}
		this.delayedSyncTimerIds.clear();
	}

	private ensureObserver(): void {
		if (this.observer !== null) {
			return;
		}
		const MutationObserverConstructor = (this.win as WindowWithMutationObserver).MutationObserver ?? MutationObserver;
		const observer = new MutationObserverConstructor(() => this.queueSyncCycle());
		observer.observe(this.doc.body, {
			attributes: true,
			attributeFilter: ["class", "style"],
			childList: true,
			subtree: true,
		});
		this.observer = observer;
	}

	private disconnectObserver(): void {
		this.observer?.disconnect();
		this.observer = null;
	}

	private disable(): void {
		this.disconnectObserver();
		this.clearDelayedSyncs();
		this.cleanupRenderedState();
	}

	private cleanupRenderedState(): void {
		this.removeSidebarButton();
		this.removeCreateButton();
		const body = this.doc.body;
		body.removeClass(BODY_ACTIVE_CLASS);
		body.removeClass(BODY_FLOATING_CLASS);
		body.removeClass(BODY_FIXED_CLASS);
		for (const element of body.findAll(`.${NAVBAR_COMPACT_CLASS}`)) {
			this.clearNavbarStyleProperties(element);
			element.removeClass(NAVBAR_COMPACT_CLASS);
		}
		for (const element of body.findAll(`.${NATIVE_HIDDEN_CLASS}`)) {
			element.removeClass(NATIVE_HIDDEN_CLASS);
		}
	}

	private findNavbar(): HTMLElement | null {
		return this.findElement(this.doc.body, MOBILE_NAVBAR_SELECTORS.navbar);
	}

	private findActionsContainer(navbarEl: HTMLElement): HTMLElement | null {
		return this.findElementIncludingRoot(navbarEl, MOBILE_NAVBAR_SELECTORS.actions);
	}

	private findAction(navbarEl: HTMLElement, key: NavbarActionKey): HTMLElement | null {
		return this.findElement(navbarEl, MOBILE_NAVBAR_SELECTORS[key]);
	}

	private findElement(root: ParentNode, selectors: string[]): HTMLElement | null {
		for (const selector of selectors) {
			const element = root.querySelector(selector);
			if (element?.instanceOf(HTMLElement)) {
				return element;
			}
		}
		return null;
	}

	private findElementIncludingRoot(root: HTMLElement, selectors: string[]): HTMLElement | null {
		for (const selector of selectors) {
			if (root.matches(selector)) {
				return root;
			}
			const element = root.querySelector(selector);
			if (element?.instanceOf(HTMLElement)) {
				return element;
			}
		}
		return null;
	}

	private hideNativeActions(navbarEl: HTMLElement): void {
		for (const key of HIDDEN_NATIVE_ACTIONS) {
			const actionEl = this.findAction(navbarEl, key);
			if (actionEl === null) {
				this.recordDebugInfo(`mobile navbar ${key} action not found`);
				continue;
			}
			actionEl.addClass(NATIVE_HIDDEN_CLASS);
		}
	}

	private syncSidebarButton(navbarEl: HTMLElement): void {
		const actionsEl = this.findActionsContainer(navbarEl);
		if (actionsEl === null) {
			this.recordDebugInfo("mobile navbar actions container not found");
			this.removeSidebarButton();
			return;
		}
		if (this.sidebarButtonEl === null || !this.sidebarButtonEl.isConnected) {
			this.removeSidebarButton();
			this.sidebarButtonEl = actionsEl.createEl("button", {
				cls: `mobile-navbar-action clickable-icon ${SIDEBAR_ACTION_CLASS}`,
				attr: {
					type: "button",
					title: "打开或收起 Knomo 侧栏",
					"aria-label": "打开或收起 Knomo 侧栏",
				},
			});
			setIcon(this.sidebarButtonEl, KNOMO_SIDEBAR_MENU_ICON);
			this.sidebarButtonEl.addEventListener("click", this.handleSidebarButtonClick);
		}
		for (const duplicate of this.doc.body.findAll(`.${SIDEBAR_ACTION_CLASS}`)) {
			if (duplicate !== this.sidebarButtonEl) {
				duplicate.remove();
			}
		}
		this.moveSidebarButtonToFirstVisiblePosition(actionsEl, navbarEl);
	}

	private moveSidebarButtonToFirstVisiblePosition(actionsEl: HTMLElement, navbarEl: HTMLElement): void {
		if (this.sidebarButtonEl === null) {
			return;
		}
		const firstRetainedAction = RETAINED_NATIVE_ACTIONS
			.map((key) => this.findAction(navbarEl, key))
			.find((element): element is HTMLElement => element !== null && actionsEl.contains(element)) ?? null;
		if (firstRetainedAction !== null) {
			if (this.sidebarButtonEl.nextSibling !== firstRetainedAction) {
				actionsEl.insertBefore(this.sidebarButtonEl, firstRetainedAction);
			}
			return;
		}
		if (actionsEl.firstChild !== this.sidebarButtonEl) {
			actionsEl.insertBefore(this.sidebarButtonEl, actionsEl.firstChild);
		}
	}

	private removeSidebarButton(): void {
		this.sidebarButtonEl?.removeEventListener("click", this.handleSidebarButtonClick);
		this.sidebarButtonEl?.remove();
		this.sidebarButtonEl = null;
		for (const element of this.doc.body.findAll(`.${SIDEBAR_ACTION_CLASS}`)) {
			element.remove();
		}
	}

	private syncCreateButton(navbarEl: HTMLElement, floating: boolean, edgeInsets: ChromeEdgeInsets): void {
		if (this.createButtonEl === null || !this.createButtonEl.isConnected) {
			this.removeCreateButton();
			this.createButtonEl = this.view.containerEl.createEl("button", {
				cls: CREATE_BUTTON_CLASS,
				attr: {
					type: "button",
					title: "新建 memo",
					"aria-label": "新建 memo",
				},
			});
			setIcon(this.createButtonEl, "plus");
			this.createButtonEl.addEventListener("click", this.handleCreateButtonClick);
		}
		if (this.createButtonEl.parentElement !== this.view.containerEl) {
			this.view.containerEl.appendChild(this.createButtonEl);
		}
		for (const duplicate of this.doc.body.findAll(`.${CREATE_BUTTON_CLASS}`)) {
			if (duplicate !== this.createButtonEl) {
				duplicate.remove();
			}
		}
		this.positionCreateButton(navbarEl, floating, edgeInsets);
		const hidden = this.options.isComposerOpen();
		this.createButtonEl.toggleClass(CREATE_BUTTON_HIDDEN_CLASS, hidden);
		this.createButtonEl.setAttr("aria-hidden", hidden ? "true" : "false");
	}

	private positionCreateButton(navbarEl: HTMLElement, floating: boolean, edgeInsets: ChromeEdgeInsets): void {
		if (this.createButtonEl === null) {
			return;
		}
		const bottom = floating ? this.getFloatingCreateButtonBottom(navbarEl) : this.getFixedCreateButtonBottom(navbarEl);
		this.setStyleProperty(this.createButtonEl, CREATE_BUTTON_RIGHT_VAR, `${edgeInsets.right}px`);
		this.setStyleProperty(this.createButtonEl, CREATE_BUTTON_BOTTOM_VAR, `${bottom}px`);
	}

	private getFloatingCreateButtonBottom(navbarEl: HTMLElement): number {
		const rect = navbarEl.getBoundingClientRect();
		if (this.isBottomNavbarRect(rect)) {
			const centerY = rect.top + rect.height / 2;
			const bottom = Math.round(this.win.innerHeight - centerY - CREATE_BUTTON_SIZE / 2);
			if (this.isUsableCreateButtonBottom(bottom)) {
				this.stableFloatingCreateButtonBottom = bottom;
			}
		}
		return this.stableFloatingCreateButtonBottom;
	}

	private getFixedCreateButtonBottom(navbarEl: HTMLElement): number {
		const rect = navbarEl.getBoundingClientRect();
		if (this.isBottomNavbarRect(rect)) {
			const bottom = Math.round(this.win.innerHeight - rect.top + CREATE_BUTTON_GAP);
			if (this.isUsableCreateButtonBottom(bottom)) {
				this.stableFixedCreateButtonBottom = bottom;
			}
		}
		return this.stableFixedCreateButtonBottom;
	}

	private isBottomNavbarRect(rect: DOMRect): boolean {
		return (
			rect.width > 0 &&
			rect.height > 0 &&
			rect.top > this.win.innerHeight * 0.55 &&
			rect.bottom <= this.win.innerHeight + 24 &&
			rect.left >= -24 &&
			rect.right <= this.win.innerWidth + 24
		);
	}

	private isUsableCreateButtonBottom(bottom: number): boolean {
		return Number.isFinite(bottom) && bottom >= CHROME_EDGE_FALLBACK_INSET && bottom <= this.win.innerHeight / 2;
	}

	private syncNavbarPlacement(navbarEl: HTMLElement, floating: boolean, edgeInsets: ChromeEdgeInsets): void {
		if (!floating) {
			this.clearNavbarStyleProperties(navbarEl);
			return;
		}
		this.setStyleProperty(navbarEl, NAVBAR_EDGE_LEFT_VAR, `${edgeInsets.left}px`);
		this.setStyleProperty(
			navbarEl,
			NAVBAR_RESERVED_RIGHT_VAR,
			`${edgeInsets.right + CREATE_BUTTON_SIZE + MIN_COLLISION_GAP}px`,
		);
	}

	private getChromeEdgeInsets(navbarEl: HTMLElement): ChromeEdgeInsets {
		const measuredEdgeInsets = this.measureChromeEdgeInsets(navbarEl);
		if (measuredEdgeInsets !== null) {
			this.stableEdgeInsets = measuredEdgeInsets;
		}
		return this.stableEdgeInsets;
	}

	private measureChromeEdgeInsets(navbarEl: HTMLElement): ChromeEdgeInsets | null {
		const leftInset = this.measureChromeInset(MOBILE_NAVBAR_SELECTORS.topLeftChrome, "left");
		const rightInset = this.measureChromeInset(MOBILE_NAVBAR_SELECTORS.topRightChrome, "right");
		if (leftInset !== null || rightInset !== null) {
			return {
				left: leftInset ?? this.stableEdgeInsets.left,
				right: rightInset ?? this.stableEdgeInsets.right,
			};
		}

		const topChromeEl = this.findElement(this.doc.body, MOBILE_NAVBAR_SELECTORS.topChrome);
		const topChromeRect = topChromeEl?.getBoundingClientRect();
		if (topChromeRect !== undefined && this.isUsableChromeRect(topChromeRect)) {
			const topChromeLeftInset = Math.round(topChromeRect.left);
			const topChromeRightInset = Math.round(this.win.innerWidth - topChromeRect.right);
			if (this.isUsableChromeInset(topChromeLeftInset) && this.isUsableChromeInset(topChromeRightInset)) {
				return {
					left: topChromeLeftInset,
					right: topChromeRightInset,
				};
			}
		}

		const navbarRect = navbarEl.getBoundingClientRect();
		if (this.isUsableChromeRect(navbarRect)) {
			const navbarLeftInset = Math.round(navbarRect.left);
			if (this.isUsableChromeInset(navbarLeftInset)) {
				return {
					left: navbarLeftInset,
					right: this.stableEdgeInsets.right,
				};
			}
		}

		return null;
	}

	private measureChromeInset(selectors: string[], side: "left" | "right"): number | null {
		const element = this.findElement(this.doc.body, selectors);
		const rect = element?.getBoundingClientRect();
		if (rect === undefined || !this.isUsableChromeRect(rect)) {
			return null;
		}
		const inset = side === "left" ? Math.round(rect.left) : Math.round(this.win.innerWidth - rect.right);
		if (!this.isUsableChromeInset(inset)) {
			return null;
		}
		return inset;
	}

	private isUsableChromeRect(rect: DOMRect): boolean {
		return (
			rect.width > 0 &&
			rect.height > 0 &&
			rect.top >= -24 &&
			rect.top < this.win.innerHeight / 2 &&
			rect.left >= 0 &&
			rect.right <= this.win.innerWidth
		);
	}

	private isUsableChromeInset(inset: number): boolean {
		return (
			Number.isFinite(inset) &&
			inset >= CHROME_EDGE_FALLBACK_INSET &&
			inset <= Math.min(CHROME_EDGE_MAX_INSET, this.win.innerWidth / 4)
		);
	}

	private setStyleProperty(element: HTMLElement, name: string, value: string): void {
		if (element.style.getPropertyValue(name) !== value) {
			element.style.setProperty(name, value);
		}
	}

	private clearNavbarStyleProperties(element: HTMLElement): void {
		element.style.removeProperty(NAVBAR_EDGE_LEFT_VAR);
		element.style.removeProperty(NAVBAR_RESERVED_RIGHT_VAR);
	}

	private removeCreateButton(): void {
		this.createButtonEl?.removeEventListener("click", this.handleCreateButtonClick);
		this.createButtonEl?.remove();
		this.createButtonEl = null;
		for (const element of this.doc.body.findAll(`.${CREATE_BUTTON_CLASS}`)) {
			element.remove();
		}
	}

	private isFloatingNavbar(navbarEl: HTMLElement): boolean {
		return this.doc.body.hasClass("is-floating-nav") || navbarEl.hasClass("is-floating-nav");
	}

	private readonly handleSidebarButtonClick = (event: MouseEvent): void => {
		event.preventDefault();
		event.stopPropagation();
		this.options.toggleSidebar();
		this.queueSyncCycle();
	};

	private readonly handleCreateButtonClick = (event: MouseEvent): void => {
		event.preventDefault();
		event.stopPropagation();
		this.options.openComposer();
		this.queueSyncCycle();
	};

	private recordDebugInfo(message: string): void {
		this.debugMessages.add(message);
	}

	static cleanupDocument(doc: Document): void {
		const body = doc.body;
		body.removeClass(BODY_ACTIVE_CLASS);
		body.removeClass(BODY_FLOATING_CLASS);
		body.removeClass(BODY_FIXED_CLASS);
		for (const element of body.findAll(`.${SIDEBAR_ACTION_CLASS}, .${CREATE_BUTTON_CLASS}`)) {
			element.remove();
		}
		for (const element of body.findAll(`.${NAVBAR_COMPACT_CLASS}`)) {
			element.style.removeProperty(NAVBAR_EDGE_LEFT_VAR);
			element.style.removeProperty(NAVBAR_RESERVED_RIGHT_VAR);
			element.removeClass(NAVBAR_COMPACT_CLASS);
		}
		for (const element of body.findAll(`.${NATIVE_HIDDEN_CLASS}`)) {
			element.removeClass(NATIVE_HIDDEN_CLASS);
		}
	}
}
