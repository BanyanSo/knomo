import { t } from "../i18n";
import type { MemoRecord } from "../types/memo";
import type { CardFlowRenderMode } from "./KnomoCardFlow";
import type { ShuffleDaySnapshot } from "./ShuffleDayController";
import { getEmptyStateTitle } from "./viewNavigation";
import type { SidebarNav } from "./viewNavigation";

export interface CardFlowRegularFilterCopy {
	summary: string;
	emptyTitle: string;
}

export type CardFlowHeader =
	| { type: "summary"; text: string }
	| { type: "random-toolbar"; count: number }
	| { type: "shuffle-day"; selectedDate: string; stats: NonNullable<ShuffleDaySnapshot["stats"]> };

export type CardFlowPresentation =
	| {
		type: "empty";
		title: string;
		description: string;
	}
	| {
		type: "items";
		memos: MemoRecord[];
		mode: CardFlowRenderMode;
		headers: CardFlowHeader[];
	};

export interface CardFlowPresentationOptions {
	cardFlowError: string | null;
	activeNav: SidebarNav;
	randomReunionLoading: boolean;
	shuffleDay: ShuffleDaySnapshot;
	memos: MemoRecord[];
	regularFilterCopy: CardFlowRegularFilterCopy | null;
	trashLoading: boolean;
	trashError: string | null;
	trashMemos: MemoRecord[] | null;
}

export function getCardFlowPresentation(options: CardFlowPresentationOptions): CardFlowPresentation {
	if (options.cardFlowError !== null) {
		return {
			type: "empty",
			title: t("empty.cardFlowFailed"),
			description: options.cardFlowError,
		};
	}
	if (options.activeNav === "trash") {
		return getTrashCardFlowPresentation({
			trashLoading: options.trashLoading,
			trashError: options.trashError,
			trashMemos: options.trashMemos,
		});
	}
	if (options.activeNav === "random" && options.randomReunionLoading) {
		return {
			type: "empty",
			title: t("empty.randomLoading"),
			description: "",
		};
	}
	if (options.activeNav === "shuffleDay") {
		return getShuffleDayCardFlowPresentation(options.shuffleDay);
	}
	if (options.memos.length === 0) {
		return {
			type: "empty",
			title: options.regularFilterCopy?.emptyTitle ?? getEmptyStateTitle(options.activeNav),
			description: "",
		};
	}

	const headers: CardFlowHeader[] = [];
	if (options.activeNav === "review") {
		headers.push({ type: "summary", text: t("list.reviewSummary", { count: options.memos.length }) });
	}
	if (options.activeNav === "random") {
		headers.push({ type: "random-toolbar", count: options.memos.length });
	}
	if (options.regularFilterCopy !== null) {
		headers.push({ type: "summary", text: options.regularFilterCopy.summary });
	}
	return {
		type: "items",
		memos: options.memos,
		mode: "memo",
		headers,
	};
}

function getShuffleDayCardFlowPresentation(snapshot: ShuffleDaySnapshot): CardFlowPresentation {
	if (snapshot.status === "idle" || snapshot.status === "loading") {
		return {
			type: "empty",
			title: t("shuffleDay.loadingTitle"),
			description: "",
		};
	}
	if (snapshot.status === "empty-no-memos") {
		return {
			type: "empty",
			title: t("shuffleDay.emptyNoMemosTitle"),
			description: t("shuffleDay.emptyNoMemosDesc"),
		};
	}
	if (snapshot.status === "empty-not-enough-history") {
		return {
			type: "empty",
			title: t("shuffleDay.emptyNotEnoughTitle"),
			description: t("shuffleDay.emptyNotEnoughDesc"),
		};
	}
	if (snapshot.status === "empty-day-cleared") {
		return {
			type: "empty",
			title: t("shuffleDay.emptyDayClearedTitle"),
			description: t("shuffleDay.emptyDayClearedDesc"),
		};
	}
	if (snapshot.status === "failed") {
		return {
			type: "empty",
			title: t("shuffleDay.failedTitle"),
			description: t("shuffleDay.failedDesc"),
		};
	}
	if (snapshot.selectedDate === null || snapshot.stats === null || snapshot.memos.length === 0) {
		return {
			type: "empty",
			title: t("shuffleDay.emptyDayClearedTitle"),
			description: t("shuffleDay.emptyDayClearedDesc"),
		};
	}
	return {
		type: "items",
		memos: snapshot.memos,
		mode: "memo",
		headers: [{ type: "shuffle-day", selectedDate: snapshot.selectedDate, stats: snapshot.stats }],
	};
}

interface TrashCardFlowPresentationOptions {
	trashLoading: boolean;
	trashError: string | null;
	trashMemos: MemoRecord[] | null;
}

function getTrashCardFlowPresentation(options: TrashCardFlowPresentationOptions): CardFlowPresentation {
	if (options.trashLoading || options.trashMemos === null) {
		return {
			type: "empty",
			title: t("empty.trashLoading"),
			description: "",
		};
	}
	if (options.trashError !== null) {
		return {
			type: "empty",
			title: t("empty.trashFailed"),
			description: options.trashError,
		};
	}
	if (options.trashMemos.length === 0) {
		return {
			type: "empty",
			title: t("empty.trashEmptyTitle"),
			description: t("empty.trashEmptyDesc"),
		};
	}
	return {
		type: "items",
		memos: options.trashMemos,
		mode: "trash",
		headers: [],
	};
}
