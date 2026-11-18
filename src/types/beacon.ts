import type { ObservationHandle } from "./catalog";
import type { MemoViewItem } from "./memoView";

export interface BeaconReference {
	sourcePath: string;
	blockId: string;
	memoTime: string;
}

export interface BeaconSnapshot {
	state: "unset" | "locating" | "ready" | "unavailable";
	reason?: "unreadable" | "unlocated" | "missing-id" | "conflicting-id" | "not-memo";
	memo?: MemoViewItem;
	// 仅在当前 runtime 等待改名前的可见卡片退出，不落盘。
	previousSources?: ReadonlyArray<{ sourcePath: string; sourceRevision: string }>;
	// 控件只可操作其呈现时的选择；此代数仅在当前 runtime 有效。
	selection: number;
}

export function sameBeaconHandle(left: ObservationHandle, right: ObservationHandle): boolean {
	return left.sourcePath === right.sourcePath && left.sourceRevision === right.sourceRevision
		&& left.startLine === right.startLine && left.endLine === right.endLine && left.rawBlockHash === right.rawBlockHash;
}
