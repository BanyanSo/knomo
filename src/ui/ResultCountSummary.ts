import { t, type TranslationKey, type TranslationParams } from "../i18n";

export interface ResultCountSummary {
	template: TranslationKey;
	params: TranslationParams;
	count: number | null;
	pending: boolean;
}

interface SummaryNodes {
	key: string;
	slot: HTMLElement;
	value: HTMLElement;
	state: string;
	revealed: boolean;
}

const summaryNodes = new WeakMap<HTMLElement, SummaryNodes>();

// 先定位语言模板中的数量位置，再插入条件文字；用户输入中的占位符保持原样。
export function syncResultCountSummary(element: HTMLElement, summary: ResultCountSummary): void {
	const template = t(summary.template);
	const key = JSON.stringify([template, summary.params]);
	let nodes = summaryNodes.get(element);
	if (nodes?.key !== key) {
		element.empty();
		const [before, after] = template.split("{{count}}");
		const interpolate = (text: string) => text.replace(/\{\{(\w+)\}\}/gu, (match, name: string) => {
			const value = summary.params[name];
			return value == null ? match : String(value);
		});
		element.createSpan({ cls: "knomo-result-summary-text", text: interpolate(before) });
		const slot = element.createSpan({ cls: "knomo-result-summary-count", attr: { role: "status", "aria-live": "polite", "aria-atomic": "true" } });
		const value = slot.createSpan({ cls: "knomo-result-summary-value", attr: { "aria-hidden": "true" } });
		const dots = slot.createSpan({ cls: "knomo-result-summary-dots", attr: { "aria-hidden": "true" } });
		for (let index = 0; index < 3; index++) dots.createSpan();
		element.createSpan({ cls: "knomo-result-summary-text", text: interpolate(after) });
		nodes = { key, slot, value, state: "", revealed: false };
		summaryNodes.set(element, nodes);
		slot.addEventListener("animationend", event => {
			if (event.animationName === "knomo-result-count-reveal") slot.removeClass("is-revealing");
		});
	}
	const state = summary.count !== null ? "ready" : summary.pending ? "pending" : "unavailable";
	const text = summary.count !== null ? String(summary.count) : state === "pending" ? "" : "—";
	if (nodes.state === "pending" && state === "ready" && !nodes.revealed) {
		nodes.slot.addClass("is-revealing");
		nodes.revealed = true;
	}
	if (state !== "ready") nodes.slot.removeClass("is-revealing");
	if (nodes.value.textContent !== text) nodes.value.setText(text);
	nodes.slot.setAttr("data-state", state);
	const label = state === "pending" ? t("loading.label") : text;
	if (nodes.slot.getAttribute("aria-label") !== label) nodes.slot.setAttr("aria-label", label);
	nodes.state = state;
}

export function renderResultCountSummary(container: HTMLElement, summary: ResultCountSummary): HTMLElement {
	const element = container.createDiv({ cls: "knomo-list-summary knomo-result-summary" });
	syncResultCountSummary(element, summary);
	return element;
}
