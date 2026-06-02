import type { MemoRecord } from "../types/memo";
import { withMemoIdAlias } from "../utils/references";
import type { MemoAction, TrashAction } from "./KnomoActionDispatch";

export interface MemoCardShellOptions {
	memoId: string;
	renderIndex: number;
	randomCard: boolean;
	includeActions: boolean;
	activeMenuMemoId: string | null;
	getA11yId: (id: string) => string;
}

export interface MemoCardShell {
	className: string;
	attrs: Record<string, string>;
	randomCardDescriptionId: string | null;
}

export type MemoSourceReferenceMeta =
	| { type: "none" }
	| { type: "plain"; sourceMemoId: string }
	| { type: "markdown"; text: string; sourcePath: string };

export interface TrashActionState {
	disabled: boolean;
	busy: boolean;
}

export interface MemoCardActionMeta {
	action: MemoAction;
	className: string;
}

export interface TrashCardActionMeta {
	action: TrashAction;
	className: string;
	state: TrashActionState;
}

const MEMO_CARD_ACTIONS: readonly MemoAction[] = ["edit", "reference", "copy-text", "copy-link", "delete"];
const TRASH_CARD_ACTIONS: readonly TrashAction[] = ["restore", "purge"];

export function getMemoCardShell(options: MemoCardShellOptions): MemoCardShell {
	const attrs: Record<string, string> = { "data-memo-id": options.memoId };
	let randomCardDescriptionId: string | null = null;
	if (options.randomCard) {
		randomCardDescriptionId = options.getA11yId(`random-card-${options.renderIndex}-description`);
		attrs.tabindex = "0";
		attrs["aria-describedby"] = randomCardDescriptionId;
		attrs["data-random-reunion-card"] = "true";
	}
	return {
		className: options.includeActions && options.activeMenuMemoId === options.memoId
			? "knomo-card is-menu-open"
			: "knomo-card",
		attrs,
		randomCardDescriptionId,
	};
}

export function getTrashMemoCardClass(busyAction: TrashAction | null): string {
	return busyAction !== null ? "knomo-card knomo-trash-card is-busy" : "knomo-card knomo-trash-card";
}

export function getMemoActionClass(action: MemoAction): string {
	return action === "delete" ? "knomo-card-action is-danger" : "knomo-card-action";
}

export function getMemoCardActions(): MemoCardActionMeta[] {
	return MEMO_CARD_ACTIONS.map((action) => ({
		action,
		className: getMemoActionClass(action),
	}));
}

export function getTrashActionClass(action: TrashAction): string {
	return action === "purge" ? "knomo-inline-button is-danger" : "knomo-inline-button";
}

export function getTrashActionState(action: TrashAction, busyAction: TrashAction | null): TrashActionState {
	return {
		disabled: busyAction !== null,
		busy: busyAction === action,
	};
}

export function getTrashCardActions(busyAction: TrashAction | null): TrashCardActionMeta[] {
	return TRASH_CARD_ACTIONS.map((action) => ({
		action,
		className: getTrashActionClass(action),
		state: getTrashActionState(action, busyAction),
	}));
}

export function getMemoSourceReferenceMeta(memo: MemoRecord, deletedMemoIds: ReadonlySet<string>): MemoSourceReferenceMeta {
	if (memo.sourceMemoId === null || deletedMemoIds.has(memo.sourceMemoId)) {
		return { type: "none" };
	}
	const sourceReferenceText = getSourceReferenceText(memo);
	if (sourceReferenceText === null) {
		return { type: "plain", sourceMemoId: memo.sourceMemoId };
	}
	return {
		type: "markdown",
		text: sourceReferenceText,
		sourcePath: memo.dailyRef.path,
	};
}

export function getMemoWarningText(memo: MemoRecord): string | null {
	if (memo.syncStatus !== "synced") {
		return memo.issue?.message ?? memo.syncStatus;
	}
	return memo.issue?.message ?? null;
}

export function getTrashMemoWarningText(memo: MemoRecord): string | null {
	return memo.issue?.message ?? null;
}

function getSourceReferenceText(memo: MemoRecord): string | null {
	const sourceMemoId = memo.sourceMemoId ?? memo.references[0]?.memoId ?? null;
	const referenceText = memo.references[0]?.referenceText ?? null;
	if (sourceMemoId === null || referenceText === null) {
		return null;
	}
	return withMemoIdAlias(referenceText, sourceMemoId);
}
