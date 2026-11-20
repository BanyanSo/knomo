import { sameObservationHandle, type ObservationHandle, type MemoObservation } from "../types/catalog";
import type { FavoriteCollection, FavoriteItem } from "../types/favorite";
import { favoriteLocation } from "../types/favorite";
import type { MarkdownBlockReferenceResult } from "../types/memoOperations";
import { observationHandleKey, type ConfirmedDailyMemoPresentation } from "./DailyMemoPresentationChange";
import { confirmDailyAnchor, findDailyAnchor, indexDailyMemoAnchors, DailyAnchorError, DailyAnchorSourceUnlocatedError, type DailyAnchorSource } from "./DailyMemoAnchor";
import type { FavoriteStore } from "./FavoriteStore";
import { logContinuationFailure } from "../utils/continuationDiagnostics";

interface FavoriteServiceOptions {
	getDate: (path: string) => string | null;
	getFileIdentity: (path: string) => object | null;
	readSource: (path: string) => Promise<DailyAnchorSource>;
	isSourceCurrent: (source: DailyAnchorSource) => Promise<boolean>;
	createBlockReference: (handle: ObservationHandle) => Promise<MarkdownBlockReferenceResult>;
}

export interface FavoriteCardState {
	favoriteId?: string;
	disabled: boolean;
	checking?: true;
}

export class FavoriteSelectionChangedError extends Error {}

interface FavoriteBinding extends ObservationHandle { favoriteId: string; time: string }
type SourceState = { status: "missing" | "waiting" }
	| { status: "ready"; revision: string; bindings: Map<string, FavoriteBinding>; blocked: ReadonlySet<string> };
type Transfer = { path: string; file: object | null; restored?: ObservationHandle };

export class FavoriteService {
	private readonly listeners = new Set<(refreshList: boolean, paths?: readonly string[]) => void>();
	private readonly sources = new Map<string, SourceState>();
	private readonly reads = new Map<string, Promise<SourceState>>();
	private readonly transfers = new Map<string, Transfer>();
	private readonly deleted = new Map<string, { item: FavoriteItem; collectionId: string }>();
	private readonly pending = new Map<string, ObservationHandle>();
	private readonly repairing = new Set<string>();
	private readonly sourceSequence = new Map<string, number>();
	private readonly unsubscribe: () => void;
	private collection: FavoriteCollection | null = null;
	private byPath = new Map<string, FavoriteItem[]>();
	private version = 0;
	private configuration = 0;
	private closed = false;

	constructor(readonly store: FavoriteStore, private readonly options: FavoriteServiceOptions,
		private readonly runMutation: <T>(action: () => Promise<T>) => Promise<T> = action => action()) {
		this.unsubscribe = store.subscribe(() => this.storeChanged());
	}

	get revision(): number { return this.version; }
	get status() { return this.store.getState().status; }
	get persistedCount(): number { return this.collection?.items.length ?? 0; }
	getDate(path: string): string | null { return this.options.getDate(path); }
	paths(): Iterable<string> { return this.byPath.keys(); }
	countAt(path: string): number { return this.byPath.get(path)?.length ?? 0; }
	retry(force = true): Promise<void> { return this.store.retry(force).then(() => this.retryRepairs()); }
	subscribe(listener: (refreshList: boolean, paths?: readonly string[]) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}
	dispose(): void {
		this.closed = true;
		this.version++;
		this.unsubscribe();
		this.store.dispose();
		this.listeners.clear();
		this.sources.clear();
		this.reads.clear();
		this.deleted.clear();
		this.transfers.clear();
		this.pending.clear();
	}

	cardState(handle: ObservationHandle): FavoriteCardState {
		const state = this.sources.get(handle.sourcePath);
		const key = observationHandleKey(handle);
		const favorite = state?.status === "ready" ? state.bindings.get(key) : undefined;
		const status = this.status;
		const ready = status === "ready";
		const checking = status === "loading" || (ready && this.byPath.has(handle.sourcePath)
			&& (!state || state.status === "waiting" || (state.status === "ready" && state.revision !== handle.sourceRevision)));
		return {
			...(checking ? { checking: true } as const : {}),
			favoriteId: ready && favorite && sameObservationHandle(favorite, handle) ? favorite.favoriteId : undefined,
			disabled: !ready || (state?.status === "ready" && state.blocked.has(key))
				|| this.pending.has(key) || [...this.pending.values()].some(item => item.sourcePath === handle.sourcePath
				&& item.startLine === handle.startLine),
		};
	}

	checkVisible(path: string): void {
		if (this.status === "ready" && this.byPath.has(path) && !this.sources.has(path)) void this.resolve(path);
	}

	async star(handle: ObservationHandle): Promise<void> {
		const original = { ...handle };
		return this.runMutation(() => this.starSelection(original));
	}

	private starSelection(original: ObservationHandle): Promise<void> {
		return this.perform(original, () => this.store.run(async operation => {
			const configuration = this.configuration;
			const file = this.options.getFileIdentity(original.sourcePath);
			const result = await this.options.createBlockReference(original);
			let verifySource: () => void = () => { throw new Error("Favorites source is not confirmed."); };
			const { source, observation } = await confirmDailyAnchor(original, result, this.options.readSource, current => {
				verifySource = this.sourceGuard(current, configuration);
				return this.options.isSourceCurrent(current);
			});
			verifySource();
			if (!file || file !== this.options.getFileIdentity(original.sourcePath)) throw new Error("Favorites original Daily moved.");
			const item: FavoriteItem = { favoriteId: crypto.randomUUID(), sourcePath: source.path, blockId: result.blockId,
				memoTime: observation.time, starredAt: new Date().toISOString() };
			const location = favoriteLocation(item.sourcePath, item.blockId);
			const verifyCurrentSource = async () => {
				verifySource();
				if (!await this.options.isSourceCurrent(source)) throw new Error("Favorites Daily source changed.");
				verifySource();
			};
			await this.store.commit(operation, items => {
				const existing = items.find(current => favoriteLocation(current.sourcePath, current.blockId) === location);
				if ((existing && this.transfers.has(existing.favoriteId)) || this.hasIncomingTransfer(items, item)) {
					throw new FavoriteSelectionChangedError("Favorites location is being relocated.");
				}
				return existing ? items : [...items, item];
			}, verifySource, verifyCurrentSource);
			await verifyCurrentSource();
			this.acceptSource(source);
		}));
	}

	async unstar(handle: ObservationHandle, favoriteId: string): Promise<void> {
		const original = { ...handle };
		const expected = this.collection?.items.find(item => item.favoriteId === favoriteId);
		const collectionId = this.collection?.collectionId;
		if (!expected || this.cardState(original).favoriteId !== favoriteId) throw new FavoriteSelectionChangedError("Favorites selection changed.");
		const file = this.options.getFileIdentity(original.sourcePath);
		return this.perform(original, () => this.store.run(async operation => {
			if (operation.copy?.data.collectionId !== collectionId || !file || file !== this.options.getFileIdentity(original.sourcePath)) {
				throw new FavoriteSelectionChangedError("Favorites selection changed.");
			}
			const configuration = this.configuration;
			const source = await this.options.readSource(original.sourcePath);
			const guard = this.sourceGuard(source, configuration, file);
			const observation = findDailyAnchor(source, expected.blockId);
			if (!sameObservationHandle(observation, original) || !await this.options.isSourceCurrent(source))
				throw new FavoriteSelectionChangedError("Favorites source changed.");
			await this.store.commit(operation, items => {
				if (!items.some(item => sameLocation(item, expected)) || this.transfers.has(favoriteId) || this.hasIncomingTransfer(items, expected)) {
					throw new FavoriteSelectionChangedError("Favorites selection changed.");
				}
				return items.filter(item => item.favoriteId !== favoriteId);
			}, guard);
		}));
	}

	sourceChanged(path: string, kind: "change" | "delete" | "rename", newPath?: string): void {
		if (this.closed) return;
		const affected = new Set([...this.byPath.keys(), ...Array.from(this.pending.values(), handle => handle.sourcePath)]
			.filter(current => within(current, path)));
		if (kind === "rename" && newPath) {
			for (const item of this.collection?.items ?? []) {
				const previous = this.transfers.get(item.favoriteId);
				const old = previous?.path ?? item.sourcePath;
				if (!within(old, path)) continue;
				const destination = newPath + old.slice(path.length);
				const file = this.options.getFileIdentity(destination);
				if (file && (!previous || previous.file === file)) {
					this.transfers.set(item.favoriteId, { ...previous, path: destination, file });
					affected.add(item.sourcePath);
					affected.add(destination);
				}
			}
			this.groupItems();
		}
		for (const current of affected) {
			this.sources.delete(current);
			this.reads.delete(current);
			this.sourceSequence.set(current, (this.sourceSequence.get(current) ?? 0) + 1);
		}
		if (affected.size) this.changed([...affected]);
		if (kind === "rename") for (const current of affected) this.checkVisible(current);
	}

	configurationChanged(): void {
		this.configuration++;
		this.sources.clear();
		this.reads.clear();
		this.changed();
	}

	catalogChanged(path?: string): void {
		if (path && !this.byPath.has(path)) return;
		if (path && this.sources.get(path)?.status === "waiting") this.sources.delete(path);
		if (this.byPath.size) this.changed(path ? [path] : undefined);
	}

	observeSource(source: DailyAnchorSource): void {
		if (this.closed || this.status !== "ready" || !this.byPath.has(source.path) || !source.blockAnchors) return;
		const known = this.sources.get(source.path);
		if (known?.status === "ready" && known.revision === source.sourceRevision) return;
		void this.resolve(source.path, source);
	}

	confirmed(presentation: ConfirmedDailyMemoPresentation): void {
		const { change, observations, blockAnchors } = presentation;
		this.sourceChanged(change.sourcePath, "change");
		this.observeSource({ path: change.sourcePath, logicalDate: change.logicalDate, sourceRevision: change.sourceRevision, observations, blockAnchors });
	}

	trashConfirmed(snapshotId: string, presentation: ConfirmedDailyMemoPresentation, deleted?: MemoObservation,
		beforeAnchors?: Readonly<Record<string, number>>, restored?: MemoObservation): void {
		const collection = this.collection;
		const { change } = presentation;
		// 重读期间先记下本轮删除和上次确认的收藏。跨路径写入仍须在队列内核对该收藏。
		if (collection && deleted?.existingBlockId && beforeAnchors?.[deleted.existingBlockId] === 1
			&& change.beforeSourceRevision === deleted.sourceRevision
			&& change.replacements.some(entry => entry.after === null && sameObservationHandle(entry.before, deleted))) {
			const item = collection.items.find(item => item.sourcePath === deleted.sourcePath && item.blockId === deleted.existingBlockId
				&& !this.transfers.has(item.favoriteId));
			if (item) this.deleted.set(snapshotId, { item, collectionId: collection.collectionId });
		}
		if (restored) {
			const proof = this.deleted.get(snapshotId);
			this.deleted.delete(snapshotId);
			if (proof && collection?.collectionId === proof.collectionId && collection.items.some(item => sameLocation(item, proof.item))
				&& restored.sourcePath !== proof.item.sourcePath && restored.existingBlockId === proof.item.blockId
				&& change.inserted && sameObservationHandle(change.inserted, restored)) {
				this.transfers.set(proof.item.favoriteId, { path: restored.sourcePath, file: this.options.getFileIdentity(restored.sourcePath), restored });
				this.sources.delete(proof.item.sourcePath);
				this.reads.delete(proof.item.sourcePath);
				this.groupItems();
			}
		}
		this.confirmed(presentation);
	}

	resolve(path: string, parsed?: DailyAnchorSource, retry = false): Promise<SourceState> {
		const existing = this.reads.get(path);
		if (existing) return existing;
		const cached = this.sources.get(path);
		if (!parsed && cached && !retry) return Promise.resolve(cached);
		if (retry) this.sources.delete(path);
		const items = this.byPath.get(path);
		if (!items || this.closed || this.status !== "ready") return Promise.resolve({ status: "waiting" });
		const current = () => !this.closed && this.status === "ready" && this.reads.get(path) === task;
		const task = Promise.resolve().then(async (): Promise<SourceState> => {
			try {
				const source = parsed ?? await this.options.readSource(path);
				if (source.path === path && current() && await this.options.isSourceCurrent(source) && current()) {
					return this.acceptSource(source);
				}
				const waiting = { status: "waiting" } as const;
				if (current()) this.sources.set(path, waiting);
				return waiting;
			} catch (error) {
				const result: SourceState = { status: error instanceof DailyAnchorSourceUnlocatedError ? "missing" : "waiting" };
				if (current()) this.sources.set(path, result);
				if (result.status === "waiting") this.report("source", error);
				return result;
			}
		}).finally(() => {
			if (this.reads.get(path) === task) {
				this.reads.delete(path);
				// 恢复定位会改变可确认的列表成员，通知保留了失败结果的读者。
				if (cached && cached.status !== "ready" && this.sources.get(path)?.status === "ready") this.changed([path]);
				else this.notify(false, [path]);
			}
		});
		this.reads.set(path, task);
		return task;
	}

	private acceptSource(source: DailyAnchorSource): SourceState {
		const items = this.byPath.get(source.path);
		if (!items || this.closed || this.status !== "ready" || !source.blockAnchors) return { status: "waiting" };
		const bindings = new Map<string, FavoriteBinding>();
		// 只保留已收藏 occurrence 的句柄与时间，不在服务内缓存 Daily 正文。
		const index = indexDailyMemoAnchors(source);
		const seen = new Set<string>(), conflicts = new Set<string>();
		const blocked = new Set<string>();
		for (const { blockId } of items) {
			if (seen.has(blockId)) conflicts.add(blockId);
			seen.add(blockId);
		}
		for (const item of items) {
			let observation: MemoObservation;
			try { observation = findDailyAnchor(source, item.blockId, index); }
			catch (error) {
				if (error instanceof DailyAnchorError) continue;
				throw error;
			}
			const key = observationHandleKey(observation);
			// 迁入位置冲突时保留所有原关系并暂停这张卡片的拾星操作。
			if (conflicts.has(item.blockId)) {
				blocked.add(key);
				continue;
			}
			const transfer = this.transfers.get(item.favoriteId);
			if (transfer && (!transfer.file || transfer.file !== this.options.getFileIdentity(source.path)
				|| transfer.restored && !sameObservationHandle(transfer.restored, observation))) continue;
			// 跨路径更新落盘前，目标不能代替原收藏进入可操作展示。
			if (transfer || item.memoTime !== observation.time) this.repair(source, item, observation, transfer);
			if (transfer) continue;
			const { sourcePath, sourceRevision, startLine, endLine, rawBlockHash, time } = observation;
			bindings.set(key, { sourcePath, sourceRevision, startLine, endLine, rawBlockHash, time, favoriteId: item.favoriteId });
		}
		const state: SourceState = { status: "ready", revision: source.sourceRevision, bindings, blocked };
		this.sources.set(source.path, state);
		return state;
	}

	private repair(source: DailyAnchorSource, expected: FavoriteItem, observation: MemoObservation, transfer?: Transfer): void {
		const id = expected.favoriteId;
		if (this.repairing.has(id)) return;
		const collectionId = this.collection?.collectionId;
		const configuration = this.configuration;
		this.repairing.add(id);
		void this.store.run(async operation => {
			if (operation.copy?.data.collectionId !== collectionId || this.transfers.get(id) !== transfer) return;
			const file = this.options.getFileIdentity(source.path);
			if (transfer && transfer.file !== file) return;
			const current = this.sourceGuard(source, configuration, file);
			if (!await this.options.isSourceCurrent(source)) return;
			const guard = () => {
				current();
				if (this.transfers.get(id) !== transfer) throw new Error("Favorites relocation changed.");
			};
			await this.store.commit(operation, items => {
				const item = items.find(item => sameLocation(item, expected) && item.memoTime === expected.memoTime);
				if (!item) throw new Error("Favorites item changed during reconciliation.");
				if (items.some(other => other.favoriteId !== id && other.blockId === item.blockId
					&& (other.sourcePath === source.path || this.transfers.get(other.favoriteId)?.path === source.path)))
					throw new Error("Favorites destination already contains this anchor.");
				return items.map(other => other === item ? { ...item, sourcePath: source.path, memoTime: observation.time } : other);
			}, guard);
		}).catch(error => this.report("reconcile-anchor", error)).finally(() => this.repairing.delete(id));
	}

	private retryRepairs(): void {
		for (const [path, items] of this.byPath) {
			const status = this.sources.get(path)?.status;
			if (status === "waiting" || items.some(item => this.transfers.has(item.favoriteId)
				|| status === "ready" && this.hasOldTime(path, item))) {
				void this.resolve(path, undefined, true);
			}
		}
	}

	private hasOldTime(path: string, item: FavoriteItem): boolean {
		const state = this.sources.get(path);
		return state?.status === "ready" && [...state.bindings.values()].some(binding => binding.favoriteId === item.favoriteId && binding.time !== item.memoTime);
	}

	private sourceGuard(source: DailyAnchorSource, configuration: number, file = this.options.getFileIdentity(source.path)): () => void {
		const sequence = this.sourceSequence.get(source.path);
		return () => {
			if (this.closed || configuration !== this.configuration || sequence !== this.sourceSequence.get(source.path)
				|| !file || this.options.getFileIdentity(source.path) !== file || this.options.getDate(source.path) !== source.logicalDate) {
				throw new Error("Favorites Daily source changed.");
			}
		};
	}

	private async perform(handle: ObservationHandle, action: () => Promise<void>): Promise<void> {
		const key = observationHandleKey(handle);
		if (this.closed || this.cardState(handle).disabled) throw new Error("Favorites action is already pending.");
		this.pending.set(key, handle);
		this.notify(false, [handle.sourcePath]);
		try { await action(); }
		finally { this.pending.delete(key);
			if (!this.byPath.has(handle.sourcePath)) this.sourceSequence.delete(handle.sourcePath);
			this.notify(false, [handle.sourcePath]); }
	}

	private storeChanged(): void {
		const state = this.store.getState();
		if (state.status === "ready") {
			const next = state.copy?.data ?? null;
			if (next?.collectionId !== this.collection?.collectionId) {
				this.deleted.clear();
				this.transfers.clear();
			}
			if (JSON.stringify(next) !== JSON.stringify(this.collection)) {
				const previous = this.byPath;
				const nextItems = new Map((next?.items ?? []).map(item => [item.favoriteId, item]));
				for (const [snapshotId, proof] of this.deleted) {
					const item = nextItems.get(proof.item.favoriteId);
					if (!item || !sameLocation(item, proof.item)) this.deleted.delete(snapshotId);
				}
				for (const item of this.collection?.items ?? []) {
					const current = nextItems.get(item.favoriteId);
					if (!current || !sameLocation(item, current)) this.transfers.delete(item.favoriteId);
				}
				this.collection = next;
				this.groupItems();
				for (const [path, items] of previous) if (JSON.stringify(items) !== JSON.stringify(this.byPath.get(path))) {
					this.sources.delete(path);
					this.reads.delete(path);
				}
			}
		} else {
			this.reads.clear();
		}
		this.changed();
	}

	private groupItems(): void {
		const grouped = new Map<string, FavoriteItem[]>();
		for (const item of this.collection?.items ?? []) {
			const path = this.transfers.get(item.favoriteId)?.path ?? item.sourcePath;
			const group = grouped.get(path) ?? [];
			group.push(item);
			grouped.set(path, group);
		}
		this.byPath = grouped;
	}

	private hasIncomingTransfer(items: readonly FavoriteItem[], { sourcePath, blockId }: FavoriteItem): boolean {
		return items.some(item => item.blockId === blockId && this.transfers.get(item.favoriteId)?.path === sourcePath);
	}

	private changed(paths?: readonly string[]): void { this.version++; this.notify(true, paths); }
	private notify(refresh: boolean, paths?: readonly string[]): void {
		if (!this.closed) for (const listener of this.listeners) {
			try { listener(refresh, paths); } catch (error) { this.report("render", error); }
		}
	}
	private report(operation: string, error: unknown): void { logContinuationFailure("view", "favorites-" + operation, error); }
}

function sameLocation(left: FavoriteItem, right: FavoriteItem): boolean {
	return left.favoriteId === right.favoriteId && left.sourcePath === right.sourcePath && left.blockId === right.blockId;
}
function within(path: string, parent: string): boolean { return path === parent || path.startsWith(parent + "/"); }
