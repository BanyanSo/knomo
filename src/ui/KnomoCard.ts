import { setIcon } from "obsidian";

import { KNOMO_TIME_BUOY_ICON } from "../icons";
import { t } from "../i18n";
import type { MemoViewItem as MemoRecord } from "../types/memoView";
import type { TimeBuoyDateStatus } from "../types/timeBuoy";
import { getMemoContentStats } from "../utils/memoContentStats";
import type { MemoAction, TrashAction } from "./KnomoActionDispatch";
import {
	getMemoCardActions,
	getMemoCardActionSection,
	getMemoCardShell,
	getMemoSourceReferenceMeta,
	getTrashCardActions,
	getTrashMemoCardClass,
	isCjkMemoContent,
	isMemoCardMenuReady,
	MEMO_ACTION_ICONS,
	MEMO_WORD_COUNT_ICON,
} from "./KnomoCardMetadata";
import type { MarkdownRenderPriority } from "./MarkdownRenderQueue";
import type { MemoCardPreview, MemoPreviewImage } from "./MemoCardPreview";
import { getMemoRenderKey } from "./MemoRenderRevision";
import { formatObservationDisplayTime } from "./MemoDisplayFormatters";
import type { MemoTimePresentation } from "./RecentTimeFlowPresentation";

export interface MemoCardTimeBuoy {
	status: TimeBuoyDateStatus;
	label: string;
}

export interface RenderMemoCardOptions<TMemo extends MemoRecord = MemoRecord> {
	generation: number;
	renderIndex: number;
	includeActions: boolean;
	randomCard: boolean;
	timeBuoy?: MemoCardTimeBuoy;
	beacon?: { selection: number; top: boolean };
	timePresentation?: MemoTimePresentation;
	activeMenuMemoId: string | null;
	formatDisplayTime: (value: string) => string;
	getMarkdownPriority: (renderIndex: number) => MarkdownRenderPriority;
	getMemoCardPreview: (memo: TMemo) => MemoCardPreview;
	queueMemoMarkdown: (memo: TMemo, container: HTMLElement, generation: number, priority: MarkdownRenderPriority, previewText: string) => void;
	renderMemoCardImages: (container: HTMLElement, memo: TMemo, images: MemoPreviewImage[], generation: number, reusedImagesEl?: HTMLElement | null) => void;
	queueSourceReferenceMarkdown: (container: HTMLElement, text: string, sourcePath: string, generation: number) => void;
	reusedBodyEl?: HTMLElement | null;
	reusedImagesEl?: HTMLElement | null;
}

export interface RenderTrashMemoCardOptions<TMemo extends MemoRecord = MemoRecord> {
	generation: number;
	renderIndex: number;
	busyAction: TrashAction | null;
	cleanupPending?: boolean;
	formatDisplayTime: (value: string) => string;
	formatOptionalTime: (value: string | undefined) => string;
	getMarkdownPriority: (renderIndex: number) => MarkdownRenderPriority;
	getMemoCardPreview: (memo: TMemo) => MemoCardPreview;
	queueMemoMarkdown: (memo: TMemo, container: HTMLElement, generation: number, priority: MarkdownRenderPriority, previewText: string) => void;
	renderMemoCardImages: (container: HTMLElement, memo: TMemo, images: MemoPreviewImage[], generation: number, reusedImagesEl?: HTMLElement | null) => void;
}

export function renderKnomoMemoCard<TMemo extends MemoRecord>(container: HTMLElement, memo: TMemo, options: RenderMemoCardOptions<TMemo>): HTMLElement {
	const markdownPriority = options.getMarkdownPriority(options.renderIndex);
	const cardMenuReady = isMemoCardMenuReady(memo);
	const shell = getMemoCardShell({
		memoId: memo.id,
		renderKey: getMemoRenderKey(memo),
		includeActions: options.includeActions,
		activeMenuMemoId: cardMenuReady ? options.activeMenuMemoId : null,
	});
	const card = container.createEl("article", {
		cls: isCjkMemoContent(memo.contentSnapshot)
			? `${shell.className} is-cjk-content`
			: shell.className,
		attr: shell.attrs,
	});
	if (options.beacon?.top) {
		card.addClass("has-beacon");
		card.setAttr("data-beacon-top", "true");
		const decoration = card.createDiv({ cls: "knomo-card-beacon-decoration", attr: { "aria-hidden": "true" } });
		decoration.createDiv({ cls: "knomo-card-beacon-sweep" });
		renderMemoCardBeaconTower(decoration);
	}
	const head = card.createDiv({ cls: "knomo-card-head" });
	card.setAttr("data-time-presentation", JSON.stringify(options.timePresentation ?? { mode: "full" }));
	renderMemoCardTime(head, memo, options);
	if (options.includeActions) {
		const menu = head.createEl("button", {
			cls: "knomo-card-menu",
			attr: {
				type: "button",
				"aria-label": cardMenuReady ? t("card.moreActions") : t("card.actionsPreparing"),
				"aria-haspopup": "menu",
				"aria-expanded": cardMenuReady && options.activeMenuMemoId === memo.id ? "true" : "false",
				...(cardMenuReady
					? { "data-action": "toggle-card-menu", "data-memo-id": memo.id }
					: { "aria-disabled": "true" }),
			},
		});
		menu.disabled = !cardMenuReady;
		setIcon(menu, "more-horizontal");

		if (cardMenuReady) {
			const actions = head.createDiv({
				cls: "knomo-card-actions",
				attr: { role: "menu" },
			});
			let previousSection: string | null = null;
			for (const action of getMemoCardActions(memo, options.randomCard, false, options.beacon !== undefined)) {
				const section = getMemoCardActionSection(action.action);
				if (previousSection !== null && previousSection !== section) {
					renderCardMenuSeparator(actions, section);
				}
				previousSection = section;
				const button = renderCardAction(
					actions,
					memo.id,
					action.action,
					getMemoActionLabel(action.action),
					action.className,
				);
				if (action.action === "remove-beacon") button.setAttr("data-beacon-selection", String(options.beacon!.selection));
			}
			renderCardMenuSeparator(actions, "knomo-card-info");
			const wordCount = actions.createDiv({ cls: "knomo-card-word-count" });
			setIcon(wordCount.createSpan({ cls: "knomo-menu-icon", attr: { "aria-hidden": "true" } }), MEMO_WORD_COUNT_ICON);
			wordCount.createSpan({ cls: "knomo-menu-label", text: t("card.wordCount", { count: getMemoContentStats(memo).wordCount }) });
		}
	}

	if (options.reusedBodyEl !== undefined && options.reusedBodyEl !== null) {
		card.appendChild(options.reusedBodyEl);
	} else {
		renderMemoCardBody(card, memo, {
			generation: options.generation,
			markdownPriority,
			getMemoCardPreview: options.getMemoCardPreview,
			queueMemoMarkdown: options.queueMemoMarkdown,
			renderMemoCardImages: options.renderMemoCardImages,
			reusedImagesEl: options.reusedImagesEl,
		});
	}
	renderCardMeta(card, memo, options);
	syncMemoCardTimeBuoy(card, options.timeBuoy);
	if (options.beacon?.top) card.createSpan({ cls: "knomo-visually-hidden", text: t("beacon.name") });
	return card;
}

function renderMemoCardBeaconTower(decoration: HTMLElement): void {
	const tower = decoration.createSvg("svg", { cls: "knomo-card-beacon-tower", attr: {
		viewBox: "0 0 116 174", "aria-hidden": "true", focusable: "false",
	} });
	tower.createSvg("path", { cls: "knomo-card-beacon-tower-shade", attr: {
		d: "M31 39L58 17L85 39Z M43 64H73L91 169H100V174H16V169H24Z",
	} });
	tower.createSvg("path", { cls: "knomo-card-beacon-tower-face", attr: {
		d: "M43 65H63L69 169H24Z M46 39H70V64H46Z M38 64H78V70H38Z",
	} });
	// 灯室中心 (58, 52) 与 CSS 中固定柔光、扫光的光源坐标对应。
	tower.createSvg("rect", { cls: "knomo-card-beacon-tower-lamp", attr: { x: "49", y: "42", width: "18", height: "20", rx: "3" } });
	tower.createSvg("path", { cls: "knomo-card-beacon-tower-shade", attr: {
		d: "M58 92a8 8 0 0 1 8 8v18H50v-18a8 8 0 0 1 8-8Z M56 137a9 9 0 0 1 9 9v23H47v-23a9 9 0 0 1 9-9Z",
	} });
}

export function syncMemoCardTimeBuoy(card: HTMLElement, timeBuoy: MemoCardTimeBuoy | undefined): void {
	const indicator = card.querySelector<HTMLElement>(":scope > .knomo-card-time-buoy");
	const previousStatus = indicator?.getAttr("data-time-buoy-status");
	if (previousStatus !== timeBuoy?.status) {
		if (previousStatus) card.removeClass(`is-time-buoy-${previousStatus}`);
		if (timeBuoy) {
			card.addClass("has-time-buoy");
			card.addClass(`is-time-buoy-${timeBuoy.status}`);
		} else card.removeClass("has-time-buoy");
		if (previousStatus === "today") card.querySelector(":scope > .knomo-card-time-buoy-wave")?.remove();
		if (!card.hasAttribute("data-beacon-top") && timeBuoy?.status === "today") renderMemoCardTimeBuoyWave(card);
	}
	if (timeBuoy) {
		const badge = indicator ?? card.createSpan({ cls: "knomo-card-time-buoy", attr: {
			role: "img", "data-time-buoy-card": "true",
		} });
		if (!indicator) setIcon(badge, KNOMO_TIME_BUOY_ICON);
		if (previousStatus !== timeBuoy.status) badge.setAttr("data-time-buoy-status", timeBuoy.status);
		if (badge.getAttr("aria-label") !== timeBuoy.label) badge.setAttr("aria-label", timeBuoy.label);
	} else indicator?.remove();
}

export function syncMemoCardBeaconAction(card: HTMLElement, memo: MemoRecord, selection?: number): void {
	const menu = card.querySelector<HTMLElement>(".knomo-card-actions");
	if (!menu || !memo.catalog || memo.status !== "active" || card.hasAttribute("data-knomo-readonly-transition")) return;
	const action = selection === undefined ? "set-beacon" : "remove-beacon";
	let button = menu.querySelector<HTMLButtonElement>("[data-memo-action='set-beacon'], [data-memo-action='remove-beacon']");
	if (!button) {
		button = renderCardAction(menu, memo.id, action, getMemoActionLabel(action), "knomo-card-action");
		menu.insertBefore(button, menu.querySelector(".knomo-card-menu-separator"));
	}
	if (button.getAttribute("data-memo-action") !== action) {
		button.setAttr("data-memo-action", action);
		button.querySelector(".knomo-menu-label")?.setText(getMemoActionLabel(action));
	}
	const token = selection === undefined ? null : String(selection);
	if (button.getAttribute("data-beacon-selection") !== token) {
		if (token === null) button.removeAttribute("data-beacon-selection");
		else button.setAttr("data-beacon-selection", token);
	}
}

function renderMemoCardTime<TMemo extends MemoRecord>(container: HTMLElement, memo: TMemo, options: RenderMemoCardOptions<TMemo>): void {
	const attrs: Record<string, string> = {
		type: "button",
		"aria-label": t("card.openDaily"),
		"data-memo-time-open": "daily",
		"data-memo-id": memo.id,
	};
	if (options.randomCard) {
		attrs["data-random-reunion-card"] = "true";
	}
	const recent = options.timePresentation?.mode === "recent" ? options.timePresentation : null;
	const button = container.createEl("button", {
		cls: "knomo-card-time",
		text: recent !== null ? undefined : memo.catalog === undefined
			? options.formatDisplayTime(memo.createdAt)
			: formatObservationDisplayTime(memo.catalog.observation),
		attr: attrs,
	});
	if (recent !== null) {
		button.addClass("knomo-recent-time");
		const icon = button.createSpan({ cls: "knomo-recent-time-icon", attr: { "aria-hidden": "true" } });
		setIcon(icon, recent.icon);
		button.createSpan({ text: recent.time });
	}
}

function renderMemoCardTimeBuoyWave(card: HTMLElement): void {
	const wave = card.createSvg("svg", {
		cls: "knomo-card-time-buoy-wave",
		attr: {
			viewBox: "0 0 100 10",
			preserveAspectRatio: "none",
			"aria-hidden": "true",
			focusable: "false",
		},
	});
	const wavePath = "M0 6 C10 2 20 10 30 6 C40 2 50 10 60 6 C70 2 80 10 90 6 C94 4.4 97 4.6 100 6";
	wave.createSvg("path", {
		cls: "knomo-card-time-buoy-wave-fill",
		attr: { d: `${wavePath} L100 10 L0 10 Z` },
	});
	wave.createSvg("path", {
		cls: "knomo-card-time-buoy-wave-line",
		attr: { d: wavePath },
	});
}

export function renderKnomoTrashMemoCard<TMemo extends MemoRecord>(container: HTMLElement, memo: TMemo, options: RenderTrashMemoCardOptions<TMemo>): HTMLElement {
	const markdownPriority = options.getMarkdownPriority(options.renderIndex);
	const card = container.createEl("article", {
		cls: getTrashMemoCardClass(options.busyAction),
		attr: { "data-memo-id": memo.id },
	});
	const head = card.createDiv({ cls: "knomo-card-head" });
	head.createDiv({ cls: "knomo-card-time", text: t("trash.createdAt", { time: options.formatDisplayTime(memo.createdAt) }) });
	const actions = head.createDiv({ cls: "knomo-trash-actions" });
	for (const action of getTrashCardActions(options.busyAction, memo.trashItem?.purgeAllowed === true)) {
		renderTrashAction(
			actions,
			memo.id,
			action.action,
			getTrashActionLabel(action.action, action.state.busy, options.cleanupPending),
			action.state.disabled,
			action.className,
		);
	}

	renderMemoCardBody(card, memo, {
		generation: options.generation,
		markdownPriority,
		getMemoCardPreview: options.getMemoCardPreview,
		queueMemoMarkdown: options.queueMemoMarkdown,
		renderMemoCardImages: options.renderMemoCardImages,
	});

	const meta = card.createDiv({ cls: "knomo-card-meta" });
	meta.createDiv({ text: t("trash.deletedAt", { time: options.formatOptionalTime(memo.deletedAt) }) });
	return card;
}

interface RenderMemoCardBodyOptions<TMemo extends MemoRecord = MemoRecord> {
	generation: number;
	markdownPriority: MarkdownRenderPriority;
	getMemoCardPreview: (memo: TMemo) => MemoCardPreview;
	queueMemoMarkdown: (memo: TMemo, container: HTMLElement, generation: number, priority: MarkdownRenderPriority, previewText: string) => void;
	renderMemoCardImages: (container: HTMLElement, memo: TMemo, images: MemoPreviewImage[], generation: number, reusedImagesEl?: HTMLElement | null) => void;
	reusedImagesEl?: HTMLElement | null;
}

export function renderMemoCardBody<TMemo extends MemoRecord>(card: HTMLElement, memo: TMemo, options: RenderMemoCardBodyOptions<TMemo>): HTMLElement {
	const preview = options.getMemoCardPreview(memo);
	const body = card.createDiv({ cls: "knomo-card-body" });
	if (preview.text.trim().length > 0) {
		const content = body.createDiv({ cls: "knomo-card-content markdown-rendered" });
		// 首次渲染先提供正文占位，避免图片先出现而整段正文稍后从零高度插入。
		content.createDiv({ cls: "knomo-card-text-placeholder", text: preview.text, attr: { "data-knomo-render-placeholder": "", inert: "" } });
		options.queueMemoMarkdown(memo, content, options.generation, options.markdownPriority, preview.text);
	}
	options.renderMemoCardImages(body, memo, preview.images, options.generation, options.reusedImagesEl ?? null);
	return body;
}

function renderCardMeta<TMemo extends MemoRecord>(card: HTMLElement, memo: TMemo, options: RenderMemoCardOptions<TMemo>): void {
	const sourceReference = getMemoSourceReferenceMeta(memo);
	if (sourceReference.type !== "none") {
		const meta = card.createDiv({ cls: "knomo-card-meta knomo-source-reference markdown-rendered" });
		const icon = meta.createSpan({ cls: "knomo-reference-icon", attr: { role: "img", "aria-label": t("reference.fromPrefix") } });
		setIcon(icon, "message-square-quote");
		const content = meta.createDiv({ cls: "knomo-source-reference-content" });
		const referenceText = sourceReference.text;
		options.queueSourceReferenceMarkdown(
			content,
			referenceText,
			sourceReference.sourcePath,
			options.generation,
		);
	}
}

export function syncMemoCardRelationsAction(card: HTMLElement, memo: MemoRecord, hasReferrers: boolean): void {
	const action = getMemoCardActions(memo, false, hasReferrers).find(item => item.action === "relations");
	card.toggleAttribute("data-has-referrers", action !== undefined);
	const current = card.querySelector<HTMLElement>('[data-memo-action="relations"]');
	if (!action) {
		const focused = current === card.ownerDocument.activeElement;
		current?.remove();
		if (focused) card.querySelector<HTMLElement>(".knomo-card-menu")?.focus({ preventScroll: true });
		return;
	}
	if (current) return;
	const menu = card.querySelector<HTMLElement>(".knomo-card-actions");
	if (!menu) return;
	const button = renderCardAction(menu, memo.id, action.action, getMemoActionLabel(action.action), action.className);
	menu.insertBefore(button, menu.querySelector('.knomo-card-menu-separator[data-before-section="knomo-card-danger"], .knomo-card-menu-separator[data-before-section="knomo-card-info"]'));
}

function renderCardMenuSeparator(container: HTMLElement, section: string): void {
	container.createDiv({
		cls: "knomo-card-menu-separator",
		attr: { role: "separator", "data-before-section": section },
	});
}

function renderCardAction(
	container: HTMLElement,
	memoId: string,
	action: MemoAction,
	label: string,
	className: string,
): HTMLButtonElement {
	const button = container.createEl("button", {
		cls: className,
		attr: {
			type: "button",
			role: "menuitem",
			"data-memo-action": action,
			"data-menu-section": getMemoCardActionSection(action),
			"data-memo-id": memoId,
		},
	});
	setIcon(button.createSpan({ cls: "knomo-menu-icon", attr: { "aria-hidden": "true" } }), MEMO_ACTION_ICONS[action]);
	button.createSpan({ cls: "knomo-menu-label", text: label });
	return button;
}

function renderTrashAction(
	container: HTMLElement,
	memoId: string,
	action: TrashAction,
	label: string,
	disabled: boolean,
	className: string,
): void {
	container.createEl("button", {
		cls: className,
		text: label,
		attr: {
			type: "button",
			"data-trash-action": action,
			"data-memo-id": memoId,
		},
	}).disabled = disabled;
}

export function getMemoActionLabel(action: MemoAction): string {
	if (action === "set-beacon") return t("beacon.set");
	if (action === "remove-beacon") return t("beacon.remove");
	if (action === "share-image") return t("share.share");
	if (action === "relations") return t("relations.title");
	if (action === "edit") return t("card.edit");
	if (action === "reference") return t("card.reference");
	if (action === "open-daily") return t("card.openDaily");
	if (action === "view-day") return t("card.viewDay");
	if (action === "copy-text") return t("card.copyText");
	if (action === "copy-link") return t("card.copyLink");
	if (action === "mark-reviewed") return t("card.markReviewed");
	return t("card.delete");
}

function getTrashActionLabel(action: TrashAction, busy: boolean, cleanupPending = false): string {
	if (action === "purge") return busy ? t("trash.purging") : t("trash.purge");
	if (cleanupPending) return busy ? t("trash.cleaningUp") : t("trash.retryCleanup");
	return busy ? t("trash.restoring") : t("trash.restore");
}
