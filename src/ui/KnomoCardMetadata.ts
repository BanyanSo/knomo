import type { MemoViewItem as MemoRecord } from "../types/memoView";
import { getPreferredMemoBlockReferenceText, stripTrailingWikiLink } from "../utils/references";
import type { MemoAction, TrashAction } from "./KnomoActionDispatch";

export interface MemoCardShellOptions {
	memoId: string;
	renderKey?: string;
	includeActions: boolean;
	activeMenuMemoId: string | null;
}

export interface MemoCardShell {
	className: string;
	attrs: Record<string, string>;
}

export type MemoSourceReferenceMeta =
	| { type: "none" }
	| { type: "markdown"; text: string; sourcePath: string };

export interface TrashActionState {
	disabled: boolean;
	busy: boolean;
}

export interface MemoCardActionMeta {
	action: MemoAction;
	className: string;
	candidateMemoId?: string;
}

export type MemoCardActionExplanation = "identity-actions-paused" | null;

export interface TrashCardActionMeta {
	action: TrashAction;
	className: string;
	state: TrashActionState;
}

const MEMO_CARD_ACTIONS: readonly MemoAction[] = ["edit", "reference", "open-daily", "copy-text", "copy-link", "delete"];
const TRASH_CARD_ACTIONS: readonly TrashAction[] = ["restore", "purge"];
const CJK_CONTENT_MIN_HAN_COUNT = 8;
const CJK_CONTENT_MIN_HAN_RATIO = 0.25;
const HAN_CHARACTER_PATTERN = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/g;

export function isCjkMemoContent(content: string): boolean {
	const visibleText = getVisibleMemoText(content);
	if (visibleText.length === 0) {
		return false;
	}
	const hanCount = (visibleText.match(HAN_CHARACTER_PATTERN) ?? []).length;
	return hanCount >= CJK_CONTENT_MIN_HAN_COUNT && hanCount / visibleText.length >= CJK_CONTENT_MIN_HAN_RATIO;
}

export function getMemoCardShell(options: MemoCardShellOptions): MemoCardShell {
	const attrs: Record<string, string> = {
		"data-memo-id": options.memoId,
		"data-memo-render-key": options.renderKey ?? options.memoId,
	};
	const className = options.includeActions ? "knomo-card has-card-actions" : "knomo-card";
	return {
		className: options.includeActions && options.activeMenuMemoId === options.memoId
			? `${className} is-menu-open`
			: className,
		attrs,
	};
}

export function getTrashMemoCardClass(busyAction: TrashAction | null): string {
	return busyAction !== null ? "knomo-card knomo-trash-card is-busy" : "knomo-card knomo-trash-card";
}

export function getMemoActionClass(action: MemoAction): string {
	return action === "delete" ? "knomo-card-action is-danger" : "knomo-card-action";
}

export function getMemoCardActions(memo?: MemoRecord): MemoCardActionMeta[] {
	const actions = MEMO_CARD_ACTIONS.filter((action) => isMemoActionAvailable(memo, action)).map((action) => ({
		action,
		className: getMemoActionClass(action),
	}));
	const resolved = memo?.catalog?.resolved;
	if (memo?.catalog?.capabilities.identity.repair !== "ready" || resolved?.kind !== "ambiguous") {
		return actions;
	}
	const repairs = [...new Set(resolved.candidates.map((candidate) => candidate.memoId))].sort().map((candidateMemoId) => ({
		action: "confirm-identity" as const,
		className: getMemoActionClass("confirm-identity"),
		candidateMemoId,
	}));
	return [...actions, ...repairs];
}

export function getMemoCardActionExplanation(memo: MemoRecord): MemoCardActionExplanation {
	const identity = memo.catalog?.capabilities.identity;
	return identity?.recoverableDelete === "conflicted" && identity.repair !== "ready"
		? "identity-actions-paused"
		: null;
}

export type MemoDeleteMode = "recoverable" | "permanent" | "unavailable";

export function isMemoCardMenuReady(memo: MemoRecord): boolean {
	const capabilities = memo.catalog?.capabilities;
	if (capabilities === undefined) return true;
	return capabilities.markdown.view
		&& capabilities.markdown.copy
		&& capabilities.markdown.openDaily;
}

function isMemoActionAvailable(memo: MemoRecord | undefined, action: MemoAction): boolean {
	const capabilities = memo?.catalog?.capabilities;
	if (capabilities === undefined) return true;
	if (action === "open-daily") return capabilities.markdown.openDaily;
	if (action === "copy-text") return capabilities.markdown.copy;
	if (action === "edit") return capabilities.markdown.edit;
	if (action === "delete") return memo === undefined || getMemoDeleteMode(memo) !== "unavailable";
	if (action === "reference" || action === "copy-link") return capabilities.markdown.explicitBlockReference;
	return false;
}

export function getTrashActionClass(action: TrashAction): string {
	return action === "purge" ? "knomo-inline-button is-danger" : "knomo-inline-button";
}

export function getTrashActionState(
	action: TrashAction,
	busyAction: TrashAction | null,
	purgeAllowed = true,
): TrashActionState {
	return {
		disabled: busyAction !== null || (action === "purge" && !purgeAllowed),
		busy: busyAction === action,
	};
}

export function getTrashCardActions(busyAction: TrashAction | null, purgeAllowed: boolean): TrashCardActionMeta[] {
	return TRASH_CARD_ACTIONS.map((action) => ({
		action,
		className: getTrashActionClass(action),
		state: getTrashActionState(action, busyAction, purgeAllowed),
	}));
}

export function getMemoSourceReferenceMeta(memo: MemoRecord, deletedMemoIds: ReadonlySet<string>): MemoSourceReferenceMeta {
	if (memo.sourceMemoId !== null && deletedMemoIds.has(memo.sourceMemoId)) {
		return { type: "none" };
	}
	const sourceReferenceText = getSourceReferenceText(memo);
	if (sourceReferenceText !== null) {
		return {
			type: "markdown",
			text: sourceReferenceText,
			sourcePath: memo.dailyRef.path,
		};
	}
	return { type: "none" };
}

function getSourceReferenceText(memo: MemoRecord): string | null {
	const referenceText = memo.references[0]?.referenceText
		?? getPreferredMemoBlockReferenceText(memo.contentSnapshot);
	return referenceText;
}

export function getMemoDisplayContent(memo: MemoRecord): string {
	return getSourceReferenceText(memo) === null
		? memo.contentSnapshot
		: stripTrailingWikiLink(memo.contentSnapshot);
}

export function getMemoDeleteMode(memo: MemoRecord): MemoDeleteMode {
	const capabilities = memo.catalog?.capabilities;
	if (capabilities === undefined || capabilities.identity.recoverableDelete === "ready") {
		return "recoverable";
	}
	return capabilities.identity.recoverableDelete === "absent" && capabilities.markdown.remove
		? "permanent"
		: "unavailable";
}

function getVisibleMemoText(content: string): string {
	return content
		.replace(/```[\s\S]*?```/g, " ")
		.replace(/`[^`\n]*`/g, " ")
		.replace(/!\[[^\]]*\]\([^)]+\)/g, " ")
		.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
		.replace(/!?\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_match: string, target: string, alias: string | undefined) => {
			return alias ?? target;
		})
		.replace(/^#{1,6}\s+/gm, "")
		.replace(/^>\s?/gm, "")
		.replace(/^\s*[-*+]\s+/gm, "")
		.replace(/^\s*\d+[.)]\s+/gm, "")
		.replace(/[*_~#>[\]()`]/g, "")
		.replace(/\s+/g, "");
}
