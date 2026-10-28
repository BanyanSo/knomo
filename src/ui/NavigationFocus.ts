const pointerClicks = new WeakMap<Document, number>();
const pointerFocus = new WeakMap<Document, () => void>();

/** helper 的同步 click 保留触摸来源；不根据 detail=0 把合成触摸误判成键盘。 */
export function clickFromPointer(target: HTMLElement): void {
	const doc = target.ownerDocument;
	const depth = pointerClicks.get(doc) ?? 0;
	pointerClicks.set(doc, depth + 1);
	try { target.click(); }
	finally { if (depth) pointerClicks.set(doc, depth); else pointerClicks.delete(doc); }
}

export function isKeyboardActivation(event: MouseEvent | KeyboardEvent): boolean {
	if (event.type === "keydown" || event.type === "keyup") return true;
	const doc = (event.currentTarget as Node | null)?.ownerDocument ?? (event.target as Node | null)?.ownerDocument;
	return !(doc && pointerClicks.has(doc)) && event.detail === 0
		&& !(event as PointerEvent).pointerType
		&& !(event as MouseEvent & { sourceCapabilities?: { firesTouchEvents?: boolean } }).sourceCapabilities?.firesTouchEvents;
}

/** 只交接当前界面的焦点；可见弹层和被挂起的页面优先。 */
export function canFocusSurface(surface: HTMLElement, owner: HTMLElement = surface): boolean {
	const doc = surface.ownerDocument;
	if (!surface.isConnected || doc.visibilityState === "hidden" || surface.closest("[inert], [hidden], [aria-hidden='true']")) return false;
	const overlays = Array.from(doc.querySelectorAll<HTMLElement>(".modal-container, .menu, .suggestion-container, .suggestion-bg"))
		.filter(el => el.getClientRects().length > 0);
	return !overlays.some(el => el !== owner);
}

/** 焦点交接与焦点环独立：指针仍聚焦，后续键盘操作立即恢复宿主提示。 */
export function focusForNavigation(target: HTMLElement, focusVisible = true): void {
	const doc = target.ownerDocument;
	pointerFocus.get(doc)?.();
	if (!focusVisible) {
		target.setAttribute("data-knomo-pointer-focus", "");
		const clear = (): void => {
			target.removeAttribute("data-knomo-pointer-focus");
			target.removeEventListener("blur", clear);
			doc.removeEventListener("keydown", clear, true);
			if (pointerFocus.get(doc) === clear) pointerFocus.delete(doc);
		};
		pointerFocus.set(doc, clear);
		target.addEventListener("blur", clear, { once: true });
		doc.addEventListener("keydown", clear, true);
	}
	target.focus({ preventScroll: true });
}

export function releaseNavigationFocus(surface: HTMLElement): void {
	if (surface.matches("[data-knomo-pointer-focus]") || surface.querySelector("[data-knomo-pointer-focus]")) pointerFocus.get(surface.ownerDocument)?.();
}
