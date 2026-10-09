interface MobileViewFocusRecoveryOptions {
	getRoot(): HTMLElement | null;
	canRecover(): boolean;
}

const RECOVERY_LIFETIME = 5000;
const READINESS_INTERVAL = 100;
const EDITABLE_SELECTOR = "input, textarea, select, [contenteditable='true']";

/** 在宿主交接期间恢复非编辑焦点；用户操作接管后立即释放本轮请求。 */
export class MobileViewFocusRecovery {
	private cleanup: (() => void) | null = null;

	constructor(private readonly options: MobileViewFocusRecoveryOptions) {}

	recover(isCurrent: () => boolean = () => true, defer = false): void {
		this.cancel();
		const root = this.options.getRoot();
		if (!root || !this.options.canRecover() || !isCurrent()) return;
		const doc = root.ownerDocument;
		const win = doc.defaultView!;
		let frame: number | null = null;
		let poll: number | null = null;
		let foregroundSeen = doc.visibilityState === "visible";
		let foregroundFocusRequested = false;
		let focusRequested = false;
		let polling = true;
		let nextWindowFocusAttempt = 0;
		const current = () => this.cleanup === cleanup && isCurrent() && this.options.canRecover()
			&& this.options.getRoot() === root && root.isConnected;
		const focus = (gesture = false): void => {
			if (!current()) { cancel(); return; }
			if (doc.visibilityState !== "visible") return;
			foregroundSeen = true;
			// 菜单及其蒙版可分别退场，onHide 不代表宿主交接已完成。
			if (root.closest("[inert], [hidden], [aria-hidden='true']") ||
				Array.from(doc.querySelectorAll<HTMLElement>(".modal-container, .menu, .suggestion-container, .suggestion-bg"))
					.some(element => element.getClientRects().length > 0)) return;
			const active = doc.activeElement;
			if (active instanceof win.HTMLElement && active.closest(EDITABLE_SELECTOR)) {
				// 隐藏节点或其他 leaf 的旧焦点不代表用户的新输入意图。
				const hidden = active.closest("[inert], [hidden], [aria-hidden='true']") || active.getClientRects().length === 0;
				const leaf = hidden ? null : active.closest(".workspace-leaf");
				if (!hidden && (leaf === null || leaf.contains(root))) { cancel(); return; }
			}
			// 真机记录中 root 已聚焦而窗口仍失焦；此时不能跳过窗口激活请求。
			if (!doc.hasFocus() && (gesture || win.performance.now() >= nextWindowFocusAttempt)) {
				nextWindowFocusAttempt = win.performance.now() + 250;
				win.focus();
				if (!current()) return;
			}
			if (active === root && (foregroundFocusRequested || !doc.hasFocus() && focusRequested) && !gesture) return;
			if (!root.hasAttribute("tabindex")) root.tabIndex = -1;
			focusRequested = true;
			root.focus({ preventScroll: true });
			foregroundFocusRequested = doc.hasFocus();
		};
		const schedule = (): void => {
			if (this.cleanup !== cleanup || frame !== null) return;
			frame = win.requestAnimationFrame(() => { frame = null; focus(); });
		};
		const sample = (): void => {
			poll = null;
			focus();
			if (this.cleanup === cleanup && polling) poll = win.setTimeout(sample, READINESS_INTERVAL);
		};
		const visibility = (): void => {
			if (doc.visibilityState !== "visible" && foregroundSeen) cancel();
			else schedule();
		};
		const interrupt = (event: Event): void => {
			// 首次前台手势可能先于窗口 focus；在原始手势内交接，不拦截或合成按钮点击。
			if ((event.type === "pointerdown" || event.type === "touchstart")
				&& event.target instanceof win.Element && !event.target.closest(EDITABLE_SELECTOR)) focus(true);
			cancel();
		};
		const cancel = (): void => { if (this.cleanup === cleanup) this.cancel(); };
		const interactions = ["pointerdown", "touchstart", "keydown", "click", "compositionstart"] as const;
		for (const type of interactions) doc.addEventListener(type, interrupt, { capture: true, passive: true });
		doc.addEventListener("visibilitychange", visibility);
		doc.addEventListener("focusin", schedule);
		doc.addEventListener("focusout", schedule);
		win.addEventListener("focus", schedule);
		win.addEventListener("keyboardDidHide", schedule);
		win.addEventListener("pagehide", cancel);
		// 只限制主动轮询；首个手势可能在数秒之后，不能因超时丢掉被动交接。
		const deadline = win.setTimeout(() => {
			polling = false;
			if (poll !== null) win.clearTimeout(poll);
			poll = null;
		}, RECOVERY_LIFETIME);
		const cleanup = (): void => {
			win.clearTimeout(deadline);
			if (frame !== null) win.cancelAnimationFrame(frame);
			if (poll !== null) win.clearTimeout(poll);
			for (const type of interactions) doc.removeEventListener(type, interrupt, true);
			doc.removeEventListener("visibilitychange", visibility);
			doc.removeEventListener("focusin", schedule);
			doc.removeEventListener("focusout", schedule);
			win.removeEventListener("focus", schedule);
			win.removeEventListener("keyboardDidHide", schedule);
			win.removeEventListener("pagehide", cancel);
		};
		this.cleanup = cleanup;
		if (!defer) focus();
		if (this.cleanup === cleanup) {
			schedule();
			poll = win.setTimeout(sample, READINESS_INTERVAL);
		}
	}

	cancel(): void {
		const cleanup = this.cleanup;
		this.cleanup = null;
		cleanup?.();
	}
}
