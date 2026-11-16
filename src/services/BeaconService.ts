import type { ObservationHandle, MemoObservation } from "../types/catalog";
import type { CatalogMemoItem } from "../types/catalogView";
import { sameBeaconHandle, type BeaconReference, type BeaconSnapshot } from "../types/beacon";
import { toCatalogMemoView } from "../types/memoView";
import { buildPluginDataWithBeacon, getBeaconData, parseBeaconReference } from "../utils/pluginData";
import { PluginDataStore } from "./PluginDataStore";
import type { ConfirmedDailyMemoPresentation, DailyMemoBodyProof } from "./DailyMemoPresentationChange";
import { logContinuationFailure } from "../utils/continuationDiagnostics";

export interface BeaconSource {
	path: string;
	logicalDate: string;
	sourceRevision: string;
	observations: readonly MemoObservation[];
	bodyProof?: DailyMemoBodyProof;
}

export class BeaconSourceUnavailableError extends Error {}
export class BeaconSourceUnlocatedError extends Error {}

export interface BeaconServiceOptions {
	readSource: (path: string) => Promise<BeaconSource>;
	isSourceCurrent: (source: BeaconSource) => Promise<boolean>;
	readMemo: (handle: ObservationHandle) => Promise<CatalogMemoItem | null>;
	onFailure: (error: unknown, operation: "read" | "write") => void;
}

// 一条可丢弃的展示选择；持久化只保存引用，所有正文仍从当前 Daily/Catalog 取得。
export class BeaconService {
	private raw: unknown;
	private reference: BeaconReference | null = null;
	private snapshot: BeaconSnapshot = { state: "unset", selection: 0 };
	private readonly listeners = new Set<() => void>();
	private readonly renamedSources = new Map<string, { sourcePath: string; sourceRevision: string }>();
	private queue: Promise<unknown> = Promise.resolve();
	private generation = 0;
	private intent = 0;
	private selection = 0;
	private readable = false;
	private closed = false;
	private deleted = false;
	private verified: ObservationHandle | null = null;
	private settingSource: { path: string; changed: boolean; deleted: boolean } | null = null;
	private pending: { reference: BeaconReference | null; intent: number; selection: number } | null = null;
	private resolving: { generation: number; intent: number; promise: Promise<void> } | null = null;

	constructor(private readonly store: PluginDataStore, private readonly options: BeaconServiceOptions) {}

	getSnapshot(): BeaconSnapshot { return this.snapshot; }
	retry(): Promise<void> { return this.readable ? this.refresh() : this.reload(); }
	isSelectedHandle(handle: ObservationHandle): boolean { return this.reference !== null && sameBeaconHandle(this.reference.handle, handle); }
	subscribe(listener: () => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
	dispose(): void { this.closed = true; this.generation++; this.intent++; this.listeners.clear(); }

	reload(): Promise<void> {
		this.intent++;
		this.invalidate();
		return this.serial(async () => {
			try {
				const raw = getBeaconData(await this.store.read());
				if (this.closed) return;
				this.readable = true;
				if (fingerprint(raw) !== fingerprint(this.raw) || this.selection === 0) {
					this.raw = raw;
					this.reference = parseBeaconReference(raw);
					this.selection++;
					this.verified = null;
					this.deleted = false;
					this.renamedSources.clear();
					this.pending = null;
				} else if (this.pending) {
					this.pending = { ...this.pending, intent: this.intent };
				} else {
					this.reference = parseBeaconReference(this.raw);
				}
				this.invalidate();
			} catch (error) {
				if (this.closed) return;
				this.readable = false;
				this.publish("unavailable", "unreadable");
				this.options.onFailure(error, "read");
			}
		}).then(() => this.refresh());
	}

	set(handle: ObservationHandle): Promise<void> {
		const original = copyHandle(handle);
		this.intent++;
		return this.serial(async () => {
			this.assertWritable();
			// 保存前也观察目标路径，覆盖首次选择及替换到另一份 Daily 的窗口。
			const setting = this.settingSource = { path: original.sourcePath, changed: false, deleted: false };
			try {
				const generation = this.generation;
				const source = await this.options.readSource(original.sourcePath);
				const observation = source.observations.find(item => sameBeaconHandle(item, original));
				const memo = observation ? await this.options.readMemo(original) : null;
				if (!memo || !observation || memo.observation.logicalDate !== source.logicalDate
					|| !await this.options.isSourceCurrent(source) || generation !== this.generation || setting.changed || this.closed) {
					throw new Error("Beacon observation changed; refresh and select again.");
				}
				const reference = referenceFor(original, source);
				await this.store.mutate(async data => {
					if (!await this.options.isSourceCurrent(source) || generation !== this.generation || setting.changed) throw new Error("Beacon source changed.");
					this.assertWritable();
					return { nextData: buildPluginDataWithBeacon(data, reference), result: undefined };
				});
				if (this.closed) return;
				this.raw = reference;
				this.reference = { ...reference, handle: { ...reference.handle, sourcePath: setting.path } };
				this.selection++;
				this.pending = null;
				this.deleted = setting.deleted;
				this.renamedSources.clear();
				if (setting.path !== original.sourcePath) {
					this.renamedSources.set(original.sourcePath + "\0" + original.sourceRevision,
						{ sourcePath: original.sourcePath, sourceRevision: original.sourceRevision });
				}
				this.verified = null;
				// 配置落盘不证明源仍有效；保存后复用定向校验，不重新发布保存前的正文。
				this.invalidate();
			} finally { if (this.settingSource === setting) this.settingSource = null; }
		}).finally(() => this.resumePending()).then(() => this.refresh());
	}

	remove(selection: number): Promise<void> {
		this.intent++;
		return this.serial(async () => {
			this.assertWritable();
			if (selection !== this.selection) { this.notify(); return; }
			const expected = fingerprint(this.raw);
			const result = await this.store.mutate(data => {
				this.assertWritable();
				const raw = getBeaconData(data);
				return fingerprint(raw) === expected
					? { nextData: buildPluginDataWithBeacon(data, undefined), result: { removed: true, raw: undefined } }
					: { nextData: null, result: { removed: false, raw } };
			});
			if (this.closed) return;
			this.raw = result.raw;
			this.reference = parseBeaconReference(this.raw);
			this.selection++;
			this.pending = null;
			this.verified = null;
			this.deleted = false;
			this.renamedSources.clear();
			this.invalidate();
		}).finally(() => this.resumePending()).then(() => this.refresh());
	}

	// 由 Catalog 已有文件事件入口调用；不另建监听器或轮询。
	sourceChanged(path: string, kind: "change" | "delete" | "rename" = "change", newPath?: string): void {
		const setting = this.settingSource;
		if (setting && (setting.path === path || setting.path.startsWith(path + "/"))) {
			setting.changed = true;
			if (kind === "delete") setting.deleted = true;
			if (kind === "rename" && newPath !== undefined) setting.path = newPath + setting.path.slice(path.length);
		}
		const ref = this.reference;
		if (!ref || !(ref.handle.sourcePath === path || ref.handle.sourcePath.startsWith(path + "/"))) return;
		this.invalidate();
		if (kind === "delete") { this.deleted = true; this.publish("unavailable", "unlocated"); }
		if (kind === "rename" && newPath !== undefined && !this.deleted) {
			this.renamedSources.set(ref.handle.sourcePath + "\0" + ref.handle.sourceRevision,
				{ sourcePath: ref.handle.sourcePath, sourceRevision: ref.handle.sourceRevision });
			const target = newPath + ref.handle.sourcePath.slice(path.length);
			// 路径事件本身只证明改名，目标日期、revision/正文和解析区间仍须复核。
			this.reference = { ...ref, handle: { ...ref.handle, sourcePath: target } };
			this.pending = { reference: this.reference, intent: this.intent, selection: this.selection };
		}
		if (kind !== "delete") void this.refresh();
	}

	configurationChanged(): void { this.verified = null; this.invalidate(); }

	confirmed(presentation: ConfirmedDailyMemoPresentation, deletedTarget?: ObservationHandle): void {
		const ref = this.reference, change = presentation.change;
		if (!ref || this.deleted || ref.handle.sourcePath !== change.sourcePath) return;
		if (ref.handle.sourceRevision === change.sourceRevision) return;
		this.invalidate();
		if (ref.handle.sourceRevision !== change.beforeSourceRevision || ref.logicalDate !== change.logicalDate) return;
		const replacement = change.replacements.find(item => sameBeaconHandle(item.before, ref.handle));
		if (!replacement) return;
		const targetDeleted = deletedTarget && this.verified && sameBeaconHandle(deletedTarget, ref.handle)
			&& sameBeaconHandle(this.verified, ref.handle);
		if (targetDeleted) {
			this.pending = { reference: null, intent: this.intent, selection: this.selection };
			this.publish("unavailable", "unlocated");
		} else if (replacement.after !== null && presentation.observations.some(item => sameBeaconHandle(item, replacement.after!))) {
			this.reference = { handle: { ...replacement.after }, logicalDate: change.logicalDate,
				...(presentation.bodyProof ? { bodyProof: presentation.bodyProof } : {}) };
			this.verified = replacement.after;
			this.pending = { reference: this.reference, intent: this.intent, selection: this.selection };
		} else {
			// 空映射不证明所选 Memo 被删除，保留选择但不能认领其它 occurrence。
			this.verified = null;
			this.publish("unavailable", "unlocated");
		}
	}

	refresh(): Promise<void> {
		if (this.closed || !this.readable) return Promise.resolve();
		const generation = this.generation;
		if (this.resolving?.generation === generation && this.resolving.intent === this.intent) return this.resolving.promise;
		const task = { generation, intent: this.intent, promise: Promise.resolve() };
		task.promise = this.resolve(generation).finally(() => { if (this.resolving === task) this.resolving = null; });
		this.resolving = task;
		return task.promise;
	}

	private async resolve(generation: number): Promise<void> {
		const selection = this.selection, intent = this.intent;
		const current = () => !this.closed && generation === this.generation && selection === this.selection && intent === this.intent;
		if (this.pending && this.pending.intent !== intent) {
			// 用户操作已排队，旧映射不能抢先落盘或覆盖其结果。
			return;
		}
		if (this.pending?.reference === null) { await this.persistPending(); return; }
		if (this.raw === undefined) { this.publish("unset"); return; }
		const ref = this.reference;
		if (!ref || this.deleted) { this.publish("unavailable", "unlocated"); return; }
		try {
			const source = await this.options.readSource(ref.handle.sourcePath);
			if (!current()) return;
			if (source.logicalDate !== ref.logicalDate) throw new BeaconSourceUnlocatedError();
			let handle = ref.handle;
			if (source.sourceRevision !== handle.sourceRevision) {
				if (!ref.bodyProof || !source.bodyProof || ref.bodyProof.digest !== source.bodyProof.digest) throw new BeaconSourceUnlocatedError();
				const delta = source.bodyProof.startLine - ref.bodyProof.startLine;
				handle = { ...handle, sourceRevision: source.sourceRevision, startLine: handle.startLine + delta, endLine: handle.endLine + delta };
			}
			if (!source.observations.some(item => sameBeaconHandle(item, handle))) throw new BeaconSourceUnlocatedError();
			const memo = await this.options.readMemo(handle);
			if (!current()) return;
			const sourceCurrent = await this.options.isSourceCurrent(source);
			if (!current()) return;
			if (!sourceCurrent) { this.publish("locating"); return; }
			if (!memo || memo.observation.logicalDate !== source.logicalDate) { this.publish("locating"); return; }
			const next = referenceFor(handle, source);
			this.reference = next;
			this.verified = handle;
			if (fingerprint(next) !== fingerprint(this.raw)) this.pending = { reference: next, intent, selection };
			if (this.pending) await this.persistPending();
			if (current() && this.reference !== null) this.publish("ready", undefined, memo);
		} catch (error) {
			if (!current()) return;
			this.publish("unavailable", error instanceof BeaconSourceUnlocatedError ? "unlocated" : "unreadable");
		}
	}

	private persistPending(): Promise<void> {
		const pending = this.pending;
		if (!pending) return Promise.resolve();
		return this.serial(async () => {
			const raw = this.raw;
			const current = () => !this.closed && this.pending === pending && this.intent === pending.intent && this.selection === pending.selection;
			if (!current()) return;
			try {
				const result = await this.store.mutate(data => {
					if (!current()) return { nextData: null, result: { applied: false, raw: getBeaconData(data) } };
					if (fingerprint(getBeaconData(data)) !== fingerprint(raw)) return { nextData: null, result: { applied: false, raw: getBeaconData(data) } };
					return { nextData: buildPluginDataWithBeacon(data, pending.reference ?? undefined), result: { applied: true, raw: pending.reference ?? undefined } };
				});
				if (!result.applied) {
					if (!current()) return;
					this.raw = result.raw;
					this.pending = null;
					this.reference = parseBeaconReference(result.raw);
					this.verified = null;
					this.selection++;
					this.invalidate();
					return;
				}
				// 已开始的共享保存先于后续用户操作完成；接住其落盘值，使后续 CAS
				// 能移除同一选择或保存下一次连续映射，但不发布被新选择取代的正文。
				if (this.closed || this.selection !== pending.selection || fingerprint(this.raw) !== fingerprint(raw)) return;
				this.raw = result.raw;
				if (this.pending === pending) {
					this.pending = null;
					if (pending.reference === null) {
						this.reference = null;
						this.verified = null;
						this.selection++;
						this.invalidate();
					}
				}
			} catch (error) { if (current()) this.options.onFailure(error, "write"); }
		});
	}

	private invalidate(): void {
		this.generation++;
		this.publish(this.raw === undefined ? "unset" : "locating");
	}

	private publish(state: BeaconSnapshot["state"], reason?: BeaconSnapshot["reason"], memo?: CatalogMemoItem): void {
		const next: BeaconSnapshot = { state, selection: this.selection,
			...(this.renamedSources.size > 0 ? { previousSources: [...this.renamedSources.values()] } : {}),
			...(this.reference ? { logicalDate: this.reference.logicalDate } : {}), ...(reason ? { reason } : {}),
			...(memo ? { memo: toCatalogMemoView(memo) } : {}) };
		if (JSON.stringify(next) === JSON.stringify(this.snapshot)) return;
		this.snapshot = next;
		this.notify();
	}

	private notify(): void {
		if (!this.closed) for (const listener of this.listeners) {
			try { listener(); } catch (error) { logContinuationFailure("view", "beacon-render", error); }
		}
	}
	private resumePending(): void {
		if (this.pending?.selection !== this.selection) return;
		this.pending = { ...this.pending, intent: this.intent };
		void this.refresh();
	}
	private assertWritable(): void { if (this.closed || !this.readable) throw new BeaconSourceUnavailableError("Beacon settings unavailable."); }
	private serial<T>(operation: () => Promise<T>): Promise<T> {
		const result = this.queue.catch(() => undefined).then(operation);
		this.queue = result.catch(() => undefined);
		return result;
	}
}

function referenceFor(handle: ObservationHandle, source: BeaconSource): BeaconReference {
	return { handle: copyHandle(handle), logicalDate: source.logicalDate, ...(source.bodyProof ? { bodyProof: source.bodyProof } : {}) };
}

function copyHandle(handle: ObservationHandle): ObservationHandle {
	return { sourcePath: handle.sourcePath, sourceRevision: handle.sourceRevision, startLine: handle.startLine,
		endLine: handle.endLine, rawBlockHash: handle.rawBlockHash };
}

function fingerprint(value: unknown): string { return JSON.stringify(value) ?? "undefined"; }
