import { TFile, TFolder } from "obsidian";
import type { App } from "obsidian";
import type { TrashQueryResult, TrashSnapshot, TrashStoreState } from "../types/trash";

// 所有实例共享当前 Vault 的本地操作队列；不形成磁盘协议。
interface TrashCoordinator {
	queue: Promise<unknown>;
	revision: number;
	pending: number;
	publication: { path: string; revision: number; state: TrashStoreState } | null;
	listeners: Set<() => void>;
}
const coordinators = new WeakMap<App, TrashCoordinator>();

export type TrashOperationStore = Pick<TrashSnapshotStore, "read" | "save" | "saveAll" | "assertUnchanged" | "remove" | "clear"> & { assertActive(): void };

export function getTrashFilePath(monthlyFolder: string): string {
	if (monthlyFolder !== "") assertVaultPath(monthlyFolder);
	return monthlyFolder ? `${monthlyFolder}/knomo-trash.json` : "knomo-trash.json";
}

export class TrashSnapshotStore {
	private readonly coordinator;
	private reading: Promise<TrashQueryResult> | null = null;
	private configurationRevision = 0;
	private disposed = false;
	private readonly subscriptions = new Set<() => void>();

	constructor(private readonly app: App, private readonly monthlyFolder: string | (() => string), private readonly assertActive: () => void = () => undefined) {
		this.coordinator = coordinators.get(app) ?? { queue: Promise.resolve(), revision: 0, pending: 0, publication: null, listeners: new Set<() => void>() };
		coordinators.set(app, this.coordinator);
	}

	get path(): string { return getTrashFilePath(typeof this.monthlyFolder === "string" ? this.monthlyFolder : this.monthlyFolder()); }

	getState(): TrashStoreState {
		try {
			if (this.disposed) throw new Error("Trash runtime disposed.");
			this.assertActive();
			const current = this.coordinator.publication;
			if (current?.path === this.path && current.revision === this.coordinator.revision) return structuredClone(current.state);
			return { status: "idle", items: null, count: null, error: null };
		} catch (error) { return { status: "error", items: null, count: null, error: String(error) }; }
	}

	subscribe(listener: () => void): () => void {
		if (this.disposed) return () => undefined;
		this.subscriptions.add(listener);
		this.coordinator.listeners.add(listener);
		return () => { this.subscriptions.delete(listener); this.coordinator.listeners.delete(listener); };
	}

	dispose(): void {
		this.disposed = true;
		for (const listener of this.subscriptions) this.coordinator.listeners.delete(listener);
		this.subscriptions.clear();
		this.invalidateConfiguration();
	}

	handleFileChange(path: string, oldPath?: string): void {
		let target: string;
		try { target = this.path; } catch { return; }
		const affects = (candidate: string) => target === candidate || target.startsWith(`${candidate}/`);
		if (affects(path) || oldPath !== undefined && affects(oldPath)) this.invalidate();
	}

	invalidate(): void {
		this.coordinator.revision++;
		this.coordinator.publication = null;
		this.notify();
	}

	invalidateConfiguration(invalidateState = true): void { this.configurationRevision++; if (invalidateState) this.invalidate(); }

	// 回调内使用绑定的操作对象，避免队列重入；锁覆盖整个 Daily 删除/恢复提交窗口。
	runExclusive<T>(action: (store: TrashOperationStore) => Promise<T>): Promise<T> {
		const path = this.path;
		const revision = this.configurationRevision;
		const guard = () => {
			if (this.disposed) throw new Error("Trash runtime disposed.");
			this.assertActive();
			if (this.path !== path || revision !== this.configurationRevision) throw new Error("Trash configuration changed.");
		};
		this.coordinator.pending++;
		const pending = this.coordinator.queue.catch(() => undefined).then(async () => {
			guard();
			let active = true;
			let verifiedRevision: number | null = null;
			const check = () => { guard(); if (!active) throw new Error("Trash operation ended."); };
			const read = async (id: string) => {
				check();
				let items: TrashSnapshot[];
				try { items = await this.readDisk(path); }
				catch (error) {
					this.invalidate();
					this.publish(path, { status: "error", items: null, count: null, error: String(error) });
					throw error;
				}
				check();
				const item = items.find((item) => item.snapshotId === id);
				if (!item) throw new Error(`Trash snapshot unavailable: ${id}`);
				return item;
			};
			const saveAll = (snapshots: readonly TrashSnapshot[]) => {
				const expected = structuredClone(snapshots);
				validateItems(expected);
				return this.modify(path, check, (items) => {
					const byId = new Map(items.map((item) => [item.snapshotId, item]));
					for (const snapshot of expected) {
						const current = byId.get(snapshot.snapshotId);
						if (current && !sameSnapshot(current, snapshot)) throw new Error(`Trash snapshot changed: ${snapshot.snapshotId}`);
						if (!current) items.push(snapshot);
					}
					return items;
				});
			};
			try {
				return await action({ assertActive: () => {
					check();
					if (verifiedRevision !== null && verifiedRevision !== this.coordinator.revision) throw new Error("Trash changed before Daily commit.");
				}, read, saveAll, save: (snapshot) => saveAll([snapshot]),
					assertUnchanged: async (snapshot) => {
						const revision = this.coordinator.revision;
						validateSnapshot(snapshot, snapshot.snapshotId);
						if (!sameSnapshot(await read(snapshot.snapshotId), snapshot)) throw new Error(`Trash snapshot changed: ${snapshot.snapshotId}`);
						if (revision !== this.coordinator.revision) throw new Error("Trash changed while verifying snapshot.");
						verifiedRevision = revision;
					},
					remove: (snapshot, allowMissing = false) => {
						const expected = structuredClone(snapshot);
						validateSnapshot(expected, expected.snapshotId);
						return this.modify(path, check, (items) => {
							const current = items.find((item) => item.snapshotId === expected.snapshotId);
							if (!current && allowMissing) return items;
							if (!current || !sameSnapshot(current, expected)) throw new Error(`Trash snapshot changed: ${expected.snapshotId}`);
							return items.filter((item) => item.snapshotId !== expected.snapshotId);
						});
					},
					clear: () => this.modify(path, check, () => []),
				});
			} finally { active = false; }
		}).finally(() => { this.coordinator.pending--; });
		this.coordinator.queue = pending;
		return pending;
	}

	save(snapshot: TrashSnapshot): Promise<void> { const copy = structuredClone(snapshot); return this.runExclusive((store) => store.save(copy)); }
	saveAll(snapshots: readonly TrashSnapshot[]): Promise<void> { const copy = structuredClone(snapshots); return this.runExclusive((store) => store.saveAll(copy)); }
	read(id: string): Promise<TrashSnapshot> { return this.runExclusive((store) => store.read(id)); }
	assertUnchanged(snapshot: TrashSnapshot): Promise<void> { const copy = structuredClone(snapshot); return this.runExclusive((store) => store.assertUnchanged(copy)); }
	remove(snapshot: TrashSnapshot, allowMissing = false): Promise<void> { const copy = structuredClone(snapshot); return this.runExclusive((store) => store.remove(copy, allowMissing)); }
	clear(): Promise<void> { return this.runExclusive((store) => store.clear()); }

	async assertContainsAll(snapshots: readonly TrashSnapshot[]): Promise<void> {
		const expected = structuredClone(snapshots);
		validateItems(expected);
		const path = this.path;
		await this.runExclusive(async (store) => {
			const current = new Map((await this.readDisk(path)).map((item) => [item.snapshotId, item]));
			store.assertActive();
			if (!expected.every((item) => { const found = current.get(item.snapshotId); return found !== undefined && sameSnapshot(found, item); })) {
				throw new Error("Trash target verification failed.");
			}
		});
	}

	query(): Promise<TrashQueryResult> {
		if (!this.reading) {
			let resolve!: (result: TrashQueryResult) => void;
			let reject!: (error: unknown) => void;
			const pending = new Promise<TrashQueryResult>((res, rej) => { resolve = res; reject = rej; });
			// 先登记共享请求，再发布 loading，避免订阅回调重入创建第二次读取。
			this.reading = pending.finally(() => { this.reading = null; });
			void this.load().then(resolve, reject);
		}
		return this.reading.then((result) => structuredClone(result));
	}

	private async load(): Promise<TrashQueryResult> {
		for (let attempt = 0; attempt < 3; attempt++) {
			if (this.coordinator.pending > 0) {
				await this.coordinator.queue.catch(() => undefined);
				const current = this.getState();
				if (current.status === "error") return { items: [], errors: [{ snapshotId: "", message: current.error ?? "Trash unavailable." }] };
			}
			let path = "";
			const revision = this.coordinator.revision;
			try {
				if (this.disposed) throw new Error("Trash runtime disposed.");
				path = this.path;
				this.assertActive();
				const state = this.getState();
				if (state.status === "ready") return { items: state.items, errors: [] };
				if (attempt > 0 && state.status === "error") return { items: [], errors: [{ snapshotId: "", message: state.error ?? "Trash unavailable." }] };
				this.publish(path, { status: "loading", items: null, count: null, error: null });
				const items = await this.readDisk(path);
				this.assertActive();
				if (path !== this.path || revision !== this.coordinator.revision) continue;
				const sorted = this.publishReady(path, items);
				if (path !== this.path || revision !== this.coordinator.revision) continue;
				return { items: structuredClone(sorted), errors: [] };
			} catch (error) {
				if (revision !== this.coordinator.revision) continue;
				try { if (path && path !== this.path) continue; } catch { /* 配置错误由下面的失败 state 报告。 */ }
				this.publish(path, { status: "error", items: null, count: null, error: String(error) });
				return { items: [], errors: [{ snapshotId: "", message: String(error) }] };
			}
		}
		const message = "Trash changed while reading; retry.";
		this.publish(this.path, { status: "error", items: null, count: null, error: message });
		return { items: [], errors: [{ snapshotId: "", message }] };
	}

	private async readDisk(path: string): Promise<TrashSnapshot[]> {
		const file = this.app.vault.getAbstractFileByPath(path);
		if (file === null && !await this.app.vault.adapter.exists(path)) return [];
		if (!(file instanceof TFile)) throw new Error(`Trash file unavailable: ${path}`);
		const text = await this.app.vault.read(file);
		if (file.path !== path || this.app.vault.getAbstractFileByPath(path) !== file) throw new Error("Trash file changed while reading.");
		return parseCollection(text);
	}

	private async modify(path: string, guard: () => void, update: (items: TrashSnapshot[]) => TrashSnapshot[]): Promise<void> {
		this.invalidate();
		let attempted = false;
		try {
			guard();
			const file = this.app.vault.getAbstractFileByPath(path);
			let expected: TrashSnapshot[] = [];
			if (file === null) {
				if (await this.app.vault.adapter.exists(path)) throw new Error(`Trash file unavailable: ${path}`);
				expected = update([]);
				if (expected.length) {
					await this.ensureParent(path, guard);
					guard();
					attempted = true;
					await this.app.vault.create(path, encodeCollection(expected));
				}
			} else {
				if (!(file instanceof TFile)) throw new Error(`Trash file unavailable: ${path}`);
				guard();
				await this.app.vault.process(file, (text) => {
					guard();
					if (file.path !== path || this.app.vault.getAbstractFileByPath(path) !== file) throw new Error("Trash file moved.");
					expected = update(parseCollection(text));
					attempted = true;
					return encodeCollection(expected);
				});
			}
			guard();
			const verificationRevision = this.coordinator.revision;
			const actual = await this.readDisk(path);
			guard();
			if (verificationRevision !== this.coordinator.revision) throw new Error("Trash changed during write verification.");
			if (!sameItems(actual, expected)) throw new Error("Trash write verification failed.");
			this.coordinator.revision++;
			this.publishReady(path, actual);
		} catch (error) {
			// 写后抛错和读回失败均不报告成功，不回写旧集合；重读只用于报告磁盘现状。
			this.invalidate();
			let observed = "not attempted";
			if (attempted) {
				try { observed = `${(await this.readDisk(path)).length} items readable`; }
				catch { observed = "unreadable"; }
			}
			const failure = new Error(`Trash operation failed (${observed}): ${String(error)}`);
			if (this.path === path) this.publish(path, { status: "error", items: null, count: null, error: failure.message });
			throw failure;
		}
	}

	private async ensureParent(path: string, guard: () => void): Promise<void> {
		const parts = path.split("/").slice(0, -1);
		for (let index = 1; index <= parts.length; index++) {
			guard();
			const folder = parts.slice(0, index).join("/");
			if (this.app.vault.getAbstractFileByPath(folder) === null) {
				try { await this.app.vault.createFolder(folder); }
				catch (error) { if (!(this.app.vault.getAbstractFileByPath(folder) instanceof TFolder)) throw error; }
			}
			if (!(this.app.vault.getAbstractFileByPath(folder) instanceof TFolder)) throw new Error(`Trash folder unavailable: ${folder}`);
		}
	}

	private notify(): void {
		for (const listener of this.coordinator.listeners) {
			// 展示失败不能改变已确认的磁盘操作结果。
			try { listener(); } catch (error) { console.error("Trash state listener failed", error); }
		}
	}
	private publish(path: string, state: TrashStoreState): void {
		if (this.disposed) return;
		this.coordinator.publication = { path, revision: this.coordinator.revision, state };
		this.notify();
	}
	private publishReady(path: string, items: TrashSnapshot[]): TrashSnapshot[] {
		const sorted = structuredClone(items).sort((a, b) => b.deletedAt.localeCompare(a.deletedAt) || a.snapshotId.localeCompare(b.snapshotId));
		this.publish(path, { status: "ready", items: sorted, count: sorted.length, error: null });
		return sorted;
	}
}

function encodeCollection(items: readonly TrashSnapshot[]): string { return JSON.stringify({ kind: "knomo-trash", items }); }
function parseCollection(text: string): TrashSnapshot[] {
	const value: unknown = JSON.parse(text);
	if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid Trash collection ownership.");
	const collection = value as { kind?: unknown; items?: unknown };
	if (collection.kind !== "knomo-trash" || Object.keys(value).length !== 2) throw new Error("Invalid Trash collection ownership.");
	validateItems(collection.items);
	return collection.items;
}
function validateItems(value: unknown): asserts value is TrashSnapshot[] {
	if (!Array.isArray(value)) throw new Error("Invalid Trash collection.");
	const ids = new Set<string>();
	for (const item of value) {
		validateSnapshot(item, (item as TrashSnapshot | null)?.snapshotId ?? "");
		if (ids.has(item.snapshotId)) throw new Error("Duplicate Trash snapshot ID.");
		ids.add(item.snapshotId);
	}
}
function sameItems(a: TrashSnapshot[], b: TrashSnapshot[]): boolean {
	const byId = new Map(a.map((item) => [item.snapshotId, item]));
	return a.length === b.length && b.every((item) => { const current = byId.get(item.snapshotId); return current !== undefined && sameSnapshot(current, item); });
}

export function assertVaultPath(path: string): void {
	if (!path || (/[\\:]/u.test(path) || Array.from(path).some(character => character.charCodeAt(0) < 32)) || path.split("/").some((part) => !part || part === "." || part === "..")) {
		throw new Error("Invalid Vault path.");
	}
}

function validateSnapshot(value: unknown, snapshotId: string): asserts value is TrashSnapshot {
	if (value === null || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length !== 6
		|| !/^[a-zA-Z0-9_-]{1,128}$/u.test(snapshotId)) throw new Error("Invalid Trash snapshot.");
	const item = value as Partial<TrashSnapshot>;
	if (item.snapshotId !== snapshotId || typeof item.deletedAt !== "string" || !Number.isFinite(Date.parse(item.deletedAt))
		|| typeof item.sourcePath !== "string" || !item.sourcePath.endsWith(".md")
		|| typeof item.logicalDate !== "string" || !/^\d{4}-\d{2}-\d{2}$/u.test(item.logicalDate)
		|| new Date(`${item.logicalDate}T00:00:00Z`).toISOString().slice(0, 10) !== item.logicalDate
		|| !(item.section === null || typeof item.section === "string" && /^#{1,6} [^\r\n]+$/u.test(item.section))
		|| typeof item.rawBlock !== "string" || item.rawBlock.length === 0) throw new Error("Invalid Trash snapshot.");
	assertVaultPath(item.sourcePath);
}

function sameSnapshot(a: TrashSnapshot, b: TrashSnapshot): boolean {
	return a.snapshotId === b.snapshotId && a.deletedAt === b.deletedAt && a.sourcePath === b.sourcePath
		&& a.logicalDate === b.logicalDate && a.section === b.section && a.rawBlock === b.rawBlock;
}
