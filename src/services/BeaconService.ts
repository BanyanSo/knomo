import type { MemoObservation, ObservationHandle } from "../types/catalog";
import type { CatalogMemoItem } from "../types/catalogView";
import type { MarkdownBlockReferenceResult } from "../types/memoOperations";
import { sameBeaconHandle, type BeaconReference, type BeaconSnapshot } from "../types/beacon";
import { toCatalogMemoView } from "../types/memoView";
import { buildPluginDataWithBeacon, getBeaconData, parseBeaconReference } from "../utils/pluginData";
import { PluginDataStore } from "./PluginDataStore";
import type { ConfirmedDailyMemoPresentation } from "./DailyMemoPresentationChange";
import { logContinuationFailure } from "../utils/continuationDiagnostics";

export interface BeaconSource {
	path: string;
	logicalDate: string;
	sourceRevision: string;
	observations: readonly MemoObservation[];
	blockAnchors?: Readonly<Record<string, number>>;
}

export class BeaconSourceUnavailableError extends Error {}
export class BeaconSourceUnlocatedError extends Error {}
export class BeaconNotSavedError extends Error {}
class BeaconAnchorError extends Error {
	constructor(readonly reason: NonNullable<BeaconSnapshot["reason"]>) { super(reason); }
}

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
	private settingSource: { path: string; interrupted: boolean } | null = null;
	private pending: { reference: BeaconReference | null; intent: number; selection: number; generation: number } | null = null;
	private resolving: { generation: number; intent: number; promise: Promise<void> } | null = null;

	constructor(private readonly store: PluginDataStore, private readonly options: BeaconServiceOptions) {}
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
				if (fingerprint(raw) !== fingerprint(this.raw) || this.selection === 0) this.adopt(raw);
				this.invalidate();
			} catch (error) {
				if (this.closed) return;
				this.readable = false;
				this.publish("unavailable", "unreadable");
				this.options.onFailure(error, "read");
			}
		}).finally(() => this.resumePending()).then(() => this.refresh());
	}

	set(handle: ObservationHandle): Promise<void> {
		const original = { sourcePath: handle.sourcePath, sourceRevision: handle.sourceRevision,
			startLine: handle.startLine, endLine: handle.endLine, rawBlockHash: handle.rawBlockHash };
		const intent = ++this.intent;
		return this.serial(async () => {
			this.assertWritable();
			if (intent !== this.intent) return;
			const expected = fingerprint(this.raw), configuration = this.configuration;
			const setting = this.settingSource = { path: original.sourcePath, interrupted: false };
			const current = () => !this.closed && this.intent === intent && this.configuration === configuration && !setting.interrupted;
			try {
				const result = await this.options.createBlockReference(original);
				if (!current()) throw new Error("Beacon selection changed.");
				// 新建和复用 ID 都复核本次返回的 occurrence；编辑器事务本身不证明落盘。
				const source = await this.options.readSource(original.sourcePath);
				if (!result.observation || source.sourceRevision !== result.observation.sourceRevision) {
					throw new BeaconNotSavedError("Save the Daily note and select its current card again.");
				}
				const observation = findAnchor(source, result.blockId);
				if (!sameBeaconHandle(result.observation, observation) || source.path !== original.sourcePath
					|| !await this.options.isSourceCurrent(source) || !current()) throw new Error("Beacon source changed.");
				const reference = referenceFor(observation);
				const saved = await this.store.mutate(async data => {
					this.assertWritable();
					if (!current() || !await this.options.isSourceCurrent(source) || !current()) throw new Error("Beacon source changed.");
					const raw = getBeaconData(data);
					return fingerprint(raw) === expected
						? { nextData: buildPluginDataWithBeacon(data, reference), result: { applied: true, raw: reference } }
						: { nextData: null, result: { applied: false, raw } };
				});
				if (this.closed) return;
				if (!saved.applied) { this.adopt(saved.raw); this.invalidate(); return; }
				// 已开始的保存必须接住落盘值，后续排队的移除/换选才可据此做 CAS。
				if (!current()) {
					this.raw = saved.raw; this.reference = parseBeaconReference(saved.raw); this.pending = null;
					// 候选文件在保存期间消失/改名，旧路径后来重建也不能发布为成功。
					if (setting.interrupted) this.deleted = true;
					if (this.intent === intent) {
						this.selection++; this.invalidate(); this.publish("unavailable", "unreadable");
						throw new Error("Beacon source changed while settings were being saved.");
					}
					return;
				}
				this.adopt(saved.raw);
				this.invalidate();
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
			this.adopt(raw); this.invalidate();
		}).finally(() => this.resumePending()).then(() => this.refresh());
	}

	// 消费普通扫描已有的完整解析；只保留所选文件，不缓存候选或全库正文。
	observeSource(source: BeaconSource): void {
		if (this.closed || !this.readable || this.deleted || source.path !== this.selectedPath()
			|| this.source?.sourceRevision === source.sourceRevision && this.source.logicalDate === source.logicalDate) return;
		this.invalidate(); this.source = source;
		void this.refresh();
	}

	sourceChanged(path: string, kind: "change" | "delete" | "rename" = "change", newPath?: string): void {
		const matches = (target: string) => target === path || target.startsWith(path + "/");
		if (this.settingSource && matches(this.settingSource.path) && kind !== "change") this.settingSource.interrupted = true;
		const selectedPath = this.selectedPath();
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
			this.publish("unavailable", "missing-id");
		} else if (presentation.blockAnchors) {
			this.source = { path: change.sourcePath, logicalDate: change.logicalDate, sourceRevision: change.sourceRevision,
				observations: presentation.observations, blockAnchors: presentation.blockAnchors };
		}
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
		const current = () => !this.closed && generation === this.generation && selection === this.selection && intent === this.intent;
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
			const observation = findAnchor(source, ref.blockId);
			this.source = source;
			const next = referenceFor(observation);
			if (fingerprint(next) !== fingerprint(this.raw)) this.pending = { reference: next, intent, selection, generation };
			// 配置时间保存失败不遮掉已确认的当前正文；下一次有效刷新可重试。
			this.publish("ready", undefined, this.options.fromObservation(observation), source.logicalDate);
			if (this.pending) await this.persistPending();
		} catch (error) {
			if (!current()) return;
			this.publish("unavailable", error instanceof BeaconAnchorError ? error.reason
				: error instanceof BeaconSourceUnlocatedError ? "unlocated" : "unreadable");
		}
	}

	private persistPending(): Promise<void> {
		const pending = this.pending;
		if (!pending) return Promise.resolve();
		return this.serial(async () => {
			const raw = this.raw;
			const current = () => !this.closed && this.pending === pending && this.intent === pending.intent
				&& this.selection === pending.selection && (pending.reference === null || this.generation === pending.generation);
			if (!current()) return;
			try {
				const result = await this.store.mutate(data => {
					if (!current() || fingerprint(getBeaconData(data)) !== fingerprint(raw)) return { nextData: null, result: { applied: false, raw: getBeaconData(data) } };
					return { nextData: buildPluginDataWithBeacon(data, pending.reference ?? undefined), result: { applied: true, raw: pending.reference ?? undefined } };
				});
				if (!result.applied) {
					if (!current()) return;
					this.adopt(result.raw); this.invalidate();
					queueMicrotask(() => { void this.refresh(); }); return;
				}
				if (this.closed || this.selection !== pending.selection || fingerprint(this.raw) !== fingerprint(raw)) return;
				this.raw = result.raw;
				if (this.pending !== pending) return;
				this.pending = null;
				if (pending.reference === null) { this.adopt(undefined); this.invalidate(); }
				else this.reference = pending.reference;
			} catch (error) { if (current()) this.options.onFailure(error, "write"); }
		});
	}

	private selectedPath(): string | null { return this.reference ? this.renamedPath ?? this.reference.sourcePath : null; }
	private adopt(raw: unknown): void {
		this.raw = raw; this.reference = parseBeaconReference(raw); this.selection++;
		this.pending = null; this.source = null; this.presentedSource = null;
		this.deleted = false; this.renamedPath = null; this.renamedSources.clear();
	}
	private invalidate(): void {
		this.generation++; this.source = null;
		if (this.pending?.reference) this.pending = null;
		// 源事件不能替代失败的配置重读；保留可重试的读取错误。
		if (!this.readable && this.snapshot.reason === "unreadable") return;
		this.publish(this.raw === undefined ? "unset" : "locating");
	}
	private publish(state: BeaconSnapshot["state"], reason?: BeaconSnapshot["reason"], memo?: CatalogMemoItem, logicalDate?: string): void {
		// 只保留上次实际展示过的路径/版本，供明确改名时等待旧卡；不参与目标匹配或写入。
		if (state === "ready" && memo) this.presentedSource = { path: memo.sourcePath, sourceRevision: memo.observationHandle.sourceRevision };
		const next: BeaconSnapshot = { state, selection: this.selection,
			...(this.renamedSources.size ? { previousSources: [...this.renamedSources.values()] } : {}),
			...(logicalDate ? { logicalDate } : {}), ...(reason ? { reason } : {}),
			...(memo ? { memo: toCatalogMemoView(memo) } : {}) };
		if (JSON.stringify(next) === JSON.stringify(this.snapshot)) return;
		this.snapshot = next; this.notify();
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
function findAnchor(source: BeaconSource, blockId: string): MemoObservation {
	if (!source.blockAnchors) throw new BeaconSourceUnavailableError("Complete block anchor counts are required.");
	const count = source.blockAnchors[blockId] ?? 0;
	if (count === 0) throw new BeaconAnchorError("missing-id");
	if (count !== 1) throw new BeaconAnchorError("conflicting-id");
	const matches = source.observations.filter(item => item.existingBlockId === blockId);
	if (matches.length !== 1) throw new BeaconAnchorError("not-memo");
	return matches[0]!;
}
function fingerprint(value: unknown): string { return JSON.stringify(value) ?? "undefined"; }
