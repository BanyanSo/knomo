import type { MemoObservation } from "../types/catalog";
import type { IdentityLedgerObservationEvidence } from "../types/identityLedger";

type MemoSignature = Pick<MemoObservation, "sourcePath" | "logicalDate" | "section" | "time" | "contentHash">;

// 文件版本与行号只属于当前扫描句柄，不参与身份候选分组。
export function memoObservationSignature(value: MemoSignature): string {
	return JSON.stringify([value.sourcePath.replace(/\\/gu, "/"), value.logicalDate, value.section, value.time, value.contentHash]);
}

export function assignObservationOccurrences(observations: MemoObservation[]): void {
	const groups = new Map<string, MemoObservation[]>();
	for (const observation of observations) {
		const key = memoObservationSignature(observation);
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

const ORDER_DIGITS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

// 在相邻位置之间分配新位置，已有 Memo 不重编号；字符串比较不依赖设备 locale。
export function identityOrderBetween(lower: string | null, upper: string | null): string {
	if (lower !== null && upper !== null && lower >= upper) throw new Error("Ambiguous identity order.");
	let result = "";
	for (let index = 0; ; index += 1) {
		const left = index < (lower?.length ?? 0) ? ORDER_DIGITS.indexOf(lower![index]!) : 0;
		const right = index < (upper?.length ?? 0) ? ORDER_DIGITS.indexOf(upper![index]!) : ORDER_DIGITS.length;
		if (right - left > 1) return result + ORDER_DIGITS[Math.floor((left + right) / 2)];
		result += ORDER_DIGITS[left];
		if (left < right) upper = null;
	}
}

export function initialIdentityOrder(index: number): string {
	return (index + 1).toString(16).padStart(14, "0") + "V";
}

export function observationIdentityEvidence(
	observation: MemoObservation,
	order = initialIdentityOrder(observation.occurrenceIndex),
): IdentityLedgerObservationEvidence {
	return {
		sourcePath: observation.sourcePath.replace(/\\/gu, "/"),
		logicalDate: observation.logicalDate,
		section: observation.section,
		time: observation.time,
		contentHash: observation.contentHash,
		order,
	};
}
