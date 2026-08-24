import type { CatalogMemoItem, TrashMemoItem } from "./catalogView";
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
	catalog?: CatalogMemoItem;
	trashItem?: TrashMemoItem;
}

export function isCatalogMemoView(item: MemoViewItem): item is MemoViewItem & { catalog: CatalogMemoItem } {
	return item.catalog !== undefined;
}

export function toCatalogMemoView(item: CatalogMemoItem): MemoViewItem {
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
		catalog: item,
	};
}

export function isTrashMemoView(item: MemoViewItem): item is MemoViewItem & { trashItem: TrashMemoItem } {
	return item.trashItem !== undefined;
}

export function toTrashMemoView(item: TrashMemoItem): MemoViewItem {
	return {
		id: item.key,
		createdAt: `${item.logicalDate}T00:00:00`,
		updatedAt: item.deletedAt,
		contentSnapshot: item.content,
		contentHash: item.contentHash,
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
		trashItem: item,
	};
}
