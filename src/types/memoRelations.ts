import type { CatalogCoverage, ObservationHandle } from "./catalog";

export interface MemoRelationTarget { path: string; blockId: string }

export interface MemoRelationNode {
	handle: ObservationHandle;
	logicalDate: string;
	time: string;
	blockId: string | null;
	targets: MemoRelationTarget[];
}

// 只保存候选与定位上下文，不包含正文、身份或写权限。
export interface CatalogFileRelations {
	anchors: Record<string, number>;
	nodes: MemoRelationNode[];
}

export interface MemoRelationSnapshot {
	version: number;
	coverage: CatalogCoverage;
	complete: boolean;
	errors: string[];
	// 补扫由既有 Catalog 队列接续；调用方不能在同一队列内等待它。
	recovering?: boolean;
	nodes: ReadonlyMap<string, MemoRelationNode>;
	sources: ReadonlyMap<string, readonly MemoRelationNode[]>;
	referrers: ReadonlyMap<string, readonly MemoRelationNode[]>;
}
