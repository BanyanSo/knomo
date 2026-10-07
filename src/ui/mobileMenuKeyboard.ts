// 局部菜单键盘行为；仅滚动菜单自身，避免 scrollIntoView 带动宿主页面。
export function registerMobileMenuKeyboard(menu: HTMLElement, trigger: HTMLElement, close: () => void): () => void {
	const items = (): HTMLElement[] => Array.from(menu.querySelectorAll<HTMLElement>("[role='menuitem'], [role='menuitemradio']"))
		.filter(item => !item.hasAttribute("disabled") && item.getAttribute("aria-disabled") !== "true");
	const keydown = (event: KeyboardEvent): void => {
		if (event.key === "Escape") {
			event.preventDefault(); event.stopPropagation();
			const restore = menu.contains(menu.ownerDocument.activeElement);
			close();
			if (restore && trigger.isConnected) trigger.focus({ preventScroll: true });
			return;
		}
		if (!["ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) return;
		event.preventDefault(); event.stopPropagation();
		const choices = items();
		if (!choices.length) return;
		const current = choices.indexOf(menu.ownerDocument.activeElement as HTMLElement);
		const index = event.key === "Home" ? 0 : event.key === "End" ? choices.length - 1
			: (current + (event.key === "ArrowDown" ? 1 : -1) + choices.length) % choices.length;
		focusMobileMenuItem(menu, choices[index]);
	};
	const focusout = (event: FocusEvent): void => {
		if (event.relatedTarget !== null && !menu.contains(event.relatedTarget as Node)) close();
	};
	menu.addEventListener("keydown", keydown);
	menu.addEventListener("focusout", focusout);
	return () => { menu.removeEventListener("keydown", keydown); menu.removeEventListener("focusout", focusout); };
}

export function focusMobileMenuItem(menu: HTMLElement, item: HTMLElement): void {
	for (const other of Array.from(menu.querySelectorAll<HTMLElement>("[role^='menuitem']"))) other.tabIndex = other === item ? 0 : -1;
	item.focus({ preventScroll: true });
	const top = item.offsetTop, bottom = top + item.offsetHeight;
	if (top < menu.scrollTop) menu.scrollTop = top;
	else if (bottom > menu.scrollTop + menu.clientHeight) menu.scrollTop = bottom - menu.clientHeight;
}
