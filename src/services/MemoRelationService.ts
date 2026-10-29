import type { CatalogFileRecord, ObservationHandle } from "../types/catalog";
import type { MemoRelationNode, MemoRelationSnapshot } from "../types/memoRelations";
import type { MemoCatalogService } from "./MemoCatalogService";
import type { CatalogChangeCursor } from "./CatalogFileChanges";
import { observationHandleKey } from "./DailyMemoPresentationChange";

export interface MemoRelationOptions {
	resolvePath?: (path: string, sourcePath: string) => { path: string | null; pending?: boolean };
	isFileCurrent?: (file: CatalogFileRecord) => boolean;
	getFailedFileCount?: () => number;
	requestScan?: () => void | Promise<void>;
	canRequestScan?: () => boolean;
	getReadBlocker?: () => boolean;
}

export class MemoRelationsChangedError extends Error {
	constructor() { super("Memo relations changed; refresh and select the record again."); }
}

export class MemoRelationSubjectUnavailableError extends Error {
	constructor() { super("The selected Memo occurrence is no longer available."); }
}

export interface MemoRelationChange {
	paths: ReadonlySet<string>;
	names: ReadonlySet<string>;
}

export function relationChangeAffects(change: MemoRelationChange | null, handle: ObservationHandle): boolean {
	return change === null || change.paths.has(handle.sourcePath) || change.names.has(linkBasename(handle.sourcePath));
}

interface ResolvedSource {
	node: MemoRelationNode;
	targets: readonly MemoRelationNode[];
	names: Set<string>;
	complete: boolean;
	errors: string[];
}

// 单个 runtime 的可重建元数据索引。正文仍由 CatalogReadService 按窗口读取。
export class MemoRelationService {
	private version = 0;
	private cursor: CatalogChangeCursor | undefined;
	private files = new Map<string, CatalogFileRecord>();
	private fileStates = new Map<string, boolean>();
	private snapshot: MemoRelationSnapshot | null = null;
	private task: Promise<MemoRelationSnapshot> | null = null;
	private controller: AbortController | null = null;
	private readonly listeners = new Set<(change: MemoRelationChange | null) => void>();
	private readonly unsubscribe: () => void;
	private disposed = false;
	private anchors = new Map<string, MemoRelationNode>();
	private dependencies = new Map<string, ReadonlySet<string>>();
	private pendingSources = new Set<string>();
	private scanFailures = 0;
	private resolved = new Map<string, ResolvedSource>();
	private indexedSnapshot: MemoRelationSnapshot | null = null;
	private dirtyNames: Set<string> | null = null;
	private readonly recoveryKeys = new Map<string, string>();
	private scanRecovery: Promise<void> | null = null;
	private readers = 0;
	private diagnosticKey: string | null = null;
	private inputBlocked = false;

	constructor(private readonly catalog: MemoCatalogService, private readonly options: MemoRelationOptions = {}) {
		this.unsubscribe = catalog.onChange((path, file) => this.invalidate(path === undefined ? undefined : [path], file));
	}

	subscribe(listener: (change: MemoRelationChange | null) => void): () => void {
		this.listeners.add(listener);
		return () => { this.listeners.delete(listener); this.cancelUnusedBuild(); };
	}

	invalidate(paths?: readonly string[], file?: CatalogFileRecord): void {
		this.invalidateState(paths, file);
	}

	private invalidateState(paths?: readonly string[], file?: CatalogFileRecord, keepTask = false): void {
		const names = new Set(paths?.map(linkBasename));
		const affectedPaths = new Set(paths);
		const targetNames = new Set(names);
		if (paths === undefined) this.dirtyNames = null;
		else {
			for (const name of names) this.dirtyNames?.add(name);
			const affected = new Set<string>();
			for (const path of paths) for (const node of this.files.get(path)?.relations?.nodes ?? []) affected.add(observationHandleKey(node.handle));
			for (const name of names) for (const key of this.dependencies.get(name) ?? []) affected.add(key);
			for (const key of affected) {
				const entry = this.resolved.get(key);
				if (!entry) continue;
				affectedPaths.add(entry.node.handle.sourcePath);
				for (const target of entry.targets) affectedPaths.add(target.handle.sourcePath);
			}
			// 新增或改链后的目标尚未进入旧索引，按目标名称保守通知可能受影响的卡片。
			for (const node of file?.relations?.nodes ?? []) for (const target of node.targets) {
				if (target.path) targetNames.add(linkBasename(target.path));
			}
		}
		this.version++;
		this.snapshot = null;
		if (!keepTask) { this.controller?.abort(); this.task = null; }
		const change = paths === undefined || !this.indexedSnapshot?.complete ? null : { paths: affectedPaths, names: targetNames };
		for (const listener of this.listeners) listener(change);
	}

	invalidateResolution(paths?: readonly string[]): void {
		if (paths && this.indexedSnapshot && paths.every(path => !this.files.has(path) && !this.dependencies.has(linkBasename(path)))) return;
		this.invalidate(paths);
	}

	async refreshState(): Promise<void> {
		if (this.disposed || !this.indexedSnapshot) return;
		try {
			const coverage = await this.catalog.getStore().getCoverage();
			if (this.disposed) return;
			if (JSON.stringify(coverage) !== JSON.stringify(this.indexedSnapshot.coverage) || this.failedFileCount() !== this.scanFailures
				|| this.inputBlocked !== this.readBlocked()) this.invalidate();
		} catch (error) {
			if (this.disposed) return;
			console.error("Knomo relation state refresh failed", error);
			this.invalidate();
		}
	}

	retryPendingResolution(): void {
		if (!this.indexedSnapshot?.complete || this.indexedSnapshot.errors.length) this.invalidate();
	}

	beginReading(): void {
		if (this.disposed || this.task || this.scanRecovery) return;
		if (this.snapshot?.errors.length || !this.snapshot && this.recoveryKeys.size) {
			this.recoveryKeys.clear(); this.diagnosticKey = null; this.invalidate();
		}
	}

	dispose(): void {
		this.disposed = true;
		this.invalidate();
		this.unsubscribe();
		this.listeners.clear();
		this.files.clear();
		this.fileStates.clear();
		this.anchors.clear(); this.dependencies.clear(); this.pendingSources.clear();
		this.resolved.clear();
		this.indexedSnapshot = null;
	}

	async read(signal?: AbortSignal, handles?: readonly ObservationHandle[]): Promise<MemoRelationSnapshot> {
		this.readers++;
		try {
			// 正常取消只合并一次最新读取并让出执行权，持续变化交回消费者的尾随刷新。
			try { return await this.readCurrent(signal); }
			catch (error) {
				if (!handles || !(error instanceof MemoRelationsChangedError) || signal?.aborted || this.disposed) throw error;
				await pause();
				return await this.readCurrent(signal);
			}
		} finally { this.readers--; this.cancelUnusedBuild(); }
	}

	private cancelUnusedBuild(): void {
		if (this.readers) return;
		this.controller?.abort();
		this.task = null;
	}

	private async readCurrent(signal?: AbortSignal): Promise<MemoRelationSnapshot> {
		signal?.throwIfAborted();
		if (this.disposed) throw new MemoRelationsChangedError();
		if (!this.task) {
			const controller = new AbortController();
			this.controller = controller;
			const task = this.buildWithRecovery(controller.signal);
			this.task = task;
			void task.finally(() => { if (this.task === task) this.task = null; }).catch(() => undefined);
		}
		const task = this.task;
		const controller = this.controller;
		let result: MemoRelationSnapshot;
		try { result = await consume(task, signal); }
		catch (error) {
			if (!signal?.aborted && controller?.signal.aborted) throw new MemoRelationsChangedError();
			throw error;
		}
		signal?.throwIfAborted();
		if (result.errors.length && !result.recovering) {
			const key = JSON.stringify([result.errors, [...this.recoveryKeys]]);
			if (key !== this.diagnosticKey) { this.diagnosticKey = key; console.warn("Knomo relation read failed", result.errors); }
		}
		return result;
	}

	async assertCurrent(snapshot: MemoRelationSnapshot, signal?: AbortSignal, handles?: readonly ObservationHandle[]): Promise<void> {
		signal?.throwIfAborted();
		// 提交前的 coverage/配置探测也走共享读取与恢复预算，不能遗漏末次校验中的临时 I/O 故障。
		const current = await this.read(signal, handles);
		if (this.disposed || current.version !== this.version || !handles && snapshot.version !== current.version
			|| snapshot.complete !== current.complete || JSON.stringify(snapshot.errors) !== JSON.stringify(current.errors)
			|| JSON.stringify(snapshot.coverage) !== JSON.stringify(current.coverage)
			|| handles?.some(handle => relationSlice(snapshot, handle) !== relationSlice(current, handle))) throw new MemoRelationsChangedError();
		signal?.throwIfAborted();
	}

	async verifyHandle(handle: ObservationHandle, signal?: AbortSignal): Promise<void> {
		signal?.throwIfAborted();
		const file = await this.catalog.getStore().getFile(handle.sourcePath);
		if (!file || file.sourceRevision !== handle.sourceRevision || !this.fileCurrent(file)) throw new MemoRelationSubjectUnavailableError();
		signal?.throwIfAborted();
	}

	private fileCurrent(file: CatalogFileRecord): boolean { return this.options.isFileCurrent?.(file) ?? true; }
	private failedFileCount(): number { return this.options.getFailedFileCount?.() ?? 0; }
	private readBlocked(): boolean { return this.catalog.getStore().getLifecycle().state !== "ready" || this.options.getReadBlocker?.() === true; }
	private sameFileStates(): boolean { return [...this.files.values()].every(file => this.fileCurrent(file) === this.fileStates.get(file.sourcePath)); }

	private async buildWithRecovery(signal: AbortSignal): Promise<MemoRelationSnapshot> {
		let result: MemoRelationSnapshot;
		try { result = await this.loadSnapshot(signal); }
		catch (error) {
			signal.throwIfAborted();
			if (error instanceof MemoRelationsChangedError) throw error;
			const cursor = await this.catalog.readFileChangesSince().catch(() => null);
			const key = JSON.stringify(["read", cursor?.cursor ?? this.cursor]);
			if (!this.claimRecovery(key)) throw error;
			await pause(); signal.throwIfAborted();
			return this.loadSnapshot(signal);
		}
		const needsScan = this.scanFailures > 0 || result.coverage.kind !== "complete" || [...this.fileStates.values()].some(current => !current);
		this.inputBlocked = this.readBlocked();
		if (this.inputBlocked) {
			return this.indexedSnapshot = this.snapshot = { ...result, recovering: undefined, complete: false, errors: [...new Set([...result.errors, "Daily relation input unavailable"])] };
		}
		if (needsScan && this.options.requestScan && this.catalog.getStore().getLifecycle().state === "ready" && this.options.canRequestScan?.() !== false) {
			const key = JSON.stringify(["scan", result.coverage, this.scanFailures,
				[...this.files.values()].map(file => [file.sourcePath, file.sourceRevision, this.fileStates.get(file.sourcePath)])]);
			if (!this.scanRecovery && this.claimRecovery(key)) {
				// 不等待低优先级队列内再次入队的扫描，避免统计等调用与扫描互相等待。
				const recovery = Promise.resolve().then(() => {
					if (!this.disposed && this.readers) return this.options.requestScan!();
				}).catch(error => { if (!this.disposed) console.error("Knomo relation scan recovery failed", error); }).finally(() => {
					if (this.scanRecovery === recovery) this.scanRecovery = null;
					if (!this.disposed) this.invalidate();
				});
				this.scanRecovery = recovery;
			}
			if (this.scanRecovery) return this.snapshot = { ...result, recovering: true };
			// 已经补扫且没有继续推进的生产者时说明真实不可用，不能永久保留加载占位。
			return this.indexedSnapshot = this.snapshot = { ...result, recovering: undefined, complete: false, errors: [...new Set([...result.errors, "Daily relation scan did not settle"])] };
		}
		if (!result.errors.length) return result;
		const filesByName = new Map<string, CatalogFileRecord[]>();
		for (const file of this.files.values()) {
			const name = linkBasename(file.sourcePath), files = filesByName.get(name) ?? [];
			files.push(file); filesByName.set(name, files);
		}
		const failed = [...this.resolved.values()].filter(entry => entry.errors.length).map(entry => [
			observationHandleKey(entry.node.handle), entry.node.targets,
			[...entry.names].map(name => (filesByName.get(name) ?? [])
				.map(file => [file.sourcePath, file.sourceRevision, this.fileStates.get(file.sourcePath)])),
		]);
		// 预算依赖真实失败范围的输入，内部版本变化、重复通知和组件重绘不会重置它。
		if (!failed.length || !this.claimRecovery(JSON.stringify(["resolution", failed]))) return result;
		await pause(); signal.throwIfAborted();
		return this.build(signal);
	}

	private claimRecovery(key: string): boolean {
		const scope = (JSON.parse(key) as string[])[0];
		if (this.recoveryKeys.get(scope) === key) return false;
		this.recoveryKeys.set(scope, key);
		return true;
	}

	get revision(): number { return this.version; }

	private async loadSnapshot(signal: AbortSignal): Promise<MemoRelationSnapshot> {
		const changes = await this.catalog.readFileChangesSince(this.cursor);
		signal.throwIfAborted();
		if (changes.invalidated) throw new MemoRelationsChangedError();
		const snapshot = this.snapshot;
		if (snapshot && changes.sourcePaths?.length === 0) {
			const coverage = await this.catalog.getStore().getCoverage();
			signal.throwIfAborted();
			if (this.snapshot !== snapshot) throw new MemoRelationsChangedError();
			if (this.inputBlocked === this.readBlocked() && JSON.stringify(coverage) === JSON.stringify(snapshot.coverage)
				&& this.sameFileStates() && this.failedFileCount() === this.scanFailures) return snapshot;
			this.invalidateState(undefined, undefined, true);
		}
		return this.build(signal);
	}

	private async build(signal: AbortSignal): Promise<MemoRelationSnapshot> {
		const version = this.version;
		const changes = await this.catalog.readFileChangesSince(this.cursor);
		const dirtyNames = this.dirtyNames === null || changes.sourcePaths === null ? null
			: new Set([...this.dirtyNames, ...changes.sourcePaths.map(linkBasename)]);
		const files = changes.sourcePaths === null ? new Map((await this.catalog.listFiles()).map(file => [file.sourcePath, file])) : new Map(this.files);
		if (changes.sourcePaths !== null) for (let offset = 0; offset < changes.sourcePaths.length; offset += 32) {
			signal.throwIfAborted();
			const batch = await Promise.all(changes.sourcePaths.slice(offset, offset + 32).map(path => this.catalog.getStore().getFile(path)));
			for (let index = 0; index < batch.length; index++) {
				const path = changes.sourcePaths[offset + index], file = batch[index];
				if (file) files.set(path, file); else files.delete(path);
			}
			await pause();
		}
		const coverage = await this.catalog.getStore().getCoverage();
		let complete = coverage.kind === "complete" && coverage.configurationComplete !== false;
		const errors = new Set<string>();
		const scanFailures = this.failedFileCount();
		if (scanFailures) { complete = false; errors.add("Daily scan failed"); }
		const nodes = new Map(this.indexedSnapshot?.nodes);
		const anchors = new Map(this.anchors);
		const usableFiles = new Map<string, CatalogFileRecord>();
		const states = new Map<string, boolean>();
		const changed = new Set<string>();
		const removeFile = (file: CatalogFileRecord): void => {
			for (const node of file.relations?.nodes ?? []) {
				const key = observationHandleKey(node.handle);
				nodes.delete(key); changed.add(key);
				if (node.blockId) anchors.delete(file.sourcePath + "\0" + node.blockId);
			}
		};
		for (const [path, file] of this.files) if (!files.has(path)) removeFile(file);
		for (const file of files.values()) {
			signal.throwIfAborted();
			const current = this.fileCurrent(file); states.set(file.sourcePath, current);
			if (current !== this.fileStates.get(file.sourcePath)) dirtyNames?.add(linkBasename(file.sourcePath));
			const previous = this.files.get(file.sourcePath);
			const retained = previous === file && current === this.fileStates.get(file.sourcePath);
			if (!retained && previous) removeFile(previous);
			if (!current || !file.relations) { complete = false; continue; }
			usableFiles.set(file.sourcePath, file);
			// 未变化分区直接沿用节点与锚点，不枚举其中每个 occurrence。
			if (retained) continue;
			for (const node of file.relations.nodes) {
				const key = observationHandleKey(node.handle);
				nodes.set(key, node); changed.add(key);
				if (node.blockId && file.relations.anchors[node.blockId] === 1) anchors.set(file.sourcePath + "\0" + node.blockId, node);
			}
		}
		const candidates = new Set(changed);
		if (dirtyNames === null) for (const key of nodes.keys()) candidates.add(key);
		else {
			for (const name of dirtyNames) for (const key of this.dependencies.get(name) ?? []) candidates.add(key);
			// 来源自身的 metadata 会影响解析可用性，正文未变也必须重验其上下文。
			for (const file of usableFiles.values()) if (dirtyNames.has(linkBasename(file.sourcePath))) {
				for (const node of file.relations!.nodes) candidates.add(observationHandleKey(node.handle));
			}
		}
		for (const key of this.pendingSources) candidates.add(key);
		const resolvedSources = new Map(this.resolved);
		const pendingSources = new Set(this.pendingSources);
		let operations = 0;
		for (const key of candidates) {
			const node = nodes.get(key);
			if (!node) { resolvedSources.delete(key); pendingSources.delete(key); continue; }
			if (++operations % 256 === 0) { signal.throwIfAborted(); await pause(); }
			const targets = new Map<string, MemoRelationNode>();
			const entry: ResolvedSource = { node, targets: [], names: new Set(), complete: true, errors: [] };
			for (const target of node.targets) {
				signal.throwIfAborted();
				if (++operations % 256 === 0) await pause();
				if (target.path) entry.names.add(linkBasename(target.path));
				try {
					const resolved: { path: string | null; pending?: boolean } = target.path === "" ? { path: node.handle.sourcePath }
						: this.options.resolvePath?.(target.path, node.handle.sourcePath) ?? resolveLocalPath(target.path, node.handle.sourcePath, files);
					if (resolved.pending) { entry.complete = false; continue; }
					if (resolved.path === null) continue;
					entry.names.add(linkBasename(resolved.path));
					if (files.has(resolved.path) && !usableFiles.has(resolved.path)) { entry.complete = false; continue; }
					const destination = anchors.get(resolved.path + "\0" + target.blockId);
					if (!destination || observationHandleKey(destination.handle) === key) continue;
					targets.set(observationHandleKey(destination.handle), destination);
				} catch (error) {
					entry.complete = false;
					entry.errors.push(error instanceof Error ? error.message : String(error));
				}
			}
			entry.targets = [...targets.values()];
			resolvedSources.set(key, entry);
			if (entry.complete) pendingSources.delete(key); else pendingSources.add(key);
		}
		for (const key of pendingSources) {
			complete = false;
			for (const error of resolvedSources.get(key)!.errors) errors.add(error);
		}
		// 只替换变化来源的边；未受影响的列表保留数组和排序，不逐边反复复制大列表。
		const sources = new Map(this.indexedSnapshot?.sources);
		const referrers = new Map(this.indexedSnapshot?.referrers);
		const removed = new Set<string>(), touched = new Set<string>();
		const added = new Map<string, MemoRelationNode[]>();
		// 依赖名称反向索引按本批变化复制集合，避免更新一个文件时扫描全部来源。
		const dependencies = new Map(this.dependencies);
		const editedNames = new Map<string, Set<string>>();
		const editName = (name: string): Set<string> => {
			let keys = editedNames.get(name);
			if (!keys) { keys = new Set(dependencies.get(name)); editedNames.set(name, keys); dependencies.set(name, keys); }
			return keys;
		};
		for (const key of candidates) {
			const before = this.resolved.get(key), after = resolvedSources.get(key);
			if (before === after) continue;
			if (before) {
				removed.add(key); sources.delete(key);
				for (const target of before.targets) touched.add(observationHandleKey(target.handle));
				for (const name of before.names) if (!after?.names.has(name)) editName(name).delete(key);
			}
			if (after) {
				sources.set(key, after.targets);
				for (const name of after.names) if (!before?.names.has(name)) editName(name).add(key);
				for (const target of after.targets) {
					const targetKey = observationHandleKey(target.handle);
					const incoming = added.get(targetKey) ?? [];
					incoming.push(after.node); added.set(targetKey, incoming); touched.add(targetKey);
				}
			}
		}
		for (const [name, keys] of editedNames) if (!keys.size) dependencies.delete(name);
		for (const key of touched) {
			const incoming = [...(referrers.get(key) ?? []).filter(node => !removed.has(observationHandleKey(node.handle))), ...(added.get(key) ?? [])];
			incoming.sort((a, b) => `${b.logicalDate}T${b.time.padEnd(8, ":00")}`.localeCompare(`${a.logicalDate}T${a.time.padEnd(8, ":00")}`)
				|| observationHandleKey(a.handle).localeCompare(observationHandleKey(b.handle)));
			if (incoming.length) referrers.set(key, incoming); else referrers.delete(key);
		}
		signal.throwIfAborted();
		const after = await this.catalog.readFileChangesSince(changes.cursor);
		if (version !== this.version || after.invalidated || after.sourcePaths === null || after.sourcePaths.length) throw new MemoRelationsChangedError();
		if (JSON.stringify(await this.catalog.getStore().getCoverage()) !== JSON.stringify(coverage)) throw new MemoRelationsChangedError();
		if ([...files.values()].some(file => this.fileCurrent(file) !== states.get(file.sourcePath))) throw new MemoRelationsChangedError();
		if (this.failedFileCount() !== scanFailures) throw new MemoRelationsChangedError();
		// 末次异步校验也可能跨过失效或销毁；发布所有内部状态前再次确认当前构建。
		signal.throwIfAborted();
		if (this.disposed || version !== this.version) throw new MemoRelationsChangedError();
		this.files = files;
		this.fileStates = states;
		this.anchors = anchors;
		this.dependencies = dependencies;
		this.pendingSources = pendingSources;
		this.scanFailures = scanFailures;
		this.cursor = after.cursor;
		this.resolved = resolvedSources;
		this.dirtyNames = new Set();
		return this.indexedSnapshot = this.snapshot = { version, coverage, complete, errors: [...errors], nodes, sources, referrers };
	}
}

function pause(): Promise<void> { return new Promise(resolve => window.setTimeout(resolve, 0)); }

function consume<T>(task: Promise<T>, signal?: AbortSignal): Promise<T> {
	if (!signal) return task;
	signal.throwIfAborted();
	return new Promise((resolve, reject) => {
		const abort = () => {
			const reason: unknown = signal.reason;
			if (reason instanceof Error) reject(reason);
			else { const error = new Error("Memo relations reading cancelled."); error.name = "AbortError"; reject(error); }
		};
		signal.addEventListener("abort", abort, { once: true });
		void task.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
	});
}

function relationSlice(snapshot: MemoRelationSnapshot, handle: ObservationHandle): string {
	const key = observationHandleKey(handle);
	return JSON.stringify([snapshot.nodes.has(key), (snapshot.sources.get(key) ?? []).map(node => observationHandleKey(node.handle)),
		(snapshot.referrers.get(key) ?? []).map(node => observationHandleKey(node.handle))]);
}

function linkBasename(path: string): string { return path.replace(/\\/gu, "/").split("/").pop()!.replace(/\.md$/iu, "").toLocaleLowerCase(); }

function resolveLocalPath(path: string, sourcePath: string, files: ReadonlyMap<string, CatalogFileRecord>): { path: string | null } {
	const segments = (sourcePath.slice(0, sourcePath.lastIndexOf("/") + 1) + path).split("/");
	const normalized: string[] = [];
	for (const part of segments) { if (part === "..") normalized.pop(); else if (part !== ".") normalized.push(part); }
	const extension = (value: string) => value.endsWith(".md") ? value : value + ".md";
	if (path.startsWith(".")) return { path: files.has(extension(normalized.join("/"))) ? extension(normalized.join("/")) : null };
	if (files.has(extension(path))) return { path: extension(path) };
	const matches = [...files.keys()].filter(file => file.endsWith("/" + extension(path)) || file === extension(path));
	return { path: matches.length === 1 ? matches[0] : null };
}
