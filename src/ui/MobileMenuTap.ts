// 菜单的轻触直接沿宿主 click 路径执行；滚动、拖动、多指和长按交还宿主。
export function registerMobileMenuTap(menu: HTMLElement, backdrop: HTMLElement, dismiss: () => void): () => void {
	return registerMenuTap(menu.ownerDocument, target => {
		const item = target.closest<HTMLElement>(".menu-item:not(.is-disabled):not(.is-label)");
		// 只有编辑/引用在失焦时保留原生触摸，由 View 在窗口激活后恢复动作。
		if (item?.querySelector("[data-knomo-menu-input]") && !menu.ownerDocument.hasFocus()) return null;
		return backdrop.contains(target) ? backdrop : item?.closest(".menu") === menu ? item : null;
	}, surface => { if (surface === backdrop) dismiss(); else surface.click(); });
}

// 仅补齐本视图的两个菜单入口；iOS 失焦时首次触摸可能没有兼容 click。
export function registerMobileMenuTriggerTap(doc: Document, resolve: (target: Element) => HTMLElement | null): () => void {
	const win = doc.defaultView!;
	let activated: { surface: HTMLElement; until: number } | null = null;
	const reset = (): void => { activated = null; };
	const click = (event: MouseEvent): void => {
		if (event.detail === 0 || !activated || Date.now() > activated.until) return;
		if (event.target instanceof win.Node && activated.surface.contains(event.target)) {
			reset();
			event.preventDefault();
			event.stopImmediatePropagation();
		}
	};
	win.addEventListener("pointerdown", reset, true);
	win.addEventListener("touchstart", reset, true);
	win.addEventListener("click", click, true);
	const release = registerMenuTap(doc, resolve, surface => {
		activated = { surface, until: Date.now() + 600 };
		// 沿用原有 click 路由；detail=0 不会被本轮兼容点击去重拦截。
		surface.click();
	});
	return () => {
		release(); reset();
		win.removeEventListener("pointerdown", reset, true);
		win.removeEventListener("touchstart", reset, true);
		win.removeEventListener("click", click, true);
	};
}

function registerMenuTap(doc: Document, resolve: (target: Element) => HTMLElement | null, activate: (surface: HTMLElement, event: TouchEvent) => void,
	options: { canStart?: () => boolean; preserveNative?: boolean } = {}): () => void {
	const win = doc.defaultView!;
	let releaseGesture: (() => void) | null = null;
	const cancel = (): void => { releaseGesture?.(); releaseGesture = null; };
	const start = (event: TouchEvent): void => {
		cancel();
		if (event.defaultPrevented || event.touches.length !== 1 || options.canStart?.() === false) return;
		const target = event.target;
		if (!(target instanceof win.Element)) return;
		const surface = resolve(target);
		if (!surface) return;
		const first = event.touches[0];
		const began = event.timeStamp;
		const point = (next: TouchEvent): Touch | undefined => Array.from(next.changedTouches).find(touch => touch.identifier === first.identifier);
		const move = (next: TouchEvent): void => {
			const touch = point(next);
			if (next.defaultPrevented || next.touches.length !== 1 || (touch && Math.hypot(touch.clientX - first.clientX, touch.clientY - first.clientY) > 8)) cancel();
		};
		const end = (next: TouchEvent): void => {
			cancel();
			const touch = point(next);
			if (options.canStart?.() === false || next.defaultPrevented || !next.cancelable || next.touches.length !== 0 || !touch
				|| next.timeStamp - began > 600 || !surface.isConnected || resolve(surface) !== surface
				|| Math.hypot(touch.clientX - first.clientX, touch.clientY - first.clientY) > 8) return;
			const hit = doc.elementFromPoint(touch.clientX, touch.clientY);
			if (!hit || !surface.contains(hit)) return;
			// 取消 iOS 后续的兼容鼠标事件，避免关闭后穿透或二次执行。
			if (!options.preserveNative) next.preventDefault();
			activate(surface, next);
		};
		const scroll = (next: Event): void => {
			const target = next.target;
			if (target === win || target instanceof win.Node && (target.contains(surface) || surface.contains(target))) cancel();
		};
		// 在 touchstart 冒泡到 window 后注册，先让宿主手势处理 move/end。
		win.addEventListener("touchmove", move, { passive: true });
		win.addEventListener("touchend", end, { passive: false });
		win.addEventListener("touchcancel", cancel);
		win.addEventListener("pointercancel", cancel);
		win.addEventListener("pagehide", cancel);
		doc.addEventListener("visibilitychange", cancel);
		win.addEventListener("scroll", scroll, true);
		win.addEventListener("blur", cancel);
		releaseGesture = () => {
			win.removeEventListener("touchmove", move);
			win.removeEventListener("touchend", end);
			win.removeEventListener("touchcancel", cancel);
			win.removeEventListener("pointercancel", cancel);
			win.removeEventListener("pagehide", cancel);
			doc.removeEventListener("visibilitychange", cancel);
			win.removeEventListener("scroll", scroll, true);
			win.removeEventListener("blur", cancel);
		};
	};
	win.addEventListener("touchstart", start, { passive: true });
	return () => { cancel(); win.removeEventListener("touchstart", start); };
}

/** 失焦首击让原生触摸先激活窗口；只有 click 确实缺失时才补执行一次。 */
export function registerMobileFirstTapRecovery(doc: Document, resolve: (target: Element) => HTMLElement | null): () => void {
	const win = doc.defaultView!;
	let beganUnfocused = false;
	let pointerBegan = false;
	let timer: number | null = null;
	let pending: { surface: HTMLElement; event: TouchEvent; until: number; x: number; y: number } | null = null;
	let replayed: { surface: HTMLElement; until: number; x: number; y: number } | null = null;
	const clear = (): void => {
		if (timer !== null) win.clearTimeout(timer);
		timer = null;
		pending = null;
	};
	const cancel = (): void => { clear(); replayed = null; beganUnfocused = false; pointerBegan = false; };
	const pointerdown = (event: PointerEvent): void => {
		cancel();
		pointerBegan = event.pointerType === "touch";
		beganUnfocused = pointerBegan && !doc.hasFocus();
	};
	const touchstart = (): void => {
		clear(); replayed = null;
		if (!pointerBegan) beganUnfocused = !doc.hasFocus();
		pointerBegan = false;
	};
	const click = (event: MouseEvent): void => {
		clear();
		if (!replayed || event.detail === 0 || win.performance.now() > replayed.until) return;
		if ((event.target instanceof win.Node && replayed.surface.contains(event.target))
			|| Math.hypot(event.clientX - replayed.x, event.clientY - replayed.y) <= 8) {
			replayed = null;
			event.preventDefault();
			event.stopImmediatePropagation();
		}
	};
	const run = (): void => {
		timer = null;
		const tap = pending;
		if (!tap) return;
		if (tap.event.defaultPrevented || doc.visibilityState !== "visible" || win.performance.now() > tap.until
			|| !tap.surface.isConnected || resolve(tap.surface) !== tap.surface) { clear(); return; }
		if (!doc.hasFocus()) { timer = win.setTimeout(run, 50); return; }
		const hit = doc.elementFromPoint(tap.x, tap.y);
		if (!hit || !tap.surface.contains(hit)) { clear(); return; }
		clear();
		replayed = { surface: tap.surface, x: tap.x, y: tap.y, until: win.performance.now() + 600 };
		tap.surface.click();
	};
	const focusin = (event: FocusEvent): void => {
		if (event.target instanceof win.Element && event.target.closest("input, textarea, select, [contenteditable='true']")) clear();
	};
	const blur = (event: Event): void => { if (event.target === win) cancel(); };
	win.addEventListener("pointerdown", pointerdown, { capture: true, passive: true });
	win.addEventListener("touchstart", touchstart, { capture: true, passive: true });
	win.addEventListener("click", click, true);
	win.addEventListener("focusin", focusin, true);
	win.addEventListener("blur", blur);
	const cancellations = ["keydown", "contextmenu", "touchcancel", "pointercancel", "scroll", "pagehide", "visibilitychange"];
	for (const type of cancellations) win.addEventListener(type, cancel, { capture: true, passive: true });
	const release = registerMenuTap(doc, resolve, (surface, event) => {
		const touch = event.changedTouches[0];
		pending = { surface, event, x: touch.clientX, y: touch.clientY, until: win.performance.now() + 600 };
		// 真机原生 focus 在 touchend 后约 20–50ms 到达；先给兼容 click 留出正常分发机会。
		timer = win.setTimeout(run, 100);
	}, { canStart: () => beganUnfocused && doc.visibilityState === "visible", preserveNative: true });
	return () => {
		release(); cancel();
		win.removeEventListener("pointerdown", pointerdown, true);
		win.removeEventListener("touchstart", touchstart, true);
		win.removeEventListener("click", click, true);
		win.removeEventListener("focusin", focusin, true);
		win.removeEventListener("blur", blur);
		for (const type of cancellations) win.removeEventListener(type, cancel, true);
	};
}
