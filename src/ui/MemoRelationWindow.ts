import type { MemoRelationNode } from "../types/memoRelations";
import { observationHandleKey } from "../services/DailyMemoPresentationChange";
import type { DailyMemoPresentationChange } from "../services/DailyMemoPresentationChange";

// 高度只保留数字；正文、DOM 与渲染任务仅保留当前窗口及正在操作的一行。
export class RelationRowHeights {
	private readonly tree: number[];
	constructor(readonly values: number[]) {
		this.tree = new Array<number>(values.length + 1).fill(0);
		for (let index = 0; index < values.length; index++) this.add(index, values[index]);
	}
	prefix(end: number): number { let total = 0; for (; end > 0; end -= end & -end) total += this.tree[end]; return total; }
	set(index: number, height: number): void { const delta = height - this.values[index]; this.values[index] = height; this.add(index, delta); }
	indexAt(offset: number): number {
		let index = 0, sum = 0;
		for (let step = 2 ** Math.floor(Math.log2(Math.max(1, this.values.length))); step > 0; step >>= 1) {
			if (index + step < this.tree.length && sum + this.tree[index + step] <= offset) { sum += this.tree[index + step]; index += step; }
		}
		return Math.min(index, Math.max(0, this.values.length - 1));
	}
	private add(index: number, delta: number): void { for (index++; index < this.tree.length; index += index & -index) this.tree[index] += delta; }
}

export class MemoRelationWindow {
	private nodes: readonly MemoRelationNode[] = [];
	private heights = new RelationRowHeights([]);
	private readonly measured = new Map<string, number>();
	private readonly rows = new Map<string, HTMLElement>();
	private readonly ready = new Map<HTMLElement, Promise<void>>();
	private readonly resize: ResizeObserver | null;
	private indices = new Map<string, number>();
	private disposed = false;
	private queued = false;
	private complete = true;

	constructor(readonly el: HTMLElement, private readonly scroll: HTMLElement, private readonly estimate: number,
		private readonly render: (row: HTMLElement, node: MemoRelationNode, index: number) => Promise<void>,
		private readonly release: (row: HTMLElement) => void) {
		el.classList.add("knomo-relation-window");
		el.setAttribute("role", "list");
		el.setAttribute("tabindex", "-1");
		const Resize = (el.win as Window & { ResizeObserver?: typeof ResizeObserver }).ResizeObserver;
		this.resize = Resize ? new Resize(() => this.measure()) : null;
		scroll.addEventListener("scroll", this.onScroll, { passive: true });
		el.addEventListener("keydown", this.onKeydown);
	}

	setNodes(nodes: readonly MemoRelationNode[], complete = true): void {
		const anchor = this.captureAnchor();
		const previous = this.nodes;
		const focused = [...this.rows].find(([, row]) => row.contains(this.el.doc.activeElement));
		this.nodes = nodes;
		this.indices = new Map(nodes.map((node, index) => [observationHandleKey(node.handle), index]));
		this.heights = new RelationRowHeights(nodes.map(node => this.measured.get(observationHandleKey(node.handle)) ?? this.estimate));
		for (const [key, row] of this.rows) if (!this.indices.has(key)) this.remove(key, row);
		for (const key of this.measured.keys()) if (!this.indices.has(key)) this.measured.delete(key);
		this.setComplete(complete);
		this.layout();
		const oldIndex = anchor ? previous.findIndex(node => observationHandleKey(node.handle) === anchor.key) : -1;
		const neighbor = oldIndex < 0 ? undefined : previous.slice(oldIndex + 1).find(node => this.indices.has(observationHandleKey(node.handle)))
			?? previous.slice(0, oldIndex).reverse().find(node => this.indices.has(observationHandleKey(node.handle)));
		this.restoreAnchor(anchor && !this.indices.has(anchor.key) && neighbor ? { key: observationHandleKey(neighbor.handle), offset: anchor.offset } : anchor);
		this.update();
		if (focused && !this.indices.has(focused[0])) {
			const focusAfterRemoval = this.el.doc.activeElement;
			const index = Math.min(Math.max(0, previous.findIndex(node => observationHandleKey(node.handle) === focused[0])), nodes.length - 1);
			const row = this.ensureRow(index);
			void Promise.resolve(row ? this.ready.get(row) : undefined).then(() => {
				if (this.disposed || !this.el.isConnected || this.el.doc.activeElement !== focusAfterRemoval || this.el.contains(this.el.doc.activeElement)) return;
				(row?.querySelector<HTMLElement>("button,a[href],input") ?? this.el).focus({ preventScroll: true });
			});
		}
	}

	setComplete(complete: boolean): void {
		this.complete = complete;
		for (const row of this.rows.values()) row.setAttribute("aria-setsize", String(complete ? this.nodes.length : -1));
	}

	remap(change: DailyMemoPresentationChange, rebind: (row: HTMLElement, before: MemoRelationNode, after: MemoRelationNode) => void): void {
		const replacements = new Map(change.replacements.map(item => [observationHandleKey(item.before), item.after]));
		this.nodes = this.nodes.map(node => {
			const key = observationHandleKey(node.handle), after = replacements.get(key);
			if (!after || after.rawBlockHash !== node.handle.rawBlockHash) return node;
			const current = { ...node, handle: after }, nextKey = observationHandleKey(after), row = this.rows.get(key);
			if (row) {
				this.rows.delete(key); this.rows.set(nextKey, row); row.dataset.relationRow = nextKey;
				rebind(row, node, current);
			}
			const measured = this.measured.get(key);
			if (measured !== undefined) { this.measured.delete(key); this.measured.set(nextKey, measured); }
			return current;
		});
		this.indices = new Map(this.nodes.map((node, index) => [observationHandleKey(node.handle), index]));
	}

	refresh(): void { this.update(); }
	async settled(): Promise<void> { await Promise.all([...this.ready.values()]); }
	readingAnchor(): { key: string; offset: number } | null { return this.captureAnchor(); }
	restoreReadingAnchor(anchor: { key: string; offset: number }): void { this.restoreAnchor(anchor); this.update(); }

	dispose(): void {
		this.disposed = true;
		this.scroll.removeEventListener("scroll", this.onScroll);
		this.el.removeEventListener("keydown", this.onKeydown);
		this.resize?.disconnect();
		for (const [key, row] of this.rows) this.remove(key, row);
		this.measured.clear();
	}

	private offset(): number { return this.scroll.scrollTop + this.el.getBoundingClientRect().top - this.scroll.getBoundingClientRect().top; }
	private onScroll = (): void => {
		if (this.queued) return;
		this.queued = true;
		this.el.win.requestAnimationFrame(() => { this.queued = false; if (!this.disposed) this.update(); });
	};
	private update(): void {
		if (this.disposed) return;
		const top = this.scroll.scrollTop - this.offset();
		const start = this.heights.indexAt(Math.max(0, top - 600));
		const end = Math.min(this.nodes.length, start + 24, this.heights.indexAt(Math.max(0, top + this.scroll.clientHeight + 600)) + 2);
		const wanted = new Set(this.nodes.slice(start, end).map(node => observationHandleKey(node.handle)));
		for (const [key, row] of this.rows) if (!wanted.has(key) && !row.contains(this.el.doc.activeElement)) this.remove(key, row);
		for (let index = start; index < end; index++) this.ensureRow(index);
		this.layout();
	}
	private ensureRow(index: number): HTMLElement | undefined {
		const node = this.nodes[index];
		if (!node) return;
		const key = observationHandleKey(node.handle);
		let row = this.rows.get(key);
		if (!row) {
			row = this.el.createDiv({ cls: "knomo-relation-window-row", attr: { role: "listitem", "data-relation-row": key } });
			this.rows.set(key, row);
			this.resize?.observe(row);
		}
		if (!row.firstElementChild && row.dataset.loading !== "true") {
			row.dataset.loading = "true";
			const ready = this.render(row, node, index).finally(() => {
				if (this.ready.get(row!) !== ready) return;
				row!.dataset.loading = "false";
				this.ready.delete(row!);
				if (!this.disposed && this.rows.get(row!.dataset.relationRow!) === row) {
					this.measure();
					// 旧批次被取消时仍可能保留同一行；完成后显式接续，不等待下一次滚动。
					if (!row!.firstElementChild) this.onScroll();
				}
			});
			this.ready.set(row, ready);
			void ready.catch(() => undefined);
		}
		row.setAttribute("aria-posinset", String(index + 1));
		row.setAttribute("aria-setsize", String(this.complete ? this.nodes.length : -1));
		return row;
	}
	private layout(): void {
		this.el.setCssProps({ "--knomo-relation-height": this.heights.prefix(this.nodes.length) + "px" });
		let expected = this.el.firstElementChild;
		for (const [key, row] of [...this.rows].sort((a, b) => this.indices.get(a[0])! - this.indices.get(b[0])!)) {
			row.setCssProps({ "--knomo-relation-top": this.heights.prefix(this.indices.get(key)!) + "px" });
			if (row !== expected) this.el.insertBefore(row, expected);
			expected = row.nextElementSibling;
		}
	}
	private measure(): void {
		if (this.disposed) return;
		const anchor = this.captureAnchor();
		let changed = false;
		for (const [key, row] of this.rows) {
			if (!row.firstElementChild || row.dataset.loading === "true") continue;
			const index = this.indices.get(key), height = row.getBoundingClientRect().height;
			if (index === undefined || height < 1 || Math.abs(this.heights.values[index] - height) < 1) continue;
			this.measured.set(key, height); this.heights.set(index, height); changed = true;
		}
		if (changed) { this.layout(); this.restoreAnchor(anchor); this.update(); }
	}
	private captureAnchor(): { key: string; offset: number } | null {
		const offset = this.scroll.scrollTop - this.offset();
		if (offset < 0 || !this.nodes.length) return null;
		const index = this.heights.indexAt(offset);
		return { key: observationHandleKey(this.nodes[index].handle), offset: offset - this.heights.prefix(index) };
	}
	private restoreAnchor(anchor: { key: string; offset: number } | null): void {
		const index = anchor ? this.indices.get(anchor.key) : undefined;
		if (index !== undefined) this.scroll.scrollTop = this.offset() + this.heights.prefix(index) + anchor!.offset;
	}
	private remove(key: string, row: HTMLElement): void {
		this.resize?.unobserve(row); this.release(row); row.remove(); this.rows.delete(key); this.ready.delete(row);
	}
	private onKeydown = (event: KeyboardEvent): void => {
		if (event.key !== "Tab" || event.defaultPrevented) return;
		const active = this.el.doc.activeElement as HTMLElement | null;
		const row = active?.closest<HTMLElement>("[data-relation-row]");
		const index = row ? this.indices.get(row.dataset.relationRow!) : undefined;
		if (index === undefined || !row) return;
		const controls = Array.from(row.querySelectorAll<HTMLElement>("button:not(:disabled),a[href],input:not(:disabled),[tabindex='0']"));
		if (active !== (event.shiftKey ? controls[0] : controls[controls.length - 1])) return;
		const next = index + (event.shiftKey ? -1 : 1);
		if (next < 0 || next >= this.nodes.length) return;
		event.preventDefault();
		const target = this.ensureRow(next);
		this.layout();
		const focus = () => {
			if (!target?.isConnected) return;
			const buttons = target.querySelectorAll<HTMLElement>("button:not(:disabled),a[href],input:not(:disabled),[tabindex='0']");
			(event.shiftKey ? buttons[buttons.length - 1] : buttons[0])?.focus();
		};
		void Promise.resolve(target ? this.ready.get(target) : undefined).then(() => this.el.win.requestAnimationFrame(focus));
	};
}
