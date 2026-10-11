// 以所属面板和窗口的交集限制菜单；测量布局尺寸，避免开合动画的缩放影响定位。
export function positionDesktopMenu(menu: HTMLElement, anchor: HTMLElement, bounds: HTMLElement, align: "start" | "end"): boolean {
	const parent = menu.offsetParent;
	const win = menu.ownerDocument.defaultView;
	if (parent === null || win === null) return false;
	const boundsRect = bounds.getBoundingClientRect();
	const leftEdge = Math.max(0, boundsRect.left) + 8;
	const rightEdge = Math.min(win.innerWidth, boundsRect.right) - 8;
	const topEdge = Math.max(0, boundsRect.top) + 8;
	const bottomEdge = Math.min(win.innerHeight, boundsRect.bottom) - 8;
	if (rightEdge <= leftEdge || bottomEdge <= topEdge) return false;

	menu.setCssProps({
		"--knomo-desktop-menu-max-width": `${Math.floor(rightEdge - leftEdge)}px`,
		"--knomo-desktop-menu-max-height": "none",
	});
	const anchorRect = anchor.getBoundingClientRect();
	const width = menu.offsetWidth;
	const height = menu.offsetHeight;
	const spaceBelow = Math.max(0, bottomEdge - anchorRect.bottom - 6);
	const spaceAbove = Math.max(0, anchorRect.top - topEdge - 6);
	const above = height > spaceBelow && spaceAbove > spaceBelow;
	const availableHeight = Math.floor(Math.min(bottomEdge - topEdge, above ? spaceAbove : spaceBelow));
	menu.setCssProps({ "--knomo-desktop-menu-max-height": `${availableHeight}px` });
	const renderedHeight = menu.offsetHeight;
	const left = Math.max(leftEdge, Math.min(rightEdge - width, align === "start" ? anchorRect.left : anchorRect.right - width));
	const preferredTop = above ? anchorRect.top - 6 - renderedHeight : anchorRect.bottom + 6;
	const top = Math.max(topEdge, Math.min(bottomEdge - renderedHeight, preferredTop));
	const parentRect = parent.getBoundingClientRect();
	menu.setCssProps({
		"--knomo-desktop-menu-left": `${left - parentRect.left - parent.clientLeft + parent.scrollLeft}px`,
		"--knomo-desktop-menu-top": `${top - parentRect.top - parent.clientTop + parent.scrollTop}px`,
	});
	menu.classList.add("is-desktop-menu-positioned");
	return above;
}
