import { setIcon } from "obsidian";

import { t } from "../i18n";
import { buildTagTree } from "../utils/tagTree";
import type { TagSummary, TagTreeNode } from "../utils/tagTree";
import { getSidebarNavItems, TRASH_NAV_ITEM } from "./viewNavigation";
import type { SidebarNav, SidebarNavItem } from "./viewNavigation";

export const SIDEBAR_MIN_WIDTH = 210;
export const SIDEBAR_MAX_WIDTH = 300;

interface KnomoSidebarOptions {
	sidebarMinWidth: number;
	sidebarMaxWidth: number;
	createHiddenText: (container: HTMLElement, id: string, text: string) => string;
	createIconButton: (
		container: HTMLElement,
		icon: string,
		ariaLabel: string,
		cls: string,
		action: string,
		showTooltip?: boolean,
	) => HTMLButtonElement;
}

export interface KnomoSidebarElements {
	statsEl: HTMLElement;
	allTagsEl: HTMLElement;
	trashCountEl: HTMLElement;
	resizerEl: HTMLElement;
}

export interface RenderSidebarTagsOptions {
	activeTagKey: string | null;
	expandedTagGroups: ReadonlySet<string>;
	emptyText: string;
}

export interface SidebarDragState {
	pointerId: number;
	startX: number;
	startWidth: number;
}

export function renderKnomoSidebar(sidebar: HTMLElement, options: KnomoSidebarOptions): KnomoSidebarElements {
	const header = sidebar.createDiv({ cls: "knomo-sidebar-header" });
	const brand = header.createDiv({ cls: "knomo-brand" });
	brand.createDiv({ cls: "knomo-brand-title", text: "Knomo" });
	brand.createDiv({ cls: "knomo-brand-subtitle", text: t("sidebar.subtitle") });
	const actions = header.createDiv({ cls: "knomo-sidebar-actions" });
	options.createIconButton(actions, "bar-chart-3", t("sidebar.stats"), "knomo-sidebar-action", "focus-stats");
	options.createIconButton(actions, "refresh-cw", t("sidebar.refresh"), "knomo-sidebar-action", "refresh");
	options.createIconButton(actions, "panel-left-close", t("sidebar.hide"), "knomo-sidebar-action knomo-desktop-only", "collapse-sidebar");

	const statsLabelId = options.createHiddenText(sidebar, "stats-label", t("sidebar.stats"));
	const statsEl = sidebar.createDiv({ cls: "knomo-sidebar-stats", attr: { "aria-labelledby": statsLabelId, tabindex: "-1" } });

	const navLabelId = options.createHiddenText(sidebar, "nav-label", t("sidebar.scope"));
	const nav = sidebar.createEl("nav", {
		cls: "knomo-nav",
		attr: { "aria-labelledby": navLabelId },
	});
	for (const item of getSidebarNavItems()) {
		renderSidebarNavButton(nav, item);
	}

	const allTagSection = sidebar.createDiv({ cls: "knomo-tag-section" });
	allTagSection.createDiv({ cls: "knomo-section-label", text: t("sidebar.allTags") });
	const allTagsEl = allTagSection.createDiv({ cls: "knomo-tag-list" });

	const trashSection = sidebar.createDiv({ cls: "knomo-trash-section" });
	const trashButton = renderSidebarNavButton(trashSection, TRASH_NAV_ITEM);
	trashButton.addClass("knomo-trash-nav-button");
	const trashCountEl = trashButton.createSpan({ cls: "knomo-trash-count" });

	const resizerLabelId = options.createHiddenText(sidebar, "resizer-label", t("sidebar.resize"));
	const resizerEl = sidebar.createDiv({
		cls: "knomo-sidebar-resizer knomo-desktop-only",
		attr: {
			role: "separator",
			"aria-orientation": "vertical",
			"aria-labelledby": resizerLabelId,
			"aria-valuemin": String(options.sidebarMinWidth),
			"aria-valuemax": String(options.sidebarMaxWidth),
			tabindex: "0",
		},
	});

	return {
		statsEl,
		allTagsEl,
		trashCountEl,
		resizerEl,
	};
}

export function clampSidebarWidth(width: number): number {
	return Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, Math.round(width)));
}

export function createSidebarDragState(event: PointerEvent, startWidth: number): SidebarDragState {
	return {
		pointerId: event.pointerId,
		startX: event.clientX,
		startWidth,
	};
}

export function getSidebarDragWidth(drag: SidebarDragState, clientX: number): number {
	return drag.startWidth + clientX - drag.startX;
}

export function renderSidebarStat(container: HTMLElement, value: string, label: string): void {
	const item = container.createDiv({ cls: "knomo-stat" });
	item.createDiv({ cls: "knomo-stat-value", text: value });
	item.createDiv({ cls: "knomo-stat-label", text: label });
}

export function renderSidebarTags(container: HTMLElement | null, tags: TagSummary[], options: RenderSidebarTagsOptions): void {
	if (container === null) {
		return;
	}
	container.empty();
	const tree = buildTagTree(tags);
	if (tree.length === 0) {
		container.createDiv({ cls: "knomo-muted-text", text: options.emptyText });
		return;
	}
	for (const tag of tree) {
		renderTagTreeNode(container, tag, options);
	}
}

export function syncSidebarNavButtons(rootEl: HTMLElement | null, activeNav: SidebarNav): void {
	rootEl?.findAll("[data-nav]").forEach((element) => {
		const active = element.getAttr("data-nav") === activeNav;
		element.toggleClass("is-active", active);
		element.setAttr("aria-pressed", active ? "true" : "false");
	});
}

function renderSidebarNavButton(container: HTMLElement, item: SidebarNavItem): HTMLButtonElement {
	const button = container.createEl("button", {
		cls: "knomo-nav-button",
		attr: {
			type: "button",
			"aria-pressed": "false",
			"data-nav": item.nav,
		},
	});
	setIcon(button.createSpan({ cls: "knomo-button-icon" }), item.icon);
	button.createSpan({ cls: "knomo-button-label", text: item.label });
	return button;
}

function renderTagTreeNode(container: HTMLElement, tag: TagTreeNode, options: RenderSidebarTagsOptions): void {
	const collapsed = tag.children.length > 0 && !options.expandedTagGroups.has(tag.key);
	const node = container.createDiv({ cls: collapsed ? "knomo-tag-node is-collapsed" : "knomo-tag-node" });
	const row = node.createDiv({ cls: "knomo-tag-row" });
	const button = row.createEl("button", {
		cls: options.activeTagKey === tag.key ? "knomo-tag-nav is-active" : "knomo-tag-nav",
		attr: {
			type: "button",
			"data-tag": tag.name,
			"data-tag-key": tag.key,
			"aria-pressed": options.activeTagKey === tag.key ? "true" : "false",
		},
	});
	button.createSpan({ cls: "knomo-tag-name", text: tag.label });
	if (tag.children.length > 0) {
		const toggle = row.createEl("button", {
			cls: "knomo-tag-toggle",
			attr: {
				type: "button",
				"aria-label": collapsed ? t("tags.expandGroup") : t("tags.collapseGroup"),
				"aria-expanded": collapsed ? "false" : "true",
				"data-tag-toggle": tag.key,
			},
		});
		toggle.createSpan({ cls: "knomo-tag-count", text: String(tag.count) });
		const toggleIcon = toggle.createSpan({ cls: "knomo-tag-toggle-icon" });
		setIcon(toggleIcon, "chevron-down");
	} else {
		row.createSpan({ cls: "knomo-tag-count", text: String(tag.count) });
	}
	if (tag.children.length > 0) {
		const children = node.createDiv({ cls: "knomo-tag-children" });
		for (const child of tag.children) {
			renderTagTreeNode(children, child, options);
		}
	}
}
