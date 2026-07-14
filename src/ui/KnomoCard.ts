import { setIcon } from "obsidian";

import { KNOMO_TIME_BUOY_ICON } from "../icons";
import { t } from "../i18n";
import type { MemoRecord } from "../types/memo";
import type { TimeBuoyDateStatus } from "../types/timeBuoy";
import { getMemoContentStats } from "../utils/memoContentStats";
import { formatMemoIssue } from "../utils/serviceText";
import type { MemoAction, TrashAction } from "./KnomoActionDispatch";
import {
	getMemoCardActions,
	getMemoCardShell,
	getMemoSourceReferenceMeta,
	getMemoWarningText,
	getTrashCardActions,
	getTrashMemoCardClass,
	getTrashMemoWarningText,
	isCjkMemoContent,
} from "./KnomoCardMetadata";
import type { MarkdownRenderPriority } from "./MarkdownRenderQueue";
import type { MemoCardPreview, MemoPreviewImage } from "./MemoCardPreview";

export interface MemoCardTimeBuoy {
	status: TimeBuoyDateStatus;
	label: string;
}

export interface RenderMemoCardOptions {
	generation: number;
	renderIndex: number;
	includeActions: boolean;
	randomCard: boolean;
	timeBuoy?: MemoCardTimeBuoy;
	activeMenuMemoId: string | null;
	deletedMemoIds: ReadonlySet<string>;
	formatDisplayTime: (value: string) => string;
	formatSettingsText: (value: string) => string;
	getMarkdownPriority: (renderIndex: number) => MarkdownRenderPriority;
	getMemoCardPreview: (memo: MemoRecord) => MemoCardPreview;
	queueMemoMarkdown: (memo: MemoRecord, container: HTMLElement, generation: number, priority: MarkdownRenderPriority, previewText: string) => void;
	renderMemoCardImages: (container: HTMLElement, memo: MemoRecord, images: MemoPreviewImage[], generation: number, reusedImagesEl?: HTMLElement | null) => void;
	queueSourceReferenceMarkdown: (container: HTMLElement, text: string, sourcePath: string, generation: number) => void;
	reusedBodyEl?: HTMLElement | null;
	reusedImagesEl?: HTMLElement | null;
}

export interface RenderTrashMemoCardOptions {
	generation: number;
	renderIndex: number;
	busyAction: TrashAction | null;
	formatDisplayTime: (value: string) => string;
	formatOptionalTime: (value: string | undefined) => string;
	formatDeleteSource: (value: string) => string;
	formatSettingsText: (value: string) => string;
	getMarkdownPriority: (renderIndex: number) => MarkdownRenderPriority;
	getMemoCardPreview: (memo: MemoRecord) => MemoCardPreview;
	queueMemoMarkdown: (memo: MemoRecord, container: HTMLElement, generation: number, priority: MarkdownRenderPriority, previewText: string) => void;
	renderMemoCardImages: (container: HTMLElement, memo: MemoRecord, images: MemoPreviewImage[], generation: number, reusedImagesEl?: HTMLElement | null) => void;
}

export function renderKnomoMemoCard(container: HTMLElement, memo: MemoRecord, options: RenderMemoCardOptions): HTMLElement {
	const markdownPriority = options.getMarkdownPriority(options.renderIndex);
	const shell = getMemoCardShell({
		memoId: memo.id,
		includeActions: options.includeActions,
		activeMenuMemoId: options.activeMenuMemoId,
	});
	const timeBuoyClass = options.timeBuoy === undefined
		? ""
		: ` has-time-buoy is-time-buoy-${options.timeBuoy.status}`;
	const card = container.createEl("article", {
		cls: isCjkMemoContent(memo.contentSnapshot)
			? `${shell.className} is-cjk-content${timeBuoyClass}`
			: `${shell.className}${timeBuoyClass}`,
		attr: shell.attrs,
	});
	const head = card.createDiv({ cls: "knomo-card-head" });
	renderMemoCardTime(head, memo, options);
	if (options.includeActions) {
		const menu = head.createEl("button", {
			cls: "knomo-card-menu",
			attr: {
				type: "button",
				"aria-label": t("card.moreActions"),
				"aria-expanded": options.activeMenuMemoId === memo.id ? "true" : "false",
				"data-action": "toggle-card-menu",
				"data-memo-id": memo.id,
			},
		});
		setIcon(menu, "more-horizontal");

		const actions = head.createDiv({ cls: "knomo-card-actions", attr: { role: "menu" } });
		for (const action of getMemoCardActions()) {
			renderCardAction(actions, memo.id, action.action, getMemoActionLabel(action.action), action.className);
		}
		actions.createDiv({
			cls: "knomo-card-word-count",
			text: t("card.wordCount", { count: getMemoContentStats(memo).wordCount }),
		});
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
	renderMemoCardTimeBuoy(card, options.timeBuoy);
	return card;
}

function renderMemoCardTime(container: HTMLElement, memo: MemoRecord, options: RenderMemoCardOptions): void {
	const attrs: Record<string, string> = {
		type: "button",
		"aria-label": t("card.openDaily"),
		"data-memo-time-open": "daily",
		"data-memo-id": memo.id,
	};
	if (options.randomCard) {
		attrs["data-random-reunion-card"] = "true";
	}
	container.createEl("button", {
		cls: "knomo-card-time",
		text: options.formatDisplayTime(memo.createdAt),
		attr: attrs,
	});
}

function renderMemoCardTimeBuoy(card: HTMLElement, timeBuoy: MemoCardTimeBuoy | undefined): void {
	if (timeBuoy === undefined) {
		return;
	}
	if (timeBuoy.status === "today") {
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
	const indicator = card.createSpan({
		cls: "knomo-card-time-buoy",
		attr: {
			role: "img",
			"aria-label": timeBuoy.label,
			"data-time-buoy-card": "true",
			"data-time-buoy-status": timeBuoy.status,
		},
	});
	setIcon(indicator, KNOMO_TIME_BUOY_ICON);
}

export function renderKnomoTrashMemoCard(container: HTMLElement, memo: MemoRecord, options: RenderTrashMemoCardOptions): HTMLElement {
	const markdownPriority = options.getMarkdownPriority(options.renderIndex);
	const card = container.createEl("article", {
		cls: getTrashMemoCardClass(options.busyAction),
		attr: { "data-memo-id": memo.id },
	});
	const head = card.createDiv({ cls: "knomo-card-head" });
	head.createDiv({ cls: "knomo-card-time", text: t("trash.createdAt", { time: options.formatDisplayTime(memo.createdAt) }) });
	const actions = head.createDiv({ cls: "knomo-trash-actions" });
	for (const action of getTrashCardActions(options.busyAction)) {
		renderTrashAction(
			actions,
			memo.id,
			action.action,
			getTrashActionLabel(action.action, action.state.busy),
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

	const meta = card.createDiv({ cls: "knomo-card-meta knomo-trash-meta" });
	meta.createDiv({ text: t("trash.deletedAt", { time: options.formatOptionalTime(memo.deletedAt) }) });
	if (memo.deleteSource !== undefined && memo.deleteSource.trim().length > 0) {
		meta.createDiv({ text: t("trash.deleteSource", { source: options.formatDeleteSource(memo.deleteSource) }) });
	}
	const warningText = getTrashMemoWarningText(memo);
	if (warningText !== null) {
		card.createDiv({
			cls: "knomo-card-warning",
			text: memo.issue === null ? options.formatSettingsText(warningText) : formatMemoIssue(memo.issue),
		});
	}
	return card;
}

interface RenderMemoCardBodyOptions {
	generation: number;
	markdownPriority: MarkdownRenderPriority;
	getMemoCardPreview: (memo: MemoRecord) => MemoCardPreview;
	queueMemoMarkdown: (memo: MemoRecord, container: HTMLElement, generation: number, priority: MarkdownRenderPriority, previewText: string) => void;
	renderMemoCardImages: (container: HTMLElement, memo: MemoRecord, images: MemoPreviewImage[], generation: number, reusedImagesEl?: HTMLElement | null) => void;
	reusedImagesEl?: HTMLElement | null;
}

export function renderMemoCardBody(card: HTMLElement, memo: MemoRecord, options: RenderMemoCardBodyOptions): HTMLElement {
	const preview = options.getMemoCardPreview(memo);
	const body = card.createDiv({ cls: "knomo-card-body" });
	if (preview.text.trim().length > 0) {
		const content = body.createDiv({ cls: "knomo-card-content markdown-rendered" });
		options.queueMemoMarkdown(memo, content, options.generation, options.markdownPriority, preview.text);
	}
	options.renderMemoCardImages(body, memo, preview.images, options.generation, options.reusedImagesEl ?? null);
	return body;
}

function renderCardMeta(card: HTMLElement, memo: MemoRecord, options: RenderMemoCardOptions): void {
	const sourceReference = getMemoSourceReferenceMeta(memo, options.deletedMemoIds);
	if (sourceReference.type !== "none") {
		const meta = card.createDiv({ cls: "knomo-card-meta knomo-source-reference markdown-rendered" });
		if (sourceReference.type === "plain") {
			meta.setText(`${t("reference.fromPrefix")}${sourceReference.sourceMemoId}`);
		} else {
			const referenceText = `${t("reference.fromPrefix")}${sourceReference.text}`;
			options.queueSourceReferenceMarkdown(
				meta,
				referenceText,
				sourceReference.sourcePath,
				options.generation,
			);
		}
	}
	const warningText = getMemoWarningText(memo);
	if (warningText !== null) {
		card.createDiv({
			cls: "knomo-card-warning",
			text: memo.issue === null ? options.formatSettingsText(warningText) : formatMemoIssue(memo.issue),
		});
	}
}

function renderCardAction(container: HTMLElement, memoId: string, action: MemoAction, label: string, className: string): void {
	container.createEl("button", {
		cls: className,
		text: label,
		attr: {
			type: "button",
			role: "menuitem",
			"data-memo-action": action,
			"data-memo-id": memoId,
		},
	});
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

function getMemoActionLabel(action: MemoAction): string {
	if (action === "edit") return t("card.edit");
	if (action === "reference") return t("card.reference");
	if (action === "open-daily") return t("card.openDaily");
	if (action === "copy-text") return t("card.copyText");
	if (action === "copy-link") return t("card.copyLink");
	return t("card.delete");
}

function getTrashActionLabel(action: TrashAction, busy: boolean): string {
	if (action === "restore") {
		return busy ? t("trash.restoring") : t("trash.restore");
	}
	return busy ? t("trash.purging") : t("trash.purge");
}
