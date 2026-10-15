import type { MemoObservation, ObservationHandle } from "../types/catalog";
import type { PreparedDailyWrite } from "./DailyMemoWriteGateway";

// 仅描述一次已确认提交的展示变化，不持久化，也不授权继续旧编辑或排队写入。
export interface DailyMemoPresentationChange {
	sourcePath: string;
	beforeSourceRevision: string;
	sourceRevision: string;
	logicalDate: string;
	replacements: ReadonlyArray<{ before: ObservationHandle; after: ObservationHandle | null }>;
	inserted: ObservationHandle | null;
	changed: ObservationHandle | null;
}

export interface ConfirmedDailyMemoPresentation {
	change: DailyMemoPresentationChange;
	observations: readonly MemoObservation[];
}

export function observationHandleKey(handle: Pick<ObservationHandle, "sourcePath" | "sourceRevision" | "startLine">): string {
	return handle.sourcePath + "\0" + String(handle.startLine).padStart(10, "0") + "\0" + handle.sourceRevision;
}

export function buildDailyMemoPresentationChange(
	prepared: PreparedDailyWrite,
	changedBefore: MemoObservation | null,
	changedAfter: MemoObservation | null,
): DailyMemoPresentationChange {
	const before = prepared.before.observations.filter(memo => !sameObservation(memo, changedBefore));
	const after = prepared.after.observations.filter(memo => !sameObservation(memo, changedAfter));
	// 提交只替换/插入/删除指定区间；其余 occurrence 按原顺序对应，hash 只复核未变的 raw block。
	const unchanged = before.length === after.length && before.every((memo, index) => {
		const next = after[index];
		return memo.rawBlockHash === next.rawBlockHash && memo.time === next.time
			&& memo.logicalDate === next.logicalDate && memo.section === next.section;
	});
	const retained = new Map(before.map((memo, index) => [
		observationHandleKey(memo), unchanged ? after[index] : null,
	]));
	return {
		sourcePath: prepared.sourcePath,
		beforeSourceRevision: prepared.before.sourceRevision,
		sourceRevision: prepared.after.sourceRevision,
		logicalDate: prepared.logicalDate,
		replacements: prepared.before.observations.map(memo => ({
			before: toHandle(memo),
			after: toHandleOrNull(sameObservation(memo, changedBefore) ? changedAfter : retained.get(observationHandleKey(memo)) ?? null),
		})),
		inserted: changedBefore === null ? toHandleOrNull(changedAfter) : null,
		changed: toHandleOrNull(changedAfter),
	};
}

function sameObservation(memo: MemoObservation, other: MemoObservation | null): boolean {
	return other !== null && memo.sourcePath === other.sourcePath && memo.sourceRevision === other.sourceRevision
		&& memo.startLine === other.startLine && memo.endLine === other.endLine && memo.rawBlockHash === other.rawBlockHash;
}

function toHandleOrNull(memo: MemoObservation | null): ObservationHandle | null {
	return memo === null ? null : toHandle(memo);
}

function toHandle(memo: MemoObservation): ObservationHandle {
	return { sourcePath: memo.sourcePath, sourceRevision: memo.sourceRevision,
		startLine: memo.startLine, endLine: memo.endLine, rawBlockHash: memo.rawBlockHash };
}
