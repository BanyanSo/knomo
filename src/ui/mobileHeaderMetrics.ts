export const MOBILE_DRAWER_TOP_DEFAULT = "max(calc(44px + env(safe-area-inset-top)), var(--header-height, 44px))";
export const MOBILE_SEARCH_TOP_DEFAULT = "max(14px, env(safe-area-inset-top))";

export interface MobileHeaderOffsets {
	drawerTop: number;
	searchTop: number;
}

const MOBILE_HEADER_SEARCH_ANCHOR_SELECTORS = [
	".view-actions .knomo-mobile-header-action",
	".view-actions",
	".view-header-title",
	".view-header-title-container",
];

export function measureMobileHeaderOffsets(headerEl: HTMLElement | null, viewportHeight: number): MobileHeaderOffsets | null {
	if (headerEl === null) {
		return null;
	}
	const headerRect = headerEl.getBoundingClientRect();
	if (!isUsableHeaderRect(headerRect, viewportHeight)) {
		return null;
	}
	return {
		drawerTop: Math.ceil(headerRect.bottom),
		searchTop: Math.round(measureMobileSearchTop(headerEl, headerRect, viewportHeight)),
	};
}

function measureMobileSearchTop(headerEl: HTMLElement, headerRect: DOMRect, viewportHeight: number): number {
	const HTMLElementConstructor = (headerEl.win as Window & { HTMLElement: typeof HTMLElement }).HTMLElement;
	for (const selector of MOBILE_HEADER_SEARCH_ANCHOR_SELECTORS) {
		const element = headerEl.querySelector(selector);
		if (!element?.instanceOf(HTMLElementConstructor)) {
			continue;
		}
		const rect = element.getBoundingClientRect();
		if (isUsableSearchAnchorRect(rect, viewportHeight)) {
			return rect.top;
		}
	}
	return headerRect.top;
}

function isUsableHeaderRect(rect: DOMRect, viewportHeight: number): boolean {
	return (
		Number.isFinite(rect.top) &&
		Number.isFinite(rect.bottom) &&
		Number.isFinite(rect.width) &&
		Number.isFinite(rect.height) &&
		rect.width > 0 &&
		rect.height > 0 &&
		rect.bottom > 0 &&
		rect.bottom <= viewportHeight / 2
	);
}

function isUsableSearchAnchorRect(rect: DOMRect, viewportHeight: number): boolean {
	return (
		Number.isFinite(rect.top) &&
		Number.isFinite(rect.bottom) &&
		Number.isFinite(rect.width) &&
		Number.isFinite(rect.height) &&
		rect.width > 0 &&
		rect.height > 0 &&
		rect.top >= 0 &&
		rect.top < viewportHeight / 2 &&
		rect.bottom > 0 &&
		rect.bottom <= viewportHeight / 2
	);
}
