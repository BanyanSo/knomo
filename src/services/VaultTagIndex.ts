import { Component, getAllTags, TAbstractFile, TFile, TFolder } from "obsidian";
import type { App, CachedMetadata } from "obsidian";
import { buildTagDisplayMapCooperatively, normalizeTagDisplay, normalizeTagKey } from "../utils/tags";
import type { TagDisplaySource } from "../utils/tags";
import { CooperativeYieldController, stableSortCooperatively, type CooperativeTaskRuntime } from "./CooperativeTask";
import { ObsidianExcludeService, type TagCandidatePolicy } from "./ObsidianExcludeService";

interface FileTagSnapshot {
	mtime: number;
	tags: readonly string[];
}

export interface VaultTagSnapshot {
	revision: number;
	status: "idle" | "building" | "ready" | "partial";
	displayByKey: ReadonlyMap<string, string>;
	suggestions: readonly string[];
	exclusionState: "current" | "degraded";
}

export class VaultTagIndex extends Component {
	private snapshot: VaultTagSnapshot = { revision: 0, status: "idle", displayByKey: new Map(), suggestions: [], exclusionState: "current" };
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
	private readonly exclusions: ObsidianExcludeService;
	private candidatePolicy: TagCandidatePolicy | null = null;
	private exclusionError: string | null = null;
	private exclusionVersion = 0;
	private readonly eligibility = new Map<string, { eligible: boolean; fingerprint: string }>();
	private readonly diagnostics = new Map<string, string>();
	private retryAt = 0;
	private retryDelay = 1000;
	private readonly suggestionSessions = new Set<() => void>();

	constructor(private readonly app: App) { super(); this.exclusions = new ObsidianExcludeService(app); }

	onload(): void {
		this.register(this.exclusions.subscribe(() => this.refreshExclusions()));
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

	private refreshExclusions(allowRetry = false): void {
		if (this.stopped) return;
		const retry = allowRetry && this.snapshot.exclusionState === "degraded" && Date.now() >= this.retryAt
			&& this.buildPromise === null && this.timer === null;
		try {
			const policy = this.exclusions.readTagCandidatePolicy();
			if (this.candidatePolicy?.fingerprint === policy.fingerprint && this.exclusionError === null && !retry) return;
			this.candidatePolicy = policy;
			this.exclusionError = null;
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			if (this.exclusionError === message && !retry) return;
			this.candidatePolicy = null;
			this.exclusionError = message;
			this.reportFailure("exclusions", error);
		}
		this.exclusionVersion++;
		this.markChanged("");
	}

	private reportFailure(kind: string, error: unknown): void {
		const message = error instanceof Error ? error.message : String(error);
		if (this.diagnostics.has(kind)) return;
		this.diagnostics.set(kind, message);
		console.error(`[Knomo] Tag index ${kind} unavailable; retaining usable tags`, error);
	}

	watchSuggestions(listener: () => void, doc: Document): () => void {
		if (this.stopped) return () => {};
		const win = doc.defaultView;
		let timer: number | null = null;
		let stopped = false;
		const unsubscribe = this.subscribe(listener);
		const check = () => {
			if (stopped) return;
			if (timer !== null) win?.clearTimeout(timer);
			timer = null;
			if (doc.hidden) return;
			this.refreshExclusions(true);
			// 仅候选会话存活且窗口可见时兜底比较规则，不扫描正文。
			timer = win?.setTimeout(check, 1000) ?? null;
		};
		const stop = () => {
			if (stopped) return;
			stopped = true;
			if (timer !== null) win?.clearTimeout(timer);
			unsubscribe();
			doc.removeEventListener("visibilitychange", check);
			win?.removeEventListener("focus", check);
			this.suggestionSessions.delete(stop);
		};
		this.suggestionSessions.add(stop);
		doc.addEventListener("visibilitychange", check);
		win?.addEventListener("focus", check);
		check();
		return stop;
	}

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
		this.refreshExclusions(true);
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
		for (const stop of this.suggestionSessions) stop();
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
		const exclusionVersion = this.exclusionVersion;
		const policy = this.candidatePolicy;
		let degraded = policy === null;
		const decisions = new Map<string, { entry: FileTagSnapshot; eligible: boolean; fingerprint: string }>();
		const partial = this.missingCachePaths.size > 0;
		const entries = await stableSortCooperatively([...this.fileSnapshots.entries()], ([left], [right]) => left.localeCompare(right), runtime);
		const sources: TagDisplaySource[] = [];
		const candidateSources: TagDisplaySource[] = [];
		const suggestionByKey = new Map<string, string>();
		let order = 0;
		for (const [path, entry] of entries) {
			let eligible = this.eligibility.get(path)?.eligible ?? true;
			try {
				if (policy !== null) {
					eligible = !policy.isIgnored(path);
					decisions.set(path, { entry, eligible, fingerprint: policy.fingerprint });
				}
			}
			catch (error) {
				degraded = true;
				this.reportFailure("exclusions", error);
			}
			for (const tag of entry.tags) {
				const source = { tag, modifiedTime: entry.mtime, order: order++ };
				sources.push(source);
				if (eligible) candidateSources.push(source);
				const key = normalizeTagKey(tag);
				if (eligible && key.length > 0 && !suggestionByKey.has(key)) suggestionByKey.set(key, tag);
				if (controller.shouldYield()) await controller.yieldNow();
			}
			if (controller.shouldYield()) await controller.yieldNow();
		}
		const displayByKey = await buildTagDisplayMapCooperatively(sources, runtime);
		const candidateDisplayByKey = candidateSources.length === sources.length ? displayByKey
			: await buildTagDisplayMapCooperatively(candidateSources, runtime);
		const candidates: string[] = [];
		for (const [key, tag] of suggestionByKey) {
			candidates.push(candidateDisplayByKey.get(key) ?? tag);
			if (controller.shouldYield()) await controller.yieldNow();
		}
		let suggestions: readonly string[] = await stableSortCooperatively(candidates, (left, right) => left.localeCompare(right, "zh"), runtime);
		this.checkActive();
		this.refreshExclusions();
		// 规则变化使整批资格失效，旧结果不得发布或唤醒候选等待者。
		if (exclusionVersion !== this.exclusionVersion) return;
		// 只提交仍属于本批文件的判定，删除、改名或替换不能被迟到任务复活。
		for (const [path, decision] of decisions) {
			if (this.fileSnapshots.get(path) === decision.entry) this.eligibility.set(path, { eligible: decision.eligible, fingerprint: decision.fingerprint });
		}
		if (degraded) {
			this.retryAt = Date.now() + this.retryDelay;
			this.retryDelay = Math.min(30000, this.retryDelay * 2);
		} else {
			this.retryAt = 0;
			this.retryDelay = 1000;
			this.diagnostics.delete("exclusions");
		}
		if (!partial) this.diagnostics.delete("metadata");
		if (suggestions.length === this.snapshot.suggestions.length
			&& suggestions.every((tag, index) => tag === this.snapshot.suggestions[index])) suggestions = this.snapshot.suggestions;
		this.publishedGeneration = generation;
		this.snapshot = {
			revision: this.snapshot.revision + 1,
			status: generation < this.generation ? "building" : partial ? "partial" : "ready",
			displayByKey, suggestions, exclusionState: degraded ? "degraded" : "current",
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
		let cache: CachedMetadata | null;
		try { cache = this.app.metadataCache.getFileCache(file); }
		catch (error) { this.reportFailure("metadata", error); this.markMissing(file.path, event); return; }
		if (cache !== null) this.setFileSnapshot(file, cache, event);
		else this.markMissing(file.path, event);
	}

	private markMissing(path: string, event: boolean): void {
		const missing = this.missingCachePaths.has(path);
		this.missingCachePaths.add(path);
		if (event && !missing) this.markChanged(path);
	}

	private setFileSnapshot(file: TFile, cache: CachedMetadata, event = false): void {
		if (file.extension !== "md") { this.removePath(file.path); return; }
		let tags: string[];
		try { tags = [...new Set((getAllTags(cache) ?? []).map(normalizeTagDisplay).filter(tag => tag.length > 0))]; }
		catch (error) { this.reportFailure("metadata", error); this.markMissing(file.path, event); return; }
		const recovered = this.missingCachePaths.delete(file.path);
		const previous = this.fileSnapshots.get(file.path);
		if (previous?.mtime === file.stat.mtime && previous.tags.length === tags.length
			&& previous.tags.every((tag, index) => tag === tags[index])) {
			if (event && recovered) this.markChanged(file.path);
			return;
		}
		this.fileSnapshots.set(file.path, { mtime: file.stat.mtime, tags });
		if (event) this.markChanged(file.path);
	}

	private removePath(path: string): void {
		if (this.stopped) return;
		const removed = this.fileSnapshots.delete(path);
		const missing = this.missingCachePaths.delete(path);
		this.eligibility.delete(path);
		if (removed || missing || !this.scanned) this.markChanged(path);
	}

	private handleRename(file: TAbstractFile, oldPath: string): void {
		if (this.stopped) return;
		if (file instanceof TFile) {
			const previous = this.fileSnapshots.get(oldPath);
			this.removePath(oldPath);
			if (file.extension === "md") {
				if (previous) this.fileSnapshots.set(file.path, previous);
				this.markChanged(file.path);
				this.readFile(file, true);
			}
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
			this.missingCachePaths.add(nextPath);
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
					this.readFile(child, true);
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
