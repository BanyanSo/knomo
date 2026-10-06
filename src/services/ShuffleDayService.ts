import { t } from "../i18n";
import { formatDatePart, formatLocalIsoString } from "../utils/date";
import { buildPluginDataWithShuffleDayHistory, extractShuffleDayHistory } from "../utils/pluginData";
import {
	buildShuffleDayStats, normalizeShuffleDayHistory, selectShuffleDayDate, sortShuffleDayMemos,
	type ShuffleDayHistoryEntry, type ShuffleDaySelectionResult, type ShuffleDaySelectorOptions,
} from "../utils/shuffleDay";
import { CatalogDiscoveryInvalidatedError } from "./CatalogReadService";
import type { CatalogReadService } from "./CatalogReadService";
import type { PluginDataStore } from "./PluginDataStore";

export type ShuffleDayCatalogReader = Pick<CatalogReadService, "readDailyAggregateSnapshot" | "listMemoViewsForDate" | "isDiscoverySnapshotCurrent">;

export class ShuffleDayService {
	private sessionHistory: ShuffleDayHistoryEntry[] = [];
	private pendingEvents: ShuffleDayHistoryEntry[] = [];

	constructor(private readonly pluginDataStore: PluginDataStore, private readonly now: () => Date = () => new Date()) {}

	async selectCatalogShuffleDay(catalog: ShuffleDayCatalogReader,
		options: Omit<ShuffleDaySelectorOptions, "history"> & { signal?: AbortSignal } = {},
	): Promise<ShuffleDaySelectionResult> {
		options.signal?.throwIfAborted();
		let savedData: unknown;
		let historyUnavailable = false;
		try { savedData = await this.pluginDataStore.read(); }
		catch { historyUnavailable = true; }
		options.signal?.throwIfAborted();
		for (let attempt = 0; attempt < 3; attempt++) {
			const now = options.now ?? this.now();
			try {
				const snapshot = await catalog.readDailyAggregateSnapshot(options.signal);
				options.signal?.throwIfAborted();
				if (snapshot.day !== formatDatePart(options.today ?? now)) throw new CatalogDiscoveryInvalidatedError();
				const history = normalizeShuffleDayHistory([...this.sessionHistory, ...extractShuffleDayHistory(savedData, now)], now);
				const result = selectShuffleDayDate(snapshot.aggregates, { ...options, now, today: options.today ?? now, history });
				if (result.status !== "ready") {
					if (!await catalog.isDiscoverySnapshotCurrent(snapshot, options.signal)) throw new CatalogDiscoveryInvalidatedError();
					options.signal?.throwIfAborted();
					return result;
				}
				const memos = sortShuffleDayMemos(await catalog.listMemoViewsForDate(result.selectedDate, { snapshot, signal: options.signal }));
				options.signal?.throwIfAborted();
				if (memos.length === 0 || !await catalog.isDiscoverySnapshotCurrent(snapshot, options.signal)) throw new CatalogDiscoveryInvalidatedError();
				options.signal?.throwIfAborted();
				return { ...result, memos, stats: buildShuffleDayStats(memos), historyUnavailable };
			} catch (error) {
				options.signal?.throwIfAborted();
				if (!(error instanceof CatalogDiscoveryInvalidatedError)) throw error;
			}
		}
		throw new Error(t("error.revisitChanged"));
	}

	// 在 Controller 接受结果时同步记录会话事件；之后导航不撤销已成立的提交。
	acceptSelection(date: string): Promise<void> {
		const now = this.now();
		const event = { date, shownAt: formatLocalIsoString(now) };
		this.sessionHistory = normalizeShuffleDayHistory([event, ...this.sessionHistory], now);
		this.pendingEvents = normalizeShuffleDayHistory([event, ...this.pendingEvents], now);
		const events = [...this.pendingEvents];
		return this.pluginDataStore.mutate(savedData => {
			const history = normalizeShuffleDayHistory([...events, ...extractShuffleDayHistory(savedData, now)], now);
			return { nextData: buildPluginDataWithShuffleDayHistory(savedData, history, now), result: undefined };
		}).then(() => {
			// 只确认此次保存包含的事件，旧完成不能移除之后接受的新事件。
			const saved = new Set(events.map(event => `${event.date}\n${event.shownAt}`));
			this.pendingEvents = this.pendingEvents.filter(event => !saved.has(`${event.date}\n${event.shownAt}`));
		});
	}
}
