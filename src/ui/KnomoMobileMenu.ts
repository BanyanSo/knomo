import { Menu } from "obsidian";
import { registerMobileMenuTap } from "./MobileMenuTap";

export type MobileMenuKind = "card" | "scope";

interface MobileMenuOptions {
	kind: MobileMenuKind;
	trigger: HTMLElement;
	build: (menu: Menu, select: (action: () => void, focus?: "view" | "action") => void, createTitle: (text: string, opensInput?: boolean) => DocumentFragment) => void;
	onClose: () => void;
	onReturnToView?: (isCurrent: () => boolean) => void;
}

// 只管理 Knomo 的一个宿主菜单；菜单隐藏后通知视图恢复焦点，布局、主题与历史返回由宿主管理。
export class KnomoMobileMenu {
	private revision = 0;
	private selectionDepth = 0;
	private current: { kind: MobileMenuKind; menu: Menu; element: HTMLElement | null; finish: () => void } | null = null;

	constructor(private readonly createMenu: () => Menu = () => new Menu()) {}

	get kind(): MobileMenuKind | null {
		return this.current?.kind ?? null;
	}

	getInputTapTarget(target: Element): HTMLElement | null {
		const menu = this.current?.element;
		const item = target.closest<HTMLElement>(".menu-item:not(.is-disabled):not(.is-label)");
		return menu && item?.closest(".menu") === menu && item.querySelector("[data-knomo-menu-input]")
			&& !item.closest("[inert], [hidden], [aria-hidden='true'], [aria-disabled='true']") ? item : null;
	}

	open(options: MobileMenuOptions): void {
		this.close();
		if (!options.trigger.isConnected) return;
		const revision = ++this.revision;
		const menu = this.createMenu();
		const doc = options.trigger.ownerDocument;
		const titleElements: HTMLElement[] = [];
		let releaseInteraction: (() => void) | null = null;
		let closed = false;
		let selected = false;
		let returnFocus = true;
		let actionPending = false;
		let dismissed = false;
		let hidden = false;
		let observer: MutationObserver | null = null;
		const session = { kind: options.kind, menu, element: null as HTMLElement | null, finish: () => {
			if (closed) return;
			closed = true;
			observer?.disconnect();
			releaseInteraction?.();
			releaseInteraction = null;
			if (this.current === session) this.current = null;
			options.onClose();
		} };
		this.current = session;
		const returnToView = (): void => {
			if (hidden && returnFocus && !actionPending && revision === this.revision) {
				options.onReturnToView?.(() => revision === this.revision && returnFocus && !actionPending
					&& (selected || options.trigger.isConnected));
			}
		};
		menu.onHide(() => {
			if (hidden) return;
			hidden = true;
			session.finish();
			// 先隐藏后派发选项时，延迟请求仍由本轮菜单及选项的焦点归属校验。
			returnToView();
		});
		try {
			options.build(menu, (action, focus = "view") => {
				// 宿主可能先隐藏再派发选项；自然隐藏不改变本轮 revision。
				if (revision !== this.revision || selected || dismissed || !options.trigger.isConnected) return;
				selected = true;
				returnFocus = focus === "view";
				actionPending = true;
				session.finish();
				this.selectionDepth++;
				try {
					menu.hide();
					// 编辑器/跳转动作保留原始手势内的同步聚焦。
					action();
				} finally {
					this.selectionDepth--;
					actionPending = false;
					returnToView();
				}
			}, (text, opensInput = false) => {
				// 使用公开的 DocumentFragment 标题定位本菜单，不依赖 Menu 的私有 DOM 属性。
				const title = doc.adoptNode(createSpan());
				title.textContent = text;
				if (opensInput) title.setAttribute("data-knomo-menu-input", "");
				titleElements.push(title);
				const fragment = doc.adoptNode(createFragment());
				fragment.appendChild(title);
				return fragment;
			});
			const win = doc.defaultView!;
			observer = new win.MutationObserver(() => {
				if (!options.trigger.isConnected) this.close();
			});
			observer.observe(doc.body, { childList: true, subtree: true });
			const rect = options.trigger.getBoundingClientRect();
			menu.showAtPosition({ x: rect.left, y: rect.bottom, width: rect.width }, doc);
			const menuEl = titleElements.map(title => title.closest<HTMLElement>(".menu")).find(element => element !== null);
			if (menuEl) {
				session.element = menuEl;
				menuEl.classList.add("knomo-mobile-menu", "knomo-mobile-menu-" + options.kind);
				const backdrop = menuEl.nextElementSibling;
				if (backdrop instanceof win.HTMLElement && backdrop.matches(".suggestion-bg")) {
					const dismiss = (): void => {
						if (this.current !== session) return;
						dismissed = true;
						session.finish();
						menu.hide();
					};
					const click = (event: MouseEvent): void => {
						event.preventDefault();
						event.stopImmediatePropagation();
						dismiss();
					};
					// 只接管本菜单的蒙版，菜单项及其他弹层不经过全局 click 捕获。
					backdrop.addEventListener("click", click, true);
					const releaseTap = registerMobileMenuTap(menuEl, backdrop, dismiss);
					releaseInteraction = () => {
						backdrop.removeEventListener("click", click, true);
						releaseTap();
					};
				}
			}
		} catch (error) {
			this.close();
			throw error;
		}
	}

	close(kind?: MobileMenuKind): void {
		if (kind !== undefined && this.current !== null && this.current.kind !== kind) return;
		// 选项自身再次关闭已结束的菜单，不撤销它的返回焦点；新菜单仍正常替换本轮。
		if (this.current === null && this.selectionDepth > 0) return;
		// 宿主已自然隐藏时仍使迟到选项失效，但不影响另一种正在显示的菜单。
		this.revision++;
		const session = this.current;
		if (!session) return;
		session.finish();
		session.menu.hide();
	}
}
