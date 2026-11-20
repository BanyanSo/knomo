import type { MemoObservation, ObservationHandle } from "../types/catalog";
import type { CatalogMemoItem } from "../types/catalogView";
import type { MarkdownBlockReferenceResult } from "../types/memoOperations";
import { sameBeaconHandle, type BeaconReference, type BeaconSnapshot } from "../types/beacon";
import { toCatalogMemoView } from "../types/memoView";
import { buildPluginDataWithBeacon, getBeaconData, parseBeaconReference } from "../utils/pluginData";
import { PluginDataStore } from "./PluginDataStore";
import type { ConfirmedDailyMemoPresentation } from "./DailyMemoPresentationChange";
import { logContinuationFailure } from "../utils/continuationDiagnostics";

import { confirmDailyAnchor, findDailyAnchor, DailyAnchorError, DailyAnchorChangedError, DailyAnchorSourceUnavailableError as BeaconSourceUnavailableError,
	DailyAnchorSourceUnlocatedError as BeaconSourceUnlocatedError, type DailyAnchorSource as BeaconSource } from "./DailyMemoAnchor";
export { DailyAnchorSourceUnavailableError as BeaconSourceUnavailableError, DailyAnchorSourceUnlocatedError as BeaconSourceUnlocatedError,
	DailyAnchorNotSavedError as BeaconNotSavedError, type DailyAnchorSource as BeaconSource } from "./DailyMemoAnchor";

export interface BeaconServiceOptions {
	readSource: (path: string) => Promise<BeaconSource>;
	isSourceCurrent: (source: BeaconSource) => Promise<boolean>;
	createBlockReference: (handle: ObservationHandle) => Promise<MarkdownBlockReferenceResult>;
	fromObservation: (observation: MemoObservation) => CatalogMemoItem;
	onFailure: (error: unknown, operation: "read" | "write") => void;
}

// 灯标只保存一个原生锚点选择；当前正文和操作句柄始终来自已核对的 Daily。
export class BeaconService {
	private raw: unknown;
	private reference: BeaconReference | null = null;
	private snapshot: BeaconSnapshot = { state: "unset", selection: 0 };
	private readonly listeners = new Set<() => void>();
	private readonly renamedSources = new Map<string, { sourcePath: string; sourceRevision: string }>();
	private presentedSource: Pick<BeaconSource, "path" | "sourceRevision"> | null = null;
	private renamedPath: string | null = null;
	private source: BeaconSource | null = null;
	private queue: Promise<unknown> = Promise.resolve();
	private generation = 0;
	private configuration = 0;
	private intent = 0;
	private selection = 0;
	private readable = false;
	private closed = false;
	private deleted = false;
	private settingSource: { path: string; interrupted: boolean; events: number } | null = null;
	private pending: { reference: BeaconReference | null; intent: number; selection: number; generation: number } | null = null;
	private resolving: { generation: number; intent: number; promise: Promise<void> } | null = null;

	constructor(private readonly store: PluginDataStore, private readonly options: BeaconServiceOptions,
		private readonly runMutation: <T>(action: () => Promise<T>) => Promise<T> = action => action()) {}
	getSnapshot(): BeaconSnapshot { return this.snapshot; }
	retry(): Promise<void> { return this.readable ? this.refresh() : this.reload(); }
	isSelectedHandle(handle: ObservationHandle): boolean {
		const current = this.snapshot.memo?.catalog?.observationHandle;
		return this.snapshot.state === "ready" && current !== undefined && sameBeaconHandle(current, handle);
	}
	// 仅判断当前解析结果的展示归属，不能借此替换已打开操作的原 observation。
	isBoundObservation(observation: MemoObservation, blockAnchors?: Readonly<Record<string, number>>): boolean {
		return !this.deleted && this.reference !== null && observation.sourcePath === this.selectedPath()
			&& observation.existingBlockId === this.reference.blockId && blockAnchors?.[this.reference.blockId] === 1;
	}
	subscribe(listener: () => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
	dispose(): void { this.closed = true; this.generation++; this.intent++; this.source = null; this.listeners.clear(); }

	reload(): Promise<void> {
		this.intent++;
		this.invalidate();
		return this.serial(async () => {
			try {
				const raw = getBeaconData(await this.store.read());
				if (this.closed) return;
				this.readable = true;
				this.accept(raw);
				this.invalidate();
			} catch (error) {
				if (this.closed) return;
				this.readable = false;
				this.configuration++;
				this.invalidate();
				this.publish("unavailable", "unreadable");
				this.options.onFailure(error, "read");
			}
		}).finally(() => this.resumePending()).then(() => this.refresh());
	}

	set(handle: ObservationHandle): Promise<void> {
		const original = { sourcePath: handle.sourcePath, sourceRevision: handle.sourceRevision,
			startLine: handle.startLine, endLine: handle.endLine, rawBlockHash: handle.rawBlockHash };
		return this.runMutation(() => this.setSelection(original));
	}

	private setSelection(original: ObservationHandle): Promise<void> {
		const intent = ++this.intent;
		return this.serial(async () => {
			this.assertWritable();
			if (intent !== this.intent) return;
			const expected = fingerprint(this.raw), configuration = this.configuration;
			const setting = this.settingSource = { path: original.sourcePath, interrupted: false, events: 0 };
			const current = () => !this.closed && this.readable && this.intent === intent
				&& this.configuration === configuration && !setting.interrupted;
			try {
				const result = await this.options.createBlockReference(original);
				if (!current()) throw new Error("Beacon selection changed.");
				// 新建和复用 ID 都复核本次返回的 occurrence；编辑器事务本身不证明落盘。
				const { source, observation } = await confirmDailyAnchor(original, result, this.options.readSource, this.options.isSourceCurrent).catch(error => {
					if (error instanceof DailyAnchorChangedError) throw new Error("Beacon source changed.");
					throw error;
				});
				if (!current()) throw new Error("Beacon source changed.");
				const reference = referenceFor(observation);
				const saved = await this.store.mutate(data => {
					const raw = getBeaconData(data);
					return fingerprint(raw) === expected
						? { nextData: buildPluginDataWithBeacon(data, reference), result: { applied: true, raw: reference } }
						: { nextData: null, result: { applied: false, raw } };
				}, async () => {
					const events = setting.events;
					if (!current() || !await this.options.isSourceCurrent(source) || !current()) throw new Error("Beacon source changed.");
					return () => {
						if (!current()) throw new Error("Beacon source changed.");
						return setting.events === events;
					};
				});
				if (this.closed) return;
				// 落盘选择也要交给排队中的新意图；旧菜单令牌随旧选择失效。
				this.accept(saved.raw, saved.applied ? setting : undefined);
				this.invalidate();
				if (saved.applied && setting.interrupted && this.intent === intent) {
					this.publish("unavailable", "unlocated");
					throw new Error("Beacon source changed while settings were being saved.");
				}
			} finally { if (this.settingSource === setting) this.settingSource = null; }
		}).finally(() => this.resumePending()).then(() => intent === this.intent ? this.refresh() : undefined);
	}

	remove(selection: number): Promise<void> {
		if (selection !== this.selection) { this.notify(); return Promise.resolve(); }
		++this.intent;
		return this.serial(async () => {
			this.assertWritable();
			if (selection !== this.selection) { this.notify(); return; }
			const expected = fingerprint(this.raw);
			const raw = await this.store.mutate(data => {
				this.assertWritable();
				return fingerprint(getBeaconData(data)) === expected
					? { nextData: buildPluginDataWithBeacon(data, undefined), result: undefined }
					: { nextData: null, result: getBeaconData(data) };
			});
			if (this.closed) return;
			this.accept(raw); this.invalidate();
		}).finally(() => this.resumePending()).then(() => this.refresh());
	}

	// 消费普通扫描已有的完整解析；只保留所选文件，不缓存候选或全库正文。
	observeSource(source: BeaconSource): void {
		if (this.closed || !this.readable || this.deleted) return;
		if (source.path !== this.selectedPath()) {
			void this.verifyRecreatedSource(source);
			return;
		}
		if (this.source?.sourceRevision === source.sourceRevision && this.source.logicalDate === source.logicalDate) return;
		this.invalidate(); this.source = source;
		void this.refresh();
	}

	private async verifyRecreatedSource(source: BeaconSource): Promise<void> {
		const key = source.path + "\0" + source.sourceRevision;
		const previous = this.renamedSources.get(key);
		if (!previous) return;
		const selection = this.selection, configuration = this.configuration;
		try {
			if (!await this.options.isSourceCurrent(source) || this.closed || !this.readable || this.deleted
				|| selection !== this.selection || configuration !== this.configuration || this.renamedSources.get(key) !== previous) return;
			// Catalog 可以复用字节完全相同的分区；当前 Vault 文件的证明足以解除这一条等待。
			this.renamedSources.delete(key);
			this.publish(this.snapshot.state, this.snapshot.reason, this.snapshot.memo);
		} catch (error) {
			if (!this.closed && selection === this.selection && this.renamedSources.get(key) === previous) {
				this.options.onFailure(error, "read");
			}
		}
	}

	sourceChanged(path: string, kind: "change" | "delete" | "rename" = "change", newPath?: string): void {
		const matches = (target: string) => target === path || target.startsWith(path + "/");
		if (this.settingSource && matches(this.settingSource.path)) {
			this.settingSource.events++;
			if (kind !== "change") this.settingSource.interrupted = true;
		}
		const selectedPath = this.selectedPath();
		for (const [key, previous] of this.renamedSources) {
			if (matches(previous.sourcePath) || (kind === "rename" && selectedPath && matches(selectedPath))) {
				this.renamedSources.set(key, { ...previous });
			}
		}
		if (!selectedPath || !matches(selectedPath)) return;
		const previous = this.source ?? this.presentedSource;
		this.invalidate();
		if (kind === "delete") {
			this.deleted = true;
			if (this.readable) this.publish("unavailable", "unlocated");
		}
		if (kind === "rename" && newPath !== undefined && !this.deleted) {
			if (previous?.path === selectedPath) this.renamedSources.set(selectedPath + "\0" + previous.sourceRevision,
				{ sourcePath: selectedPath, sourceRevision: previous.sourceRevision });
			// 只有明确 rename 能改变查找路径；旧路径重建不能在过渡中接管。
			this.renamedPath = newPath + selectedPath.slice(path.length);
		}
		// 普通扫描随后会交付同轮解析；索引失败由 settle/可见恢复入口定向重试。
	}

	configurationChanged(): void { this.configuration++; this.invalidate(); }

	stageConfirmedAnchor(presentation: ConfirmedDailyMemoPresentation): (() => void) | null {
		const { change, observations, blockAnchors } = presentation;
		const previous = this.snapshot.memo?.catalog?.observationHandle;
		const reference = this.reference;
		if (!change.updateExistingOnly || !this.readable || this.closed || this.deleted || this.pending
			|| !previous || !reference || this.selectedPath() !== change.sourcePath || blockAnchors?.[reference.blockId] !== 1) return null;
		const handle = change.replacements.find(item => sameBeaconHandle(item.before, previous))?.after;
		const observation = handle && observations.find(item => item.existingBlockId === reference.blockId && sameBeaconHandle(item, handle));
		if (!observation || handle!.rawBlockHash !== previous.rawBlockHash || observation.time !== reference.memoTime) return null;
		this.generation++;
		this.source = { path: change.sourcePath, logicalDate: change.logicalDate, sourceRevision: change.sourceRevision, observations, blockAnchors };
		// 先让每个视图沿提交映射更新卡片，再通知灯标订阅者，避免夹入定位占位。
		this.publish("ready", undefined, toCatalogMemoView(this.options.fromObservation(observation)), false);
		const staged = this.snapshot;
		return () => { if (this.snapshot === staged) this.notify(); };
	}

	confirmed(presentation: ConfirmedDailyMemoPresentation, deletedTarget?: MemoObservation,
		beforeBlockAnchors?: Readonly<Record<string, number>>): void {
		const ref = this.reference, change = presentation.change;
		if (!ref || this.deleted || this.selectedPath() !== change.sourcePath) return;
		this.invalidate();
		// 删除证明来自 Trash 已确认落盘的同版原 occurrence，不能仅因锚点缺失清空配置。
		if (deletedTarget && this.isBoundObservation(deletedTarget, beforeBlockAnchors)
			&& deletedTarget.sourceRevision === change.beforeSourceRevision
			&& change.replacements.some(item => sameBeaconHandle(item.before, deletedTarget) && item.after === null)) {
			this.pending = { reference: null, intent: this.intent, selection: this.selection, generation: this.generation };
			if (this.readable) this.publish("unavailable", "missing-id");
		} else if (presentation.blockAnchors) {
			this.source = { path: change.sourcePath, logicalDate: change.logicalDate, sourceRevision: change.sourceRevision,
				observations: presentation.observations, blockAnchors: presentation.blockAnchors };
		}
	}

	refreshIfNeeded(): Promise<void> {
		return this.pending || this.snapshot.state === "locating" || this.snapshot.reason === "unreadable"
			? this.refresh() : Promise.resolve();
	}

	refresh(): Promise<void> {
		if (this.closed || !this.readable) return Promise.resolve();
		const generation = this.generation;
		if (this.resolving?.generation === generation && this.resolving.intent === this.intent) return this.resolving.promise;
		const task = { generation, intent: this.intent, promise: Promise.resolve() };
		task.promise = this.resolve(generation).finally(() => { if (this.resolving === task) this.resolving = null; });
		this.resolving = task; return task.promise;
	}

	private async resolve(generation: number): Promise<void> {
		const selection = this.selection, intent = this.intent;
		const current = () => !this.closed && this.readable && generation === this.generation
			&& selection === this.selection && intent === this.intent;
		if (this.pending && this.pending.intent !== intent) return;
		if (this.pending?.reference === null) { await this.persistPending(); return; }
		if (this.raw === undefined) { this.publish("unset"); return; }
		const ref = this.reference, path = this.selectedPath();
		if (!ref || !path) { this.publish("unavailable", "unlocated"); return; }
		if (this.deleted) { this.publish("unavailable", "unlocated"); return; }
		try {
			let source = this.source ?? await this.options.readSource(path);
			if (!current()) return;
			if (source.blockAnchors === undefined) source = await this.options.readSource(path);
			if (!current()) return;
			if (source.path !== path) throw new BeaconSourceUnavailableError();
			const sourceCurrent = await this.options.isSourceCurrent(source);
			if (!current()) return;
			if (!sourceCurrent) { this.source = null; this.publish("locating"); return; }
			const observation = findDailyAnchor(source, ref.blockId);
			this.source = source;
			const next = referenceFor(observation);
			if (fingerprint(next) !== fingerprint(this.raw)) this.pending = { reference: next, intent, selection, generation };
			// 配置时间保存失败不遮掉已确认的当前正文；下一次有效刷新可重试。
			this.publish("ready", undefined, toCatalogMemoView(this.options.fromObservation(observation)));
			if (this.pending) await this.persistPending();
		} catch (error) {
			if (!current()) return;
			this.publish("unavailable", error instanceof DailyAnchorError ? error.reason
				: error instanceof BeaconSourceUnlocatedError ? "unlocated" : "unreadable");
		}
	}

	private persistPending(): Promise<void> {
		const pending = this.pending;
		if (!pending) return Promise.resolve();
		return this.serial(async () => {
			const raw = this.raw;
			const current = () => !this.closed && this.readable && this.pending === pending && this.intent === pending.intent
				&& this.selection === pending.selection && (pending.reference === null || this.generation === pending.generation);
			if (!current()) return;
			try {
				const result = await this.store.mutate(data => {
					if (!current() || fingerprint(getBeaconData(data)) !== fingerprint(raw)) return { nextData: null, result: { applied: false, raw: getBeaconData(data) } };
					return { nextData: buildPluginDataWithBeacon(data, pending.reference ?? undefined), result: { applied: true, raw: pending.reference ?? undefined } };
				});
				if (!result.applied) {
					if (!current()) return;
					this.accept(result.raw); this.invalidate();
					queueMicrotask(() => { void this.refresh(); }); return;
				}
				if (this.closed || this.selection !== pending.selection || fingerprint(this.raw) !== fingerprint(raw)) return;
				if (pending.reference === null) {
					this.accept(undefined);
					this.invalidate();
					return;
				}
				this.raw = result.raw;
				this.reference = pending.reference;
				if (this.pending === pending) this.pending = null;
			} catch (error) { if (current()) this.options.onFailure(error, "write"); }
		});
	}

	private selectedPath(): string | null { return this.reference ? this.renamedPath ?? this.reference.sourcePath : null; }
	private accept(raw: unknown, explicitSet?: { interrupted: boolean }): void {
		const next = parseBeaconReference(raw);
		const sameBinding = next && this.reference && next.blockId === this.reference.blockId
			&& (next.sourcePath === this.reference.sourcePath || next.sourcePath === this.renamedPath);
		const sameSelection = this.selection > 0 && (sameBinding || fingerprint(raw) === fingerprint(this.raw));
		this.raw = raw; this.reference = next;
		if (sameSelection && !explicitSet) return;
		this.selection++;
		this.pending = null; this.source = null; this.presentedSource = null;
		this.deleted = explicitSet?.interrupted ?? false; this.renamedPath = null; this.renamedSources.clear();
	}
	private invalidate(): void {
		this.generation++; this.source = null;
		if (this.pending?.reference) this.pending = null;
		// 源事件不能替代失败的配置重读；保留可重试的读取错误。
		if (!this.readable) return;
		this.publish(this.raw === undefined ? "unset" : "locating");
	}
	private publish(state: BeaconSnapshot["state"], reason?: BeaconSnapshot["reason"], memo?: BeaconSnapshot["memo"], notify = true): void {
		// 只保留上次实际展示过的路径/版本，供明确改名时等待旧卡；不参与目标匹配或写入。
		if (state === "ready" && memo?.catalog) this.presentedSource = { path: memo.dailyRef.path, sourceRevision: memo.catalog.observationHandle.sourceRevision };
		const next: BeaconSnapshot = { state, selection: this.selection,
			...(this.renamedSources.size ? { previousSources: [...this.renamedSources.values()] } : {}),
			...(reason ? { reason } : {}), ...(memo ? { memo } : {}) };
		if (JSON.stringify(next) === JSON.stringify(this.snapshot)) return;
		this.snapshot = next; if (notify) this.notify();
	}
	private notify(): void {
		if (!this.closed) for (const listener of this.listeners) {
			try { listener(); } catch (error) { logContinuationFailure("view", "beacon-render", error); }
		}
	}
	private resumePending(): void {
		if (this.pending?.selection !== this.selection) return;
		this.pending = { ...this.pending, intent: this.intent, generation: this.generation };
		void this.refresh();
	}
	private assertWritable(): void { if (this.closed || !this.readable) throw new BeaconSourceUnavailableError("Beacon settings unavailable."); }
	private serial<T>(operation: () => Promise<T>): Promise<T> {
		const result = this.queue.catch(() => undefined).then(operation);
		this.queue = result.catch(() => undefined); return result;
	}
}

function referenceFor(observation: MemoObservation): BeaconReference {
	return { sourcePath: observation.sourcePath, blockId: observation.existingBlockId!, memoTime: observation.time };
}
function fingerprint(value: unknown): string { return JSON.stringify(value) ?? "undefined"; }
