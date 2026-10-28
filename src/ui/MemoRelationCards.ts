import { setIcon } from "obsidian";
import { t } from "../i18n";
import type { MemoViewItem } from "../types/memoView";
import type { MemoRelationSnapshot } from "../types/memoRelations";
import type { ObservationHandle } from "../types/catalog";
import type { CatalogReadService } from "../services/CatalogReadService";
import { observationHandleKey } from "../services/DailyMemoPresentationChange";
import { extractMemoRelationSummary } from "../utils/memoRelations";
import { MemoRelationsChangedError, relationChangeAffects } from "../services/MemoRelationService";
import { CatalogDiscoveryInvalidatedError } from "../services/CatalogReadService";
import { syncMemoCardRelationsAction } from "./KnomoCard";

interface CardBinding { memo: MemoViewItem; nearby: boolean; signature?: string }
const viewHandles = new WeakMap<HTMLElement, ObservationHandle>();

export class MemoRelationCards {
	private readonly cards = new Map<HTMLElement, CardBinding>();
	private readonly observer: IntersectionObserver | null;
	private readonly unsubscribe: () => void;
	private controller: AbortController | null = null;
	private timer: number | null = null;
	private disposed = false;
	private running: Promise<void> | null = null;
	private pending = false;
	private bodyRecoveryKey: string | null = null;
	private invalidatedVersion: number | null = null;
	private diagnosticKey: string | null = null;

	constructor(private readonly read: CatalogReadService, private readonly win: Window,
		private readonly open: (handle: ObservationHandle, trigger: HTMLElement, focusSubject: boolean) => Promise<void>) {
		const Observer = (win as Window & { IntersectionObserver?: typeof IntersectionObserver }).IntersectionObserver;
		this.observer = Observer ? new Observer(entries => {
			for (const entry of entries) { const binding = this.cards.get(entry.target as HTMLElement); if (binding) binding.nearby = entry.isIntersecting; }
			this.schedule();
		}, { rootMargin: "320px 0px" }) : null;
		this.unsubscribe = read.relations.subscribe(change => {
			const affected = [...this.cards].filter(([, binding]) => relationChangeAffects(change, binding.memo.catalog!.observationHandle));
			if (!affected.length) return;
			this.controller?.abort();
			for (const [card] of affected) markRelationCardStale(card);
			this.schedule();
		});
	}

	observe(card: HTMLElement, memo: MemoViewItem): void {
		if (!memo.catalog || memo.status !== "active") return;
		// 关联页仅更新菜单可见性，不继续展开下一层引用摘要。
		const previous = this.cards.get(card);
		if (previous && previous.memo.id !== memo.id) markRelationCardStale(card);
		this.cards.set(card, { memo, nearby: previous?.nearby ?? this.observer === null,
			signature: previous?.memo.id === memo.id ? previous.signature : undefined });
		this.observer?.observe(card);
		this.schedule();
	}

	refresh(): void { this.schedule(); }
	release(container: HTMLElement): void {
		for (const card of this.cards.keys()) if (container.contains(card)) {
			this.observer?.unobserve(card);
			this.cards.delete(card);
		}
		if (!this.cards.size) {
			this.controller?.abort(); this.pending = false;
			if (this.timer !== null) { this.win.clearTimeout(this.timer); this.timer = null; }
		}
	}
	dispose(): void {
		this.disposed = true;
		this.controller?.abort();
		if (this.timer !== null) this.win.clearTimeout(this.timer);
		this.observer?.disconnect();
		this.unsubscribe();
		this.cards.clear();
	}

	private schedule(): void {
		if (this.disposed || this.timer !== null) return;
		this.timer = this.win.setTimeout(() => { this.timer = null; void this.flush(); }, 35);
	}

	private async flush(): Promise<void> {
		if (this.running) { this.pending = true; return this.running; }
		const task = this.readVisible();
		this.running = task;
		try { await task; }
		finally {
			if (this.running === task) this.running = null;
			if (this.pending) { this.pending = false; this.schedule(); }
		}
	}

	private async readVisible(): Promise<void> {
		if (this.disposed) return;
		const controller = new AbortController(); this.controller = controller;
		const signal = controller.signal;
		for (const card of this.cards.keys()) if (!card.isConnected) { this.cards.delete(card); this.observer?.unobserve(card); }
		const visible = [...this.cards].filter(([card, binding]) => binding.nearby && card.getClientRects().length > 0);
		if (!visible.length) return;
		let bodyKey = "";
		try {
			const snapshot = await this.read.relations.read(signal, visible.map(([, binding]) => binding.memo.catalog!.observationHandle));
			const handles = new Map<string, ObservationHandle>();
			const changed = visible.filter(([card, binding]) => !card.closest(".knomo-relations-page") && binding.signature !== relationCardSignature(snapshot, binding.memo)
				&& (snapshot.complete || !card.querySelector(".knomo-memo-referrers")));
			for (const [, binding] of changed) for (const node of snapshot.referrers.get(binding.memo.id) ?? []) handles.set(observationHandleKey(node.handle), node.handle);
			// 为可见卡片分批读取全部引用者摘要，保留取消及版本校验。
			const summaries = new Map<string, { text: string; imageOnly: boolean }>();
			const wanted = [...handles.values()];
			bodyKey = JSON.stringify(wanted.map(observationHandleKey));
			for (let offset = 0; offset < wanted.length; offset += 64) {
				const items = await this.read.readMemoItems(wanted.slice(offset, offset + 64), signal);
				for (const item of items) summaries.set(item.key, extractMemoRelationSummary(item.content));
			}
			await this.read.relations.assertCurrent(snapshot, signal, visible.map(([, binding]) => binding.memo.catalog!.observationHandle));
			for (const [card, binding] of visible) {
				if (!card.isConnected || this.cards.get(card) !== binding) continue;
				syncMemoCardRelationsAction(card, binding.memo, snapshot.nodes.has(binding.memo.id) && !!snapshot.referrers.get(binding.memo.id)?.length);
				if (!card.closest(".knomo-relations-page")) renderMemoReferrers(card, binding.memo, snapshot, summaries, this.open);
				if (snapshot.complete || !card.querySelector(".knomo-memo-referrers[data-stale]")) binding.signature = relationCardSignature(snapshot, binding.memo);
			}
		} catch (error) {
			if (signal.aborted || this.disposed) return;
			for (const card of visible.map(([card]) => card)) markRelationCardStale(card);
			if (error instanceof MemoRelationsChangedError || error instanceof CatalogDiscoveryInvalidatedError) {
				if (this.invalidatedVersion !== this.read.relations.revision) {
					this.invalidatedVersion = this.read.relations.revision; this.schedule();
				}
			} else if (bodyKey && this.bodyRecoveryKey !== bodyKey) {
				this.bodyRecoveryKey = bodyKey; this.schedule();
			} else if (this.diagnosticKey !== bodyKey) { this.diagnosticKey = bodyKey; console.error("Knomo relation preview read failed", error); }
		}
	}
}

export function relationCardSignature(snapshot: MemoRelationSnapshot, memo: MemoViewItem): string {
	return JSON.stringify([snapshot.nodes.has(memo.id),
		(snapshot.referrers.get(memo.id) ?? []).map(node => observationHandleKey(node.handle))]);
}

export function markRelationCardStale(card: HTMLElement): void {
	const region = card.querySelector<HTMLElement>(".knomo-memo-referrers");
	if (!region) return;
	region.dataset.stale = "true";
}

export function renderMemoReferrers(card: HTMLElement, memo: MemoViewItem, snapshot: MemoRelationSnapshot,
	summaries: ReadonlyMap<string, { text: string; imageOnly: boolean }>,
	open: (handle: ObservationHandle, trigger: HTMLElement, focusSubject: boolean) => Promise<void>): void {
	const incoming = snapshot.referrers.get(memo.id) ?? [];
	const old = card.querySelector<HTMLElement>(".knomo-memo-referrers");
	const focused = old?.contains(card.ownerDocument.activeElement) ?? false;
	if (!snapshot.nodes.has(memo.id)) { markRelationCardStale(card); return; }
	// 部分结果中的缺席不能证明关系消失；保留一份阅读切片，不合并新旧集合。
	if (old && !snapshot.complete && old.dataset.previewSignature !== relationCardSignature(snapshot, memo)) {
		markRelationCardStale(card); return;
	}
	if (!incoming.length) {
		old?.remove();
		if (focused) card.querySelector<HTMLElement>(".knomo-card-menu, .knomo-card-time")?.focus({ preventScroll: true });
		return;
	}
	const signature = relationCardSignature(snapshot, memo);

	if (old?.dataset.previewSignature === signature) {
		for (const button of Array.from(old.querySelectorAll<HTMLElement>(".knomo-referrer-preview"))) viewHandles.set(button, memo.catalog!.observationHandle);
		old.toggleAttribute("data-stale", !snapshot.complete);
		return;
	}
	const region = card.ownerDocument.createElement("section");
	region.className = "knomo-memo-referrers knomo-card-meta";
	region.setAttribute("aria-label", t("relations.heading"));
	region.dataset.previewSignature = signature;
	if (!snapshot.complete) region.dataset.stale = "true";
	for (const node of incoming) {
		const summary = summaries.get(observationHandleKey(node.handle));
		const text = summary?.text || t(summary?.imageOnly ? "relations.image" : "relations.noSummary");
		const date = node.logicalDate;
		const label = t("relations.viewLabel");
		const button = region.createEl("button", { cls: "knomo-referrer-preview", attr: { type: "button", "aria-label": label } });
		button.dataset.relationTarget = observationHandleKey(node.handle); button.dataset.relationAction = "preview";
		const icon = button.createSpan({ cls: "knomo-reference-icon", attr: { "aria-hidden": "true" } });
		setIcon(icon, "message-square-reply");
		button.createEl("time", { cls: "knomo-referrer-date", text: date, attr: { datetime: date } });
		button.createSpan({ cls: "knomo-referrer-summary", text });
		viewHandles.set(button, memo.catalog!.observationHandle);
		button.addEventListener("click", event => {
			event.stopPropagation();
			// 仅键盘或辅助技术激活时转移焦点，避免首次触摸进入后在时间按钮上显示焦点环。
			void open(viewHandles.get(button)!, button, event.detail === 0);
		});
	}
	const active = focused ? card.ownerDocument.activeElement as HTMLElement : null;
	const target = active?.dataset.relationTarget, action = active?.dataset.relationAction;
	if (old) old.replaceWith(region); else card.appendChild(region);
	if (focused) (Array.from(region.querySelectorAll<HTMLElement>("button")).find(button => button.dataset.relationTarget === target
		&& button.dataset.relationAction === action) ?? region.querySelector<HTMLElement>("button")!).focus({ preventScroll: true });
}
