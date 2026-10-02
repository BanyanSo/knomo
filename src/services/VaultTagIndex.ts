import { Component, getAllTags, TAbstractFile, TFile, TFolder } from "obsidian";
import type { App, CachedMetadata } from "obsidian";
import { buildTagDisplayMapCooperatively, normalizeTagDisplay, normalizeTagKey } from "../utils/tags";
import type { TagDisplaySource } from "../utils/tags";
import { CooperativeYieldController, stableSortCooperatively, type CooperativeTaskRuntime } from "./CooperativeTask";

interface FileTagSnapshot {
	mtime: number;
	tags: readonly string[];
}

export interface VaultTagSnapshot {
	revision: number;
	status: "idle" | "building" | "ready" | "partial";
	displayByKey: ReadonlyMap<string, string>;
	suggestions: readonly string[];
}

export class VaultTagIndex extends Component {
	private snapshot: VaultTagSnapshot = { revision: 0, status: "idle", displayByKey: new Map(), suggestions: [] };
	private readonly fileSnapshots = new Map<string, FileTagSnapshot>();
	private readonly missingCachePaths = new Set<string>();
	private readonly pendingPaths = new Set<string>();
	private readonly listeners = new Set<() => void>();
	private buildPromise: Promise<void> | null = null;
	private started = false;
	private scanned = false;
	private stopped = false;
	private generation = 0;
	private publishedGeneration = -1;
	private timer: number | null = null;
	private readonly yields = new Map<number, (error: Error) => void>();
	private readonly waiters: { generation: number; resolve: (snapshot: VaultTagSnapshot) => void; reject: (error: unknown) => void }[] = [];
	private yieldOverride?: () => Promise<void>;
	private readonly interactionPauses = new Set<object>();
	private readonly interactionWaiters = new Set<{ resolve: () => void; reject: (error: Error) => void }>();

	constructor(private readonly app: App) { super(); }

	onload(): void {
		this.registerEvent(this.app.metadataCache.on("changed", (file, _data, cache) => {
			if (!this.stopped) this.setFileSnapshot(file, cache, true);
		}));
		this.registerEvent(this.app.metadataCache.on("deleted", file => this.removePath(file.path)));
		this.registerEvent(this.app.metadataCache.on("resolve", file => {
			if (this.missingCachePaths.has(file.path)) this.readFile(file, true);
		}));
		this.registerEvent(this.app.metadataCache.on("resolved", () => this.retryMissingCaches()));
		this.registerEvent(this.app.vault.on("rename", (file, oldPath) => this.handleRename(file, oldPath)));
	}

	getSnapshot(): VaultTagSnapshot { return this.snapshot; }

	// 键盘/输入法关键阶段暂停下一片；多个视图分别释放，不取消或重建已有索引。
	pauseForInteraction(): () => void {
		if (this.stopped) return () => {};
		const token = {};
		this.interactionPauses.add(token);
		if (this.timer !== null) {
			this.app.workspace.containerEl.win.clearTimeout(this.timer);
			this.timer = null;
		}
		return () => {
			if (!this.interactionPauses.delete(token) || this.interactionPauses.size > 0 || this.stopped) return;
			for (const waiter of this.interactionWaiters) waiter.resolve();
			this.interactionWaiters.clear();
			if (this.publishedGeneration < this.generation) this.schedule();
		};
	}

	subscribe(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	ensureReady(yieldToUi?: () => Promise<void>): Promise<VaultTagSnapshot> {
		if (this.stopped) return Promise.reject(new Error("Vault tag index is unloaded."));
		if (this.publishedGeneration >= this.generation) return Promise.resolve(this.snapshot);
		this.started = true;
		if (yieldToUi && this.buildPromise === null) this.yieldOverride = yieldToUi;
		const result = new Promise<VaultTagSnapshot>((resolve, reject) => {
			this.waiters.push({ generation: this.generation, resolve, reject });
		});
		this.schedule();
		return result;
	}

	onunload(): void {
		this.stopped = true;
		const win = this.app.workspace.containerEl.win;
		if (this.timer !== null) win.clearTimeout(this.timer);
		this.timer = null;
		const error = new Error("Vault tag index is unloaded.");
		for (const waiter of this.interactionWaiters) waiter.reject(error);
		this.interactionWaiters.clear();
		this.interactionPauses.clear();
		for (const [timer, reject] of this.yields) { win.clearTimeout(timer); reject(error); }
		this.yields.clear();
		this.buildPromise = null;
		this.snapshot = { ...this.snapshot, status: "idle" };
		for (const waiter of this.waiters.splice(0)) waiter.reject(error);
		this.listeners.clear();
	}

	private schedule(): void {
		if (!this.started || this.stopped || this.timer !== null || this.buildPromise !== null) return;
		this.snapshot = { ...this.snapshot, status: "building" };
		if (this.interactionPauses.size > 0) return;
		this.timer = this.app.workspace.containerEl.win.setTimeout(() => {
			this.timer = null;
			const operation = this.build().then(() => {
				if (this.buildPromise !== operation) return;
				this.buildPromise = null;
				this.yieldOverride = undefined;
				if (this.publishedGeneration < this.generation) this.schedule();
			}, (error: unknown) => {
				if (this.buildPromise !== operation) return;
				this.buildPromise = null;
				this.yieldOverride = undefined;
				this.snapshot = { ...this.snapshot, status: "idle" };
				for (const waiter of this.waiters.splice(0)) waiter.reject(error);
				console.error("[Knomo] Vault tag index build failed", error);
			});
			this.buildPromise = operation;
		}, 0);
	}

	private async yieldControl(): Promise<void> {
		this.checkActive();
		if (this.yieldOverride) await this.yieldOverride();
		else await new Promise<void>((resolve, reject) => {
			const timer = this.app.workspace.containerEl.win.setTimeout(() => {
				this.yields.delete(timer);
				resolve();
			}, 0);
			this.yields.set(timer, reject);
		});
		await this.waitForInteraction();
		this.checkActive();
	}

	private async waitForInteraction(): Promise<void> {
		this.checkActive();
		while (this.interactionPauses.size > 0) {
			await new Promise<void>((resolve, reject) => this.interactionWaiters.add({ resolve, reject }));
			this.checkActive();
		}
	}

	private checkActive(): void {
		if (this.stopped) throw new Error("Vault tag index is unloaded.");
	}

	private async build(): Promise<void> {
		const runtime: CooperativeTaskRuntime = { yieldControl: () => this.yieldControl() };
		const controller = new CooperativeYieldController(runtime);
		if (!this.scanned) {
			// 扫描不得覆盖已经收到的事件；路径单独保存以隔离扫描中的重命名。
			const files = this.app.vault.getMarkdownFiles().map(file => ({ file, path: file.path }));
			for (const { file, path } of files) {
				if (!this.pendingPaths.has(path)) this.readFile(file);
				if (controller.shouldYield()) await controller.yieldNow();
			}
			this.scanned = true;
			this.pendingPaths.clear();
		}
		// 此后到达的事件只影响下一批，当前批始终有发布机会。
		const generation = this.generation;
		const partial = this.missingCachePaths.size > 0;
		const entries = await stableSortCooperatively([...this.fileSnapshots.entries()], ([left], [right]) => left.localeCompare(right), runtime);
		const sources: TagDisplaySource[] = [];
		const suggestionByKey = new Map<string, string>();
		let order = 0;
		for (const [, entry] of entries) {
			for (const tag of entry.tags) {
				sources.push({ tag, modifiedTime: entry.mtime, order: order++ });
				const key = normalizeTagKey(tag);
				if (key.length > 0 && !suggestionByKey.has(key)) suggestionByKey.set(key, tag);
				if (controller.shouldYield()) await controller.yieldNow();
			}
		}
		const displayByKey = await buildTagDisplayMapCooperatively(sources, runtime);
		const candidates: string[] = [];
		for (const [key, tag] of suggestionByKey) {
			candidates.push(displayByKey.get(key) ?? tag);
			if (controller.shouldYield()) await controller.yieldNow();
		}
		const suggestions = await stableSortCooperatively(candidates, (left, right) => left.localeCompare(right, "zh"), runtime);
		this.checkActive();
		this.publishedGeneration = generation;
		this.snapshot = {
			revision: this.snapshot.revision + 1,
			status: generation < this.generation ? "building" : partial ? "partial" : "ready",
			displayByKey, suggestions,
		};
		for (let index = this.waiters.length - 1; index >= 0; index--) {
			if (this.waiters[index].generation <= generation) this.waiters.splice(index, 1)[0].resolve(this.snapshot);
		}
		this.notify();
	}

	private markChanged(path: string): void {
		if (!this.scanned) this.pendingPaths.add(path);
		this.generation++;
		if (this.started) this.snapshot = { ...this.snapshot, status: "building" };
		this.schedule();
	}

	private readFile(file: TFile, event = false): void {
		if (this.stopped) return;
		const cache = this.app.metadataCache.getFileCache(file);
		if (cache !== null) this.setFileSnapshot(file, cache, event);
		else {
			const removed = this.fileSnapshots.delete(file.path);
			const missing = this.missingCachePaths.has(file.path);
			this.missingCachePaths.add(file.path);
			if (event && (removed || !missing)) this.markChanged(file.path);
		}
	}

	private setFileSnapshot(file: TFile, cache: CachedMetadata, event = false): void {
		if (file.extension !== "md") { this.removePath(file.path); return; }
		const tags = [...new Set((getAllTags(cache) ?? []).map(normalizeTagDisplay).filter(tag => tag.length > 0))];
		const previous = this.fileSnapshots.get(file.path);
		if (previous?.mtime === file.stat.mtime && previous.tags.length === tags.length
			&& previous.tags.every((tag, index) => tag === tags[index])) return;
		this.fileSnapshots.set(file.path, { mtime: file.stat.mtime, tags });
		this.missingCachePaths.delete(file.path);
		if (event) this.markChanged(file.path);
	}

	private removePath(path: string): void {
		if (this.stopped) return;
		const removed = this.fileSnapshots.delete(path);
		const missing = this.missingCachePaths.delete(path);
		if (removed || missing || !this.scanned) this.markChanged(path);
	}

	private handleRename(file: TAbstractFile, oldPath: string): void {
		if (this.stopped) return;
		if (file instanceof TFile) {
			this.removePath(oldPath);
			if (file.extension === "md") this.readFile(file, true);
			return;
		}
		if (!(file instanceof TFolder)) return;
		const oldPrefix = `${oldPath}/`;
		const newPrefix = `${file.path}/`;
		// 文件夹重命名保留已有文件事实，不依赖新路径的 metadata 已经就绪。
		for (const [path, snapshot] of [...this.fileSnapshots]) {
			if (!path.startsWith(oldPrefix)) continue;
			const nextPath = `${newPrefix}${path.slice(oldPrefix.length)}`;
			this.removePath(path);
			this.fileSnapshots.set(nextPath, snapshot);
			this.markChanged(nextPath);
		}
		for (const path of [...this.missingCachePaths]) {
			if (!path.startsWith(oldPrefix)) continue;
			const nextPath = `${newPrefix}${path.slice(oldPrefix.length)}`;
			this.removePath(path);
			this.missingCachePaths.add(nextPath);
			this.markChanged(nextPath);
		}
		const visit = (folder: TFolder): void => {
			for (const child of folder.children) {
				if (child instanceof TFolder) visit(child);
				else if (child instanceof TFile && child.extension === "md") {
					this.removePath(`${oldPrefix}${child.path.slice(file.path.length + 1)}`);
					if (!this.fileSnapshots.has(child.path) && !this.missingCachePaths.has(child.path)) this.readFile(child, true);
				}
			}
		};
		visit(file);
	}

	private retryMissingCaches(): void {
		if (this.stopped) return;
		for (const path of [...this.missingCachePaths]) {
			const file = this.app.vault.getAbstractFileByPath(path);
			if (file instanceof TFile) this.readFile(file, true);
			else this.removePath(path);
		}
	}

	private notify(): void {
		for (const listener of this.listeners) listener();
	}
}
