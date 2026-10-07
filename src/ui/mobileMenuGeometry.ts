export interface MenuRect { left: number; top: number; right: number; bottom: number }

// 只计算几何；fixed 与 absolute 的坐标转换由各自入口负责。
export function placeMobileMenu(anchor: MenuRect, bounds: MenuRect, width: number, height: number, minimumHeight: number, alignRight: boolean) {
	const gap = 6;
	if (anchor.bottom <= bounds.top || anchor.top >= bounds.bottom || anchor.right <= bounds.left || anchor.left >= bounds.right) return null;
	const below = Math.max(0, bounds.bottom - anchor.bottom - gap);
	const above = Math.max(0, anchor.top - bounds.top - gap);
	const opensAbove = height > below && above > below;
	const maxHeight = opensAbove ? above : below;
	if (maxHeight < minimumHeight || bounds.right <= bounds.left) return null;
	const actualHeight = Math.min(height, maxHeight);
	return {
		left: Math.max(bounds.left, Math.min(alignRight ? anchor.right - width : anchor.left, bounds.right - width)),
		top: opensAbove ? anchor.top - gap - actualHeight : anchor.bottom + gap,
		maxHeight, opensAbove,
	};
}
