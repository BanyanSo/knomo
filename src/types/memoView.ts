import type { CatalogV2DeletedMemoItem, CatalogV2MemoItem } from "./catalogV2View";
import type { DailyRef, MemoImageRef, MemoLinkRef, MemoReference, MemoStatus } from "./memo";

// 仅供界面渲染与定位，不承担同步身份或 Monthly 快照职责。
export interface MemoViewItem {
	id: string;
	createdAt: string;
	updatedAt: string;
	contentSnapshot: string;
	contentHash: string;
	status: MemoStatus;
	tags: string[];
	links: MemoLinkRef[];
	images: MemoImageRef[];
	references: MemoReference[];
	sourceMemoId: string | null;
	dailyRef: DailyRef;
	deletedAt?: string;
	deleteSource?: string;
	catalogV2?: CatalogV2MemoItem;
	catalogV2Deleted?: CatalogV2DeletedMemoItem;
}

export function isCatalogV2MemoView(item: MemoViewItem): item is MemoViewItem & { catalogV2: CatalogV2MemoItem } {
	return item.catalogV2 !== undefined;
}

export function toCatalogV2MemoView(item: CatalogV2MemoItem): MemoViewItem {
	return {
		id: item.key,
		createdAt: item.createdAt,
		updatedAt: item.createdAt,
		contentSnapshot: item.content,
		contentHash: item.observation.contentHash,
		status: "active",
		tags: [...item.tags],
		links: [...item.links],
		images: [...item.images],
		references: [],
		sourceMemoId: item.sourceMemoId,
		dailyRef: {
			path: item.sourcePath,
			heading: item.observation.section,
			sectionType: item.observation.section === null ? "root" : "heading",
			lineNumberHint: item.lineNumberHint,
		},
		catalogV2: item,
	};
}

export function isCatalogV2DeletedMemoView(item: MemoViewItem): item is MemoViewItem & { catalogV2Deleted: CatalogV2DeletedMemoItem } {
	return item.catalogV2Deleted !== undefined;
}

export function toCatalogV2DeletedMemoView(item: CatalogV2DeletedMemoItem): MemoViewItem {
	return {
		id: item.key,
		createdAt: `${item.logicalDate}T00:00:00`,
		updatedAt: item.deletedAt,
		contentSnapshot: item.content,
		contentHash: item.deleteVersion.payload.sha256,
		status: "deleted",
		tags: [],
		links: [],
		images: [],
		references: [],
		sourceMemoId: item.sourceMemoId,
		dailyRef: {
			path: item.sourcePath,
			heading: item.section,
			sectionType: item.section === null ? "root" : "heading",
			lineNumberHint: null,
		},
		deletedAt: item.deletedAt,
		catalogV2Deleted: item,
	};
}
