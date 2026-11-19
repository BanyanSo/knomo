import type { CatalogFeatureCursor, CatalogFeatureQuery, CatalogMemoItem, CatalogMemoPage } from "../types/catalogView";
import type { CatalogReadService } from "./CatalogReadService";
import type { FavoriteService } from "./FavoriteService";
import { getCatalogQueryKey, narrowCatalogQuery } from "./SearchMatching";
import { catalogObservationKey, sameObservationHandle, type ObservationHandle } from "../types/catalog";
import { CatalogDiscoveryInvalidatedError } from "./CatalogReadService";
import { clampPageLimit } from "./MemoCatalogStore";
import type { FavoriteQueryProgress } from "../types/favorite";

const FAVORITE_DATE_BATCH_SIZE = 32;

export async function queryFavorites(
	service: CatalogReadService, favorites: FavoriteService, request: CatalogFeatureQuery, signal?: AbortSignal,
): Promise<CatalogMemoPage & { favoriteProgress: FavoriteQueryProgress }> {
	const version = favorites.revision;
	const filter = getCatalogQueryKey(request);
	const cursor = request.cursor?.favorites;
	const progress = cursor ? { ...cursor.progress } : { persisted: favorites.persistedCount, located: 0, matched: 0, missing: 0, waiting: 0 };
	const metadata = await service.query({ limit: 1, matchNone: true }, signal);
	const check = () => {
		signal?.throwIfAborted();
		if (version !== favorites.revision) throw new CatalogDiscoveryInvalidatedError();
	};
	check();
	if (request.cursor && (!cursor || cursor.version !== version || cursor.filter !== filter
		|| cursor.catalogRevision !== metadata.catalogRevision)) {
		return { ...metadata, invalidated: true, favoriteProgress: progress };
	}
	if (favorites.status !== "ready" || !progress.persisted) return { ...metadata, favoriteProgress: progress };
	if (metadata.readState === "storage_unavailable") {
		return { ...metadata, favoriteProgress: { ...progress, waiting: progress.persisted } };
	}

	const dates = new Map<string, string[]>();
	for (const path of favorites.paths()) {
		const date = favorites.getDate(path);
		if (!date) {
			if (!cursor) progress.missing += favorites.countAt(path);
			continue;
		}
		const options = narrowCatalogQuery({ ...request, logicalDates: [date] });
		if (options.matchNone || (request.logicalDates && !request.logicalDates.includes(date))) continue;
		const paths = dates.get(date) ?? [];
		paths.push(path);
		dates.set(date, paths);
	}
	const sortedDates = [...dates.keys()].sort().reverse();
	let index = cursor ? sortedDates.indexOf(cursor.date) : 0;
	if (index < 0) return { ...metadata, invalidated: true, favoriteProgress: progress };
	const end = Math.min(index + FAVORITE_DATE_BATCH_SIZE, sortedDates.length);
	const limit = clampPageLimit(request.limit);
	const continuation = (date: string) => ({ version, catalogRevision: metadata.catalogRevision, filter, date, progress });
	const items: CatalogMemoItem[] = [];
	let nextCursor: CatalogFeatureCursor | null = null;
	for (; index < end && items.length < limit; index++) {
		const date = sortedDates[index];
		const expected = new Map<string, ObservationHandle>();
		let located = 0, missing = 0, waiting = 0;
		for (const path of dates.get(date)!) {
			const total = favorites.countAt(path);
			const state = await favorites.resolve(path);
			check();
			if (state.status === "missing") {
				if (metadata.readState === "history_building") waiting += total;
				else missing += total;
				continue;
			}
			if (state.status !== "ready") { waiting += total; continue; }
			const indexed = await service.getFileSourceRevision(path, metadata.catalogRevision, signal);
			check();
			located += state.bindings.size;
			missing += total - state.bindings.size;
			if (indexed !== state.revision) { waiting += state.bindings.size; continue; }
			for (const handle of state.bindings.values()) {
				const key = catalogObservationKey(handle);
				if (!request.observationKeys || request.observationKeys.includes(key)) expected.set(key, handle);
			}
		}
		const continuing = cursor?.date === date && request.cursor?.catalog != null;
		if (!continuing) {
			progress.located += located;
			progress.missing += missing;
			progress.waiting += waiting;
		}
		if (!expected.size) continue;
		const page = await service.query({
			...request, fromDate: date, toDate: date, logicalDates: [date], observationKeys: [...expected.keys()],
			limit: limit - items.length, cursor: continuing ? request.cursor : null,
		}, signal);
		check();
		if (page.invalidated || page.catalogRevision !== metadata.catalogRevision || page.items.some(item => {
			const handle = expected.get(item.observation.observationKey);
			return !handle || !sameObservationHandle(handle, item.observationHandle);
		})) throw new CatalogDiscoveryInvalidatedError();
		items.push(...page.items);
		progress.matched += page.items.length;
		if (page.nextCursor) {
			nextCursor = { ...page.nextCursor, favorites: continuation(date) };
			break;
		}
	}
	// 一批可能没有匹配项。日期边界游标独立于 Catalog 的同日位置。
	if (!nextCursor && index < sortedDates.length) nextCursor = { catalog: null, favorites: continuation(sortedDates[index]) };
	check();
	return { ...metadata, items, nextCursor, favoriteProgress: progress };
}
