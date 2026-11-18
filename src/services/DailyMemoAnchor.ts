import { sameObservationHandle, type MemoObservation, type ObservationHandle } from "../types/catalog";
import type { MarkdownBlockReferenceResult } from "../types/memoOperations";

export interface DailyAnchorSource {
	path: string;
	logicalDate: string;
	sourceRevision: string;
	observations: readonly MemoObservation[];
	blockAnchors?: Readonly<Record<string, number>>;
}

export class DailyAnchorSourceUnavailableError extends Error {}
export class DailyAnchorSourceUnlocatedError extends Error {}
export class DailyAnchorChangedError extends Error {}
export class DailyAnchorNotSavedError extends Error {}
export class DailyAnchorError extends Error {
	constructor(readonly reason: "missing-id" | "conflicting-id" | "not-memo") { super(reason); }
}

export function findDailyAnchor(source: DailyAnchorSource, blockId: string, index?: ReadonlyMap<string, MemoObservation | null>): MemoObservation {
	if (!source.blockAnchors) throw new DailyAnchorSourceUnavailableError("Complete block anchor counts are required.");
	const count = source.blockAnchors[blockId] ?? 0;
	if (count === 0) throw new DailyAnchorError("missing-id");
	if (count !== 1) throw new DailyAnchorError("conflicting-id");
	const observation = (index ?? indexDailyMemoAnchors(source)).get(blockId);
	if (!observation) throw new DailyAnchorError("not-memo");
	return observation;
}

export function indexDailyMemoAnchors(source: DailyAnchorSource): ReadonlyMap<string, MemoObservation | null> {
	const index = new Map<string, MemoObservation | null>();
	for (const memo of source.observations) if (memo.existingBlockId) {
		index.set(memo.existingBlockId, index.has(memo.existingBlockId) ? null : memo);
	}
	return index;
}

export async function confirmDailyAnchor(
	original: ObservationHandle, result: MarkdownBlockReferenceResult,
	readSource: (path: string) => Promise<DailyAnchorSource>,
	isSourceCurrent: (source: DailyAnchorSource) => Promise<boolean>,
): Promise<{ source: DailyAnchorSource; observation: MemoObservation }> {
	const source = await readSource(original.sourcePath);
	if (!result.observation || source.sourceRevision !== result.observation.sourceRevision) {
		throw new DailyAnchorNotSavedError("Save the Daily note and select its current card again.");
	}
	const observation = findDailyAnchor(source, result.blockId);
	if (source.path !== original.sourcePath || !sameObservationHandle(result.observation, observation)
		|| !await isSourceCurrent(source)) throw new DailyAnchorChangedError("Daily source changed.");
	return { source, observation };
}
