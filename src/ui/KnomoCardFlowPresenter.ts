import { t } from "../i18n";
import type { MemoViewItem as MemoRecord } from "../types/memoView";
import type { CardFlowRenderMode } from "./KnomoCardFlow";
import type { RandomReunionStatus } from "./RandomReunionController";
import type { ShuffleDaySnapshot } from "./ShuffleDayController";
import { getEmptyStateTitle } from "./viewNavigation";
import type { SidebarNav } from "./viewNavigation";

export interface CardFlowRegularFilterCopy {
	summary: string;
	emptyTitle: string;
}

export type CardFlowHeader =
	| { type: "summary"; text: string; action?: { label: string; action: string }; feedback?: boolean }
	| { type: "random-toolbar"; count: number }
	| { type: "trash-toolbar"; count: number; busy: boolean }
	| { type: "random-day"; selectedDate: string; stats: ShuffleDaySnapshot["stats"] }
	| { type: "shuffle-day"; selectedDate: string; stats: NonNullable<ShuffleDaySnapshot["stats"]> };

export type CardFlowPresentation =
	| {
		type: "empty";
		title: string;
		description: string;
		headers?: CardFlowHeader[];
		loading?: boolean;
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
	randomReunionStatus: RandomReunionStatus;
	randomReunionError: string | null;
	shuffleDay: ShuffleDaySnapshot;
	randomDay?: ShuffleDaySnapshot;
	memos: MemoRecord[];
	matchedTotalCount: number | null;
	regularFilterCopy: CardFlowRegularFilterCopy | null;
	trashLoading: boolean;
	trashError: string | null;
	trashMemos: MemoRecord[] | null;
	trashCount: number | null;
	trashClearBusy: boolean;
}

export function getCardFlowPresentation(options: CardFlowPresentationOptions): CardFlowPresentation {
	if (options.activeNav === "random" && options.randomDay?.selectedDate) {
		const snapshot = options.randomDay;
		const presentation = getShuffleDayCardFlowPresentation(snapshot, "retry-random-day");
		if (presentation.type === "empty") {
			if (snapshot.status === "idle" || snapshot.status === "loading") presentation.title = t("random.dayLoading");
			if (snapshot.status === "failed") presentation.title = t("random.dayFailed");
			presentation.loading = snapshot.status === "loading";
		}
		presentation.headers = [{ type: "random-day", selectedDate: snapshot.selectedDate!, stats: snapshot.stats },
			...(presentation.headers ?? []).filter(header => header.type !== "shuffle-day")];
		return presentation;
	}
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
			trashCount: options.trashCount,
			trashClearBusy: options.trashClearBusy,
		});
	}
	if (options.activeNav === "random") {
		if ((options.randomReunionStatus === "idle" || options.randomReunionStatus === "loading-candidates")
			&& options.memos.length === 0) {
			return {
				type: "empty",
				title: t("empty.randomLoading"),
				description: "",
			};
		}

		if (options.randomReunionStatus === "failed") {
			return {
				type: "empty",
				title: t("error.randomLoadFailed"),
				description: options.randomReunionError ?? "",
				headers: [{ type: "random-toolbar", count: 0 }],
			};
		}
	}
	if (options.activeNav === "shuffleDay") {
		return getShuffleDayCardFlowPresentation(options.shuffleDay);
	}
	if (options.memos.length === 0) {
		return {
			type: "empty",
			title: options.regularFilterCopy?.emptyTitle ?? getEmptyStateTitle(options.activeNav),
			description: "",
			...(options.activeNav === "random" ? { headers: [{ type: "random-toolbar" as const, count: 0 },
				...(options.randomReunionError ? [{ type: "summary" as const, text: options.randomReunionError, feedback: true }] : [])] } : {}),
		};
	}

	const headers: CardFlowHeader[] = [];
	if (options.activeNav === "review" && options.matchedTotalCount !== null) {
		headers.push({ type: "summary", text: t("list.reviewSummary", { count: options.matchedTotalCount }) });
	}
	if (options.activeNav === "random") {
		headers.push({ type: "random-toolbar", count: options.memos.length });
		if (options.randomReunionError) headers.push({ type: "summary", text: options.randomReunionError, feedback: true });
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

function getShuffleDayCardFlowPresentation(snapshot: ShuffleDaySnapshot, retryAction = "refresh-shuffle-day"): CardFlowPresentation {
	const action = { label: t("settings.attention.retry"), action: retryAction };
	const feedback: CardFlowHeader[] = [snapshot.error, snapshot.historyError].filter((text): text is string => !!text)
		.map(text => ({ type: "summary", text, feedback: true, ...(text === snapshot.error ? { action } : {}) }));
	const retry: CardFlowHeader = { type: "summary", text: "", action };
	if (snapshot.status === "idle" || (snapshot.status === "loading"
		&& (snapshot.selectedDate === null || snapshot.stats === null || snapshot.memos.length === 0))) {
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
			headers: [...feedback, retry],
		};
	}
	if (snapshot.status === "failed") {
		return {
			type: "empty",
			title: t("shuffleDay.failedTitle"),
			description: snapshot.error ?? t("shuffleDay.failedDesc"),
			headers: [retry],
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
		headers: [{ type: "shuffle-day", selectedDate: snapshot.selectedDate, stats: snapshot.stats }, ...feedback],
	};
}

interface TrashCardFlowPresentationOptions {
	trashLoading: boolean;
	trashError: string | null;
	trashMemos: MemoRecord[] | null;
	trashCount: number | null;
	trashClearBusy: boolean;
}

function getTrashCardFlowPresentation(options: TrashCardFlowPresentationOptions): CardFlowPresentation {
	if (options.trashError !== null) {
		return {
			type: "empty",
			title: t("empty.trashFailed"),
			description: options.trashError,
		};
	}
	if (options.trashMemos === null) {
		return {
			type: "empty",
			title: t("empty.trashLoading"),
			description: "",
		};
	}
	if (options.trashMemos.length > 0) {
		return {
			type: "items",
			memos: options.trashMemos,
			mode: "trash",
			headers: !options.trashLoading && options.trashCount !== null && options.trashCount > 0
				? [{ type: "trash-toolbar", count: options.trashCount, busy: options.trashClearBusy }] : [],
		};
	}

	return {
		type: "empty",
		title: t("empty.trashEmptyTitle"),
		description: t("empty.trashEmptyDesc"),
	};
}
