// 菜单的轻触直接沿宿主 click 路径执行；滚动、拖动、多指和长按交还宿主。
export function registerMobileMenuTap(menu: HTMLElement, backdrop: HTMLElement, dismiss: () => void): () => void {
	const doc = menu.ownerDocument;
	const win = doc.defaultView!;
	let releaseGesture: (() => void) | null = null;
	const cancel = (): void => { releaseGesture?.(); releaseGesture = null; };
	const start = (event: TouchEvent): void => {
		cancel();
		if (event.defaultPrevented || event.touches.length !== 1) return;
		const target = event.target;
		if (!(target instanceof win.Element)) return;
		const item = target.closest<HTMLElement>(".menu-item:not(.is-disabled):not(.is-label)");
		const surface = backdrop.contains(target) ? backdrop
			: item?.closest(".menu") === menu ? item : null;
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
			if (next.defaultPrevented || !next.cancelable || next.touches.length !== 0 || !touch
				|| next.timeStamp - began > 600 || !surface.isConnected
				|| Math.hypot(touch.clientX - first.clientX, touch.clientY - first.clientY) > 8) return;
			const hit = doc.elementFromPoint(touch.clientX, touch.clientY);
			if (!hit || !surface.contains(hit)) return;
			// 取消 iOS 后续的兼容鼠标事件，避免关闭后穿透或二次执行。
			next.preventDefault();
			if (surface === backdrop) dismiss();
			else surface.click();
		};
		const scroll = (next: Event): void => {
			const target = next.target;
			if (target === win || target instanceof win.Node && (target.contains(menu) || menu.contains(target))) cancel();
		};
		// 在 touchstart 冒泡到 window 后注册，先让宿主手势处理 move/end。
		win.addEventListener("touchmove", move, { passive: true });
		win.addEventListener("touchend", end, { passive: false });
		win.addEventListener("touchcancel", cancel);
		win.addEventListener("scroll", scroll, true);
		win.addEventListener("blur", cancel);
		releaseGesture = () => {
			win.removeEventListener("touchmove", move);
			win.removeEventListener("touchend", end);
			win.removeEventListener("touchcancel", cancel);
			win.removeEventListener("scroll", scroll, true);
			win.removeEventListener("blur", cancel);
		};
	};
	win.addEventListener("touchstart", start, { passive: true });
	return () => { cancel(); win.removeEventListener("touchstart", start); };
}
