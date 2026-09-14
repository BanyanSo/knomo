export function registerComposerToolGesture(tools: HTMLElement, run: (action: string, event: MouseEvent) => void): () => void {
	let pointer: { id: number; x: number; y: number; moved: boolean; button: HTMLElement; touch: boolean } | null = null;
	let suppressClickUntil = 0;
	const buttonAt = (target: EventTarget | null) => target instanceof tools.ownerDocument.defaultView!.Element
		? target.closest<HTMLElement>("[data-action]") : null;
	const down = (event: PointerEvent) => {
		const button = buttonAt(event.target);
		if (!button) return;
		pointer = { id: event.pointerId, x: event.clientX, y: event.clientY, moved: false, button, touch: event.pointerType !== "mouse" };
		if (!pointer.touch) event.preventDefault();
	};
	const move = (event: PointerEvent) => {
		const current = pointer;
		if (!current || current.id !== event.pointerId) return;
		if (Math.hypot(event.clientX - current.x, event.clientY - current.y) > 8) current.moved = true;
	};
	const up = (event: PointerEvent) => {
		if (!pointer || pointer.id !== event.pointerId) return;
		const current = pointer;
		pointer = null;
		if (!current.touch) return;
		suppressClickUntil = Date.now() + 600;
		if (!current.moved && buttonAt(event.target) === current.button) {
			event.preventDefault();
			run(current.button.dataset.action!, event);
		}
	};
	const cancel = () => { pointer = null; suppressClickUntil = Date.now() + 600; };
	const mouse = (event: MouseEvent) => { event.preventDefault(); };
	const click = (event: MouseEvent) => {
		const button = buttonAt(event.target);
		if (!button) return;
		event.preventDefault(); event.stopImmediatePropagation();
		if (Date.now() >= suppressClickUntil || event.detail === 0) run(button.dataset.action!, event);
	};
	tools.addEventListener("pointerdown", down);
	tools.addEventListener("pointermove", move);
	tools.addEventListener("pointerup", up);
	tools.addEventListener("pointercancel", cancel);
	tools.addEventListener("mousedown", mouse);
	tools.addEventListener("click", click, true);
	return () => {
		tools.removeEventListener("pointerdown", down); tools.removeEventListener("pointermove", move);
		tools.removeEventListener("pointerup", up); tools.removeEventListener("pointercancel", cancel);
		tools.removeEventListener("mousedown", mouse); tools.removeEventListener("click", click, true);
	};
}
