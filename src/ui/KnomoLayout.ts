export type LayoutMode = "desktop-wide" | "desktop-narrow" | "mobile";

export function resolveLayout(mobile: boolean, width: number, previous: LayoutMode = "desktop-narrow"): LayoutMode {
	if (mobile) return "mobile";
	if (!Number.isFinite(width) || width <= 0) return previous === "mobile" ? "desktop-narrow" : previous;
	return width >= 780 ? "desktop-wide" : "desktop-narrow";
}

export function getDrawerWidth(available: number, saved: number): number {
	const width = Math.max(0, available);
	return Math.min(Math.min(300, Math.max(210, saved)), width >= 258 ? width - 48 : width);
}

// 只隔离所属 View，其他 Pane 仍可正常接收焦点和输入。
export class DesktopDrawerFocus {
	private open = false;
	private entry: HTMLElement | null = null;

	sync(root: HTMLElement, narrow: boolean, open: boolean, collapsed: boolean): void {
		const sidebar = root.querySelector<HTMLElement>(".knomo-sidebar");
		const main = root.querySelector<HTMLElement>(".knomo-main");
		if (!sidebar || !main) return;
		const active = root.ownerDocument.activeElement as HTMLElement | null;
		const wasOpen = this.open;
		this.open = narrow && open;
		main.inert = narrow && open;
		sidebar.inert = narrow ? !open : collapsed;
		if (this.open && !wasOpen) {
			this.entry = active && root.contains(active) ? active : null;
			sidebar.querySelector<HTMLElement>('[data-action="close-drawer"]')?.focus({ preventScroll: true });
		} else if (wasOpen && !this.open) {
			if (active && (root.contains(active) || active === root.ownerDocument.body)) {
				const fallback = root.querySelector<HTMLElement>(narrow ? '.knomo-compact-menu-btn' : collapsed ? '.knomo-sidebar-toggle' : '[data-action="collapse-sidebar"]');
				const target = this.entry?.isConnected && this.entry.getClientRects().length ? this.entry : fallback;
				target?.focus({ preventScroll: true });
			}
			this.entry = null;
		}
	}

	handleKeydown(event: KeyboardEvent, sidebar: HTMLElement, close: () => void): boolean {
		if (!this.open || event.defaultPrevented || event.isComposing || event.keyCode === 229) return false;
		if (event.key === "Escape") {
			event.preventDefault();
			event.stopPropagation();
			close();
			return true;
		}
		if (event.key !== "Tab") return false;
		const items = Array.from(sidebar.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), [tabindex="0"]')).filter(el => el.getClientRects().length > 0 && el.ownerDocument.defaultView?.getComputedStyle(el).visibility !== "hidden");
		const first = items[0];
		const last = items[items.length - 1];
		if (first && last && (event.shiftKey ? sidebar.ownerDocument.activeElement === first : sidebar.ownerDocument.activeElement === last)) {
			event.preventDefault();
			(event.shiftKey ? last : first).focus();
			return true;
		}
		return false;
	}
}
