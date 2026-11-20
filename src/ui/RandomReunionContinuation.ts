import type { MemoObservation, ObservationHandle } from "../types/catalog";
import type { MemoViewItem } from "../types/memoView";
import type { DiaryMemoParseResult } from "../services/DiaryMemoParser";
import { observationHandleKey, type ConfirmedDailyMemoPresentation, type DailyMemoBodyProof } from "../services/DailyMemoPresentationChange";

export interface RandomReunionFileProof {
	sourcePath: string;
	sourceRevision: string;
	logicalDate: string;
	body: DailyMemoBodyProof;
	observationCount?: number;
	members: ReadonlyMap<string, MemoObservation>;
}

// 依据来自本组所在文件的已确认提交；整份正文相等才允许按相对区间接续展示。
export function captureRandomReunionFileProof(
	presentation: ConfirmedDailyMemoPresentation, memos: readonly MemoViewItem[],
): RandomReunionFileProof | null {
	const { change, bodyProof } = presentation;
	if (!bodyProof || !change.changed || change.inserted || (!change.updateExistingOnly
		&& !memos.some(memo => memo.id === observationHandleKey(change.changed!)))) return null;
	const observations = new Map(presentation.observations.map(memo => [observationHandleKey(memo), memo]));
	const members = new Map<string, MemoObservation>();
	for (const memo of memos) {
		if (memo.dailyRef.path !== change.sourcePath) continue;
		const observation = observations.get(memo.id);
		if (!observation || observation.logicalDate !== change.logicalDate || !sameHandle(observation, memo.catalog?.observationHandle)) return null;
		members.set(memo.id, observation);
	}
	if (!members.size) return null;
	return { sourcePath: change.sourcePath, sourceRevision: change.sourceRevision, logicalDate: change.logicalDate,
		body: bodyProof, observationCount: presentation.observations.length, members };
}

export function matchRandomReunionFileProof(
	proof: RandomReunionFileProof, parsed: DiaryMemoParseResult, body: DailyMemoBodyProof | undefined,
): Map<string, ObservationHandle> | null {
	if (!body || body.digest !== proof.body.digest
		|| proof.observationCount !== undefined && parsed.observations.length !== proof.observationCount) return null;
	const byLine = new Map(parsed.observations.map(memo => [memo.startLine, memo]));
	const changes = new Map<string, ObservationHandle>();
	for (const [id, previous] of proof.members) {
		const current = byLine.get(previous.startLine - proof.body.startLine + body.startLine);
		if (!current || current.sourcePath !== proof.sourcePath || current.logicalDate !== proof.logicalDate
			|| current.endLine - body.startLine !== previous.endLine - proof.body.startLine
			|| current.rawBlockHash !== previous.rawBlockHash || current.section !== previous.section || current.time !== previous.time) return null;
		changes.set(id, { sourcePath: current.sourcePath, sourceRevision: current.sourceRevision,
			startLine: current.startLine, endLine: current.endLine, rawBlockHash: current.rawBlockHash });
	}
	return changes;
}

function sameHandle(left: ObservationHandle, right: ObservationHandle | undefined): boolean {
	return right !== undefined && left.sourcePath === right.sourcePath && left.sourceRevision === right.sourceRevision
		&& left.startLine === right.startLine && left.endLine === right.endLine && left.rawBlockHash === right.rawBlockHash;
}
