export function prefersReducedPopupMotion(win: Window): boolean {
	return win.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;
}

// 每个元素只接收自身指定属性；较短属性结束不能提前完成整个退出。
export function waitForPopupTransitions(
	win: Window,
	targets: Array<{ element: HTMLElement; properties: string[] }>,
	complete: () => void,
): () => void {
	const removers: Array<() => void> = [];
	let timer: number | null = null;
	let finished = false;
	const pending = new Map<HTMLElement, Set<string>>();
	let longest = 0;
	const started = win.performance.now();
	const cleanup = (): void => {
		finished = true;
		if (timer !== null) win.clearTimeout(timer);
		for (const remove of removers) remove();
	};
	const finish = (): void => { if (!finished) { cleanup(); complete(); } };
	const seconds = (value: string): number => parseFloat(value) * (value.trim().endsWith("ms") ? 1 : 1000) || 0;
	for (const { element, properties } of targets) {
		const style = win.getComputedStyle(element);
		const names = style.transitionProperty.split(",").map(value => value.trim());
		const durations = style.transitionDuration.split(",").map(seconds);
		const delays = style.transitionDelay.split(",").map(seconds);
		const active = new Set<string>();
		for (const property of properties) {
			let index = -1;
			names.forEach((name, current) => { if (name === property || name === "all") index = current; });
			if (index < 0) continue;
			const duration = durations[index % durations.length];
			const total = duration + delays[index % delays.length];
			if (duration <= 0 || total <= 0) continue;
			active.add(property);
			longest = Math.max(longest, total);
		}
		if (active.size === 0) continue;
		pending.set(element, active);
		const running = new Set<string>();
		const handler = (event: TransitionEvent): void => {
			if (finished || event.target !== element || event.timeStamp < started || !active.has(event.propertyName)) return;
			if (event.type === "transitionrun") { running.add(event.propertyName); return; }
			// 新一轮的 run 之前可能还有旧过渡的取消事件，不能用它完成新退出。
			if (!running.has(event.propertyName)) return;
			active.delete(event.propertyName);
			if (active.size === 0) pending.delete(element);
			if (pending.size === 0) finish();
		};
		element.addEventListener("transitionend", handler);
		element.addEventListener("transitioncancel", handler);
		element.addEventListener("transitionrun", handler);
		removers.push(() => {
			element.removeEventListener("transitionend", handler);
			element.removeEventListener("transitioncancel", handler);
			element.removeEventListener("transitionrun", handler);
		});
	}
	if (pending.size === 0) finish();
	else timer = win.setTimeout(finish, longest + 50);
	return cleanup;
}
