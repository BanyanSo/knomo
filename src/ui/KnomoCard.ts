import { setIcon } from "obsidian";

import { t } from "../i18n";
import type { MemoRecord } from "../types/memo";
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

export interface RenderMemoCardOptions {
	generation: number;
	renderIndex: number;
	includeActions: boolean;
	randomCard: boolean;
	activeMenuMemoId: string | null;
	deletedMemoIds: ReadonlySet<string>;
	getA11yId: (id: string) => string;
	formatDisplayTime: (value: string) => string;
	formatSettingsText: (value: string) => string;
	getMarkdownPriority: (renderIndex: number) => MarkdownRenderPriority;
	queueMemoMarkdown: (memo: MemoRecord, container: HTMLElement, generation: number, priority: MarkdownRenderPriority) => void;
	queueSourceReferenceMarkdown: (container: HTMLElement, text: string, sourcePath: string, generation: number) => void;
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
	queueMemoMarkdown: (memo: MemoRecord, container: HTMLElement, generation: number, priority: MarkdownRenderPriority) => void;
}

export function renderKnomoMemoCard(container: HTMLElement, memo: MemoRecord, options: RenderMemoCardOptions): void {
	const markdownPriority = options.getMarkdownPriority(options.renderIndex);
	const shell = getMemoCardShell({
		memoId: memo.id,
		renderIndex: options.renderIndex,
		randomCard: options.randomCard,
		includeActions: options.includeActions,
		activeMenuMemoId: options.activeMenuMemoId,
		getA11yId: options.getA11yId,
	});
	const card = container.createEl("article", {
		cls: isCjkMemoContent(memo.contentSnapshot) ? `${shell.className} is-cjk-content` : shell.className,
		attr: shell.attrs,
	});
	if (shell.randomCardDescriptionId !== null) {
		card.createSpan({
			cls: "knomo-visually-hidden",
			text: t("card.openSourceHint"),
			attr: { id: shell.randomCardDescriptionId },
		});
	}
	const head = card.createDiv({ cls: "knomo-card-head" });
	head.createDiv({ cls: "knomo-card-time", text: options.formatDisplayTime(memo.createdAt) });
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
	}

	const content = card.createDiv({ cls: "knomo-card-content markdown-rendered" });
	options.queueMemoMarkdown(memo, content, options.generation, markdownPriority);
	renderCardMeta(card, memo, options);
}

export function renderKnomoTrashMemoCard(container: HTMLElement, memo: MemoRecord, options: RenderTrashMemoCardOptions): void {
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

	const content = card.createDiv({ cls: "knomo-card-content markdown-rendered" });
	options.queueMemoMarkdown(memo, content, options.generation, markdownPriority);

	const meta = card.createDiv({ cls: "knomo-card-meta knomo-trash-meta" });
	meta.createDiv({ text: t("trash.deletedAt", { time: options.formatOptionalTime(memo.deletedAt) }) });
	if (memo.deleteSource !== undefined && memo.deleteSource.trim().length > 0) {
		meta.createDiv({ text: t("trash.deleteSource", { source: options.formatDeleteSource(memo.deleteSource) }) });
	}
	const warningText = getTrashMemoWarningText(memo);
	if (warningText !== null) {
		card.createDiv({ cls: "knomo-card-warning", text: options.formatSettingsText(warningText) });
	}
}

function renderCardMeta(card: HTMLElement, memo: MemoRecord, options: RenderMemoCardOptions): void {
	const sourceReference = getMemoSourceReferenceMeta(memo, options.deletedMemoIds);
	if (sourceReference.type !== "none") {
		const meta = card.createDiv({ cls: "knomo-card-meta knomo-source-reference markdown-rendered" });
		if (sourceReference.type === "plain") {
			meta.setText(`${t("reference.fromPrefix")}${sourceReference.sourceMemoId}`);
		} else {
			options.queueSourceReferenceMarkdown(
				meta,
				`${t("reference.fromPrefix")}${sourceReference.text}`,
				sourceReference.sourcePath,
				options.generation,
			);
		}
	}
	const warningText = getMemoWarningText(memo);
	if (warningText !== null) {
		card.createDiv({ cls: "knomo-card-warning", text: options.formatSettingsText(warningText) });
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
