import { Menu } from "obsidian";
import { registerMobileMenuTap } from "./MobileMenuTap";

export type MobileMenuKind = "card" | "scope";

interface MobileMenuOptions {
	kind: MobileMenuKind;
	trigger: HTMLElement;
	build: (menu: Menu, select: (action: () => void) => void, createTitle: (text: string) => DocumentFragment) => void;
	onClose: () => void;
}

// 只管理 Knomo 的一个宿主菜单；布局、主题、焦点与历史返回由 Obsidian 管理。
export class KnomoMobileMenu {
	private revision = 0;
	private current: { kind: MobileMenuKind; menu: Menu; finish: () => void } | null = null;

	constructor(private readonly createMenu: () => Menu = () => new Menu()) {}

	get kind(): MobileMenuKind | null {
		return this.current?.kind ?? null;
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
		let observer: MutationObserver | null = null;
		const session = { kind: options.kind, menu, finish: () => {
			if (closed) return;
			closed = true;
			observer?.disconnect();
			releaseInteraction?.();
			releaseInteraction = null;
			if (this.current === session) this.current = null;
			options.onClose();
		} };
		this.current = session;
		menu.onHide(session.finish);
		try {
			options.build(menu, action => {
				// 宿主可能先隐藏再派发选项；自然隐藏不改变本轮 revision。
				if (revision !== this.revision || selected || !options.trigger.isConnected) return;
				selected = true;
				session.finish();
				menu.hide();
				// 保持在当前用户手势内调用 Composer 聚焦，不排入异步关闭回调。
				action();
			}, text => {
				// 使用公开的 DocumentFragment 标题定位本菜单，不依赖 Menu 的私有 DOM 属性。
				const title = doc.createElement("span");
				title.textContent = text;
				titleElements.push(title);
				const fragment = doc.createDocumentFragment();
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
				menuEl.classList.add("knomo-mobile-menu", "knomo-mobile-menu-" + options.kind);
				const backdrop = menuEl.nextElementSibling;
				if (backdrop instanceof win.HTMLElement && backdrop.matches(".suggestion-bg")) {
					const dismiss = (): void => { if (this.current === session) this.close(); };
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
		// 宿主已自然隐藏时仍使迟到选项失效，但不影响另一种正在显示的菜单。
		this.revision++;
		const session = this.current;
		if (!session) return;
		session.finish();
		session.menu.hide();
	}
}
