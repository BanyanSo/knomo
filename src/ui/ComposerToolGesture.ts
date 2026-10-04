interface ComposerToolTouchOptions {
	capture: () => (() => boolean);
	scrollElement: HTMLElement;
}

export function registerComposerToolGesture(tools: HTMLElement, run: (action: string, event: MouseEvent) => void,
	touchOptions?: ComposerToolTouchOptions, mouseDragScroll = false): () => void {
	let pointer: { id: number; x: number; y: number; moved: boolean; button: HTMLElement | null; touch: boolean;
		toolsScrollLeft: number;
		valid?: () => boolean; scrollTop?: number; scrollLeft?: number } | null = null;
	let suppressClickUntil = 0;
	let suppressMouseClick = false;
	const releaseCapture = (id: number) => {
		if (tools.hasPointerCapture?.(id)) tools.releasePointerCapture(id);
	};
	const buttonAt = (target: EventTarget | null) => target instanceof tools.ownerDocument.defaultView!.Element
		? target.closest<HTMLElement>("[data-action]") : null;
	const down = (event: PointerEvent) => {
		if (event.pointerType === "mouse" && event.button !== 0) return;
		if (touchOptions && pointer && pointer.id !== event.pointerId) {
			pointer = null;
			suppressClickUntil = Date.now() + 600;
			return;
		}
		const button = buttonAt(event.target);
		if (!button && !(mouseDragScroll && event.pointerType === "mouse")) return;
		if (event.pointerType === "mouse") suppressMouseClick = false;
		pointer = { id: event.pointerId, x: event.clientX, y: event.clientY, moved: false, button, touch: event.pointerType !== "mouse",
			toolsScrollLeft: tools.scrollLeft,
			valid: touchOptions?.capture(), scrollTop: touchOptions?.scrollElement.scrollTop,
			scrollLeft: touchOptions?.scrollElement.scrollLeft };
		if (!pointer.touch) event.preventDefault();
	};
	const move = (event: PointerEvent) => {
		const current = pointer;
		if (!current || current.id !== event.pointerId) return;
		if (Math.hypot(event.clientX - current.x, event.clientY - current.y) > 8) current.moved = true;
		if (!current.touch && mouseDragScroll && tools.scrollWidth > tools.clientWidth
			&& (Math.abs(event.clientX - current.x) > 8 || tools.hasPointerCapture?.(current.id))) {
			// 超过点击阈值才横拖，捕获指针以接住工具组之外的松手与取消。
			if (!tools.hasPointerCapture?.(current.id)) tools.setPointerCapture?.(current.id);
			tools.scrollLeft = current.toolsScrollLeft + current.x - event.clientX;
			event.preventDefault();
		}
	};
	const scroll = () => { if (pointer) pointer.moved = true; };
	const up = (event: PointerEvent) => {
		if (!pointer || pointer.id !== event.pointerId) return;
		const current = pointer;
		pointer = null;
		if (!current.touch) {
			suppressMouseClick = mouseDragScroll && current.moved;
			releaseCapture(current.id);
			return;
		}
		suppressClickUntil = Date.now() + 600;
		if (!current.moved && (!touchOptions || Math.hypot(event.clientX - current.x, event.clientY - current.y) <= 8
			&& touchOptions.scrollElement.scrollTop === current.scrollTop && touchOptions.scrollElement.scrollLeft === current.scrollLeft
			&& current.valid?.()) && current.button && buttonAt(event.target) === current.button) {
			event.preventDefault();
			run(current.button.dataset.action!, event);
		}
	};
	const cancel = (event: PointerEvent) => {
		if (!pointer || pointer.id !== event.pointerId) return;
		const current = pointer;
		pointer = null;
		if (current.touch) suppressClickUntil = Date.now() + 600;
		else suppressMouseClick = mouseDragScroll && current.moved;
		releaseCapture(current.id);
	};
	const mouse = (event: MouseEvent) => { event.preventDefault(); };
	const click = (event: MouseEvent) => {
		const button = buttonAt(event.target);
		if (!button) return;
		event.preventDefault(); event.stopImmediatePropagation();
		if (suppressMouseClick && event.detail !== 0) { suppressMouseClick = false; return; }
		if (Date.now() >= suppressClickUntil || event.detail === 0) run(button.dataset.action!, event);
	};
	tools.addEventListener("pointerdown", down);
	tools.addEventListener("pointermove", move);
	touchOptions?.scrollElement.addEventListener("scroll", scroll);
	tools.addEventListener("pointerup", up);
	tools.addEventListener("pointercancel", cancel);
	tools.addEventListener("lostpointercapture", cancel);
	tools.addEventListener("mousedown", mouse);
	tools.addEventListener("click", click, true);
	return () => {
		const current = pointer;
		pointer = null;
		if (current) releaseCapture(current.id);
		tools.removeEventListener("pointerdown", down); tools.removeEventListener("pointermove", move);
		touchOptions?.scrollElement.removeEventListener("scroll", scroll);
		tools.removeEventListener("pointerup", up); tools.removeEventListener("pointercancel", cancel);
		tools.removeEventListener("lostpointercapture", cancel);
		tools.removeEventListener("mousedown", mouse); tools.removeEventListener("click", click, true);
	};
}
