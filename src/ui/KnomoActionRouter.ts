export type RootClickRoute =
	| { type: "tag-toggle"; element: HTMLElement; tag: string | null }
	| { type: "tag"; element: HTMLElement; tag: string | null; tagKey: string | null }
	| { type: "nav"; element: HTMLElement; nav: string | null }
	| { type: "title-mode"; element: HTMLElement; mode: string | null }
	| { type: "search-date"; element: HTMLElement; filter: string | null }
	| { type: "trash-action"; element: HTMLElement; memoId: string | null; action: string | null }
	| { type: "memo-action"; element: HTMLElement; memoId: string | null; action: string | null }
	| { type: "action"; element: HTMLElement; memoId: string | null; action: string | null; mobileToolButtonEl: HTMLElement | null }
	| { type: "random-reunion-card"; element: HTMLElement; memoId: string | null }
	| {
		type: "outside";
		closeCardMenu: boolean;
		closeScopeMenu: boolean;
		closeDesktopSearch: boolean;
		closeCompactSearch: boolean;
	};

export function getRootClickRoute(target: Element, mobile: boolean): RootClickRoute {
	const tagToggleEl = closestHTMLElement(target, "[data-tag-toggle]");
	if (tagToggleEl !== null) {
		return { type: "tag-toggle", element: tagToggleEl, tag: tagToggleEl.getAttr("data-tag-toggle") };
	}

	const tagEl = closestHTMLElement(target, "[data-tag]");
	if (tagEl !== null) {
		return {
			type: "tag",
			element: tagEl,
			tag: tagEl.getAttr("data-tag"),
			tagKey: tagEl.getAttr("data-tag-key"),
		};
	}

	const navEl = closestHTMLElement(target, "[data-nav]");
	if (navEl !== null) {
		return { type: "nav", element: navEl, nav: navEl.getAttr("data-nav") };
	}

	const titleModeEl = closestHTMLElement(target, "[data-title-mode]");
	if (titleModeEl !== null) {
		return { type: "title-mode", element: titleModeEl, mode: titleModeEl.getAttr("data-title-mode") };
	}

	const searchDateEl = closestHTMLElement(target, "[data-search-date]");
	if (searchDateEl !== null) {
		return { type: "search-date", element: searchDateEl, filter: searchDateEl.getAttr("data-search-date") };
	}

	const trashActionEl = closestHTMLElement(target, "[data-trash-action]");
	if (trashActionEl !== null) {
		return {
			type: "trash-action",
			element: trashActionEl,
			memoId: trashActionEl.getAttr("data-memo-id"),
			action: trashActionEl.getAttr("data-trash-action"),
		};
	}

	const memoActionEl = closestHTMLElement(target, "[data-memo-action]");
	if (memoActionEl !== null) {
		return {
			type: "memo-action",
			element: memoActionEl,
			memoId: memoActionEl.getAttr("data-memo-id"),
			action: memoActionEl.getAttr("data-memo-action"),
		};
	}

	const actionEl = closestHTMLElement(target, "[data-action]");
	if (actionEl !== null) {
		const mobileToolButtonEl = mobile ? closestHTMLElement(target, ".knomo-tool-button") : null;
		return {
			type: "action",
			element: actionEl,
			memoId: actionEl.getAttr("data-memo-id"),
			action: actionEl.getAttr("data-action"),
			mobileToolButtonEl,
		};
	}

	const randomReunionCardEl = getRandomReunionCardRoute(target);
	if (randomReunionCardEl !== null) {
		return {
			type: "random-reunion-card",
			element: randomReunionCardEl,
			memoId: randomReunionCardEl.getAttr("data-memo-id"),
		};
	}

	return {
		type: "outside",
		closeCardMenu: target.closest(".knomo-card-actions") === null && target.closest(".knomo-card-menu") === null,
		closeScopeMenu: target.closest(".knomo-scope-popover") === null && target.closest("[data-action='toggle-scope-menu']") === null,
		closeDesktopSearch: target.closest(".knomo-search-wrap, .knomo-compact-search-wrap, .knomo-search-menu") === null,
		closeCompactSearch: target.closest(".knomo-compact-search-panel") === null && target.closest("[data-action='toggle-compact-search']") === null,
	};
}

export function getRandomReunionCardRoute(target: Element): HTMLElement | null {
	const randomReunionCardEl = closestHTMLElement(target, "[data-random-reunion-card]");
	if (randomReunionCardEl === null || !shouldOpenRandomReunionCard(target)) {
		return null;
	}
	return randomReunionCardEl;
}

export function getComposerToolButtonRoute(target: Element): { element: HTMLElement; action: string | null } | null {
	const toolButtonEl = closestHTMLElement(target, ".knomo-tool-button");
	if (toolButtonEl === null) {
		return null;
	}
	return {
		element: toolButtonEl,
		action: toolButtonEl.getAttr("data-action"),
	};
}

export function shouldOpenRandomReunionCard(target: Element): boolean {
	return target.closest("a, button, input, textarea, select, [data-tag], .knomo-card-actions, .knomo-card-menu") === null;
}

function closestHTMLElement(target: Element, selector: string): HTMLElement | null {
	const element = target.closest(selector);
	return element?.instanceOf(HTMLElement) ? element : null;
}
