import type { MemoCatalogStore } from "./MemoCatalogStore";

export interface CatalogChangeCursor {
	catalogRevision: number;
	storeGeneration: string;
}

export interface CatalogFileChanges {
	cursor: CatalogChangeCursor;
	// null 表示记录不连续或 store 已切换，调用方必须重建候选池。
	sourcePaths: string[] | null;
	invalidated: boolean;
}

const MAX_COMMITTED_REVISIONS = 256;
const MAX_COMMITTED_PATHS = 1_024;

// 只记录本进程成功提交的派生分区变化，不持久化，也不赋予正文写权限。
export class CatalogFileChangeTracker {
	private readonly revisions = new Map<number, Set<string>>();
	private pathCount = 0;

	record(revision: number, sourcePaths: readonly string[]): void {
		const paths = new Set(sourcePaths);
		if (paths.size > MAX_COMMITTED_PATHS) { this.clear(); return; }
		this.pathCount -= this.revisions.get(revision)?.size ?? 0;
		this.revisions.set(revision, paths);
		this.pathCount += paths.size;
		while (this.revisions.size > MAX_COMMITTED_REVISIONS || this.pathCount > MAX_COMMITTED_PATHS) {
			const oldest = Math.min(...this.revisions.keys());
			this.pathCount -= this.revisions.get(oldest)!.size;
			this.revisions.delete(oldest);
		}
	}

	changesSince(cursor: CatalogChangeCursor, previous?: CatalogChangeCursor): string[] | null {
		if (previous === undefined || previous.storeGeneration !== cursor.storeGeneration
			|| previous.catalogRevision > cursor.catalogRevision || cursor.catalogRevision - previous.catalogRevision > MAX_COMMITTED_REVISIONS) return null;
		const sourcePaths = new Set<string>();
		for (let revision = previous.catalogRevision + 1; revision <= cursor.catalogRevision; revision++) {
			const paths = this.revisions.get(revision);
			if (paths === undefined) return null;
			for (const sourcePath of paths) sourcePaths.add(sourcePath);
		}
		return [...sourcePaths];
	}

	clear(): void { this.revisions.clear(); this.pathCount = 0; }
}

export async function readCatalogFileChanges(store: MemoCatalogStore, tracker: CatalogFileChangeTracker,
	previous?: CatalogChangeCursor): Promise<CatalogFileChanges> {
	const generation = store.getRuntimeGeneration();
	const catalogRevision = await store.getCatalogRevision();
	const storeGeneration = store.getRuntimeGeneration();
	const cursor = { catalogRevision, storeGeneration };
	return { cursor, sourcePaths: tracker.changesSince(cursor, previous), invalidated: generation !== storeGeneration };
}
