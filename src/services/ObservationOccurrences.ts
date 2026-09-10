import type { MemoObservation } from "../types/catalog";

type MemoSignature = Pick<MemoObservation, "sourcePath" | "logicalDate" | "section" | "time" | "contentHash">;

// 只统计当前文件中的同文 occurrence，不建立跨版本身份。
function observationContentGroup(value: MemoSignature): string {
	return JSON.stringify([value.sourcePath.replace(/\\/gu, "/"), value.logicalDate, value.section, value.time, value.contentHash]);
}

export function assignObservationOccurrences(observations: MemoObservation[]): void {
	const groups = new Map<string, MemoObservation[]>();
	for (const observation of observations) {
		const key = observationContentGroup(observation);
		const group = groups.get(key) ?? [];
		group.push(observation);
		groups.set(key, group);
	}
	for (const group of groups.values()) {
		group.forEach((observation, index) => {
			observation.occurrenceIndex = index;
			observation.occurrenceCount = group.length;
		});
	}
}
