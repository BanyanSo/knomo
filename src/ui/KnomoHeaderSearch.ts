import { setIcon } from "obsidian";

import { KNOMO_SEARCH_ICON, KNOMO_SIDEBAR_MENU_ICON } from "../icons";
import { t } from "../i18n";
import type { SearchDateOption, TitleModeOption } from "./viewNavigation";
import { SEARCH_DATE_OPTIONS, TITLE_MODE_OPTIONS } from "./viewNavigation";

type CreateIconButton = (
	container: HTMLElement,
	icon: string,
	ariaLabel: string,
	cls: string,
	action: string,
	showTooltip?: boolean,
) => HTMLButtonElement;

interface HeaderSearchRenderOptions {
	createHiddenText: (container: HTMLElement, name: string, text: string) => string;
	createIconButton: CreateIconButton;
}

export interface DesktopTopbarElements {
	titleHostEl: HTMLElement;
	searchInputEl: HTMLInputElement;
}

export interface CompactHeaderElements {
	titleHostEl: HTMLElement;
	inlineSearchInputEl: HTMLInputElement;
}

export interface CompactSearchPanelElements {
	searchInputEl: HTMLInputElement;
}

export function renderKnomoDesktopTopbar(container: HTMLElement, options: HeaderSearchRenderOptions): DesktopTopbarElements {
	const topbar = container.createDiv({ cls: "knomo-topbar" });
	options.createIconButton(topbar, KNOMO_SIDEBAR_MENU_ICON, t("sidebar.show"), "knomo-sidebar-toggle", "toggle-sidebar");

	const scopeWrap = topbar.createDiv({ cls: "knomo-scope-wrap" });
	const titleHostEl = scopeWrap.createDiv({ cls: "knomo-title-host" });
	renderKnomoScopePopover(scopeWrap, "knomo-scope-popover knomo-desktop-scope-popover");

	const searchWrap = topbar.createDiv({ cls: "knomo-search-wrap" });
	const searchInputEl = renderKnomoSearchInput(searchWrap, "desktop-search-label", options.createHiddenText);
	renderKnomoSearchPopover(searchWrap);

	return {
		titleHostEl,
		searchInputEl,
	};
}

export function renderKnomoScopePopover(container: HTMLElement, cls: string): HTMLElement {
	const popover = container.createDiv({ cls, attr: { role: "menu" } });
	for (const option of TITLE_MODE_OPTIONS) {
		renderTitleModeButton(popover, option, "knomo-scope-option");
	}
	return popover;
}

export function renderKnomoCompactHeader(container: HTMLElement, options: HeaderSearchRenderOptions): CompactHeaderElements {
	const header = container.createDiv({ cls: "knomo-compact-header" });
	options.createIconButton(header, KNOMO_SIDEBAR_MENU_ICON, t("mobile.menu"), "knomo-compact-menu-btn", "open-drawer");

	const titleHostEl = header.createDiv({
		cls: "knomo-compact-title",
	});

	const inlineSearchWrap = header.createDiv({ cls: "knomo-compact-search-wrap knomo-compact-inline-search" });
	const inlineSearchInputEl = renderKnomoSearchInput(inlineSearchWrap, "compact-inline-search-label", options.createHiddenText);
	renderKnomoSearchPopover(inlineSearchWrap);

	options.createIconButton(header, KNOMO_SEARCH_ICON, t("search.label"), "knomo-compact-search-btn", "toggle-compact-search");
	return {
		titleHostEl,
		inlineSearchInputEl,
	};
}

export function renderKnomoCompactSearchPanel(container: HTMLElement, options: HeaderSearchRenderOptions): CompactSearchPanelElements {
	const panel = container.createDiv({ cls: "knomo-compact-search-panel" });
	const searchWrap = panel.createDiv({ cls: "knomo-compact-search-wrap" });
	const searchInputEl = renderKnomoSearchInput(searchWrap, "compact-search-label", options.createHiddenText);
	renderKnomoSearchPopover(searchWrap);
	return { searchInputEl };
}

export function renderKnomoSearchPopover(container: HTMLElement): HTMLElement {
	const searchMenu = container.createDiv({ cls: "knomo-search-menu", attr: { role: "menu" } });
	for (const option of SEARCH_DATE_OPTIONS) {
		renderSearchDateButton(searchMenu, option, "knomo-search-menu-option");
	}
	return searchMenu;
}

export function renderTitleModeButton(container: HTMLElement, option: TitleModeOption, cls: string): HTMLButtonElement {
	const button = container.createEl("button", {
		cls,
		attr: {
			type: "button",
			"aria-pressed": "false",
			"data-title-mode": option.mode,
		},
	});
	setIcon(button.createSpan({ cls: "knomo-button-icon" }), option.icon);
	button.createSpan({ cls: "knomo-button-label", text: option.label });
	return button;
}

export function renderSearchDateButton(
	container: HTMLElement,
	option: SearchDateOption,
	cls: string,
	label = option.label,
): HTMLButtonElement {
	const button = container.createEl("button", {
		cls,
		attr: {
			type: "button",
			"aria-pressed": "false",
			"data-search-date": option.filter,
		},
	});
	setIcon(button.createSpan({ cls: "knomo-button-icon" }), option.icon);
	button.createSpan({ cls: "knomo-button-label", text: label });
	return button;
}

function renderKnomoSearchInput(
	container: HTMLElement,
	labelName: string,
	createHiddenText: HeaderSearchRenderOptions["createHiddenText"],
): HTMLInputElement {
	setIcon(container.createSpan({ cls: "knomo-search-icon" }), KNOMO_SEARCH_ICON);
	const searchLabelId = createHiddenText(container, labelName, t("search.label"));
	return container.createEl("input", {
		cls: "knomo-search-input",
		attr: {
			type: "search",
			placeholder: t("search.label"),
			"aria-labelledby": searchLabelId,
		},
	});
}
