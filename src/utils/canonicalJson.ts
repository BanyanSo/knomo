import { isRecord } from "./object";

export function canonicalJson(value: unknown): string {
	return JSON.stringify(toCanonicalValue(value));
}

function toCanonicalValue(value: unknown): unknown {
	if (value === null || typeof value === "string" || typeof value === "boolean") return value;
	if (typeof value === "number") {
		if (!Number.isFinite(value)) throw new Error("Canonical JSON rejects non-finite numbers.");
		return value;
	}
	if (Array.isArray(value)) return value.map(toCanonicalValue);
	if (isRecord(value)) {
		const result: Record<string, unknown> = {};
		for (const key of Object.keys(value).sort(compareText)) {
			const item = value[key];
			if (item === undefined) throw new Error("Canonical JSON rejects undefined values.");
			result[key] = toCanonicalValue(item);
		}
		return result;
	}
	throw new Error(`Canonical JSON rejects ${typeof value}.`);
}

function compareText(left: string, right: string): number { return left < right ? -1 : left > right ? 1 : 0; }
