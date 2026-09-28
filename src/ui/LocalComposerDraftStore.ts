import type { App } from "obsidian";
import type { MemoViewItem } from "../types/memoView";
import type { ComposerDraftSnapshot } from "./ComposerDraft";

const STORAGE_KEY = "knomo.composerDrafts";
type Storage = Pick<App, "loadLocalStorage" | "saveLocalStorage">;
const claims = new WeakMap<Storage, Set<string>>();
const stores = new WeakMap<Storage, Set<LocalComposerDraftStore>>();

export function disposeLocalComposerDraftStores(storage: Storage): void {
	for (const store of stores.get(storage) ?? []) store.dispose();
}

export interface LocalComposerDraft {
	active: ComposerDraftSnapshot;
	editingMemo: MemoViewItem | null;
	suspendedCreate: ComposerDraftSnapshot | null;
}

interface Submission {
	id: string;
	revision: number;
	draft: LocalComposerDraft;
}

interface Entry {
	id: string;
	revision: number;
	draft: LocalComposerDraft;
	pending: Submission | null;
}

export function emptyComposerDraft(): LocalComposerDraft {
	return { active: { content: "", referenceText: null, markdownText: null, anchor: 0, head: 0, scrollTop: 0, imageLinks: [] },
		editingMemo: null, suspendedCreate: null };
}

// App 的存储 API 已按 Vault 隔离；实例独占认领，关闭后按保存顺序恢复未被认领的草稿。
// 每次写入先读取最新集合，只替换自己的条目，不能用视图启动时的集合覆盖其他视图。
export class LocalComposerDraftStore {
	private entry: Entry;
	private closed = false;
	private disposed = false;
	private persistedEntry: string;
	private inFlight = false;
	private reportedFailure = false;
	private readonly claimed: Set<string>;

	constructor(private readonly storage: Storage, private readonly onError: () => void) {
		this.claimed = claims.get(storage) ?? new Set<string>();
		claims.set(storage, this.claimed);
		let restored: Entry | undefined;
		try { restored = this.read().find(item => !this.claimed.has(item.id)); }
		catch { this.reportError(); }
		this.entry = restored ?? { id: newDraftId(), revision: 0, draft: emptyComposerDraft(), pending: null };
		this.persistedEntry = JSON.stringify(restored ?? null);
		this.claimed.add(this.entry.id);
		const active = stores.get(storage) ?? new Set<LocalComposerDraftStore>();
		active.add(this);
		stores.set(storage, active);
	}

	get draft(): LocalComposerDraft { return clone(this.entry.draft); }
	get pending(): LocalComposerDraft | null { return this.entry.pending ? clone(this.entry.pending.draft) : null; }

	changed(): void { if (!this.closed) this.entry.revision++; }

	update(draft: LocalComposerDraft): void {
		if (this.closed) return;
		if (JSON.stringify(draft) !== JSON.stringify(this.entry.draft)) {
			this.entry.draft = clone(draft);
			this.entry.revision++;
		}
		this.persist();
	}

	beginSubmission(): string {
		const id = newDraftId();
		this.inFlight = true;
		this.entry.pending = { id, revision: this.entry.revision, draft: clone(this.entry.draft) };
		this.persist();
		return id;
	}

	// 只清理提交时的版本；即使正文后来改回同文，也不能清理新输入。
	committed(id: string, clearCurrent: boolean): void {
		if (this.disposed) return;
		const pending = this.entry.pending;
		if (!pending || pending.id !== id) return;
		if (clearCurrent && pending.revision === this.entry.revision) {
			const suspended = this.entry.draft.suspendedCreate;
			this.entry.draft = { ...emptyComposerDraft(), active: suspended ?? emptyComposerDraft().active };
			this.entry.revision++;
		}
		this.entry.pending = null;
		this.persist();
	}

	acknowledgePending(): void { if (!this.disposed) { this.entry.pending = null; this.persist(); } }

	finishSubmission(): void {
		if (!this.inFlight) return;
		this.inFlight = false;
		if (this.closed) this.release();
	}

	close(): void {
		if (this.closed) return;
		this.closed = true;
		// 未决写入仍持有认领，避免新视图恢复后又被旧保存回调清理。
		if (!this.inFlight) this.release();
	}

	// 插件卸载不同于关闭视图：旧异步回调不得再写设备草稿。
	dispose(): void {
		this.disposed = true;
		this.closed = true;
		this.release();
	}

	private release(): void {
		if (stores.get(this.storage)?.delete(this)) this.claimed.delete(this.entry.id);
	}

	private read(): Entry[] {
		if (!this.storage.loadLocalStorage || !this.storage.saveLocalStorage) throw new Error("Local storage unavailable");
		const data: unknown = this.storage.loadLocalStorage(STORAGE_KEY);
		if (data == null) return [];
		if (!isObject(data) || data.schema !== 1 || !Array.isArray(data.entries)
			|| !data.entries.every(validEntry)
			|| new Set(data.entries.map(item => item.id)).size !== data.entries.length) throw new Error("Invalid draft storage");
		return clone(data.entries);
	}

	private persist(): void {
		if (this.disposed) return;
		try {
			const latest = this.read();
			// 比较实际持久化基线，不能用旧实例的内存版本覆盖重载后的新版本。
			if (JSON.stringify(latest.find(item => item.id === this.entry.id) ?? null) !== this.persistedEntry) {
				this.dispose();
				this.reportError();
				return;
			}
			const entries = latest.filter(item => item.id !== this.entry.id);
			const draft = this.entry.draft;
			if (draft.active.content.length || draft.active.referenceText !== null || draft.editingMemo || draft.suspendedCreate || this.entry.pending) {
				entries.push(clone(this.entry));
			}
			this.storage.saveLocalStorage(STORAGE_KEY, { schema: 1, entries });
			// 某些宿主会静默忽略写入，读回失败也必须提示。
			if (JSON.stringify(this.read()) !== JSON.stringify(entries)) throw new Error("Draft write was not retained");
			this.persistedEntry = JSON.stringify(entries.find(item => item.id === this.entry.id) ?? null);
			this.reportedFailure = false;
		} catch { this.reportError(); }
	}

	private reportError(): void {
		if (!this.reportedFailure) { this.reportedFailure = true; this.onError(); }
	}
}

function clone<T>(value: T): T { return JSON.parse(JSON.stringify(value)) as T; }
function newDraftId(): string {
	const bytes = crypto.getRandomValues(new Uint8Array(16));
	return Array.from(bytes, value => value.toString(16).padStart(2, "0")).join("");
}
function isObject(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null; }
function textOrNull(value: unknown): boolean { return value === null || typeof value === "string"; }
function nonnegative(value: unknown): value is number { return typeof value === "number" && Number.isSafeInteger(value) && value >= 0; }

function validSnapshot(value: unknown): value is ComposerDraftSnapshot {
	if (!isObject(value) || typeof value.content !== "string" || !textOrNull(value.referenceText) || !textOrNull(value.markdownText)
		|| !nonnegative(value.anchor) || !nonnegative(value.head) || value.anchor > value.content.length || value.head > value.content.length
		|| typeof value.scrollTop !== "number" || !Number.isFinite(value.scrollTop) || value.scrollTop < 0) return false;
	return value.imageLinks === undefined || (Array.isArray(value.imageLinks) && value.imageLinks.every(link =>
		isObject(link) && nonnegative(link.from) && nonnegative(link.to) && link.from <= link.to && link.to <= (value.content as string).length
		&& typeof link.link === "string" && typeof link.path === "string" && typeof link.sourcePath === "string"
		&& (value.content as string).slice(link.from, link.to) === link.link));
}

function validDraft(value: unknown): value is LocalComposerDraft {
	if (!isObject(value) || !validSnapshot(value.active) || !(value.suspendedCreate === null || validSnapshot(value.suspendedCreate))) return false;
	if (value.editingMemo === null) return true;
	const memo = value.editingMemo;
	if (!isObject(memo) || typeof memo.id !== "string" || typeof memo.contentSnapshot !== "string"
		|| !isObject(memo.dailyRef) || !isObject(memo.catalog) || !isObject(memo.catalog.observationHandle)) return false;
	const handle = memo.catalog.observationHandle;
	return typeof handle.sourcePath === "string" && memo.dailyRef.path === handle.sourcePath
		&& typeof handle.sourceRevision === "string" && typeof handle.rawBlockHash === "string"
		&& nonnegative(handle.startLine) && nonnegative(handle.endLine) && handle.endLine >= handle.startLine;
}

function validEntry(value: unknown): value is Entry {
	return isObject(value) && typeof value.id === "string" && nonnegative(value.revision) && validDraft(value.draft)
		&& (value.pending === null || (isObject(value.pending) && typeof value.pending.id === "string"
			&& nonnegative(value.pending.revision) && validDraft(value.pending.draft)));
}
