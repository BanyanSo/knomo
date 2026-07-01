export class ImagePreviewScrollLock {
	private cardFlowScrollTop: number | null = null;
	private mobileSearchScrollTop: number | null = null;

	lock(cardFlowEl: HTMLElement | null, mobileSearchResultsEl: HTMLElement | null): void {
		if (cardFlowEl !== null) {
			this.cardFlowScrollTop = cardFlowEl.scrollTop;
			cardFlowEl.addClass("is-image-preview-open");
		}
		if (mobileSearchResultsEl !== null) {
			this.mobileSearchScrollTop = mobileSearchResultsEl.scrollTop;
			mobileSearchResultsEl.addClass("is-image-preview-open");
		}
	}

	unlock(
		cardFlowEl: HTMLElement | null,
		mobileSearchResultsEl: HTMLElement | null,
		restoreCardFlowScrollTop: (scrollTop: number | null) => void,
	): void {
		if (cardFlowEl !== null) {
			cardFlowEl.removeClass("is-image-preview-open");
			restoreCardFlowScrollTop(this.cardFlowScrollTop);
		}
		this.cardFlowScrollTop = null;
		if (mobileSearchResultsEl !== null) {
			mobileSearchResultsEl.removeClass("is-image-preview-open");
			if (this.mobileSearchScrollTop !== null) {
				mobileSearchResultsEl.scrollTop = this.mobileSearchScrollTop;
			}
		}
		this.mobileSearchScrollTop = null;
	}
}
