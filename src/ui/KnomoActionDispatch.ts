export type ComposerToolAction = "insert-tag" | "insert-image" | "insert-list" | "insert-numbered-list";
export type MemoAction = "edit" | "reference" | "open-daily" | "copy-text" | "copy-link" | "delete";
export type TrashAction = "restore" | "purge";
export type KnomoSimpleAction =
	| "toggle-card-menu"
	| "refresh-random-reunion"
	| "load-more"
	| "load-more-mobile-search"
	| "reset-list-state"
	| "close-mobile-search"
	| "open-drawer"
	| "close-drawer"
	| "toggle-scope-menu"
	| "toggle-sidebar"
	| "collapse-sidebar"
	| "refresh"
	| "focus-stats"
	| "record-stats-previous"
	| "record-stats-next"
	| "record-stats-retry"
	| "record-stats-view-week"
	| "record-stats-view-month"
	| "record-stats-view-year"
	| "record-stats-filter-trend"
	| "record-stats-filter-hour"
	| "record-stats-filter-notes"
	| "record-stats-filter-references"
	| "record-stats-filter-max-daily-notes"
	| "record-stats-filter-max-daily-words"
	| "open-composer"
	| "close-composer"
	| "toggle-compact-search"
	| "clear-reference"
	| "cancel-edit"
	| "save-input";

export type KnomoActionDispatch =
	| { type: "none" }
	| { type: KnomoSimpleAction }
	| { type: "composer-tool"; action: ComposerToolAction }
	| { type: "unknown"; action: string };

export type MemoActionDispatch =
	| { type: "none" }
	| { type: "memo-action"; action: MemoAction }
	| { type: "unknown"; action: string };

export type TrashActionDispatch =
	| { type: "none" }
	| { type: "trash-action"; action: TrashAction }
	| { type: "unknown"; action: string };

export function getKnomoActionDispatch(action: string | null): KnomoActionDispatch {
	if (action === null) return { type: "none" };
	if (isComposerToolAction(action)) return { type: "composer-tool", action };
	if (
		action === "toggle-card-menu" ||
		action === "refresh-random-reunion" ||
		action === "load-more" ||
		action === "load-more-mobile-search" ||
		action === "reset-list-state" ||
		action === "close-mobile-search" ||
		action === "open-drawer" ||
		action === "close-drawer" ||
		action === "toggle-scope-menu" ||
		action === "toggle-sidebar" ||
		action === "collapse-sidebar" ||
		action === "refresh" ||
		action === "focus-stats" ||
		action === "record-stats-previous" ||
		action === "record-stats-next" ||
		action === "record-stats-retry" ||
		action === "record-stats-view-week" ||
		action === "record-stats-view-month" ||
		action === "record-stats-view-year" ||
		action === "record-stats-filter-trend" ||
		action === "record-stats-filter-hour" ||
		action === "record-stats-filter-notes" ||
		action === "record-stats-filter-references" ||
		action === "record-stats-filter-max-daily-notes" ||
		action === "record-stats-filter-max-daily-words" ||
		action === "open-composer" ||
		action === "close-composer" ||
		action === "toggle-compact-search" ||
		action === "clear-reference" ||
		action === "cancel-edit" ||
		action === "save-input"
	) {
		return { type: action };
	}
	return { type: "unknown", action };
}

export function shouldRenderAfterActionDispatch(dispatch: KnomoActionDispatch): boolean {
	return dispatch.type === "open-drawer" ||
		dispatch.type === "close-drawer" ||
		dispatch.type === "toggle-scope-menu" ||
		dispatch.type === "toggle-sidebar" ||
		dispatch.type === "collapse-sidebar" ||
		dispatch.type === "focus-stats" ||
		dispatch.type === "toggle-compact-search" ||
		dispatch.type === "unknown";
}

export function getMemoActionDispatch(action: string | null): MemoActionDispatch {
	if (action === null) return { type: "none" };
	if (isMemoAction(action)) return { type: "memo-action", action };
	return { type: "unknown", action };
}

export function getTrashActionDispatch(action: string | null): TrashActionDispatch {
	if (action === null) return { type: "none" };
	if (isTrashAction(action)) return { type: "trash-action", action };
	return { type: "unknown", action };
}

export function isComposerToolAction(action: string): action is ComposerToolAction {
	return action === "insert-tag" ||
		action === "insert-image" ||
		action === "insert-list" ||
		action === "insert-numbered-list";
}

export function isMemoAction(action: string): action is MemoAction {
	return action === "edit" ||
		action === "reference" ||
		action === "open-daily" ||
		action === "copy-text" ||
		action === "copy-link" ||
		action === "delete";
}

export function isTrashAction(action: string): action is TrashAction {
	return action === "restore" || action === "purge";
}
