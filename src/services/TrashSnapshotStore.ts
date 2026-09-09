import { TFile, TFolder } from "obsidian";
import type { App } from "obsidian";
import type { TrashQueryResult, TrashSnapshot, TrashStoreState } from "../types/trash";

// 所有实例共享当前 Vault 的本地操作队列；不形成磁盘协议。
const coordinators = new WeakMap<App, { queue: Promise<unknown>; revision: number }>();

export type TrashOperationStore = Pick<TrashSnapshotStore, "read" | "save" | "saveAll" | "assertUnchanged" | "remove" | "clear"> & { assertActive(): void };

export function getTrashFilePath(monthlyFolder: string): string {
	if (monthlyFolder !== "") assertVaultPath(monthlyFolder);
	return monthlyFolder ? `${monthlyFolder}/knomo-trash.json` : "knomo-trash.json";
}

export class TrashSnapshotStore {
	private readonly coordinator;
	private state: TrashStoreState = { status: "idle", items: null, count: null, error: null };
	private statePath = "";
	private stateRevision = -1;
	private reading: Promise<TrashQueryResult> | null = null;
	private configurationRevision = 0;

	constructor(private readonly app: App, private readonly monthlyFolder: string | (() => string), private readonly assertActive: () => void = () => undefined) {
		this.coordinator = coordinators.get(app) ?? { queue: Promise.resolve(), revision: 0 };
		coordinators.set(app, this.coordinator);
	}

	get path(): string { return getTrashFilePath(typeof this.monthlyFolder === "string" ? this.monthlyFolder : this.monthlyFolder()); }

	getState(): TrashStoreState {
		if (this.statePath !== this.path || this.stateRevision !== this.coordinator.revision) return { status: "idle", items: null, count: null, error: null };
		return structuredClone(this.state);
	}

	invalidate(): void {
		this.coordinator.revision++;
		this.state = { status: "idle", items: null, count: null, error: null };
	}

	invalidateConfiguration(): void { this.configurationRevision++; this.invalidate(); }

	// 回调内使用绑定的操作对象，避免队列重入；锁覆盖整个 Daily 删除/恢复提交窗口。
	runExclusive<T>(action: (store: TrashOperationStore) => Promise<T>): Promise<T> {
		const path = this.path;
		const revision = this.configurationRevision;
		const guard = () => {
			this.assertActive();
			if (this.path !== path || revision !== this.configurationRevision) throw new Error("Trash configuration changed.");
		};
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
		});
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
		if (!this.reading) this.reading = this.load().finally(() => { this.reading = null; });
		return this.reading.then((result) => structuredClone(result));
	}

	private async load(): Promise<TrashQueryResult> {
		for (let attempt = 0; attempt < 3; attempt++) {
			const path = this.path;
			const revision = this.coordinator.revision;
			try {
				this.assertActive();
				const state = this.getState();
				if (state.status === "ready") return { items: state.items, errors: [] };
				this.publish(path, { status: "loading", items: null, count: null, error: null });
				const items = await this.readDisk(path);
				this.assertActive();
				if (path !== this.path || revision !== this.coordinator.revision) continue;
				this.publishReady(path, items);
				return { items: structuredClone(this.state.status === "ready" ? this.state.items : items), errors: [] };
			} catch (error) {
				if (path !== this.path || revision !== this.coordinator.revision) continue;
				this.publish(path, { status: "error", items: null, count: null, error: String(error) });
				return { items: [], errors: [{ snapshotId: "", message: String(error) }] };
			}
		}
		throw new Error("Trash changed while reading; retry.");
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
			const actual = await this.readDisk(path);
			guard();
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

	private publish(path: string, state: TrashStoreState): void { this.statePath = path; this.stateRevision = this.coordinator.revision; this.state = state; }
	private publishReady(path: string, items: TrashSnapshot[]): void {
		const sorted = structuredClone(items).sort((a, b) => b.deletedAt.localeCompare(a.deletedAt) || a.snapshotId.localeCompare(b.snapshotId));
		this.publish(path, { status: "ready", items: sorted, count: sorted.length, error: null });
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
	if (!path || /[\\:\u0000-\u001f]/u.test(path) || path.split("/").some((part) => !part || part === "." || part === "..")) {
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
