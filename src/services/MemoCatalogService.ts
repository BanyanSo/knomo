import type {
	CatalogFileAggregate,
	CatalogFilePartition,
	CatalogFileRecord,
	CatalogInventoryEntry,
	CatalogObservation,
	CatalogQuery,
	MemoObservation,
} from "../types/catalog";
import { extractDailyExplicitReferenceTargets, getIndexableDiaryMemoContent } from "./DiaryMemoParser";
import type { MemoCatalogStore } from "./MemoCatalogStore";
import { normalizeCatalogText } from "./MemoCatalogStore";
import { getMemoContentStatsFromContent } from "../utils/memoContentStats";
import { normalizeTagDisplay, normalizeTagKey } from "../utils/tags";

export interface CatalogPartitionInput {
	inventory: CatalogInventoryEntry;
	sourceRevision: string;
	observations: readonly MemoObservation[];
	parserVersion: number;
	settingsFingerprint: string;
	auditedAt: number;
}

export class MemoCatalogService {
	constructor(private readonly store: MemoCatalogStore) {}

	open(): Promise<void> {
		return this.store.open();
	}

	close(): void {
		this.store.close();
	}

	async replaceFile(input: CatalogPartitionInput): Promise<number> {
		return this.store.replaceFilePartition(buildCatalogPartition(input));
	}

	async replaceFiles(inputs: readonly CatalogPartitionInput[]): Promise<number> {
		return this.store.replaceFilePartitions(inputs.map(buildCatalogPartition));
	}

	deleteFile(sourcePath: string): Promise<number> {
		return this.store.deleteFilePartition(sourcePath);
	}

	query(request: CatalogQuery) {
		return this.store.query(request);
	}

	getObservation(observationKey: string) {
		return this.store.getObservation(observationKey);
	}

	getFileRevisionBatch(sourcePath: string) {
		return this.store.getFileRevisionBatch(sourcePath);
	}

	listFiles() {
		return this.store.listFiles();
	}

	loadResolutionSnapshot() {
		return this.store.loadResolutionSnapshot();
	}

	saveResolutionSnapshot(snapshot: import("../types/catalog").CatalogResolutionSnapshot) {
		return this.store.saveResolutionSnapshot(snapshot);
	}

	listDailyAggregates(fromDate?: string, toDate?: string) {
		return this.store.listDailyAggregates(fromDate, toDate);
	}

	getStore(): MemoCatalogStore {
		return this.store;
	}
}

export function buildCatalogPartition(input: CatalogPartitionInput): CatalogFilePartition {
	const observations = input.observations.map(buildCatalogObservation);
	const file: CatalogFileRecord = {
		sourcePath: input.inventory.sourcePath,
		sourceRevision: input.sourceRevision,
		logicalDate: input.inventory.logicalDate,
		mtime: input.inventory.mtime,
		size: input.inventory.size,
		parserVersion: input.parserVersion,
		settingsFingerprint: input.settingsFingerprint,
		observationCount: observations.length,
		observationKeys: observations.map((observation) => observation.observationKey),
		auditedAt: input.auditedAt,
	};
	return {
		file,
		observations,
		aggregate: buildFileAggregate(file, observations),
	};
}

export function buildCatalogObservation(observation: MemoObservation): CatalogObservation {
	const linkTargets = dedupe(observation.links.map((link) => normalizeCatalogText(link.target)));
	const imagePaths = dedupe(observation.images.map((image) => normalizeCatalogText(image.path)));
	const explicitReferenceTargets = extractDailyExplicitReferenceTargets(observation.content);
	const searchText = normalizeCatalogText([
		getIndexableDiaryMemoContent(observation.content),
		...observation.tags,
		...linkTargets,
		...imagePaths,
	].join(" "));
	return {
		...observation,
		observationKey: `${observation.sourcePath}\0${observation.startLine.toString().padStart(10, "0")}`,
		createdAtKey: `${observation.logicalDate}T${normalizeMemoTime(observation.time)}`,
		searchText,
		searchTokens: buildCatalogSearchTokens(searchText),
		tagKeys: dedupe(observation.tags.map(normalizeTagKey)),
		linkTargets,
		imagePaths,
		explicitReferenceTargets,
		hasLink: linkTargets.length > 0 ? 1 : 0,
		hasImage: imagePaths.length > 0 ? 1 : 0,
		hasTask: observation.tasks.length > 0 ? 1 : 0,
		hasTimeBuoy: observation.timeBuoyDates.length > 0 ? 1 : 0,
	};
}

export function buildCatalogSearchTokens(normalizedText: string): string[] {
	const words = normalizedText.match(/[\p{L}\p{N}_-]+/gu) ?? [];
	const tokens: string[] = [];
	for (const word of words) {
		pushUnique(tokens, word);
		const characters = [...word];
		for (let index = 0; index + 2 < characters.length; index += 1) {
			pushUnique(tokens, characters.slice(index, index + 3).join(""));
		}
		if (characters.every((character) => /\p{Script=Han}/u.test(character))) {
			for (let index = 0; index < characters.length; index += 1) {
				pushUnique(tokens, characters[index]);
				if (index + 1 < characters.length) {
					pushUnique(tokens, `${characters[index]}${characters[index + 1]}`);
				}
			}
		}
	}
	return tokens;
}

export function selectCatalogSearchToken(query: string): string | null {
	const normalized = normalizeCatalogText(query);
	const words = normalized.match(/[\p{L}\p{N}_-]+/gu) ?? [];
	if (words.length === 0) {
		return null;
	}
	const candidates = [...words].sort((left, right) => [...right].length - [...left].length);
	const trigraphCandidate = candidates.find((word) => [...word].length >= 3);
	if (trigraphCandidate !== undefined) {
		return [...trigraphCandidate].slice(0, 3).join("");
	}
	const first = candidates[0] ?? "";
	const chars = [...first];
	if (chars.every((character) => /\p{Script=Han}/u.test(character))) {
		return chars.length >= 2 ? `${chars[0]}${chars[1]}` : (chars[0] ?? null);
	}
	return null;
}

function buildFileAggregate(file: CatalogFileRecord, observations: readonly CatalogObservation[]): CatalogFileAggregate {
	const explicitReferenceTargets: string[] = [];
	const tagMemoCounts: Record<string, number> = {};
	const tagDisplayNames: Record<string, string> = {};
	const hourCounts = Array.from({ length: 24 }, () => 0);
	for (const observation of observations) {
		for (const target of observation.explicitReferenceTargets) {
			pushUnique(explicitReferenceTargets, target);
		}
		for (const key of observation.tagKeys) {
			tagMemoCounts[key] = (tagMemoCounts[key] ?? 0) + 1;
		}
		for (const tag of observation.tags) {
			const key = normalizeTagKey(tag);
			const display = normalizeTagDisplay(tag);
			if (key.length > 0 && display.length > 0 && tagDisplayNames[key] === undefined) tagDisplayNames[key] = display;
		}
		const hour = Number.parseInt(observation.time.slice(0, 2), 10);
		if (Number.isInteger(hour) && hour >= 0 && hour < hourCounts.length) hourCounts[hour] += 1;
	}
	return {
		sourcePath: file.sourcePath,
		logicalDate: file.logicalDate,
		memoCount: observations.length,
		tagCount: sum(observations, (item) => item.tags.length),
		linkCount: sum(observations, (item) => item.links.length),
		imageCount: sum(observations, (item) => item.images.length),
		taskCount: sum(observations, (item) => item.tasks.length),
		timeBuoyCount: sum(observations, (item) => item.timeBuoyDates.length),
		explicitReferenceCount: sum(observations, (item) => item.explicitReferenceTargets.length),
		explicitReferenceMemoCount: sum(observations, (item) => item.explicitReferenceTargets.length > 0 ? 1 : 0),
		explicitReferenceTargets,
		wordCount: sum(observations, (item) => getMemoContentStatsFromContent(
			item.content,
			item.explicitReferenceTargets.length > 0,
		).wordCount),
		imageMemoCount: sum(observations, (item) => item.images.length > 0 ? 1 : 0),
		taggedMemoCount: sum(observations, (item) => item.tagKeys.length > 0 ? 1 : 0),
		untaggedMemoCount: sum(observations, (item) => item.tagKeys.length === 0 ? 1 : 0),
		hourCounts,
		tagMemoCounts,
		tagDisplayNames,
	};
}

function normalizeMemoTime(time: string): string {
	return time.length === 5 ? `${time}:00` : time;
}

function sum<T>(values: readonly T[], getValue: (value: T) => number): number {
	return values.reduce((total, value) => total + getValue(value), 0);
}

function dedupe(values: readonly string[]): string[] {
	const result: string[] = [];
	for (const value of values) {
		pushUnique(result, value);
	}
	return result;
}

function pushUnique(values: string[], value: string): void {
	if (value.length > 0 && !values.includes(value)) {
		values.push(value);
	}
}
