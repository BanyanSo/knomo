import { TFile, TFolder, Vault, type App } from "obsidian";
import { favoriteLocation, type FavoriteCollection, type FavoriteItem } from "../types/favorite";
import { assertVaultPath } from "./TrashSnapshotStore";
import { ensureFolder } from "../utils/vault";
import { logContinuationFailure } from "../utils/continuationDiagnostics";

const FILE_NAME = "knomo-favorite.json";
const STORAGE_KEY = "knomo.favorites.file";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
type Hint = { path: string; collectionId: string };
type WorkingCopy = { path: string; file: TFile; text: string; data: FavoriteCollection };
type StoreState = { status: "loading" | "error" | "conflict" } | { status: "ready"; copy: WorkingCopy | null };
type Operation = { folder: string; generation: number; copy: WorkingCopy | null };

class FavoriteConflict extends Error {}
class FavoriteDiscoveryChanged extends Error {}

export class FavoriteStore {
	private state: StoreState = { status: "loading" };
	private hint: Hint | undefined;
	private readonly listeners = new Set<() => void>();
	private candidates: Set<string> | undefined;
	private readonly reads = new Map<string, WorkingCopy>();
	private queue: Promise<unknown> = Promise.resolve();
	private generation = 0;
	private fileGeneration = 0;
	private closed = false;
	private refreshPending = false;
	private started = false;

	constructor(private readonly app: App, private readonly getFolder: () => string,
		private readonly isReady = () => app.workspace.layoutReady) {
		try {
			const hint = app.loadLocalStorage?.(STORAGE_KEY) as Hint | null;
			if (hint && typeof hint.path === "string" && typeof hint.collectionId === "string" && UUID.test(hint.collectionId)
				&& this.validLocation(hint.path)) this.hint = hint;
		} catch (error) { this.report("hint", error); }
	}

	getState(): StoreState { return this.state; }
	subscribe(listener: () => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
	dispose(): void { this.closed = true; this.generation++; this.reads.clear(); this.listeners.clear(); }

	retry(force = true): Promise<void> {
		this.started = true;
		return this.serial(async () => {
			if (!this.closed && this.isReady() && (force || this.state.status !== "ready")) await this.reconcile(true);
		});
	}

	configurationChanged(): void { this.invalidate(); }

	fileChanged(path: string, oldPath?: string, folder?: TFolder): void {
		if (this.closed || !this.started) return;
		const paths = oldPath === undefined ? [path] : [oldPath, path];
		const related = [...this.candidates ?? [], ...this.reads.keys(), this.hint?.path];
		try { related.push(this.pathFor(this.getFolder())); } catch { /* 配置故障由发现流程报告。 */ }
		if (!paths.some(changed => (basename(changed) === FILE_NAME && this.validLocation(changed)
			&& this.app.vault.getAbstractFileByPath(changed) instanceof TFile)
			|| related.some(current => current && within(current, changed))) && (!folder || !this.folderHasCandidate(folder))) return;
		for (const changed of paths) {
			for (const cached of this.reads.keys()) if (within(cached, changed)) this.reads.delete(cached);
		}
		// 父目录事件只重建文件名候选集合，未变化的候选无需重新读盘。
		if (folder || paths.some(changed => basename(changed) !== FILE_NAME)) this.candidates = undefined;
		else if (this.candidates) for (const changed of paths) {
			if (this.validLocation(changed) && this.app.vault.getAbstractFileByPath(changed) instanceof TFile) this.candidates.add(changed);
			else this.candidates.delete(changed);
		}
		this.fileGeneration++;
		this.invalidate();
	}

	run<T>(action: (operation: Operation) => Promise<T>): Promise<T> {
		this.started = true;
		return this.serial(async () => {
			try {
				const operation = await this.inspect(true, false);
				this.accept(operation.copy);
				return await action(operation);
			} catch (error) {
				await this.reconcile(true);
				this.report("operation", error);
				throw error;
			}
		});
	}

	assertOperation(operation: Operation): void {
		if (this.closed || !this.isReady() || operation.folder !== this.getFolder()) throw new FavoriteDiscoveryChanged("Favorites configuration changed.");
		if (operation.generation !== this.generation) throw new FavoriteDiscoveryChanged("Favorites file discovery changed.");
		if (operation.copy && !this.isFile(operation.copy.file, operation.copy.path)) throw new FavoriteDiscoveryChanged("Favorites file moved.");
	}

	async commit(operation: Operation, update: (items: FavoriteItem[]) => FavoriteItem[],
		guard: () => void = () => undefined, verifySource?: () => Promise<void>): Promise<void> {
		this.assertOperation(operation);
		let expected: FavoriteCollection | undefined;
		let file: TFile;
		if (operation.copy) {
			const copy = operation.copy;
			file = copy.file;
			if (verifySource) await verifySource();
			this.assertOperation(operation);
			await this.app.vault.process(file, text => {
				this.assertOperation(operation);
				guard();
				const current = parseFavoriteCollection(text);
				if (current.collectionId !== copy.data.collectionId) throw new FavoriteConflict("Favorites collection changed.");
				expected = { ...current, items: update(current.items) };
				return sameCollection(expected, current) ? text : encode(expected);
			});
		} else {
			const path = this.pathFor(operation.folder);
			await this.assertVacant(path);
			await ensureFolder(this.app, operation.folder);
			const latest = await this.inspect(true);
			if (latest.folder !== operation.folder || latest.copy) throw new FavoriteDiscoveryChanged("Favorites appeared before first save.");
			if (verifySource) await verifySource();
			this.assertOperation(latest);
			guard();
			expected = { kind: "knomo-favorite", version: 1, collectionId: crypto.randomUUID(), items: update([]) };
			file = await this.app.vault.create(path, encode(expected));
			// 即使读回失败，已创建文件也构成历史证据。
			this.remember({ path, collectionId: expected.collectionId });
		}
		this.reads.delete(file.path);
		const actual = await this.inspect(true, false);
		this.assertOperation(actual);
		if (actual.folder !== operation.folder || actual.copy?.file !== file || !expected || !sameCollection(actual.copy.data, expected)) {
			throw new Error("Favorites write could not be confirmed.");
		}
		this.accept(actual.copy);
	}

	relocate(newFolder: string, saveSettings: () => Promise<void>): Promise<{ favoriteError?: string }> {
		this.started = true;
		return this.serial(async () => {
			let source: WorkingCopy | null = null;
			let target: WorkingCopy | null = null;
			let copiedFileGeneration: number | undefined;
			let favoriteError: string | undefined;
			try {
				const operation = await this.inspect(true);
				source = operation.copy;
				const path = this.pathFor(newFolder);
				if (source && source.path !== path) {
					await this.assertVacant(path);
					await ensureFolder(this.app, newFolder);
					const latest = await this.inspect(true);
					if (latest.folder !== operation.folder || latest.copy?.file !== source.file || latest.copy.text !== source.text)
						throw new Error("Favorites source changed before copying.");
					await this.assertVacant(path);
					this.assertOperation(latest);
					const file = await this.app.vault.create(path, source.text);
					this.candidates = undefined;
					const generation = this.generation;
					target = await this.read(path, true);
					if (target.file !== file || target.text !== source.text) throw new Error("Favorites copy could not be confirmed.");
					await this.verifyPair(source, target, operation.folder, generation);
					copiedFileGeneration = this.fileGeneration;
				} else if (!source) {
					await this.assertVacant(path);
					this.assertOperation(operation);
				}
			} catch (error) {
				favoriteError = String(error);
				this.report("relocate", error);
			}

			try { await saveSettings(); }
			catch (error) {
				await this.reconcile(true);
				throw error;
			}

			if (source && target && copiedFileGeneration !== undefined) {
				try {
					// 设置保存可触发配置失效，文件变更仍由文件对象和原字节复核。
					if (this.getFolder() !== newFolder || this.fileGeneration !== copiedFileGeneration) throw new Error("Favorites destination configuration was not saved.");
					const generation = this.generation;
					await this.verifyPair(source, target, newFolder, generation);
					await this.app.fileManager.trashFile(source.file);
					await this.assertVacant(source.path);
					this.candidates = undefined;
					const actual = await this.inspect(true);
					if (actual.copy?.file !== target.file || actual.copy.text !== target.text) throw new Error("Favorites relocation was not confirmed.");
					this.accept(actual.copy);
				} catch (error) {
					favoriteError = String(error);
					this.report("relocate", error);
				}
			}
			await this.reconcile(true);
			return { favoriteError };
		});
	}

	private async verifyPair(source: WorkingCopy, target: WorkingCopy, folder: string, generation: number): Promise<void> {
		const paths = this.listCandidates(true);
		if (paths.length !== 2 || !paths.includes(source.path) || !paths.includes(target.path))
			throw new FavoriteConflict("Favorites candidates changed during relocation.");
		for (const copy of [target, source]) {
			const actual = await this.read(copy.path, true);
			if (actual.file !== copy.file || actual.text !== copy.text) throw new Error("Favorites source or copy changed.");
		}
		if (this.closed || folder !== this.getFolder() || generation !== this.generation
			|| !this.isFile(source.file, source.path) || !this.isFile(target.file, target.path)) throw new FavoriteDiscoveryChanged("Favorites relocation changed.");
	}

	private invalidate(): void {
		this.generation++;
		if (this.closed || !this.started) return;
		this.publish({ status: "loading" });
		if (this.refreshPending) return;
		this.refreshPending = true;
		void this.serial(async () => {
			this.refreshPending = false;
			if (!this.closed && this.isReady()) await this.reconcile(false);
		});
	}

	private async reconcile(force: boolean): Promise<void> {
		try { this.accept((await this.inspect(force)).copy); }
		catch (error) {
			if (this.closed || error instanceof FavoriteDiscoveryChanged) return;
			this.publish({ status: error instanceof FavoriteConflict ? "conflict" : "error" });
			this.report("read", error);
		}
	}

	private async inspect(force: boolean, rescan = force): Promise<Operation> {
		if (this.closed || !this.isReady()) throw new FavoriteDiscoveryChanged("Vault file discovery is not ready.");
		const folder = this.getFolder();
		const configured = this.pathFor(folder);
		const generation = this.generation;
		const paths = new Set(this.listCandidates(rescan));
		for (const path of new Set([configured, this.hint?.path])) {
			if (!path) continue;
			const file = this.app.vault.getAbstractFileByPath(path);
			if (file) paths.add(path);
			else if (await this.app.vault.adapter.exists(path)) throw new Error("Favorites file has not loaded: " + path);
		}
		const copies: WorkingCopy[] = [];
		for (const path of paths) copies.push(await this.read(path, force));
		if (copies.length > 1 || (this.hint && copies[0]?.data.collectionId !== this.hint.collectionId))
			throw new FavoriteConflict("Favorites collection is missing or conflicts with another file.");
		if (!copies.length) await this.assertVacant(configured);
		const operation = { folder, generation, copy: copies[0] ?? null };
		this.assertOperation(operation);
		return operation;
	}

	private listCandidates(force: boolean): string[] {
		if (force || !this.candidates) {
			const candidates = new Set<string>();
			for (const { path } of this.app.vault.getFiles()) {
				if (basename(path) === FILE_NAME && this.validLocation(path)) candidates.add(path);
			}
			this.candidates = candidates;
		}
		return [...this.candidates];
	}

	private folderHasCandidate(folder: TFolder): boolean {
		let found = false;
		// 宿主可能只通知父目录，搬入的新候选没有单独的文件事件。
		Vault.recurseChildren(folder, file => {
			if (!found && file instanceof TFile && basename(file.path) === FILE_NAME && this.validLocation(file.path)) found = true;
		});
		return found;
	}

	private async read(path: string, force: boolean): Promise<WorkingCopy> {
		if (!this.validLocation(path)) throw new Error("Invalid Favorites file path.");
		const file = this.app.vault.getAbstractFileByPath(path);
		if (!(file instanceof TFile)) throw new Error("Favorites path is occupied: " + path);
		const cached = this.reads.get(path);
		if (!force && cached?.file === file) return cached;
		const generation = this.generation;
		const text = await this.app.vault.read(file);
		if (generation !== this.generation || !this.isFile(file, path)) throw new FavoriteDiscoveryChanged("Favorites changed during read.");
		const copy = { path, file, text, data: parseFavoriteCollection(text) };
		this.reads.set(path, copy);
		return copy;
	}

	private pathFor(folder: string): string {
		const path = folder ? folder + "/" + FILE_NAME : FILE_NAME;
		if (!this.validLocation(path)) throw new Error("Invalid Favorites folder.");
		return path;
	}

	private validLocation(path: string): boolean {
		assertVaultPath(path);
		const parts = path.split("/");
		return parts.pop() === FILE_NAME && !within(path, this.app.vault.configDir)
			&& !parts.some(part => /^(?:\.trash|\.obsidian|_knomo-system)$/iu.test(part));
	}

	private isFile(file: TFile, path: string): boolean {
		return file.path === path && this.app.vault.getAbstractFileByPath(path) === file;
	}

	private async assertVacant(path: string): Promise<void> {
		if (this.app.vault.getAbstractFileByPath(path) || await this.app.vault.adapter.exists(path))
			throw new Error("Favorites destination is occupied: " + path);
		const parts = path.split("/").slice(0, -1);
		for (let index = 1; index <= parts.length; index++) {
			const parent = parts.slice(0, index).join("/");
			const file = this.app.vault.getAbstractFileByPath(parent);
			if (file ? !(file instanceof TFolder) : await this.app.vault.adapter.exists(parent))
				throw new Error("Favorites parent is unavailable: " + parent);
		}
	}

	private accept(copy: WorkingCopy | null): void {
		if (this.closed) return;
		if (copy) this.remember({ path: copy.path, collectionId: copy.data.collectionId });
		this.publish({ status: "ready", copy });
	}

	private remember(hint: Hint): void {
		if (this.hint?.path === hint.path && this.hint.collectionId === hint.collectionId) return;
		this.hint = hint;
		try { this.app.saveLocalStorage?.(STORAGE_KEY, hint); } catch (error) { this.report("hint", error); }
	}

	private publish(state: StoreState): void {
		if (this.closed || (this.state.status === state.status && (state.status !== "ready"
			|| this.state.status === "ready" && this.state.copy?.path === state.copy?.path && this.state.copy?.text === state.copy?.text))) return;
		this.state = state;
		for (const listener of this.listeners) {
			try { listener(); } catch (error) { this.report("render", error); }
		}
	}

	private serial<T>(action: () => Promise<T>): Promise<T> {
		const next = this.queue.then(action);
		this.queue = next.catch(() => undefined);
		return next;
	}

	private report(operation: string, error: unknown): void { logContinuationFailure("view", "favorites-" + operation, error); }
}

function basename(path: string): string { return path.slice(path.lastIndexOf("/") + 1); }

function within(path: string, parent: string): boolean { return path === parent || path.startsWith(parent + "/"); }

export function parseFavoriteCollection(text: string): FavoriteCollection {
	const value = JSON.parse(text) as Partial<FavoriteCollection> | null;
	if (!value || value.kind !== "knomo-favorite" || value.version !== 1 || Object.keys(value).length !== 4
		|| typeof value.collectionId !== "string" || !UUID.test(value.collectionId) || !Array.isArray(value.items))
		throw new Error("Invalid Favorites collection.");
	const ids = new Set<string>();
	const locations = new Set<string>();
	const items = value.items.map(item => {
		if (!item || Object.keys(item).length !== 5 || typeof item.favoriteId !== "string" || !UUID.test(item.favoriteId)
			|| typeof item.sourcePath !== "string" || !item.sourcePath.endsWith(".md")
			|| typeof item.blockId !== "string" || !/^[A-Za-z0-9-]+$/u.test(item.blockId)
			|| typeof item.memoTime !== "string" || !/^(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?$/u.test(item.memoTime)
			|| typeof item.starredAt !== "string" || !Number.isFinite(Date.parse(item.starredAt))
			|| new Date(item.starredAt).toISOString() !== item.starredAt) throw new Error("Invalid Favorites item.");
		assertVaultPath(item.sourcePath);
		const id = item.favoriteId.toLowerCase();
		const location = favoriteLocation(item.sourcePath, item.blockId);
		if (ids.has(id) || locations.has(location)) throw new Error("Duplicate Favorites item.");
		ids.add(id);
		locations.add(location);
		const { favoriteId, sourcePath, blockId, memoTime, starredAt } = item;
		return { favoriteId, sourcePath, blockId, memoTime, starredAt };
	});
	return { kind: value.kind, version: value.version, collectionId: value.collectionId, items };
}

function encode(data: FavoriteCollection): string {
	const text = JSON.stringify(data, null, 2) + "\n";
	parseFavoriteCollection(text);
	return text;
}
function sameCollection(left: FavoriteCollection, right: FavoriteCollection): boolean {
	return JSON.stringify(left) === JSON.stringify(right);
}
