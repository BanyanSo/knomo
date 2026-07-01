import {
	replaceMarkdownTaskMarkerByIndex,
	type WritableMarkdownTaskMarker,
} from "../utils/markdownTasks";

export type MemoTaskCheckboxChangePlan =
	| { type: "sync-dom" }
	| {
		type: "apply";
		marker: WritableMarkdownTaskMarker;
		nextContent: string;
		shouldEnqueue: boolean;
	};

export function getMemoTaskCheckboxChangePlan(
	latestContent: string,
	taskIndex: number,
	checked: boolean,
): MemoTaskCheckboxChangePlan {
	const marker: WritableMarkdownTaskMarker = checked ? "x" : " ";
	const nextContent = replaceMarkdownTaskMarkerByIndex(latestContent, taskIndex, marker);
	if (nextContent === null) {
		return { type: "sync-dom" };
	}
	return {
		type: "apply",
		marker,
		nextContent,
		shouldEnqueue: nextContent !== latestContent,
	};
}
