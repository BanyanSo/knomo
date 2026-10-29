import type { CatalogCapabilities, CatalogQueryFilter, ObservationHandle } from "../types/catalog";
import type { MemoViewItem } from "../types/memoView";
import { toCatalogMemoView } from "../types/memoView";
import { toCatalogMemoItem } from "../services/CatalogReadService";
import { buildCatalogObservation } from "../services/MemoCatalogService";
import { createResolvedMemoCapabilities } from "../services/MemoCapabilityModel";
import { compareCatalogObservations, createCatalogQueryMatcher } from "../services/MemoCatalogStore";
import { observationHandleKey, type ConfirmedDailyMemoPresentation, type DailyMemoPresentationChange } from "../services/DailyMemoPresentationChange";

interface PendingFilePresentation {
	change: DailyMemoPresentationChange;
	sourceRevision: string;
	revisions: string[];
	replacements: Map<string, ObservationHandle | null>;
	memos: Map<string, MemoViewItem>;
	pendingRevisions: Set<string>;
	reconciliation: number;
}

// 只保留未被 Catalog 接续的提交和已选中卡片；不缓存整份 Daily 正文，也不产生持久身份。
export class ConfirmedMemoPresentation {
	private readonly files = new Map<string, PendingFilePresentation>();

	get pending(): boolean { return this.files.size > 0; }
	getRevision(path: string): string | undefined { return this.files.get(path)?.sourceRevision; }
	getChanges(): DailyMemoPresentationChange[] { return [...this.files.values()].map(file => file.change); }
	clear(): void { this.files.clear(); }
	remove(path: string): void { this.files.delete(path); }
	getMemos(): MemoViewItem[] { return [...this.files.values()].flatMap(file => [...file.memos.values()]); }

	apply(input: ConfirmedDailyMemoPresentation, cached: readonly MemoViewItem[], capabilities: CatalogCapabilities) {
		const { change, observations } = input;
		const previous = this.files.get(change.sourcePath);
		const replacements = new Map(change.replacements.map(item => [observationHandleKey(item.before), item.after]));
		const after = new Map(observations.map(item => [observationHandleKey(item), item]));
		const makeMemo = (handle: ObservationHandle): MemoViewItem => {
			const observation = buildCatalogObservation(after.get(observationHandleKey(handle))!);
			return toCatalogMemoView(toCatalogMemoItem({ kind: "observation", observation,
				capabilities: createResolvedMemoCapabilities() }, capabilities));
		};
		const changes = new Map<string, MemoViewItem | null>();
		const memos = new Map<string, MemoViewItem>();
		for (const memo of [...(previous?.memos.values() ?? []), ...cached]) {
			if (memo.dailyRef.path !== change.sourcePath) continue;
			const handle = replacements.get(memo.id);
			const current = handle ? memos.get(observationHandleKey(handle)) ?? makeMemo(handle)
				: memo.catalog?.observationHandle.sourceRevision === change.sourceRevision ? memo : null;
			changes.set(memo.id, current);
			if (current) memos.set(current.id, current);
		}
		const changed = change.changed === null ? [] : [makeMemo(change.changed)];
		for (const memo of changed) memos.set(memo.id, memo);
		// 连续保存只组合已确认提交给出的对应关系，绝不按正文或旧行号猜测 occurrence。
		const translations = new Map<string, ObservationHandle | null>();
		for (const [key, handle] of previous?.replacements ?? []) {
			translations.set(key, handle ? replacements.get(observationHandleKey(handle)) ?? null : null);
		}
		for (const [key, handle] of replacements) translations.set(key, handle);
		const revisions = [...(previous?.revisions ?? []), change.beforeSourceRevision, change.sourceRevision];
		this.files.set(change.sourcePath, { change, sourceRevision: change.sourceRevision,
			revisions: [...new Set(revisions)], replacements: translations, memos,
			pendingRevisions: new Set([...(previous?.pendingRevisions ?? []), change.sourceRevision]), reconciliation: 0 });
		return { changes, changed };
	}

	// 旧查询可补充其它文件；受本次写入影响的 occurrence 始终使用已确认的展示版本。
	merge(memos: readonly MemoViewItem[], filter?: CatalogQueryFilter, addPending = true): MemoViewItem[] {
		// 新提交自身无法证明入向关联，待关系索引确认后再纳入统计钻取。
		if (filter?.hasReferrers) addPending = false;
		const result = new Map<string, MemoViewItem>();
		const matches = filter === undefined ? () => true : createCatalogQueryMatcher(filter);
		for (const memo of memos) {
			const file = this.files.get(memo.dailyRef.path);
			let current: MemoViewItem | null = memo;
			if (file && memo.catalog?.observationHandle.sourceRevision !== file.sourceRevision) {
				const handle = file.replacements.get(memo.id);
				current = handle ? file.memos.get(observationHandleKey(handle)) ?? remapUnchangedMemo(memo, handle) : null;
			}
			if (current?.catalog && matches(current.catalog.observation)) result.set(current.id, current);
		}
		if (addPending) for (const file of this.files.values()) for (const memo of file.memos.values()) {
			if (memo.catalog && matches(memo.catalog.observation)) result.set(memo.id, memo);
		}
		return [...result.values()].sort((left, right) => compareCatalogObservations(left.catalog!.observation, right.catalog!.observation));
	}

	acknowledge(change: DailyMemoPresentationChange): void {
		const file = this.files.get(change.sourcePath);
		if (!file) return;
		file.pendingRevisions.delete(change.sourceRevision);
		if (file.sourceRevision === change.sourceRevision) { this.files.delete(change.sourcePath); return; }
		const index = file.revisions.indexOf(change.sourceRevision);
		if (index >= 0) {
			const expired = new Set(file.revisions.splice(0, index));
			for (const key of file.replacements.keys()) if (expired.has(key.slice(key.lastIndexOf("\0") + 1))) file.replacements.delete(key);
		}
	}

	settled(change: DailyMemoPresentationChange): ((indexedRevision: string | null) => boolean) | null {
		const file = this.files.get(change.sourcePath);
		if (!file) return null;
		file.pendingRevisions.delete(change.sourceRevision);
		const run = ++file.reconciliation;
		return indexedRevision => {
			if (this.files.get(change.sourcePath) !== file || file.reconciliation !== run) return false;
			if (indexedRevision === file.sourceRevision) return true;
			// 只留当前索引版本与仍在排队的提交，失败重试不会累积已结束的历史 revision。
			const retained = new Set([file.sourceRevision, ...file.pendingRevisions, ...(indexedRevision ? [indexedRevision] : [])]);
			for (const key of file.replacements.keys()) if (!retained.has(key.slice(key.lastIndexOf("\0") + 1))) file.replacements.delete(key);
			file.revisions = file.revisions.filter(revision => retained.has(revision));
			return false;
		};
	}

	isOlder(change: DailyMemoPresentationChange): boolean {
		const file = this.files.get(change.sourcePath);
		return file !== undefined && file.sourceRevision !== change.sourceRevision && file.revisions.includes(change.sourceRevision);
	}
}

// 只在调用方已经核对提交 before/after 映射时复用正文；hash 本身不建立对应关系。
export function remapUnchangedMemo(memo: MemoViewItem, handle: ObservationHandle): MemoViewItem | null {
	if (!memo.catalog || memo.catalog.observation.rawBlockHash !== handle.rawBlockHash) return null;
	const observation = { ...memo.catalog.observation, ...handle,
		observationKey: `${handle.sourcePath}\0${String(handle.startLine).padStart(10, "0")}` };
	const item = toCatalogMemoItem({ ...memo.catalog.resolved, observation }, memo.catalog.capabilities.catalog);
	return toCatalogMemoView(item);
}
