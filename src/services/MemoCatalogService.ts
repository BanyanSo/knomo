import type {
	CatalogFileAggregate,
	CatalogFilePartition,
	CatalogFileRecord,
	CatalogInventoryEntry,
	CatalogObservation,
	CatalogQuery,
	MemoObservation,
} from "../types/catalog";
import { extractDailyExplicitReferenceTargets } from "./DiaryMemoParser";
import type { MemoCatalogStore } from "./MemoCatalogStore";
import type { CatalogChangeCursor } from "./CatalogFileChanges";
export type { CatalogChangeCursor } from "./CatalogFileChanges";
import { normalizeCatalogText } from "./MemoCatalogStore";
import { buildSearchBody } from "./SearchDocument";
import { CooperativeYieldController } from "./CooperativeTask";
import type { CooperativeTaskRuntime } from "./CooperativeTask";
import { getMemoContentStatsFromContent } from "../utils/memoContentStats";
import { normalizeTagDisplay, normalizeTagKey } from "../utils/tags";
import { collectRelationBlockAnchors, extractMemoRelationTargets } from "../utils/memoRelations";

export interface CatalogPartitionInput {
	blockAnchors?: Record<string, number>;
	inventory: CatalogInventoryEntry;
	sourceRevision: string;
	observations: readonly MemoObservation[];
	parserVersion: number;
	settingsFingerprint: string;
	auditedAt: number;
}

export interface CatalogPartitionRuntime extends CooperativeTaskRuntime {
	isCurrent: () => boolean;
}

export class MemoCatalogService {
	private readonly changeListeners = new Set<(path?: string, file?: CatalogFileRecord) => void>();
	onChange(listener: (path?: string, file?: CatalogFileRecord) => void): () => void {
		this.changeListeners.add(listener);
		return () => this.changeListeners.delete(listener);
	}
	private changed(path?: string, file?: CatalogFileRecord): void {
		for (const listener of this.changeListeners) {
			try { listener(path, file); } catch (error) { console.error("Knomo Catalog change listener failed", error); }
		}
	}
	constructor(private readonly store: MemoCatalogStore) {}

	open(): Promise<void> {
		return this.store.open();
	}

	close(): void {
		this.changed();
		this.changeListeners.clear();
		this.store.close();
	}

	async replaceFile(input: CatalogPartitionInput, runtime?: CatalogPartitionRuntime): Promise<number | null> {
		if (runtime?.isCurrent() === false) return null;
		const partition = runtime === undefined ? buildCatalogPartition(input) : await buildCatalogPartitionCooperatively(input, runtime);
		if (runtime?.isCurrent() === false) return null;
		const revision = await this.store.replaceFilePartition(partition);
		this.changed(partition.file.sourcePath, partition.file);
		return revision;
	}

	async deleteFile(sourcePath: string): Promise<number> {
		const revision = await this.store.deleteFilePartition(sourcePath);
		this.changed(sourcePath);
		return revision;
	}

	query(request: CatalogQuery, signal?: AbortSignal) {
		return this.store.query(request, signal);
	}

	count(request: Omit<CatalogQuery, "limit" | "cursor">, signal?: AbortSignal) {
		return this.store.count(request, signal);
	}

	getObservation(observationKey: string) {
		return this.store.getObservation(observationKey);
	}

	readObservationSnapshot(observationKeys: readonly string[], signal?: AbortSignal) {
		return this.store.readObservationSnapshot(observationKeys, signal);
	}

	getFileRevisionBatch(sourcePath: string) {
		return this.store.getFileRevisionBatch(sourcePath);
	}

	listFiles() {
		return this.store.listFiles();
	}

	listDailyAggregates(fromDate?: string, toDate?: string) {
		return this.store.listDailyAggregates(fromDate, toDate);
	}
	readAggregateSnapshot() { return this.store.readAggregateSnapshot(); }

	readFileChangesSince(previous?: CatalogChangeCursor) { return this.store.readFileChangesSince(previous); }

	getStore(): MemoCatalogStore {
		return this.store;
	}
}

export function buildCatalogPartition(input: CatalogPartitionInput): CatalogFilePartition {
	const partition = createCatalogPartition(input);
	for (const observation of input.observations) appendCatalogObservation(partition, observation);
	return partition;
}

// 搜索正文、token 和聚合一起分片；准备完成后才由调用方开启写事务。
export async function buildCatalogPartitionCooperatively(input: CatalogPartitionInput, runtime: CooperativeTaskRuntime): Promise<CatalogFilePartition> {
	const partition = createCatalogPartition(input);
	const controller = new CooperativeYieldController(runtime);
	for (const observation of input.observations) {
		appendCatalogObservation(partition, observation);
		if (controller.shouldYield()) await controller.yieldNow();
	}
	return partition;
}

function createCatalogPartition(input: CatalogPartitionInput): CatalogFilePartition {
	const file: CatalogFileRecord = {
		relations: { anchors: input.blockAnchors ?? {}, nodes: [] },
		sourcePath: input.inventory.sourcePath,
		sourceRevision: input.sourceRevision,
		logicalDate: input.inventory.logicalDate,
		mtime: input.inventory.mtime,
		size: input.inventory.size,
		parserVersion: input.parserVersion,
		settingsFingerprint: input.settingsFingerprint,
		observationCount: 0,
		observationKeys: [],
		auditedAt: input.auditedAt,
	};
	// 非扫描调用也可构建完整分区；生产扫描传入整份 Daily 的锚点计数。
	if (input.blockAnchors === undefined) for (const memo of input.observations) {
		for (const [id, count] of Object.entries(collectRelationBlockAnchors(memo.content))) file.relations!.anchors[id] = (file.relations!.anchors[id] ?? 0) + count;
		if (memo.existingBlockId) file.relations!.anchors[memo.existingBlockId] = (file.relations!.anchors[memo.existingBlockId] ?? 0) + 1;
	}
	return { file, observations: [], aggregate: createFileAggregate(file) };
}

function appendCatalogObservation(partition: CatalogFilePartition, source: MemoObservation): void {
	const observation = buildCatalogObservation(source);
	partition.observations.push(observation);
	const { sourcePath, sourceRevision, startLine, endLine, rawBlockHash } = source;
	partition.file.relations!.nodes.push({ handle: { sourcePath, sourceRevision, startLine, endLine, rawBlockHash },
		logicalDate: source.logicalDate, time: source.time, blockId: source.relationBlockId === undefined ? source.existingBlockId : source.relationBlockId,
		targets: extractMemoRelationTargets(source.content) });
	partition.file.observationKeys!.push(observation.observationKey);
	partition.file.observationCount++;
	addFileAggregateObservation(partition.aggregate, observation);
}

export function buildCatalogObservation(observation: MemoObservation): CatalogObservation {
	const linkTargets = dedupe(observation.links.map((link) => normalizeCatalogText(link.target)));
	const imagePaths = dedupe(observation.images.map((image) => normalizeCatalogText(image.path)));
	const explicitReferenceTargets = extractDailyExplicitReferenceTargets(observation.content);
	const searchBody = buildSearchBody(observation.content);
	const searchValues = [...searchBody, ...observation.tags.map(normalizeCatalogText), ...linkTargets, ...imagePaths];
	return {
		...observation,
		observationKey: `${observation.sourcePath}\0${observation.startLine.toString().padStart(10, "0")}`,
		createdAtKey: `${observation.logicalDate}T${normalizeMemoTime(observation.time)}`,
		searchBody,
		searchTokens: [...new Set(searchValues.flatMap(buildCatalogSearchTokens))],
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
	const tokens = new Set<string>();
	for (const word of words) {
		tokens.add(word);
		const characters = [...word];
		for (let index = 0; index + 2 < characters.length; index += 1) {
			tokens.add(characters.slice(index, index + 3).join(""));
		}
		// 混排词段也必须包含连续汉字的短 token，否则候选索引会漏掉真实子串。
		for (const run of word.match(/\p{Script=Han}+/gu) ?? []) {
			const han = [...run];
			for (let index = 0; index < han.length; index += 1) {
				tokens.add(han[index]);
				if (index + 1 < han.length) {
					tokens.add(`${han[index]}${han[index + 1]}`);
				}
			}
		}
	}
	return [...tokens];
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

function createFileAggregate(file: CatalogFileRecord): CatalogFileAggregate {
	return {
		sourcePath: file.sourcePath, logicalDate: file.logicalDate, memoCount: 0,
		tagCount: 0, linkCount: 0, imageCount: 0, taskCount: 0, timeBuoyCount: 0,
		explicitReferenceCount: 0, explicitReferenceMemoCount: 0, explicitReferenceTargets: [],
		wordCount: 0, imageMemoCount: 0, taggedMemoCount: 0, untaggedMemoCount: 0,
		hourCounts: Array.from({ length: 24 }, () => 0), tagMemoCounts: {}, tagDisplayNames: {},
	};
}

function addFileAggregateObservation(aggregate: CatalogFileAggregate, observation: CatalogObservation): void {
	aggregate.memoCount++;
	aggregate.tagCount += observation.tags.length;
	aggregate.linkCount += observation.links.length;
	aggregate.imageCount += observation.images.length;
	aggregate.taskCount += observation.tasks.length;
	aggregate.timeBuoyCount += observation.timeBuoyDates.length;
	aggregate.explicitReferenceCount += observation.explicitReferenceTargets.length;
	aggregate.explicitReferenceMemoCount += observation.explicitReferenceTargets.length > 0 ? 1 : 0;
	aggregate.wordCount += getMemoContentStatsFromContent(observation.content, observation.explicitReferenceTargets.length > 0).wordCount;
	aggregate.imageMemoCount += observation.images.length > 0 ? 1 : 0;
	aggregate.taggedMemoCount += observation.tagKeys.length > 0 ? 1 : 0;
	aggregate.untaggedMemoCount += observation.tagKeys.length === 0 ? 1 : 0;
	for (const target of observation.explicitReferenceTargets) pushUnique(aggregate.explicitReferenceTargets, target);
	for (const key of observation.tagKeys) aggregate.tagMemoCounts[key] = (aggregate.tagMemoCounts[key] ?? 0) + 1;
	for (const tag of observation.tags) {
		const key = normalizeTagKey(tag), display = normalizeTagDisplay(tag);
		if (key.length > 0 && display.length > 0 && aggregate.tagDisplayNames[key] === undefined) aggregate.tagDisplayNames[key] = display;
	}
	const hour = Number.parseInt(observation.time.slice(0, 2), 10);
	if (Number.isInteger(hour) && hour >= 0 && hour < aggregate.hourCounts.length) aggregate.hourCounts[hour]++;
}

function normalizeMemoTime(time: string): string {
	return time.length === 5 ? `${time}:00` : time;
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
