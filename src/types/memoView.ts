import type { TrashMemoItem, TrashSnapshot } from "./trash";
import { hashText } from "../utils/hash";
import type { CatalogMemoItem } from "./catalogView";
import type { DailyRef, MemoImageRef, MemoLinkRef, MemoStatus } from "./memo";

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
		createdAt: item.createdAt,
		updatedAt: item.deletedAt,
		contentSnapshot: item.content,
		contentHash: item.contentHash,
		status: "deleted",
		tags: [],
		links: [],
		images: [],
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

export function toTrashMemoItem(item: TrashSnapshot): TrashMemoItem {
	return { ...item, key: item.snapshotId,
		createdAt: item.logicalDate + "T" + (item.rawBlock.match(/^- (\d{2}:\d{2}(?::\d{2})?)/u)?.[1] ?? "00:00"),
		content: readDeletedPayloadContent(item.rawBlock), contentHash: hashText(item.rawBlock), purgeAllowed: true };
}

function readDeletedPayloadContent(rawBlock: string): string {
	const lines = rawBlock.split(/\r?\n/u);
	const first = /^- (?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?(?:\s(.*))?$/u.exec(lines[0] ?? "")?.[1] ?? "";
	const continuation = lines.slice(1).map((line) => line.replace(/^ {2}/u, ""));
	return [first, ...continuation].join("\n").replace(/\s+\^[A-Za-z0-9-]+\s*$/u, "").trim();
}
