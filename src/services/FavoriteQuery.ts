import type { CatalogFeatureCursor, CatalogFeatureQuery, CatalogMemoItem, CatalogMemoPage } from "../types/catalogView";
import type { CatalogReadService } from "./CatalogReadService";
import type { FavoriteService } from "./FavoriteService";
import { getCatalogQueryKey, narrowCatalogQuery } from "./SearchMatching";
import { catalogObservationKey, sameObservationHandle, type ObservationHandle } from "../types/catalog";
import { CatalogDiscoveryInvalidatedError } from "./CatalogReadService";

import type { FavoriteQueryProgress } from "../types/favorite";

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
		|| request.cursor.catalog.catalogRevision !== metadata.catalogRevision)) {
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
	const items: CatalogMemoItem[] = [];
	let nextCursor: CatalogFeatureCursor | null = null;
	for (const date of sortedDates) {
		if (cursor && date > cursor.date) continue;
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
		const continuing = cursor?.date === date && cursor.checkedDate;
		if (!continuing) {
			progress.located += located;
			progress.missing += missing;
			progress.waiting += waiting;
		}
		if (!expected.size) continue;
		const page = await service.query({
			...request, fromDate: date, toDate: date, logicalDates: [date], observationKeys: [...expected.keys()],
			limit: request.limit - items.length, cursor: continuing ? request.cursor : null,
		}, signal);
		check();
		if (page.invalidated || page.catalogRevision !== metadata.catalogRevision || page.items.some(item => {
			const handle = expected.get(item.observation.observationKey);
			return !handle || !sameObservationHandle(handle, item.observationHandle);
		})) throw new CatalogDiscoveryInvalidatedError();
		items.push(...page.items);
		progress.matched += page.items.length;
		if (page.nextCursor) {
			nextCursor = { ...page.nextCursor, favorites: { version, filter, date, checkedDate: true, progress } };
			break;
		}
		if (items.length >= request.limit) {
			const nextDate = sortedDates[sortedDates.indexOf(date) + 1];
			const last = page.items[page.items.length - 1];
			if (nextDate && last) nextCursor = {
				catalog: { catalogRevision: metadata.catalogRevision, createdAtKey: last.observation.createdAtKey, observationKey: last.observation.observationKey },
				favorites: { version, filter, date: nextDate, checkedDate: false, progress },
			};
			break;
		}
	}
	check();
	return { ...metadata, items, nextCursor, favoriteProgress: progress };
}
