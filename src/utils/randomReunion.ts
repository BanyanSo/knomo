import type { MemoViewItem as MemoRecord } from "../types/memoView";
import type { MemoReviewState, MemoReviewStateMap } from "../types/review";
import { formatDatePart } from "./date";
import { CooperativeYieldController } from "../services/CooperativeTask";
import type { CooperativeTaskRuntime } from "../services/CooperativeTask";

export type RandomReunionCandidate = Pick<MemoRecord, "id" | "createdAt" | "tags" | "dailyRef">;

export interface RandomReunionOptions {
	today?: Date;
	minContentLength?: number;
	blacklistTags?: string[];
	blacklistPathPrefixes?: string[];
	maxPerSourcePath?: number;
	maxPerDate?: number;
	maxPerPrimaryTag?: number;
	random?: () => number;
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
		const createdAt = parseMemoDate(memo.createdAt);
		if (createdAt === null || isSameDay(createdAt, today)) {
			return false;
		}
		if (getComparableContentLength(memo.contentSnapshot) < minContentLength) {
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
	const createdAt = parseMemoDate(memo.createdAt);
	const todayStart = startOfDay(today);
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
		: parseDatePart(reviewState.lastReviewedAt);
	if (lastReviewedAt !== null) {
		const daysSinceReview = differenceInDays(todayStart, startOfDay(lastReviewedAt));
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
	if (limit === 0) return [];
	const control = new CooperativeYieldController(runtime);
	const work = sampleWeighted(candidates, (memo) => calculateRandomReunionWeight(memo, reviews[memo.id], options.today),
		options.random ?? Math.random);
	const selected: T[] = [];
	const rejected: T[] = [];
	const ids = new Set<string>();
	const sources = new Map<string, number>();
	const dates = new Map<string, number>();
	const tags = new Map<string, number>();
	for (const memo of work) {
		if (memo !== undefined && canUseDiverseMemo(memo, sources, dates, tags, options.maxPerSourcePath ?? DEFAULT_DIVERSITY_LIMIT,
			options.maxPerDate ?? DEFAULT_DIVERSITY_LIMIT, options.maxPerPrimaryTag ?? DEFAULT_DIVERSITY_LIMIT)) {
			selected.push(memo); ids.add(memo.id); incrementDiversityCounts(memo, sources, dates, tags);
		} else if (memo !== undefined) {
			rejected.push(memo);
		}
		if (selected.length >= limit) break;
		if (control.shouldYield()) await control.yieldNow();
	}
	for (const memo of rejected) {
		if (selected.length >= limit) break;
		if (!ids.has(memo.id)) { selected.push(memo); ids.add(memo.id); }
		if (control.shouldYield()) await control.yieldNow();
	}
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
	const dateKey = getMemoDateKey(memo);
	const primaryTag = getPrimaryTag(memo.tags);
	return (
		(sourceCounts.get(sourcePath) ?? 0) < maxPerSourcePath &&
		(dateKey === null || (dateCounts.get(dateKey) ?? 0) < maxPerDate) &&
		(primaryTag === null || (tagCounts.get(primaryTag) ?? 0) < maxPerPrimaryTag)
	);
}

function incrementDiversityCounts(
	memo: RandomReunionCandidate,
	sourceCounts: Map<string, number>,
	dateCounts: Map<string, number>,
	tagCounts: Map<string, number>,
): void {
	const sourcePath = memo.dailyRef.path;
	const dateKey = getMemoDateKey(memo);
	const primaryTag = getPrimaryTag(memo.tags);
	sourceCounts.set(sourcePath, (sourceCounts.get(sourcePath) ?? 0) + 1);
	if (dateKey !== null) {
		dateCounts.set(dateKey, (dateCounts.get(dateKey) ?? 0) + 1);
	}
	if (primaryTag !== null) {
		tagCounts.set(primaryTag, (tagCounts.get(primaryTag) ?? 0) + 1);
	}
}

function getMemoDateKey(memo: RandomReunionCandidate): string | null {
	const date = parseMemoDate(memo.createdAt);
	return date === null ? null : formatDatePart(date);
}

function getPrimaryTag(tags: string[]): string | null {
	const firstTag = tags[0] ?? null;
	if (firstTag === null) {
		return null;
	}
	const normalizedTag = firstTag.replace(/^#/, "").toLowerCase();
	return normalizedTag.split("/")[0] ?? null;
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

function parseMemoDate(value: string): Date | null {
	const date = new Date(value);
	return Number.isNaN(date.getTime()) ? null : date;
}

function parseDatePart(value: string): Date | null {
	const match = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
	if (match === null) {
		return null;
	}
	const year = Number(match[1]);
	const month = Number(match[2]);
	const day = Number(match[3]);
	const date = new Date(year, month - 1, day);
	if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) {
		return null;
	}
	return date;
}

function startOfDay(date: Date): Date {
	return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function isSameDay(first: Date, second: Date): boolean {
	return formatDatePart(first) === formatDatePart(second);
}

function differenceInDays(later: Date, earlier: Date): number {
	return Math.floor((later.getTime() - earlier.getTime()) / 86400000);
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
