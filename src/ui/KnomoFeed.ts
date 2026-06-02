import { t } from "../i18n";
import type { CardFlowHeader } from "./KnomoCardFlowPresenter";

type LoadMoreAction = "load-more" | "load-more-mobile-search";

interface RenderLoadMoreButtonOptions {
	remainingCount: number;
	action: LoadMoreAction;
	extraClass?: string;
	sentinel?: boolean;
}

export function renderKnomoListSummary(container: HTMLElement, text: string): HTMLElement {
	return container.createDiv({
		cls: "knomo-list-summary",
		text,
	});
}

export function renderKnomoRandomReunionToolbar(container: HTMLElement, count: number): HTMLElement {
	const toolbar = container.createDiv({ cls: "knomo-list-toolbar" });
	renderKnomoListSummary(toolbar, t("list.randomSummary", { count }));
	toolbar.createEl("button", {
		cls: "knomo-inline-button",
		text: t("list.randomRefresh"),
		attr: {
			type: "button",
			"data-action": "refresh-random-reunion",
		},
	});
	return toolbar;
}

export function renderKnomoCardFlowHeaders(container: HTMLElement, headers: CardFlowHeader[]): HTMLElement[] {
	return headers.map((header) => {
		if (header.type === "random-toolbar") {
			return renderKnomoRandomReunionToolbar(container, header.count);
		}
		return renderKnomoListSummary(container, header.text);
	});
}

export function renderKnomoLoadMoreButton(container: HTMLElement, options: RenderLoadMoreButtonOptions): HTMLButtonElement {
	const attr: Record<string, string> = {
		type: "button",
		"data-action": options.action,
	};
	if (options.sentinel === true) {
		attr["data-load-more-sentinel"] = "true";
	}
	const cls = options.extraClass === undefined
		? "knomo-load-more"
		: `knomo-load-more ${options.extraClass}`;
	return container.createEl("button", {
		cls,
		text: t("list.loadMore", { count: options.remainingCount }),
		attr,
	});
}

export function renderKnomoEmptyState(container: HTMLElement, title = t("empty.generic"), description = ""): HTMLElement {
	const emptyState = container.createDiv({ cls: "knomo-empty-state" });
	emptyState.createDiv({ cls: "knomo-empty-title", text: title });
	if (description.length > 0) {
		emptyState.createDiv({ cls: "knomo-empty-description", text: description });
	}
	return emptyState;
}
