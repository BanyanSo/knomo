import type { ObservationHandle } from "./catalog";
import type { MemoViewItem } from "./memoView";
import type { DailyMemoBodyProof } from "../services/DailyMemoPresentationChange";

export interface BeaconReference {
	handle: ObservationHandle;
	logicalDate: string;
	bodyProof?: DailyMemoBodyProof;
}

export interface BeaconSnapshot {
	state: "unset" | "locating" | "ready" | "unavailable";
	reason?: "unreadable" | "unlocated";
	logicalDate?: string;
	memo?: MemoViewItem;
	// 仅用于当前 runtime 改名过渡时等待旧路径的可见卡片退出，不落盘。
	previousSources?: ReadonlyArray<{ sourcePath: string; sourceRevision: string }>;
	// 控件只可操作其呈现时的选择；此代数仅在当前 runtime 有效。
	selection: number;
}

export function sameBeaconHandle(left: ObservationHandle, right: ObservationHandle): boolean {
	return left.sourcePath === right.sourcePath && left.sourceRevision === right.sourceRevision
		&& left.startLine === right.startLine && left.endLine === right.endLine && left.rawBlockHash === right.rawBlockHash;
}
