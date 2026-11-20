import { buildRecordStatsCatalogQuery, CatalogDiscoveryInvalidatedError, type CatalogReadService } from "../services/CatalogReadService";
import { countFavorites } from "../services/FavoriteQuery";
import type { FavoriteService } from "../services/FavoriteService";
import type { SelectedRecordStats } from "../services/RecordStatsService";
import type { CatalogFeatureFilter } from "../types/catalogView";
import { logContinuationFailure } from "../utils/continuationDiagnostics";

// undefined 表示正在等待，null 表示本次读取无法确认。
export interface RecordStatsCounts {
	things: number | null | undefined;
	favorites: number | null | undefined;
}

interface CountRequest {
	controller: AbortController;
	value?: number | null;
}

interface CountScope {
	key: string;
	query: CatalogFeatureFilter;
	things?: CountRequest;
	favorites?: CountRequest;
	favoriteRevision?: number;
}

interface ReadCountsOptions {
	source: string;
	catalogRevision: number;
	selected: SelectedRecordStats;
	read: CatalogReadService;
	favorites?: FavoriteService | null;
	yieldToUi: (signal: AbortSignal) => Promise<void>;
	isCurrent: () => boolean;
	onUpdate: () => void;
}

function getScopeKey(source: string, selected: SelectedRecordStats): string {
	return JSON.stringify([source, selected.startDate, selected.endDateExclusive]);
}

export class RecordStatsCountsController {
	private scope?: CountScope;

	clear(): void {
		this.scope?.things?.controller.abort();
		this.scope?.favorites?.controller.abort();
		this.scope = undefined;
	}

	retryUnavailable(): void {
		if (this.scope?.things?.value === null) this.scope.things = undefined;
		if (this.scope?.favorites?.value === null) this.scope.favorites = undefined;
	}

	getCount(kind: keyof RecordStatsCounts, source: string, selected: SelectedRecordStats, favoriteRevision?: number): number | null | undefined {
		const scope = this.scope;
		if (scope?.key !== getScopeKey(source, selected)
			|| (kind === "favorites" && (favoriteRevision === undefined || scope.favoriteRevision !== favoriteRevision))) return undefined;
		return scope[kind]?.value;
	}

	read(options: ReadCountsOptions): RecordStatsCounts {
		const { selected, catalogRevision, read, favorites } = options;
		if (selected.range.memoCount === 0) {
			this.clear();
			return { things: 0, favorites: 0 };
		}
		const { startDate, endDateExclusive } = selected;
		const key = getScopeKey(options.source, selected);
		if (this.scope?.key !== key) {
			this.clear();
			this.scope = { key, query: buildRecordStatsCatalogQuery({ type: "range", startDate, endDateExclusive }).query };
		}
		const scope = this.scope;
		scope.things ??= this.start("things", scope, options, async signal => {
			const result = await read.count({ ...scope.query, hasTask: true }, signal);
			return result.catalogRevision === catalogRevision && result.complete ? result.count : null;
		});
		const favoriteRevision = favorites?.revision;
		if (scope.favoriteRevision !== favoriteRevision) {
			scope.favorites?.controller.abort();
			scope.favorites = undefined;
			scope.favoriteRevision = favoriteRevision;
		}
		if (!favorites || favorites.status !== "ready") {
			return { things: scope.things.value, favorites: favorites?.status === "loading" ? undefined : null };
		}
		scope.favorites ??= this.start("favorites", scope, options, async signal => {
			const metadata = await read.query({ limit: 1, matchNone: true }, signal);
			if (metadata.catalogRevision !== catalogRevision || metadata.invalidated || metadata.degraded || metadata.readState !== "ready"
				|| metadata.coverage.configurationComplete === false || favorites.revision !== favoriteRevision) return null;
			return countFavorites(read, favorites, scope.query, metadata, signal);
		});
		return { things: scope.things.value, favorites: scope.favorites.value };
	}

	private start(kind: keyof RecordStatsCounts, scope: CountScope, options: ReadCountsOptions,
		load: (signal: AbortSignal) => Promise<number | null>): CountRequest {
		const request: CountRequest = { controller: new AbortController() };
		const { signal } = request.controller;
		const isCurrent = () => !signal.aborted && this.scope === scope && scope[kind] === request
			&& (kind !== "favorites" || scope.favoriteRevision === options.favorites?.revision)
			&& options.isCurrent();
		void options.yieldToUi(signal).then(async () => {
			if (!isCurrent()) return;
			try {
				const value = await load(signal);
				if (isCurrent()) request.value = value;
			} catch (error) {
				if (!isCurrent()) return;
				if (!(error instanceof CatalogDiscoveryInvalidatedError)) logContinuationFailure("view", `record-stats-${kind}`, error);
				request.value = null;
			}
			if (isCurrent()) options.onUpdate();
		});
		return request;
	}
}
