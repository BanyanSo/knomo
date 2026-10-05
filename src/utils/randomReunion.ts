import type { MemoViewItem as MemoRecord } from "../types/memoView";
import type { MemoReviewState, MemoReviewStateMap } from "../types/review";
import { formatDatePart, parseMemoCalendarDate } from "./date";
import { CooperativeYieldController } from "../services/CooperativeTask";
import type { CooperativeTaskRuntime } from "../services/CooperativeTask";

export type RandomReunionCandidate = Pick<MemoRecord, "id" | "createdAt" | "tags" | "dailyRef"> & { logicalDate?: string };

export interface RandomReunionOptions {
	today?: Date;
	minContentLength?: number;
	blacklistTags?: string[];
	blacklistPathPrefixes?: string[];
	maxPerSourcePath?: number;
	maxPerDate?: number;
	maxPerPrimaryTag?: number;
	random?: () => number;
	// 批次按提交顺序排列，最后一批是最近展示；不代表已回看。
	shownBatches?: readonly (readonly string[])[];
	signal?: AbortSignal;
}

const DEFAULT_MIN_CONTENT_LENGTH = 8;
const DEFAULT_BLACKLIST_TAGS = ["临时", "草稿", "已归档", "temp", "temporary", "draft", "archived"];
const DEFAULT_BLACKLIST_PATH_PREFIXES = ["Template/", "Archive/"];
const DEFAULT_DIVERSITY_LIMIT = 2;
const MIN_WEIGHT = 0.01;
const MAX_WEIGHT = 10;

export function filterRandomReunionCandidates(
	memos: MemoRecord[],
	options: RandomReunionOptions = {},
): MemoRecord[] {
	const today = startOfDay(options.today ?? new Date());
	const minContentLength = options.minContentLength ?? DEFAULT_MIN_CONTENT_LENGTH;
	const blacklistTags = normalizeTags(options.blacklistTags ?? DEFAULT_BLACKLIST_TAGS);
	const blacklistPathPrefixes = normalizePathPrefixes(options.blacklistPathPrefixes ?? DEFAULT_BLACKLIST_PATH_PREFIXES);

	return memos.filter((memo) => {
		if (memo.status !== "active" || memo.deletedAt !== undefined) {
			return false;
		}
		const createdAt = getMemoDate({ ...memo, logicalDate: memo.catalog?.observation.logicalDate });
		if (createdAt === null || formatDatePart(createdAt) >= formatDatePart(today)) {
			return false;
		}
		if (getComparableContentLength(memo.contentSnapshot) < minContentLength && memo.images.length === 0 && memo.links.length === 0) {
			return false;
		}
		if (hasBlacklistedTag(memo.tags, blacklistTags)) {
			return false;
		}
		return !hasBlacklistedPath(memo.dailyRef.path, blacklistPathPrefixes);
	});
}

export function calculateRandomReunionWeight(
	memo: RandomReunionCandidate,
	reviewState: MemoReviewState | undefined,
	today = new Date(),
): number {
	let weight = 1;
	const createdAt = getMemoDate(memo);
	const todayStart = today;
	if (
		createdAt !== null &&
		createdAt.getMonth() === todayStart.getMonth() &&
		createdAt.getDate() === todayStart.getDate() &&
		createdAt.getFullYear() !== todayStart.getFullYear()
	) {
		weight *= 5;
	}
	if (reviewState === undefined || reviewState.reviewCount === 0) {
		weight *= 1.5;
	}
	const lastReviewedAt = reviewState?.lastReviewedAt === undefined
		? null
		: parseReviewDate(reviewState.lastReviewedAt);
	if (lastReviewedAt !== null) {
		const daysSinceReview = Math.max(0, differenceInDays(todayStart, lastReviewedAt));
		if (daysSinceReview <= 3) {
			return MIN_WEIGHT;
		}
		weight *= getReviewRecoveryMultiplier(daysSinceReview);
	}
	return clampWeight(weight);
}

// 权重树避免每次抽取重扫剩余候选，保持按原顺序累计权重的无放回抽样。
function* sampleWeighted<T>(items: T[], getWeight: (item: T) => number,
	random: () => number): Generator<T | undefined> {
	let size = 1;
	while (size < items.length) size *= 2;
	const tree = new Float64Array(size * 2);
	for (let index = 0; index < items.length; index++) {
		tree[size + index] = clampWeight(getWeight(items[index]));
		yield;
	}
	for (let index = size - 1; index > 0; index--) {
		tree[index] = tree[index * 2] + tree[index * 2 + 1];
		yield;
	}
	for (let picked = 0; picked < items.length; picked++) {
		let cursor = clampRandom(random()) * tree[1];
		let index = 1;
		while (index < size) {
			const left = tree[index * 2];
			if (left > 0 && cursor <= left) index *= 2;
			else { cursor -= left; index = index * 2 + 1; }
		}
		const memo = items[index - size];
		tree[index] = 0;
		while (index > 1) {
			index = Math.floor(index / 2);
			tree[index] = tree[index * 2] + tree[index * 2 + 1];
		}
		yield memo;
	}
}

export async function sampleRandomReunionCandidates<T extends RandomReunionCandidate>(
	candidates: T[], reviews: MemoReviewStateMap, count: number, options: RandomReunionOptions,
	runtime: CooperativeTaskRuntime,
): Promise<T[]> {
	const limit = Math.min(Math.max(0, Math.floor(count)), candidates.length);
	options.signal?.throwIfAborted();
	if (limit === 0) return [];
	const control = new CooperativeYieldController(runtime);
	const today = options.today ?? new Date();
	const batches = options.shownBatches?.slice(-3) ?? [];
	const latestBatch = new Map<string, number>();
	batches.forEach((batch, index) => batch.forEach(key => latestBatch.set(key, index + 1)));
	const layers: T[][] = batches.length === 0 ? [candidates] : Array.from({ length: batches.length + 1 }, () => []);
	if (batches.length > 0) {
		for (const memo of candidates) {
			layers[latestBatch.get(memo.id) ?? 0].push(memo);
			if (control.shouldYield()) {
				await control.yieldNow();
				options.signal?.throwIfAborted();
			}
		}
	}
	const selected: T[] = [];
	const ids = new Set<string>();
	const sources = new Map<string, number>();
	const dates = new Map<string, number>();
	const tags = new Map<string, number>();
	const accept = (memo: T) => {
		selected.push(memo);
		ids.add(memo.id);
		incrementDiversityCounts(memo, sources, dates, tags);
	};
	for (const layer of layers) {
		if (selected.length >= limit) break;
		const rejected: T[] = [];
		const rejectedByTags: T[] = [];
		const work = sampleWeighted(layer, memo => calculateRandomReunionWeight(memo, reviews[memo.id], today), options.random ?? Math.random);
		for (const memo of work) {
			options.signal?.throwIfAborted();
			if (memo !== undefined && !ids.has(memo.id)) {
				if (canUseDiverseMemo(memo, sources, dates, tags, options.maxPerSourcePath ?? DEFAULT_DIVERSITY_LIMIT,
					options.maxPerDate ?? DEFAULT_DIVERSITY_LIMIT, options.maxPerPrimaryTag ?? DEFAULT_DIVERSITY_LIMIT)) accept(memo);
				else {
					rejected.push(memo);
					if (canUseDiverseMemo(memo, sources, dates, tags, options.maxPerSourcePath ?? DEFAULT_DIVERSITY_LIMIT,
						options.maxPerDate ?? DEFAULT_DIVERSITY_LIMIT, Number.POSITIVE_INFINITY)) rejectedByTags.push(memo);
				}
			}
			if (selected.length >= limit) break;
			if (control.shouldYield()) {
				await control.yieldNow();
				options.signal?.throwIfAborted();
			}
		}
		// 同层先放宽主题，再放宽来源和日期；新鲜度始终优先于多样性。
		for (const memo of rejectedByTags) {
			if (selected.length >= limit) break;
			options.signal?.throwIfAborted();
			if (canUseDiverseMemo(memo, sources, dates, tags, options.maxPerSourcePath ?? DEFAULT_DIVERSITY_LIMIT,
				options.maxPerDate ?? DEFAULT_DIVERSITY_LIMIT, Number.POSITIVE_INFINITY)) accept(memo);
			if (control.shouldYield()) {
				await control.yieldNow();
				options.signal?.throwIfAborted();
			}
		}
		for (const memo of rejected) {
			if (selected.length >= limit) break;
			options.signal?.throwIfAborted();
			if (!ids.has(memo.id)) accept(memo);
			if (control.shouldYield()) {
				await control.yieldNow();
				options.signal?.throwIfAborted();
			}
		}
	}
	options.signal?.throwIfAborted();
	return selected;
}

function hasBlacklistedTag(tags: string[], blacklistTags: Set<string>): boolean {
	return tags.some((tag) => {
		const normalizedTag = tag.replace(/^#/, "").toLowerCase();
		return blacklistTags.has(normalizedTag) || [...blacklistTags].some((blacklistTag) => normalizedTag.startsWith(`${blacklistTag}/`));
	});
}

function hasBlacklistedPath(path: string, blacklistPathPrefixes: string[]): boolean {
	const normalizedPath = path.replace(/\\/g, "/").replace(/^\/+/, "").toLowerCase();
	return blacklistPathPrefixes.some((prefix) => normalizedPath.startsWith(prefix));
}

function getComparableContentLength(content: string): number {
	return stripMarkdownForLength(content).replace(/\s/g, "").length;
}

function stripMarkdownForLength(content: string): string {
	return content
		.replace(/!\[\[[^\]]+\]\]/g, "")
		.replace(/\[\[[^\]|]+(?:\|([^\]]+))?\]\]/g, "$1")
		.replace(/!\[[^\]]*\]\([^)]+\)/g, "")
		.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
		.replace(/`{1,3}/g, "")
		.replace(/[*_~>#-]/g, "")
		.replace(/\^[A-Za-z0-9_-]+/g, "");
}

function canUseDiverseMemo(
	memo: RandomReunionCandidate,
	sourceCounts: Map<string, number>,
	dateCounts: Map<string, number>,
	tagCounts: Map<string, number>,
	maxPerSourcePath: number,
	maxPerDate: number,
	maxPerPrimaryTag: number,
): boolean {
	const sourcePath = memo.dailyRef.path;
	if ((sourceCounts.get(sourcePath) ?? 0) >= maxPerSourcePath) return false;
	const dateKey = getMemoDateKey(memo);
	if (dateKey !== null && (dateCounts.get(dateKey) ?? 0) >= maxPerDate) return false;
	return maxPerPrimaryTag === Number.POSITIVE_INFINITY || getRootTags(memo.tags).every(tag => (tagCounts.get(tag) ?? 0) < maxPerPrimaryTag);
}

function incrementDiversityCounts(
	memo: RandomReunionCandidate,
	sourceCounts: Map<string, number>,
	dateCounts: Map<string, number>,
	tagCounts: Map<string, number>,
): void {
	const sourcePath = memo.dailyRef.path;
	const dateKey = getMemoDateKey(memo);
	const rootTags = getRootTags(memo.tags);
	sourceCounts.set(sourcePath, (sourceCounts.get(sourcePath) ?? 0) + 1);
	if (dateKey !== null) {
		dateCounts.set(dateKey, (dateCounts.get(dateKey) ?? 0) + 1);
	}
	for (const tag of rootTags) tagCounts.set(tag, (tagCounts.get(tag) ?? 0) + 1);
}

function getMemoDateKey(memo: RandomReunionCandidate): string | null {
	const key = memo.logicalDate ?? memo.createdAt.slice(0, 10);
	return /^\d{4}-\d{2}-\d{2}$/u.test(key) ? key : null;
}

function getRootTags(tags: string[]): string[] {
	return [...new Set(tags.map(tag => tag.trim().replace(/^#/, "").toLowerCase().split("/")[0]).filter(tag => tag.length > 0))];
}

function normalizeTags(tags: string[]): Set<string> {
	return new Set(tags.map((tag) => tag.replace(/^#/, "").toLowerCase()));
}

function normalizePathPrefixes(paths: string[]): string[] {
	return paths.map((path) => {
		const normalizedPath = path.replace(/\\/g, "/").replace(/^\/+/, "").toLowerCase();
		return normalizedPath.endsWith("/") ? normalizedPath : `${normalizedPath}/`;
	});
}

function getMemoDate(memo: RandomReunionCandidate): Date | null {
	const key = getMemoDateKey(memo);
	if (key === null) return null;
	const date = new Date(`${key}T00:00:00`);
	return formatDatePart(date) === key ? date : null;
}

function parseReviewDate(value: string): Date | null {
	if (/^\d{4}-\d{2}-\d{2}$/u.test(value)) return parseMemoCalendarDate(value);
	const calendar = /^(\d{4}-\d{2}-\d{2})[T ]/u.exec(value);
	if (calendar !== null && parseMemoCalendarDate(calendar[1]) === null) return null;
	const date = new Date(value);
	return Number.isNaN(date.getTime()) ? null : date;
}

function startOfDay(date: Date): Date {
	return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function differenceInDays(later: Date, earlier: Date): number {
	return (Date.UTC(later.getFullYear(), later.getMonth(), later.getDate())
		- Date.UTC(earlier.getFullYear(), earlier.getMonth(), earlier.getDate())) / 86400000;
}

function getReviewRecoveryMultiplier(daysSinceReview: number): number {
	const progress = Math.min(1, Math.max(0, (daysSinceReview - 3) / 27));
	return 0.01 + progress * 1.19;
}

function clampWeight(value: number): number {
	if (!Number.isFinite(value) || value <= 0) {
		return MIN_WEIGHT;
	}
	return Math.min(MAX_WEIGHT, Math.max(MIN_WEIGHT, value));
}

function clampRandom(value: number): number {
	if (!Number.isFinite(value)) {
		return 0;
	}
	return Math.min(0.999999999, Math.max(0, value));
}
