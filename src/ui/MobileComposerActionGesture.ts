export type MobileComposerAction = "save-input" | "cancel-edit" | "clear-reference";

interface ActionGestureOptions {
	identify: (target: Element) => { button: HTMLElement; action: MobileComposerAction } | null;
	isAvailable: (button: HTMLElement, action: MobileComposerAction) => boolean;
	captureContext: () => (() => boolean);
	execute: (action: MobileComposerAction) => void;
}

// 只保存当前指针序列；新按下和语义激活不继承上一手势的拦截窗口。
export function registerMobileComposerActionGesture(root: HTMLElement, options: ActionGestureOptions): () => void {
	const doc = root.ownerDocument;
	const win = doc.defaultView!;
	let pending: { button: HTMLElement; action: MobileComposerAction; id: number; x: number; y: number; valid: () => boolean } | null = null;
	const tails = new Map<number, { x: number; y: number }>();
	const pointers = new Set<number>();
	let releaseReferenceTail: (() => void) | null = null;
	const cancel = (): void => { pending = null; };
	const protectReferenceTail = (button: HTMLElement, origin: PointerEvent): void => {
		releaseReferenceTail?.();
		// 清除引用会移除按钮，touchend 仍可能指向旧节点，兼容鼠标事件也可能命中下层。
		const targets: EventTarget[] = [win, button];
		const types = ["touchend", "mousedown", "mouseup", "click"] as const;
		const guard = (event: Event): void => {
			if (event.type === "click" && (event as MouseEvent).detail === 0) return;
			const point = event.type === "touchend" ? (event as TouchEvent).changedTouches[0] : event as MouseEvent;
			if (!point || Math.hypot(point.clientX - origin.clientX, point.clientY - origin.clientY) > 8) return;
			event.preventDefault();
			event.stopImmediatePropagation();
			if (event.type === "click") release();
		};
		const release = (): void => {
			for (const target of targets) for (const type of types) target.removeEventListener(type, guard, true);
			win.clearTimeout(timer);
			releaseReferenceTail = null;
		};
		const timer = win.setTimeout(release, 600);
		releaseReferenceTail = release;
		for (const target of targets) for (const type of types) target.addEventListener(type, guard, { capture: true, passive: false });
	};
	const hit = (button: HTMLElement, event: PointerEvent): boolean => {
		const rect = button.getBoundingClientRect();
		const target = doc.elementFromPoint(event.clientX, event.clientY);
		return event.clientX >= rect.left && event.clientX < rect.right && event.clientY >= rect.top
			&& event.clientY < rect.bottom && target !== null && button.contains(target);
	};
	const down = (event: PointerEvent): void => {
		releaseReferenceTail?.();
		if (pointers.size === 0) tails.clear();
		pointers.add(event.pointerId);
		if (pointers.size > 1 || event.isPrimary === false) {
			if (tails.size > 0) tails.set(event.pointerId, { x: event.clientX, y: event.clientY });
			cancel(); return;
		}
		const target = event.target as Element | null;
		if (!target || !root.contains(target) || event.button !== 0 || event.defaultPrevented) return;
		const identified = options.identify(target);
		if (!identified) return;
		tails.set(event.pointerId, { x: event.clientX, y: event.clientY });
		// 仅动作按钮保护编辑焦点；正文选择与滚动保留原生路径。
		event.preventDefault();
		if (!options.isAvailable(identified.button, identified.action)) return;
		pending = { ...identified, id: event.pointerId, x: event.clientX, y: event.clientY, valid: options.captureContext() };
	};
	const move = (event: PointerEvent): void => {
		if (tails.has(event.pointerId)) tails.set(event.pointerId, { x: event.clientX, y: event.clientY });
		if (pending?.id !== event.pointerId) return;
		if (Math.hypot(event.clientX - pending.x, event.clientY - pending.y) > 8 || !hit(pending.button, event)) cancel();
	};
	const end = (event: PointerEvent): void => {
		const current = pending;
		if (tails.has(event.pointerId)) tails.set(event.pointerId, { x: event.clientX, y: event.clientY });
		pointers.delete(event.pointerId);
		if (current?.id !== event.pointerId) return;
		cancel();
		if (event.type === "pointerup" && current.valid() && current.button.isConnected
			&& Math.hypot(event.clientX - current.x, event.clientY - current.y) <= 8
			&& hit(current.button, event) && options.isAvailable(current.button, current.action)) {
			if (current.action === "clear-reference" && event.pointerType === "touch") {
				event.preventDefault();
				protectReferenceTail(current.button, event);
			}
			options.execute(current.action);
		}
	};
	const click = (event: MouseEvent): void => {
		if (event.detail === 0) return;
		const pointerId = (event as PointerEvent).pointerId;
		const entry = pointerId > 0 ? (tails.has(pointerId) ? pointerId : undefined)
			: Array.from(tails).find(([, point]) => Math.hypot(event.clientX - point.x, event.clientY - point.y) <= 8)?.[0];
		if (entry === undefined) return;
		tails.delete(entry);
		releaseReferenceTail?.();
		event.preventDefault();
		event.stopImmediatePropagation();
	};
	const scroll = (event: Event): void => {
		const target = event.target as Node | null;
		if (event.target === win || (target && typeof target.contains === "function" && (root.contains(target) || target.contains(root)))) cancel();
	};
	const lost = (event: PointerEvent): void => { if (pending?.id === event.pointerId) cancel(); };
	const blur = (): void => { cancel(); pointers.clear(); };
	const listeners: Array<[EventTarget, string, EventListener]> = [
		[win, "pointerdown", down as EventListener], [win, "pointermove", move as EventListener],
		[win, "pointerup", end as EventListener], [win, "pointercancel", end as EventListener],
		[win, "lostpointercapture", lost as EventListener], [win, "click", click as EventListener],
		[win, "scroll", scroll], [root, "composer-action-cancel", cancel], [root, "composer-reset", cancel], [root, "compositionstart", cancel], [win, "blur", blur],
	];
	for (const [target, type, handler] of listeners) target.addEventListener(type, handler, true);
	return () => {
		releaseReferenceTail?.();
		cancel(); tails.clear(); pointers.clear();
		for (const [target, type, handler] of listeners) target.removeEventListener(type, handler, true);
	};
}
