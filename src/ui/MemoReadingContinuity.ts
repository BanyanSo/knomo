import type { MemoViewItem } from "../types/memoView";
import { getMemoRenderKey } from "./MemoRenderRevision";

export interface MountedMemoCard { memo: MemoViewItem; card: HTMLElement }

// 仅保留容器的亚像素取整余量，不保存卡片、正文或跨 Revision 身份。
const scrollRounding = new WeakMap<HTMLElement, { scrollTop: number; error: number }>();

export function clearMemoReadingCompensation(root: HTMLElement): void { scrollRounding.delete(root); }

// 几何证据只用于一次布局补偿，绝不返回或重绑 observation。
export class MemoReadingPosition {
	readonly scrollTop: number;
	private readonly before: readonly MountedMemoCard[];
	private readonly candidates: Array<{ index: number; offset: number }>;
	constructor(private readonly root: HTMLElement, before: readonly MountedMemoCard[]) {
		this.before = [...before];
		this.scrollTop = root.scrollTop;
		const rounding = scrollRounding.get(root);
		const error = rounding?.scrollTop === this.scrollTop ? rounding.error : 0;
		const bounds = root.getBoundingClientRect();
		const positions = before.map(({ card }, index) => {
			const rect = card.getBoundingClientRect();
			return { index, offset: rect.top - bounds.top + error, bottom: rect.bottom - bounds.top };
		});
		const first = positions.findIndex(position => position.bottom > 0);
		this.candidates = first < 0 ? [] : [...positions.slice(first), ...positions.slice(0, first).reverse()];
	}

	target(after: readonly MountedMemoCard[], changes?: ReadonlyMap<string, MemoViewItem | null>, positional = false): number {
		if (this.scrollTop <= 1) return 0;
		const byKey = new Map(after.map(item => [getMemoRenderKey(item.memo), item.card]));
		for (const candidate of this.candidates) {
			const previous = this.before[candidate.index].memo;
			const current = changes?.has(previous.id) ? changes.get(previous.id) : previous;
			const card = current ? byKey.get(getMemoRenderKey(current)) : undefined;
			if (card) return this.position(card, candidate.offset);
		}
		if (positional && comparableMemoOrder(this.before.map(item => item.memo), after.map(item => item.memo))) {
			const candidate = this.candidates[0];
			if (candidate) return this.position(after[candidate.index].card, candidate.offset);
		}
		return this.scrollTop;
	}

	restore(after: readonly MountedMemoCard[], changes?: ReadonlyMap<string, MemoViewItem | null>, positional = false): void {
		const target = Math.max(0, this.target(after, changes, positional));
		if (Math.abs(this.root.scrollTop - target) > 0.01) this.root.scrollTop = target;
		const error = this.root.scrollTop - target;
		if (this.scrollTop > 1 && Math.abs(error) <= 1) scrollRounding.set(this.root, { scrollTop: this.root.scrollTop, error });
		else scrollRounding.delete(this.root);
	}

	private position(card: HTMLElement, offset: number): number {
		return this.root.scrollTop + card.getBoundingClientRect().top - this.root.getBoundingClientRect().top - offset;
	}
}

function memoGroup(memo: MemoViewItem): string {
	return JSON.stringify([memo.dailyRef.path, memo.createdAt, memo.dailyRef.heading, memo.status]);
}

function comparableMemoOrder(before: readonly MemoViewItem[], after: readonly MemoViewItem[]): boolean {
	if (before.length < 3 || before.length !== after.length) return false;
	const signature = (memo: MemoViewItem) => JSON.stringify([memoGroup(memo), memo.contentSnapshot]);
	const previous = before.map(signature), current = after.map(signature);
	// 重复展示、可见重排、增删及替换无权触发按序号补偿。
	if (new Set(previous).size !== previous.length || new Set(current).size !== current.length) return false;
	let changed = 0;
	return before.every((memo, index) => memoGroup(memo) === memoGroup(after[index])
		&& (previous[index] === current[index] || ++changed <= 1));
}

// 只接续刷新前仍属于本结果区的焦点。文档级监听仅存活于这次协调。
export class MemoFocusRestore {
	private readonly doc: Document | undefined;
	private readonly active: HTMLElement | null;
	private readonly previous: MemoViewItem | undefined;
	private cancelled = false;
	private readonly interrupt = (event: Event) => {
		if (event.type !== "focusin" || event.target !== this.active) this.cancelled = true;
	};
	constructor(private readonly root: HTMLElement, before: readonly MountedMemoCard[], private readonly watch = false) {
		this.doc = root.ownerDocument;
		this.active = this.doc?.activeElement as HTMLElement | null;
		this.previous = this.active ? before.find(({ card }) => card.contains(this.active))?.memo : undefined;
		if (this.previous && watch) for (const type of ["focusin", "pointerdown", "keydown", "compositionstart"]) this.doc?.addEventListener(type, this.interrupt, true);
	}

	restore(after: readonly MountedMemoCard[], changes?: ReadonlyMap<string, MemoViewItem | null>): void {
		const doc = this.doc, active = this.active;
		if (!doc || !active || !this.previous || this.cancelled || !this.root.isConnected
			|| doc.visibilityState === "hidden" || !doc.hasFocus()) return;
		if (doc.activeElement === active) return;
		if (doc.activeElement && doc.activeElement !== doc.body && doc.activeElement !== this.root) return;
		const current = changes?.has(this.previous.id) ? changes.get(this.previous.id) : this.previous;
		const card = current ? after.find(item => getMemoRenderKey(item.memo) === getMemoRenderKey(current))?.card : undefined;
		// 只有已确认映射或仍有效的原绑定才允许接续菜单；任务与文本输入回到中立区。
		const target = active.matches(".knomo-card-menu") ? card?.querySelector<HTMLElement>(".knomo-card-menu") : undefined;
		if (target) target.focus({ preventScroll: true });
		else {
			const tabIndex = this.root.getAttribute("tabindex");
			this.root.setAttribute("tabindex", "-1");
			this.root.focus({ preventScroll: true });
			if (tabIndex === null) this.root.removeAttribute("tabindex"); else this.root.setAttribute("tabindex", tabIndex);
		}
	}

	dispose(): void {
		if (this.previous && this.watch) for (const type of ["focusin", "pointerdown", "keydown", "compositionstart"]) this.doc?.removeEventListener(type, this.interrupt, true);
	}
}
