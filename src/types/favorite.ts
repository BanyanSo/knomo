export interface FavoriteQueryProgress {
	persisted: number;
	located: number;
	matched: number;
	missing: number;
	waiting: number;
}

export interface FavoriteQueryCursor {
	version: number;
	filter: string;
	date: string;
	checkedDate: boolean;
	progress: FavoriteQueryProgress;
}

export interface FavoriteItem {
	favoriteId: string;
	sourcePath: string;
	blockId: string;
	memoTime: string;
	starredAt: string;
}

export interface FavoriteCollection {
	kind: "knomo-favorite";
	version: 1;
	collectionId: string;
	items: FavoriteItem[];
}

export function favoriteLocation(path: string, blockId: string): string {
	return path + "\0" + blockId;
}
