interface OpenPopupOutsideEventResult {
	handled: boolean;
	closedMemoId: string | null;
	closedScopeMenu: boolean;
}

export class KnomoPopupState {
	private cardMenuMemoId: string | null = null;
	private scopeOpen = false;
	private suppressNextDismissClick = false;
	private suppressNextDismissClickTimerId: number | null = null;

	constructor(private readonly getWindow: () => Window) {}

	get activeMenuMemoId(): string | null {
		return this.cardMenuMemoId;
	}

	set activeMenuMemoId(memoId: string | null) {
		this.cardMenuMemoId = memoId;
	}

	get scopeMenuOpen(): boolean {
		return this.scopeOpen;
	}

	set scopeMenuOpen(open: boolean) {
		this.scopeOpen = open;
	}

	get suppressNextOpenPopupDismissClick(): boolean {
		return this.suppressNextDismissClick;
	}

	hasOpenPopup(): boolean {
		return this.cardMenuMemoId !== null || this.scopeOpen;
	}

	closeCardMenu(): string | null {
		if (this.cardMenuMemoId === null) {
			return null;
		}
		const memoId = this.cardMenuMemoId;
		this.cardMenuMemoId = null;
		return memoId;
	}

	closeOpenPopups(): { closedMemoId: string | null; closedScopeMenu: boolean } {
		const closedScopeMenu = this.scopeOpen;
		const closedMemoId = this.closeCardMenu();
		this.scopeOpen = false;
		return { closedMemoId, closedScopeMenu };
	}

	handleOpenPopupOutsideEvent(event: Event, target: EventTarget | null, suppressFollowingClick: boolean): OpenPopupOutsideEventResult {
		const element = this.getEventElement(target);
		if (element === null || !this.hasOpenPopup() || this.isTargetInOpenPopup(element)) {
			return { handled: false, closedMemoId: null, closedScopeMenu: false };
		}
		const result = this.closeOpenPopups();
		if (suppressFollowingClick) {
			this.markSuppressNextOpenPopupDismissClick();
		}
		if (!this.shouldPreserveDefaultForPopupDismiss(element)) {
			event.preventDefault();
		}
		event.stopPropagation();
		return { handled: true, ...result };
	}

	consumeSuppressedOpenPopupDismissClick(event: Event): boolean {
		if (!this.suppressNextDismissClick) {
			return false;
		}
		this.clearSuppressNextOpenPopupDismissClick();
		const target = this.getEventElement(event.target);
		const memoTimeButton = target?.closest("[data-memo-time-open='daily']");
		if (memoTimeButton?.instanceOf(HTMLElement)) {
			memoTimeButton.blur();
		}
		event.preventDefault();
		event.stopPropagation();
		event.stopImmediatePropagation();
		return true;
	}

	clearSuppressNextOpenPopupDismissClick(): void {
		this.suppressNextDismissClick = false;
		if (this.suppressNextDismissClickTimerId === null) {
			return;
		}
		this.getWindow().clearTimeout(this.suppressNextDismissClickTimerId);
		this.suppressNextDismissClickTimerId = null;
	}

	private markSuppressNextOpenPopupDismissClick(): void {
		this.clearSuppressNextOpenPopupDismissClick();
		this.suppressNextDismissClick = true;
		this.suppressNextDismissClickTimerId = this.getWindow().setTimeout(() => {
			this.suppressNextDismissClick = false;
			this.suppressNextDismissClickTimerId = null;
		}, 350);
	}

	private isTargetInOpenPopup(target: Element): boolean {
		return this.isOpenPopupTrigger(target) || this.isTargetInOpenCardMenu(target) || this.isTargetInOpenScopeMenu(target);
	}

	private isOpenPopupTrigger(target: Element): boolean {
		return target.closest(".knomo-card-menu") !== null ||
			target.closest("[data-action='toggle-card-menu']") !== null ||
			target.closest("[data-action='toggle-scope-menu']") !== null ||
			target.closest(".knomo-mobile-title") !== null;
	}

	private getEventElement(target: EventTarget | null): Element | null {
		const node = target as Node | null;
		return node?.instanceOf(Element) ? node : null;
	}

	private isTargetInOpenCardMenu(target: Element): boolean {
		if (this.cardMenuMemoId === null) {
			return false;
		}
		const card = target.closest(".knomo-card");
		if (!card?.instanceOf(HTMLElement) || card.getAttr("data-memo-id") !== this.cardMenuMemoId) {
			return false;
		}
		return target.closest(".knomo-card-actions") !== null || target.closest(".knomo-card-menu") !== null;
	}

	private isTargetInOpenScopeMenu(target: Element): boolean {
		if (!this.scopeOpen) {
			return false;
		}
		return target.closest(".knomo-scope-popover") !== null ||
			target.closest("[data-action='toggle-scope-menu']") !== null ||
			target.closest(".knomo-mobile-title") !== null;
	}

	private shouldPreserveDefaultForPopupDismiss(target: Element): boolean {
		const editable = target.closest("input, textarea, select, [contenteditable='true']");
		if (!editable?.instanceOf(HTMLElement)) {
			return false;
		}
		if (!editable.instanceOf(HTMLInputElement)) {
			return true;
		}
		return !["button", "checkbox", "color", "file", "image", "radio", "range", "reset", "submit"].includes(editable.type.toLowerCase());
	}
}
