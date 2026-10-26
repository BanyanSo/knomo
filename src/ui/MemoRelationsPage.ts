import { t } from "../i18n";
import type { ObservationHandle } from "../types/catalog";
import type { MemoRelationNode, MemoRelationSnapshot } from "../types/memoRelations";
import { toCatalogMemoView, type MemoViewItem } from "../types/memoView";
import type { CatalogReadService } from "../services/CatalogReadService";
import { observationHandleKey, type DailyMemoPresentationChange } from "../services/DailyMemoPresentationChange";
import { MemoRelationWindow } from "./MemoRelationWindow";
import { MemoRelationSubjectUnavailableError, MemoRelationsChangedError, relationChangeAffects } from "../services/MemoRelationService";
import { CatalogDiscoveryInvalidatedError } from "../services/CatalogReadService";
import { DelayedLoadingIndicator } from "./DelayedLoadingIndicator";
import { canRetainMemoCard, rebindMemoCard } from "./MemoRenderRevision";
import { remapUnchangedMemo } from "./ConfirmedMemoPresentation";
import { renderKnomoLoadingPlaceholder } from "./KnomoFeed";

interface RelationFrame { handle: ObservationHandle; scroll: number; focus: string | null; anchor?: { key: string; offset: number } | null }

export interface MemoRelationsPageOptions {
	read: CatalogReadService;
	getHost: () => HTMLElement | null;
	renderCard: (container: HTMLElement, memo: MemoViewItem, index: number) => HTMLElement;
	releaseCard: (card: HTMLElement) => void;
	retainCard?: (card: HTMLElement, memo: MemoViewItem) => void;
	onChanged: (open: boolean) => void;
	onError: (message: string) => void;
}

export class MemoRelationsPage {
	generation = 0;
	el: HTMLElement | null = null;
	private frames: RelationFrame[] = [];
	private originalFocus: HTMLElement | null = null;
	private readonly memos = new Map<string, MemoViewItem>();
	private subject: HTMLElement | null = null;
	private contextDate: HTMLElement | null = null;
	private sourcesEl: HTMLElement | null = null;
	private listEl: HTMLElement | null = null;
	private listTitle: HTMLElement | null = null;
	private status: HTMLElement | null = null;
	private sourcesWindow: MemoRelationWindow | null = null;
	private referrersWindow: MemoRelationWindow | null = null;
	private controller: AbortController | null = null;
	private rowController = new AbortController();
	private queued = false;
	private refreshTimer: number | null = null;
	private running: Promise<void> | null = null;
	private pending = false;
	private invalidatedVersion: number | null = null;
	private subjectRecoveryKey: string | null = null;
	private sources: readonly MemoRelationNode[] | null = null;
	private referrers: readonly MemoRelationNode[] | null = null;
	private sourcesTitle: HTMLElement | null = null;
	private nativeHint: HTMLElement | null = null;
	private loadingEl: HTMLElement | null = null;
	private loading: DelayedLoadingIndicator | null = null;
	private readonly rowFailures = new Map<string, number>();
	private rowFaultScope: string | null = null;
	private disposed = false;
	private navigationRun = 0;
	private readonly pendingRows = new Map<HTMLElement, { node: MemoRelationNode; index: number; done: () => void; signal: AbortSignal; generation: number }>();
	private rowsQueued = false;
	private rowsTimer: number | null = null;
	private readonly unsubscribe: () => void;

	constructor(private readonly options: MemoRelationsPageOptions) {
		this.unsubscribe = options.read.relations.subscribe(change => {
			if (!this.isOpen || !relationChangeAffects(change, this.frames[this.frames.length - 1].handle)) return;
			this.controller?.abort();
			this.rowController.abort(); this.rowController = new AbortController();
			this.markStale();
			this.refresh();
		});
	}

	get isOpen(): boolean { return this.frames.length > 0; }
	getMemos(): MemoViewItem[] { return [...this.memos.values()]; }
	findMemo(id: string): MemoViewItem | null { return this.memos.get(id) ?? null; }

	async open(handle: ObservationHandle, list = false, trigger?: HTMLElement): Promise<void> {
		if (this.disposed) return;
		const run = ++this.navigationRun;
		try {
			await this.options.read.relations.verifyHandle(handle);
			const items = await this.options.read.readMemoItems([handle]);
			if (this.disposed || run !== this.navigationRun) return;
			if (!items.length) throw Error("unavailable");
			const key = observationHandleKey(handle);
			const existing = this.frames.findIndex(frame => observationHandleKey(frame.handle) === key);
			if (existing === this.frames.length - 1 && this.isOpen) { if (list) this.scrollToList(); return; }
			if (this.isOpen) {
				const current = this.frames[this.frames.length - 1];
				current.scroll = this.el?.scrollTop ?? 0;
				current.anchor = this.referrersWindow?.readingAnchor();
				if (trigger && this.el?.contains(trigger)) {
					current.focus = JSON.stringify([trigger.dataset.relationTarget ?? trigger.closest(".knomo-card")?.getAttribute("data-memo-id"),
						trigger.dataset.relationAction ?? "menu"]);
				}
			} else this.originalFocus = trigger ?? null;
			if (existing >= 0) this.frames.splice(existing + 1);
			else this.frames.push({ handle: { ...handle }, scroll: 0, focus: null });
			this.options.read.relations.beginReading();
			this.buildShell();
			const memo = toCatalogMemoView(items[0]);
			this.options.onChanged(true);
			this.renderSubject(memo);
			if (!list && existing < 0) this.subject?.querySelector<HTMLElement>(".knomo-card-time,button")?.focus({ preventScroll: true });
			await this.load(list, existing >= 0);
		} catch { if (!this.disposed && run === this.navigationRun) this.options.onError(t("relations.unavailable")); }
	}

	back(): void {
		this.navigationRun++;
		if (!this.isOpen) return;
		this.frames.pop();
		if (!this.isOpen) { this.close(); return; }
		this.buildShell(); this.options.onChanged(true); void this.load(false, true);
	}

	close(restoreFocus = true): void {
		this.navigationRun++;
		if (!this.frames.length && !this.el) return;
		this.frames = [];
		this.clearPage();
		this.options.onChanged(false);
		if (restoreFocus && this.originalFocus?.isConnected) this.originalFocus.focus({ preventScroll: true });
		this.originalFocus = null;
	}

	dispose(): void { this.disposed = true; this.close(false); this.unsubscribe(); }

	applyChange(change: DailyMemoPresentationChange): void {
		const current = this.frames[this.frames.length - 1];
		const affected = current?.handle.sourcePath === change.sourcePath
			|| [...(this.sources ?? []), ...(this.referrers ?? [])].some(node => node.handle.sourcePath === change.sourcePath);
		const replacements = new Map(change.replacements.map(item => [observationHandleKey(item.before), item.after]));
		for (const frame of this.frames) {
			const after = replacements.get(observationHandleKey(frame.handle));
			if (after) frame.handle = after;
		}
		if (!affected) return;
		this.controller?.abort();
		this.rowController.abort(); this.rowController = new AbortController();
		const remap = (node: MemoRelationNode): MemoRelationNode => {
			const after = replacements.get(observationHandleKey(node.handle));
			return after && after.rawBlockHash === node.handle.rawBlockHash ? { ...node, handle: after } : node;
		};
		this.sourcesWindow?.remap(change, (row, _before, after) => {
			const button = row.querySelector<HTMLElement>("button");
			if (button) button.dataset.relationTarget = observationHandleKey(after.handle);
		});
		this.referrersWindow?.remap(change, (row, before, after) => {
			const old = this.memos.get(observationHandleKey(before.handle));
			const memo = old ? remapUnchangedMemo(old, after.handle) : null;
			const card = row.querySelector<HTMLElement>(".knomo-card");
			if (memo && card) { this.memos.delete(old!.id); this.memos.set(memo.id, memo); rebindMemoCard(card, memo); this.options.retainCard?.(card, memo); }
		});
		if (this.sources) this.sources = this.sources.map(remap);
		if (this.referrers) this.referrers = this.referrers.map(remap);
		this.markStale();
		this.refresh();
	}

	refresh(): void {
		if (!this.isOpen || this.queued || this.disposed) return;
		this.queued = true;
		const win = this.el?.win;
		this.refreshTimer = win?.setTimeout(() => { this.queued = false; this.refreshTimer = null; if (this.isOpen && !this.disposed) void this.load(); }, 45) ?? null;
	}

	remount(): void {
		if (!this.isOpen || this.el?.isConnected) return;
		const frame = this.frames[this.frames.length - 1];
		frame.scroll = this.el?.scrollTop ?? frame.scroll;
		this.buildShell(); this.options.onChanged(true); void this.load(false, true);
	}

	private clearPage(): void {
		this.generation++;
		this.controller?.abort();
		if (this.refreshTimer !== null) this.el?.win.clearTimeout(this.refreshTimer);
		if (this.rowsTimer !== null) this.el?.win.clearTimeout(this.rowsTimer);
		this.rowsTimer = null; this.rowsQueued = false;
		this.refreshTimer = null; this.queued = false; this.pending = false; this.running = null;
		this.loading?.clear(); this.loading = null;
		this.sources = null; this.referrers = null; this.rowFailures.clear();
		this.rowFaultScope = null;
		this.subjectRecoveryKey = null; this.invalidatedVersion = null;
		this.rowController.abort(); this.rowController = new AbortController();
		for (const pending of this.pendingRows.values()) pending.done();
		this.pendingRows.clear();
		this.sourcesWindow?.dispose(); this.sourcesWindow = null;
		this.referrersWindow?.dispose(); this.referrersWindow = null;
		if (this.subject) this.options.releaseCard(this.subject);
		this.el?.remove(); this.el = null;
		this.subject = null;
		this.memos.clear();
	}

	private buildShell(): void {
		this.clearPage();
		const host = this.options.getHost();
		if (!host) return;
		const el = this.el = host.createDiv({ cls: "knomo-card-flow knomo-relations-page", attr: { "aria-label": t("relations.title") } });
		const header = el.createDiv({ cls: "knomo-relations-header" });
		const back = header.createEl("button", { cls: "knomo-inline-button", text: "←", attr: { type: "button", "aria-label": t(this.frames.length > 1 ? "relations.back" : "relations.backList") } });
		back.addEventListener("click", () => this.back());
		header.createEl("h2", { text: t("relations.title") });
		this.contextDate = header.createEl("time", { cls: "knomo-relations-context" });
		this.status = el.createDiv({ cls: "knomo-relations-status" });
		this.status.hidden = true;
		el.createEl("h3", { text: t("relations.current"), cls: "knomo-relations-section-title" });
		this.subject = el.createDiv({ cls: "knomo-relations-subject" });
		this.sourcesEl = el.createDiv({ cls: "knomo-relations-sources" });
		this.sourcesTitle = this.sourcesEl.createEl("h3", { cls: "knomo-relations-section-title" });
		const sourceList = this.sourcesEl.createDiv();
		this.nativeHint = this.sourcesEl.createDiv({ cls: "knomo-relations-hint", text: t("relations.nativeLinks") });
		this.nativeHint.hidden = true; this.sourcesEl.hidden = true;
		this.listTitle = el.createEl("h3", { cls: "knomo-relations-section-title", attr: { tabindex: "-1" } });
		this.listTitle.textContent = t("relations.referrersHeading");
		this.loadingEl = el.createDiv({ cls: "knomo-relations-loading", attr: { "aria-busy": "true" } });
		this.loadingEl.hidden = true;
		this.loading = new DelayedLoadingIndicator({ scheduleTask: (callback, delay) => el.win.setTimeout(callback, delay), cancelTask: id => el.win.clearTimeout(id) });
		this.listEl = el.createDiv({ cls: "knomo-relations-list" });
		this.sourcesWindow = new MemoRelationWindow(sourceList, el, 48, async (row, node) => {
			const button = row.createEl("button", { cls: "knomo-relation-source", text: `${node.logicalDate} ${node.time}`, attr: { type: "button" } });
			button.dataset.relationTarget = observationHandleKey(node.handle); button.dataset.relationAction = "source";
			button.addEventListener("click", () => {
				const current = this.sources?.find(source => observationHandleKey(source.handle) === button.dataset.relationTarget);
				if (current) void this.open(current.handle, false, button);
			});
		}, () => undefined);
		this.referrersWindow = new MemoRelationWindow(this.listEl, el, 260,
			(row, node, index) => this.renderRow(row, node, index), row => this.releaseRow(row));
		this.syncLoading(true);
	}

	private renderSubject(memo: MemoViewItem): void {
		if (!this.subject || this.subject.dataset.subject === memo.id) return;
		const old = this.subject.dataset.subject;
		const before = old ? this.memos.get(old) : null, card = this.subject.querySelector<HTMLElement>(".knomo-card");
		if (before && card && canRetainMemoCard(before, memo)) {
			this.memos.delete(before.id); this.memos.set(memo.id, memo); this.subject.dataset.subject = memo.id;
			rebindMemoCard(card, memo); this.options.retainCard?.(card, memo); return;
		}
		const focused = this.subject.contains(this.subject.doc.activeElement), active = this.subject.doc.activeElement as HTMLElement | null;
		const selector = active?.classList.contains("knomo-card-time") ? ".knomo-card-time" : ".knomo-card-menu";
		this.options.releaseCard(this.subject);
		if (old) this.memos.delete(old);
		this.subject.empty();
		this.subject.dataset.subject = memo.id;
		if (this.contextDate) this.contextDate.textContent = memo.createdAt.replace("T", " ");
		this.memos.set(memo.id, memo);
		this.options.renderCard(this.subject, memo, 0);
		if (focused) this.subject.querySelector<HTMLElement>(selector)?.focus({ preventScroll: true });
	}

	private async load(list = false, restore = false): Promise<void> {
		if (this.running) { this.pending = true; return this.running; }
		const task = this.loadCurrent(list, restore);
		this.running = task;
		try { await task; }
		finally {
			if (this.running === task) {
				this.running = null;
				if (this.pending) { this.pending = false; this.refresh(); }
			}
		}
	}

	private async loadCurrent(list = false, restore = false): Promise<void> {
		if (!this.el || !this.isOpen) return;
		this.controller?.abort();
		const controller = this.controller = new AbortController();
		const signal = controller.signal;
		const frame = this.frames[this.frames.length - 1];
		let phase: "subject" | "relations" = "subject";
		try {
			await this.options.read.relations.verifyHandle(frame.handle, signal);
			const key = observationHandleKey(frame.handle);
			if (this.subject?.dataset.subject !== key) {
				const [item] = await this.options.read.readMemoItems([frame.handle], signal);
				signal.throwIfAborted(); this.renderSubject(toCatalogMemoView(item));
			}
			phase = "relations";
			const snapshot = await this.options.read.relations.read(signal, [frame.handle]);
			await this.options.read.relations.assertCurrent(snapshot, signal, [frame.handle]);
			if (!this.el || frame !== this.frames[this.frames.length - 1]) return;
			const sources = snapshot.sources.get(key) ?? [], incoming = snapshot.referrers.get(key) ?? [];
			this.renderSources(sources, snapshot, this.memos.get(key)!);
			if (snapshot.complete || this.referrers === null || this.referrers.length === 0) this.referrers = incoming;
			this.listTitle!.textContent = snapshot.complete ? t("relations.referrers", { count: incoming.length }) : t("relations.referrersHeading");
			this.referrersWindow!.setNodes(this.referrers, snapshot.complete);
			const rowScope = JSON.stringify([key, snapshot.complete, sources.map(node => observationHandleKey(node.handle)), incoming.map(node => observationHandleKey(node.handle))]);
			if (this.rowFaultScope !== rowScope) {
				for (const row of Array.from(this.listEl!.querySelectorAll<HTMLElement>("[data-relation-read-state='failed']"))) {
					if (snapshot.nodes.has(row.dataset.relationRow!)) { this.rowFailures.delete(row.dataset.relationRow!); row.empty(); delete row.dataset.relationReadState; }
				}
				this.rowFaultScope = rowScope;
			}
			for (const key of this.rowFailures.keys()) if (!this.referrers.some(node => observationHandleKey(node.handle) === key)) this.rowFailures.delete(key);
			for (const row of Array.from(this.listEl!.querySelectorAll<HTMLElement>("[data-relation-read-state='pending']"))) {
				if (snapshot.nodes.has(row.dataset.relationRow!)) row.empty();
				else if (snapshot.errors.length && !snapshot.recovering) {
					row.empty(); row.dataset.relationReadState = "failed";
					row.createDiv({ cls: "knomo-relations-hint", text: t("relations.failed"), attr: { role: "status" } });
				}
			}
			this.referrersWindow!.refresh();
			this.syncLoading(!snapshot.complete && !snapshot.errors.length && !this.referrers.length);
			this.showStatus(snapshot.errors.length && !snapshot.recovering ? t("relations.failed") : snapshot.complete && !incoming.length ? t("relations.empty") : "");
			if (list) {
				await this.referrersWindow!.settled();
				signal.throwIfAborted();
			}
			if (restore) {
				this.el.scrollTop = frame.scroll;
				if (frame.anchor) this.referrersWindow!.restoreReadingAnchor(frame.anchor);
				this.referrersWindow!.refresh(); this.sourcesWindow?.refresh();
				await this.referrersWindow!.settled();
				signal.throwIfAborted();
				this.restoreFocus(frame);
			} else if (list) this.scrollToList();
		} catch (error) {
			if (signal.aborted || !this.el) return;
			this.markStale();
			if (phase === "subject") {
				const key = observationHandleKey(frame.handle);
				if (this.subjectRecoveryKey !== key) { this.subjectRecoveryKey = key; this.refresh(); return; }
				this.syncLoading(false);
				this.showStatus(t(error instanceof MemoRelationSubjectUnavailableError || error instanceof CatalogDiscoveryInvalidatedError ? "relations.unavailable" : "relations.failed"));
			} else if (error instanceof MemoRelationsChangedError || error instanceof CatalogDiscoveryInvalidatedError) {
				if (this.invalidatedVersion !== this.options.read.relations.revision) {
					this.invalidatedVersion = this.options.read.relations.revision; this.refresh();
				}
			} else { this.syncLoading(false); this.showStatus(t("relations.failed")); }
		}
		finally {
			if (!signal.aborted) {
				if (list) this.listTitle?.focus({ preventScroll: true });
			}
		}
	}

	private renderSources(nodes: readonly MemoRelationNode[], snapshot: MemoRelationSnapshot, memo: MemoViewItem): void {
		if (!this.sourcesEl || !this.el) return;
		if (snapshot.complete || this.sources === null || this.sources.length === 0) this.sources = nodes;
		this.sourcesTitle!.textContent = t(snapshot.complete ? "relations.sources" : "relations.sourcesHeading");
		this.sourcesTitle!.hidden = !this.sources.length;
		this.nativeHint!.hidden = !(snapshot.complete && !nodes.length && memo.catalog!.observation.explicitReferenceTargets.length);
		this.sourcesEl.hidden = !this.sources.length && this.nativeHint!.hidden;
		this.sourcesWindow!.setNodes(this.sources, snapshot.complete);
	}

	private renderRow(row: HTMLElement, node: MemoRelationNode, index: number): Promise<void> {
		return new Promise(done => {
			this.pendingRows.set(row, { node, index, done, signal: this.rowController.signal, generation: this.generation });
			if (!this.rowsQueued) {
				this.rowsQueued = true;
				this.rowsTimer = this.el?.win.setTimeout(() => { this.rowsQueued = false; this.rowsTimer = null; void this.flushRows(); }, 0) ?? null;
			}
		});
	}
	private async flushRows(): Promise<void> {
		const batch = [...this.pendingRows]; this.pendingRows.clear();
		const signal = this.rowController.signal;
		const generation = this.generation;
		const current = batch.filter(([row, task]) => row.isConnected && !task.signal.aborted && task.generation === generation);
		try {
			if (!current.length) return;
			const handles = current.map(([, task]) => task.node.handle);
			let items;
			try { items = await this.options.read.readMemoItems(handles, signal); }
			catch (error) {
				if (signal.aborted || error instanceof CatalogDiscoveryInvalidatedError || !handles.some(handle => !this.rowFailures.has(observationHandleKey(handle)))) throw error;
				for (const handle of handles) this.rowFailures.set(observationHandleKey(handle), 1);
				await new Promise<void>(resolve => this.el!.win.setTimeout(resolve, 0));
				signal.throwIfAborted(); items = await this.options.read.readMemoItems(handles, signal);
			}
			for (let index = 0; index < current.length; index++) {
				const [row, task] = current[index];
				if (!row.isConnected || signal.aborted || task.generation !== this.generation) continue;
				const memo = toCatalogMemoView(items[index]);
				this.memos.set(memo.id, memo);
				delete row.dataset.relationReadState;
				this.options.renderCard(row, memo, task.index + 1);
			}
		} catch (error) {
			if (signal.aborted || generation !== this.generation) return;
			const invalidated = error instanceof CatalogDiscoveryInvalidatedError;
			let resume = false;
			for (const [row, task] of current) {
				if (!row.isConnected || task.signal.aborted) continue;
				const key = observationHandleKey(task.node.handle), pending = invalidated && !this.rowFailures.has(key);
				this.rowFailures.set(key, 1); resume ||= pending;
				row.dataset.relationReadState = pending ? "pending" : "failed";
				row.createDiv({ cls: "knomo-relations-hint", text: pending ? "" : t("relations.failed"),
					attr: pending ? { "aria-busy": "true" } : { role: "status" } });
			}
			if (resume) this.refresh();
		}
		finally {
			for (const [, task] of batch) task.done();
			const frame = this.frames[this.frames.length - 1];
			if (frame?.focus && !signal.aborted) this.restoreFocus(frame);
		}
	}
	private releaseRow(row: HTMLElement): void {
		const pending = this.pendingRows.get(row);
		if (pending) { this.pendingRows.delete(row); pending.done(); }
		for (const card of Array.from(row.querySelectorAll<HTMLElement>(".knomo-card"))) {
			const key = card.getAttribute("data-memo-id"); if (key) this.memos.delete(key);
		}
		this.options.releaseCard(row);
	}
	private scrollToList(): void {
		if (!this.el || !this.listTitle) return;
		const top = this.el.getBoundingClientRect().top;
		const header = this.el.querySelector<HTMLElement>(".knomo-relations-header");
		const inset = Math.max(0, (header?.getBoundingClientRect().bottom ?? top) - top) + 8;
		this.el.scrollTop += this.listTitle.getBoundingClientRect().top - top - inset;
		this.referrersWindow?.refresh();
		this.listTitle.focus({ preventScroll: true });
	}
	private restoreFocus(frame: RelationFrame): void {
		if (!frame.focus || !this.el) return;
		const [key, action] = JSON.parse(frame.focus) as [string, string];
		const target = Array.from(this.el.querySelectorAll<HTMLElement>("[data-relation-target],.knomo-card-menu")).find(button =>
			button.dataset.relationTarget === key && button.dataset.relationAction === action
			|| action === "menu" && button.closest(".knomo-card")?.getAttribute("data-memo-id") === key);
		(target ?? this.subject?.querySelector<HTMLElement>(".knomo-card-menu,button"))?.focus({ preventScroll: true });
		frame.focus = null;
	}
	private markStale(): void {
		if (this.listTitle) this.listTitle.textContent = t("relations.referrersHeading");
		if (this.sourcesTitle) this.sourcesTitle.textContent = t("relations.sourcesHeading");
		this.referrersWindow?.setComplete(false); this.sourcesWindow?.setComplete(false);
		if (this.status?.dataset.message !== t("relations.failed") && this.status?.dataset.message !== t("relations.unavailable")) this.showStatus("");
	}

	private syncLoading(pending: boolean): void {
		if (!this.loadingEl || !this.loading) return;
		if (!pending) { this.loading.clear(); this.loadingEl.hidden = true; return; }
		this.loadingEl.hidden = !this.loading.pending(String(this.generation), () => {
			if (!this.loadingEl || !this.isOpen) return;
			this.loadingEl.hidden = false;
			if (!this.loadingEl.firstElementChild) renderKnomoLoadingPlaceholder(this.loadingEl, true, false);
		});
	}

	private showStatus(message: string): void {
		if (!this.status) return;
		if (this.status.dataset.message === message) return;
		this.status.dataset.message = message;
		this.status.empty(); this.status.hidden = !message;
		const fault = message === t("relations.failed") || message === t("relations.unavailable");
		if (fault) { this.status.setAttribute("role", "status"); this.status.setAttribute("aria-live", "polite"); }
		else { this.status.removeAttribute("role"); this.status.removeAttribute("aria-live"); }
		this.status.createSpan({ text: message });
	}
}
