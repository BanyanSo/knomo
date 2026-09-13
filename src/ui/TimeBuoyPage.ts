import { t } from "../i18n";
import type { TimeBuoyTab, TimeBuoyTabItem, TimeBuoyViewSnapshot } from "./TimeBuoyViewController";
import { renderKnomoEmptyState } from "./KnomoFeed";

interface RenderTimeBuoyPageOptions {
	idPrefix: string;
}

export interface TimeBuoyPageRenderResult {
	panelEl: HTMLElement | null;
	items: TimeBuoyTabItem[];
}

export function renderTimeBuoyPage(
	container: HTMLElement,
	snapshot: TimeBuoyViewSnapshot,
	options: RenderTimeBuoyPageOptions,
): TimeBuoyPageRenderResult {
	container.empty();
	if (snapshot.loading) {
		renderKnomoEmptyState(container, t("timeBuoy.loading"));
		return { panelEl: null, items: [] };
	}
	if (snapshot.error !== null) {
		const state = renderKnomoEmptyState(container, t("timeBuoy.loadFailed"));
		const actions = state.createDiv({ cls: "knomo-time-buoy-error-actions" });
		renderActionButton(actions, t("timeBuoy.retry"), "retry-time-buoy");
		return { panelEl: null, items: [] };
	}
	return renderTabs(container, snapshot, options.idPrefix);
}

export function appendTimeBuoyItems(
	container: HTMLElement,
	items: readonly TimeBuoyTabItem[],
	renderIndexStart: number,
	renderCard: (container: HTMLElement, item: TimeBuoyTabItem, renderIndex: number) => void,
): void {
	let renderIndex = renderIndexStart;
	for (const item of items) {
		renderCard(container, item, renderIndex);
		renderIndex += 1;
	}
}

function renderTabs(
	container: HTMLElement,
	snapshot: TimeBuoyViewSnapshot,
	idPrefix: string,
): TimeBuoyPageRenderResult {
	const tabs: Array<{ tab: TimeBuoyTab; label: string }> = [
		{ tab: "today", label: t("timeBuoy.today") },
		{ tab: "upcoming", label: t("timeBuoy.upcoming") },
		{ tab: "past", label: t("timeBuoy.past") },
	];
	const tabList = container.createDiv({
		cls: "knomo-time-buoy-tabs",
		attr: { role: "tablist", "aria-label": t("timeBuoy.tabs.label") },
	});
	for (const { tab, label } of tabs) {
		const active = tab === snapshot.activeTab;
		tabList.createEl("button", {
			cls: active ? "knomo-time-buoy-tab is-active" : "knomo-time-buoy-tab",
			text: label,
			attr: {
				type: "button",
				id: `${idPrefix}-tab-${tab}`,
				role: "tab",
				"aria-selected": active ? "true" : "false",
				"aria-controls": `${idPrefix}-panel-${tab}`,
				tabindex: active ? "0" : "-1",
				"data-action": `time-buoy-tab-${tab}`,
				"data-time-buoy-tab": tab,
			},
		});
	}
	let activePanel: HTMLElement | null = null;
	for (const { tab } of tabs) {
		const active = tab === snapshot.activeTab;
		const attr: Record<string, string> = {
			id: `${idPrefix}-panel-${tab}`,
			role: "tabpanel",
			"aria-labelledby": `${idPrefix}-tab-${tab}`,
		};
		if (!active) {
			attr.hidden = "";
		}
		const panel = container.createEl("section", { cls: "knomo-time-buoy-panel", attr });
		if (active) {
			activePanel = panel;
		}
	}
	const items = [...snapshot[snapshot.activeTab]];
	if (activePanel !== null && snapshot.refreshError !== null) {
		const error = activePanel.createDiv({ cls: "knomo-time-buoy-refresh-error", attr: { role: "alert" } });
		error.createSpan({ text: t("timeBuoy.loadFailed") });
		renderActionButton(error, t("timeBuoy.retry"), "retry-time-buoy");
	}
	if (activePanel !== null && snapshot.activeTab !== "today" && !snapshot.complete) {
		activePanel.createDiv({
			cls: "knomo-time-buoy-partial",
			text: t("timeBuoy.partial"),
			attr: {
				role: "status",
				"aria-live": "polite",
				"data-time-buoy-partial": "",
			},
		});
	}
	if (activePanel !== null && items.length === 0) {
		const copy = getEmptyCopy(snapshot.activeTab);
		renderKnomoEmptyState(activePanel, copy.title, copy.description);
		return { panelEl: null, items };
	}
	return { panelEl: activePanel, items };
}

function getEmptyCopy(tab: TimeBuoyTab): { title: string; description: string } {
	if (tab === "today") {
		return { title: t("timeBuoy.empty.today.title"), description: t("timeBuoy.empty.today.desc") };
	}
	if (tab === "upcoming") {
		return { title: t("timeBuoy.empty.upcoming.title"), description: t("timeBuoy.empty.upcoming.desc") };
	}
	return { title: t("timeBuoy.empty.past.title"), description: t("timeBuoy.empty.past.desc") };
}

function renderActionButton(container: HTMLElement, text: string, action: string): HTMLButtonElement {
	return container.createEl("button", {
		cls: "knomo-inline-button knomo-time-buoy-action",
		text,
		attr: { type: "button", "data-action": action },
	});
}
