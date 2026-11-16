import type { BeaconSnapshot } from "../types/beacon";
import { sameBeaconHandle } from "../types/beacon";
import type { MemoViewItem } from "../types/memoView";

export function buildBeaconPresentation(snapshot: BeaconSnapshot, memos: readonly MemoViewItem[]): {
	memos: MemoViewItem[]; snapshot: BeaconSnapshot;
} {
	const beacon = snapshot.state === "ready" ? snapshot.memo : undefined;
	const handle = beacon?.catalog?.observationHandle;
	if (!beacon || !handle) return { memos: [...memos], snapshot };
	// 相关可见列表尚有旧源卡时先等待，不能同时展示旧正文与新版灯标。
	if (memos.some(memo => memo.catalog && (snapshot.previousSources?.some(source => source.sourcePath === memo.catalog!.observationHandle.sourcePath
		&& source.sourceRevision === memo.catalog!.observationHandle.sourceRevision) && memo.catalog.observationHandle.sourcePath !== handle.sourcePath
		|| memo.catalog.observationHandle.sourcePath === handle.sourcePath && memo.catalog.observationHandle.sourceRevision !== handle.sourceRevision))) {
		return { memos: [...memos], snapshot: { ...snapshot, state: "locating", memo: undefined } };
	}
	return { snapshot, memos: [beacon, ...memos.filter(memo => !memo.catalog || !sameBeaconHandle(memo.catalog.observationHandle, handle))] };
}
