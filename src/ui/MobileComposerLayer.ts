export interface MobileComposerLayerElements {
	layerEl: HTMLElement;
	backdropEl: HTMLElement;
	contentEl: HTMLElement;
}

export interface MobileComposerLayerPlacement {
	homeEl: HTMLElement | null;
	nextSibling: ChildNode | null;
}

export function createMobileComposerLayer(doc: Document): MobileComposerLayerElements {
	const layerEl = doc.body.createDiv({
		cls: "knomo-plugin knomo-mobile-composer-layer is-layout-mobile",
	});
	const backdropEl = layerEl.createDiv({
		cls: "knomo-mobile-composer-backdrop",
	});
	const stage = layerEl.createDiv({
		cls: "knomo-mobile-composer-stage",
	});
	const contentEl = stage.createDiv({
		cls: "knomo-mobile-composer-content",
	});
	backdropEl.setAttr("aria-hidden", "true");
	return { layerEl, backdropEl, contentEl };
}

export function attachMobileComposerLayer(doc: Document, layerEl: HTMLElement): void {
	if (layerEl.parentElement === null) {
		doc.body.appendChild(layerEl);
	}
}

export function moveComposerToMobileLayer(
	composerEl: HTMLElement,
	contentEl: HTMLElement,
): MobileComposerLayerPlacement | null {
	if (composerEl.parentElement === contentEl) {
		return null;
	}
	const placement: MobileComposerLayerPlacement = {
		homeEl: composerEl.parentElement,
		nextSibling: composerEl.nextSibling,
	};
	contentEl.appendChild(composerEl);
	return placement;
}

export function restoreComposerFromMobileLayer(
	composerEl: HTMLElement | null,
	contentEl: HTMLElement | null,
	homeEl: HTMLElement | null,
	nextSibling: ChildNode | null,
): void {
	if (composerEl === null || contentEl === null || homeEl === null || composerEl.parentElement !== contentEl) {
		return;
	}
	if (nextSibling !== null && nextSibling.parentNode === homeEl) {
		homeEl.insertBefore(composerEl, nextSibling);
	} else {
		homeEl.appendChild(composerEl);
	}
}

export function clearMobileComposerLayerState(layerEl: HTMLElement | null): void {
	layerEl?.toggleClass("is-open", false);
	layerEl?.toggleClass("is-closing", false);
	layerEl?.toggleClass("is-keyboard-open", false);
	layerEl?.toggleClass("is-keyboard-tracking", false);
}

export function isComposerInMobileLayer(composerEl: HTMLElement | null, contentEl: HTMLElement | null): boolean {
	return composerEl !== null && contentEl !== null && composerEl.parentElement === contentEl;
}
