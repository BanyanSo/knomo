import {
	clampSidebarWidth,
	getSidebarDragWidth,
	type SidebarDragState,
} from "./KnomoSidebar";

interface DesktopSidebarSnapshot {
	collapsed: boolean;
	width: number;
}

export class DesktopSidebarStateController {
	private collapsed = false;
	private width = 248;
	private drag: SidebarDragState | null = null;

	getSnapshot(): DesktopSidebarSnapshot {
		return {
			collapsed: this.collapsed,
			width: this.width,
		};
	}

	setFromSettings(width: number, collapsed: boolean): void {
		this.width = clampSidebarWidth(width);
		this.collapsed = collapsed;
		this.drag = null;
	}

	setCollapsed(collapsed: boolean): void {
		this.collapsed = collapsed;
	}

	toggleCollapsed(): void {
		this.collapsed = !this.collapsed;
	}

	expandWithoutPersisting(): void {
		this.collapsed = false;
	}

	setWidth(width: number): void {
		this.width = clampSidebarWidth(width);
	}

	startResize(pointerId: number, clientX: number): boolean {
		if (this.collapsed) {
			return false;
		}
		this.drag = {
			pointerId,
			startX: clientX,
			startWidth: this.width,
		};
		return true;
	}

	resize(pointerId: number, clientX: number): boolean {
		if (this.drag === null || this.drag.pointerId !== pointerId) {
			return false;
		}
		this.setWidth(getSidebarDragWidth(this.drag, clientX));
		return true;
	}

	stopResize(pointerId: number): boolean {
		if (this.drag === null || this.drag.pointerId !== pointerId) {
			return false;
		}
		this.drag = null;
		return true;
	}
}
