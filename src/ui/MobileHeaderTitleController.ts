export type MobileHeaderTitleRegisterDomEvent = <K extends "click" | "keydown">(
	target: HTMLElement,
	type: K,
	listener: (event: HTMLElementEventMap[K]) => void,
) => void;

interface MobileHeaderTitleControllerOptions {
	registerDomEvent: MobileHeaderTitleRegisterDomEvent;
	renderChevron: (container: HTMLElement) => void;
	canToggleScopeMenu: () => boolean;
	onToggleScopeMenu: () => void;
}

interface MobileHeaderTitleSyncOptions {
	headerEl: HTMLElement;
	titleEl: HTMLElement;
	isRecordStats: boolean;
	scopeMenuOpen: boolean;
	label: string;
}

export class MobileHeaderTitleController {
	private headerEl: HTMLElement | null = null;
	private titleEl: HTMLElement | null = null;
	private registeredTitleEl: HTMLElement | null = null;
	private originalText: string | null = null;

	constructor(private readonly options: MobileHeaderTitleControllerOptions) {}

	getAnchor(): HTMLElement | null {
		return this.titleEl;
	}

	sync(options: MobileHeaderTitleSyncOptions): void {
		if (this.titleEl !== options.titleEl) {
			this.remove();
			this.titleEl = options.titleEl;
			this.originalText = options.titleEl.textContent;
		}
		if (this.headerEl !== null && this.headerEl !== options.headerEl) {
			this.headerEl.removeClass("knomo-record-stats-header");
		}
		this.headerEl = options.headerEl;
		if (options.isRecordStats) {
			options.headerEl.addClass("knomo-record-stats-header");
		} else {
			options.headerEl.removeClass("knomo-record-stats-header");
		}
		if (this.registeredTitleEl !== options.titleEl) {
			this.registeredTitleEl = options.titleEl;
			this.registerTitleEvents(options.titleEl);
		}

		this.renderTitle(options);
	}

	remove(): void {
		if (this.titleEl !== null) {
			this.headerEl?.removeClass("knomo-record-stats-header");
			this.titleEl.empty();
			if (this.originalText !== null) {
				this.titleEl.setText(this.originalText);
			}
			this.titleEl.removeClass("knomo-mobile-title");
			this.titleEl.removeAttribute("role");
			this.titleEl.removeAttribute("aria-haspopup");
			this.titleEl.removeAttribute("aria-expanded");
			this.titleEl.removeAttribute("tabindex");
		}
		this.headerEl = null;
		this.titleEl = null;
		this.originalText = null;
	}

	private registerTitleEvents(titleEl: HTMLElement): void {
		this.options.registerDomEvent(titleEl, "click", (event) => {
			if (!this.options.canToggleScopeMenu()) {
				return;
			}
			event.preventDefault();
			this.options.onToggleScopeMenu();
		});
		this.options.registerDomEvent(titleEl, "keydown", (event) => {
			if (!this.options.canToggleScopeMenu()) {
				return;
			}
			if (event.key !== "Enter" && event.key !== " ") {
				return;
			}
			event.preventDefault();
			this.options.onToggleScopeMenu();
		});
	}

	private renderTitle(options: MobileHeaderTitleSyncOptions): void {
		const titleEl = options.titleEl;
		titleEl.empty();
		titleEl.addClass("knomo-mobile-title");
		if (options.isRecordStats) {
			titleEl.removeAttribute("role");
			titleEl.removeAttribute("aria-haspopup");
			titleEl.removeAttribute("aria-expanded");
			titleEl.removeAttribute("tabindex");
			titleEl.createSpan({ text: options.label });
			return;
		}
		titleEl.setAttr("role", "button");
		titleEl.setAttr("aria-haspopup", "menu");
		titleEl.setAttr("aria-expanded", options.scopeMenuOpen ? "true" : "false");
		titleEl.setAttr("tabindex", "0");
		titleEl.createSpan({ text: options.label });
		this.options.renderChevron(titleEl);
	}
}
