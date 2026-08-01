import { Component, getAllTags, TAbstractFile, TFile, TFolder } from "obsidian";
import type { App, CachedMetadata } from "obsidian";

import { buildTagDisplayMap, normalizeTagDisplay, normalizeTagKey } from "../utils/tags";
import type { TagDisplaySource } from "../utils/tags";

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
	private snapshot: VaultTagSnapshot = createEmptySnapshot();
	private readonly fileSnapshots = new Map<string, FileTagSnapshot>();
	private readonly missingCachePaths = new Set<string>();
	private readonly pendingPaths = new Set<string>();
	private readonly listeners = new Set<() => void>();
	private buildPromise: Promise<VaultTagSnapshot> | null = null;
	private building = false;

	constructor(private readonly app: App) {
		super();
	}

	onload(): void {
		this.registerEvent(this.app.metadataCache.on("changed", (file, _data, cache) => {
			this.updateFile(file, cache);
		}));
		this.registerEvent(this.app.metadataCache.on("deleted", (file) => {
			this.removePath(file.path);
		}));
		this.registerEvent(this.app.metadataCache.on("resolve", (file) => {
			if (this.missingCachePaths.has(file.path)) {
				this.refreshFile(file);
			}
		}));
		this.registerEvent(this.app.metadataCache.on("resolved", () => {
			this.retryMissingCaches();
		}));
		this.registerEvent(this.app.vault.on("rename", (file, oldPath) => {
			this.handleRename(file, oldPath);
		}));
	}

	getSnapshot(): VaultTagSnapshot {
		return this.snapshot;
	}

	subscribe(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	ensureReady(yieldToUi?: () => Promise<void>): Promise<VaultTagSnapshot> {
		if (
			(this.snapshot.status === "ready" || this.snapshot.status === "partial")
			&& this.buildPromise === null
		) {
			return Promise.resolve(this.snapshot);
		}
		if (this.buildPromise !== null) {
			return this.buildPromise;
		}
		this.buildPromise = this.build(yieldToUi).finally(() => {
			this.buildPromise = null;
		});
		return this.buildPromise;
	}

	private async build(yieldToUi?: () => Promise<void>): Promise<VaultTagSnapshot> {
		this.building = true;
		this.snapshot = { ...this.snapshot, status: "building" };
		this.notify();
		this.fileSnapshots.clear();
		this.missingCachePaths.clear();
		const files = [...this.app.vault.getMarkdownFiles()].sort((left, right) => left.path.localeCompare(right.path));
		for (let index = 0; index < files.length; index += 1) {
			this.readFile(files[index]);
			if ((index + 1) % 100 === 0) {
				await yieldToUi?.();
			}
		}
		this.building = false;
		for (const path of this.pendingPaths) {
			const file = this.app.vault.getAbstractFileByPath(path);
			if (file instanceof TFile && file.extension === "md") {
				this.readFile(file);
			} else {
				this.fileSnapshots.delete(path);
				this.missingCachePaths.delete(path);
			}
		}
		this.pendingPaths.clear();
		this.rebuildSnapshot();
		return this.snapshot;
	}

	private readFile(file: TFile): void {
		const cache = this.app.metadataCache.getFileCache(file);
		if (cache === null) {
			this.fileSnapshots.delete(file.path);
			this.missingCachePaths.add(file.path);
			return;
		}
		this.setFileSnapshot(file, cache);
	}

	private updateFile(file: TFile, cache: CachedMetadata): void {
		if (this.building) {
			this.pendingPaths.add(file.path);
			return;
		}
		this.setFileSnapshot(file, cache);
		this.rebuildSnapshot();
	}

	private refreshFile(file: TFile): void {
		if (this.building) {
			this.pendingPaths.add(file.path);
			return;
		}
		this.readFile(file);
		this.rebuildSnapshot();
	}

	private setFileSnapshot(file: TFile, cache: CachedMetadata): void {
		if (file.extension !== "md") {
			this.removePath(file.path);
			return;
		}
		const tags = [...new Set((getAllTags(cache) ?? [])
			.map(normalizeTagDisplay)
			.filter((tag) => tag.length > 0))];
		this.fileSnapshots.set(file.path, { mtime: file.stat.mtime, tags });
		this.missingCachePaths.delete(file.path);
	}

	private removePath(path: string): void {
		if (this.building) {
			this.pendingPaths.add(path);
			return;
		}
		const changed = this.fileSnapshots.delete(path) || this.missingCachePaths.delete(path);
		if (changed) {
			this.rebuildSnapshot();
		}
	}

	private handleRename(file: TAbstractFile, oldPath: string): void {
		if (file instanceof TFile) {
			this.removePath(oldPath);
			if (file.extension === "md") {
				this.refreshFile(file);
			}
			return;
		}
		if (!(file instanceof TFolder)) {
			return;
		}
		const oldPrefix = `${oldPath}/`;
		const newPrefix = `${file.path}/`;
		for (const [path, snapshot] of [...this.fileSnapshots.entries()]) {
			if (path.startsWith(oldPrefix)) {
				this.fileSnapshots.delete(path);
				this.fileSnapshots.set(`${newPrefix}${path.slice(oldPrefix.length)}`, snapshot);
			}
		}
		for (const path of [...this.missingCachePaths]) {
			if (path.startsWith(oldPrefix)) {
				this.missingCachePaths.delete(path);
				this.missingCachePaths.add(`${newPrefix}${path.slice(oldPrefix.length)}`);
			}
		}
		if (this.snapshot.status !== "idle") {
			this.rebuildSnapshot();
		}
	}

	private retryMissingCaches(): void {
		if (this.missingCachePaths.size === 0 || this.building) {
			return;
		}
		for (const path of [...this.missingCachePaths]) {
			const file = this.app.vault.getAbstractFileByPath(path);
			if (file instanceof TFile) {
				this.readFile(file);
			} else {
				this.missingCachePaths.delete(path);
			}
		}
		this.rebuildSnapshot();
	}

	private rebuildSnapshot(): void {
		if (this.snapshot.status === "idle") {
			return;
		}
		const sources: TagDisplaySource[] = [];
		const suggestionByKey = new Map<string, string>();
		let order = 0;
		for (const [, entry] of [...this.fileSnapshots.entries()].sort(([left], [right]) => left.localeCompare(right))) {
			for (const tag of entry.tags) {
				sources.push({ tag, modifiedTime: entry.mtime, order });
				const key = normalizeTagKey(tag);
				if (key.length > 0 && !suggestionByKey.has(key)) {
					suggestionByKey.set(key, tag);
				}
				order += 1;
			}
		}
		const displayByKey = buildTagDisplayMap(sources);
		const suggestions = [...suggestionByKey.keys()]
			.map((key) => displayByKey.get(key) ?? suggestionByKey.get(key) ?? key)
			.sort((left, right) => left.localeCompare(right, "zh"));
		this.snapshot = {
			revision: this.snapshot.revision + 1,
			status: this.missingCachePaths.size > 0 ? "partial" : "ready",
			displayByKey,
			suggestions,
		};
		this.notify();
	}

	private notify(): void {
		for (const listener of this.listeners) {
			listener();
		}
	}
}

function createEmptySnapshot(): VaultTagSnapshot {
	return {
		revision: 0,
		status: "idle",
		displayByKey: new Map(),
		suggestions: [],
	};
}
