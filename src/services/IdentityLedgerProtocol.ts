import { normalizePath } from "obsidian";

import type {
	IdentityLedgerEvent,
	IdentityLedgerObservationEvidence,
	ParsedIdentityLedgerSegment,
} from "../types/identityLedger";
import { isRecord } from "../utils/object";
import { normalizeVaultPath } from "../utils/path";

export const IDENTITY_LEDGER_RELATIVE_ROOT = "_knomo-data/identity/v3";

const WRITER_ID_PATTERN = /^w_[a-f0-9]{32}$/u;
const EVENT_ID_PATTERN = /^e_[a-f0-9]{32}$/u;
const MEMO_ID_PATTERN = /^(?:[a-f0-9]{8}-[a-f0-9]{4}-7[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}|m_[a-f0-9]{32})$/u;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const CONTENT_HASH_PATTERN = /^fnv1a-[a-f0-9]{8}$/u;
const LOGICAL_DATE_PATTERN = /^\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])$/u;
const MEMO_TIME_PATTERN = /^(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?$/u;

export type FillIdentityLedgerRandomBytes = (target: Uint8Array) => void;

export function createIdentityLedgerMemoId(
	now = new Date(),
	fillRandomBytes: FillIdentityLedgerRandomBytes = fillCryptoRandom,
): string {
	const bytes = new Uint8Array(16);
	fillRandomBytes(bytes);
	let timestamp = now.getTime();
	if (!Number.isSafeInteger(timestamp) || timestamp < 0 || timestamp > 0xffffffffffff) {
		throw new Error("Identity Ledger UUIDv7 timestamp is outside the supported range.");
	}
	for (let index = 5; index >= 0; index -= 1) {
		bytes[index] = timestamp % 256;
		timestamp = Math.floor(timestamp / 256);
	}
	bytes[6] = 0x70 | ((bytes[6] ?? 0) & 0x0f);
	bytes[8] = 0x80 | ((bytes[8] ?? 0) & 0x3f);
	const hex = toHex(bytes);
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function createIdentityLedgerWriterId(
	fillRandomBytes: FillIdentityLedgerRandomBytes = fillCryptoRandom,
): string {
	return `w_${createRandomHex(fillRandomBytes)}`;
}

export function createIdentityLedgerEventId(
	fillRandomBytes: FillIdentityLedgerRandomBytes = fillCryptoRandom,
): string {
	return `e_${createRandomHex(fillRandomBytes)}`;
}

export function canonicalIdentityLedgerJson(value: unknown): string {
	return JSON.stringify(toCanonicalValue(value));
}

export function serializeIdentityLedgerSegment(events: readonly IdentityLedgerEvent[]): string {
	if (events.length === 0) throw new Error("Identity Ledger segment must contain at least one event.");
	const writerId = events[0]?.writerId ?? "";
	for (const event of events) {
		assertIdentityLedgerEvent(event);
		if (event.writerId !== writerId) throw new Error("Identity Ledger segment cannot mix writer IDs.");
	}
	return `${events.map(canonicalIdentityLedgerJson).join("\n")}\n`;
}

export async function parseIdentityLedgerSegment(
	rootPath: string,
	path: string,
	content: string | Uint8Array,
): Promise<ParsedIdentityLedgerSegment> {
	const normalizedPath = normalizePath(path);
	const { writerId, expectedDigest } = readSegmentIdentityFromPath(rootPath, normalizedPath);
	const bytes = typeof content === "string" ? new TextEncoder().encode(content) : content;
	const text = typeof content === "string"
		? content
		: new TextDecoder("utf-8", { fatal: true }).decode(content);
	if (text.length === 0 || text.charCodeAt(0) === 0xfeff || !text.endsWith("\n")) {
		throw new Error(`Invalid Identity Ledger segment bytes: ${normalizedPath}`);
	}
	const lines = text.slice(0, -1).split("\n");
	if (lines.some((line) => line.length === 0)) {
		throw new Error(`Identity Ledger segment contains a blank line: ${normalizedPath}`);
	}
	const events = [] as ParsedIdentityLedgerSegment["events"];
	for (const line of lines) {
		const parsed = JSON.parse(line) as unknown;
		assertIdentityLedgerEvent(parsed);
		if (parsed.writerId !== writerId) {
			throw new Error(`Identity Ledger writer path mismatch: ${normalizedPath}`);
		}
		if (canonicalIdentityLedgerJson(parsed) !== line) {
			throw new Error(`Identity Ledger event is not canonical JSON: ${normalizedPath}`);
		}
		events.push({
			event: parsed,
			digest: await sha256Text(line),
			sourcePath: normalizedPath,
		});
	}
	const digest = await sha256Bytes(bytes);
	if (digest !== expectedDigest) {
		throw new Error(`Identity Ledger segment digest mismatch: ${normalizedPath}`);
	}
	return {
		path: normalizedPath,
		writerId,
		digest,
		byteLength: bytes.byteLength,
		events,
	};
}

export function getIdentityLedgerRootPath(knomoDataRoot: string): string {
	return normalizePath(`${normalizeVaultPath(knomoDataRoot)}/${IDENTITY_LEDGER_RELATIVE_ROOT}`);
}

export function getIdentityLedgerWriterSegmentsPath(rootPath: string, writerId: string): string {
	if (!WRITER_ID_PATTERN.test(writerId)) throw new Error("Invalid Identity Ledger writerId.");
	return normalizePath(`${normalizePath(rootPath)}/writers/${writerId}/segments`);
}

export function getIdentityLedgerSegmentPath(
	rootPath: string,
	writerId: string,
	eventId: string,
	digest: string,
): string {
	if (!EVENT_ID_PATTERN.test(eventId) || !SHA256_PATTERN.test(digest)) {
		throw new Error("Invalid Identity Ledger segment identity.");
	}
	return normalizePath(`${getIdentityLedgerWriterSegmentsPath(rootPath, writerId)}/segment-${eventId}-${digest}.jsonl`);
}

export async function sha256IdentityLedgerText(value: string): Promise<string> {
	return sha256Bytes(new TextEncoder().encode(value));
}

export function toIdentityLedgerObservationEvidence(
	observation: IdentityLedgerObservationEvidence,
): IdentityLedgerObservationEvidence {
	return {
		sourcePath: normalizePath(observation.sourcePath),
		sourceRevision: observation.sourceRevision,
		rawBlockHash: observation.rawBlockHash,
		logicalDate: observation.logicalDate,
		section: observation.section,
		startLine: observation.startLine,
		endLine: observation.endLine,
		time: observation.time,
		contentHash: observation.contentHash,
	};
}

export function assertIdentityLedgerEvent(value: unknown): asserts value is IdentityLedgerEvent {
	if (!isRecord(value)
		|| !hasExactKeys(value, ["schemaVersion", "eventId", "writerId", "memoId", "type", "baseBindingId", "occurredAt", "evidence"])
		|| value.schemaVersion !== 1
		|| !EVENT_ID_PATTERN.test(readString(value.eventId))
		|| !WRITER_ID_PATTERN.test(readString(value.writerId))
		|| !MEMO_ID_PATTERN.test(readString(value.memoId))
		|| (value.baseBindingId !== null && !EVENT_ID_PATTERN.test(readString(value.baseBindingId)))
		|| !isValidDateTime(value.occurredAt)
		|| !isRecord(value.evidence)) {
		throw new Error("Invalid Identity Ledger event.");
	}
	const evidence = value.evidence;
	switch (value.type) {
		case "create_intent":
			if (!hasExactKeys(evidence, ["targetPath", "logicalDate", "time", "contentHash", "sourceMemoId"])
				|| value.baseBindingId !== null
				|| (evidence.targetPath !== null && !isVaultPath(evidence.targetPath))
				|| !isLogicalDate(evidence.logicalDate)
				|| !MEMO_TIME_PATTERN.test(readString(evidence.time))
				|| !CONTENT_HASH_PATTERN.test(readString(evidence.contentHash))
				|| (evidence.sourceMemoId !== null && !MEMO_ID_PATTERN.test(readString(evidence.sourceMemoId)))) {
				throw new Error("Invalid Identity Ledger event.");
			}
			return;
		case "claim":
			if (!hasExactKeys(evidence, ["observation", "createIntentEventId"])
				|| value.baseBindingId !== null
				|| !isObservationEvidence(evidence.observation)
				|| (evidence.createIntentEventId !== null
					&& !EVENT_ID_PATTERN.test(readString(evidence.createIntentEventId)))) {
				throw new Error("Invalid Identity Ledger event.");
			}
			return;
		case "rebind":
			if (!hasExactKeys(evidence, ["observation", "reason"])
				|| !EVENT_ID_PATTERN.test(readString(value.baseBindingId))
				|| !isObservationEvidence(evidence.observation)
				|| !["edit", "move", "rename", "restore", "manual_resolution"].includes(readString(evidence.reason))) {
				throw new Error("Invalid Identity Ledger event.");
			}
			return;
		case "relation":
			if (!hasExactKeys(evidence, ["sourceMemoId"])
				|| !EVENT_ID_PATTERN.test(readString(value.baseBindingId))
				|| (evidence.sourceMemoId !== null && !MEMO_ID_PATTERN.test(readString(evidence.sourceMemoId)))) {
				throw new Error("Invalid Identity Ledger event.");
			}
			return;
		case "review":
			if (!hasExactKeys(evidence, ["reviewedAt"])
				|| !EVENT_ID_PATTERN.test(readString(value.baseBindingId)) || !isValidDateTime(evidence.reviewedAt)) {
				throw new Error("Invalid Identity Ledger event.");
			}
			return;
		case "delete_payload":
			if (!hasExactKeys(evidence, ["deletedAt", "sourcePath", "deletedSourceRevision", "logicalDate", "section", "rawBlock", "contentHash", "sourceMemoId"])
				|| !EVENT_ID_PATTERN.test(readString(value.baseBindingId))
				|| !isValidDateTime(evidence.deletedAt)
				|| !isVaultPath(evidence.sourcePath)
				|| (evidence.deletedSourceRevision !== null
					&& !SHA256_PATTERN.test(readString(evidence.deletedSourceRevision)))
				|| !isLogicalDate(evidence.logicalDate)
				|| (evidence.section !== null && typeof evidence.section !== "string")
				|| typeof evidence.rawBlock !== "string" || evidence.rawBlock.length === 0
				|| !CONTENT_HASH_PATTERN.test(readString(evidence.contentHash))
				|| (evidence.sourceMemoId !== null && !MEMO_ID_PATTERN.test(readString(evidence.sourceMemoId)))) {
				throw new Error("Invalid Identity Ledger event.");
			}
			return;
		case "delete_commit":
			if (!hasExactKeys(evidence, ["deleteEventId"])
				|| !EVENT_ID_PATTERN.test(readString(value.baseBindingId))
				|| !EVENT_ID_PATTERN.test(readString(evidence.deleteEventId))) {
				throw new Error("Invalid Identity Ledger event.");
			}
			return;
		case "restore":
			if (!hasExactKeys(evidence, ["observation", "deleteEventId"])
				|| !EVENT_ID_PATTERN.test(readString(value.baseBindingId))
				|| !isObservationEvidence(evidence.observation)
				|| !EVENT_ID_PATTERN.test(readString(evidence.deleteEventId))) {
				throw new Error("Invalid Identity Ledger event.");
			}
			return;
		case "repair":
			if (!hasExactKeys(evidence, ["observation"])
				|| !EVENT_ID_PATTERN.test(readString(value.baseBindingId))
				|| !isObservationEvidence(evidence.observation)) {
				throw new Error("Invalid Identity Ledger event.");
			}
			return;
		default:
			throw new Error("Invalid Identity Ledger event.");
	}
}

function readSegmentIdentityFromPath(rootPath: string, path: string): { writerId: string; expectedDigest: string } {
	const root = `${normalizePath(rootPath)}/writers/`;
	if (!path.startsWith(root)) throw new Error(`Identity Ledger segment is outside the configured root: ${path}`);
	const relative = path.slice(root.length).split("/");
	const writerId = relative[0] ?? "";
	const filenameMatch = /^segment-e_[a-f0-9]{32}-([a-f0-9]{64})\.jsonl$/u.exec(relative[2] ?? "");
	if (!WRITER_ID_PATTERN.test(writerId)
		|| relative[1] !== "segments"
		|| relative.length !== 3
		|| filenameMatch === null) {
		throw new Error(`Invalid Identity Ledger segment path: ${path}`);
	}
	return { writerId, expectedDigest: filenameMatch[1] as string };
}

function isObservationEvidence(value: unknown): value is IdentityLedgerObservationEvidence {
	return isRecord(value)
		&& hasExactKeys(value, ["sourcePath", "sourceRevision", "rawBlockHash", "logicalDate", "section", "startLine", "endLine", "time", "contentHash"])
		&& isVaultPath(value.sourcePath)
		&& SHA256_PATTERN.test(readString(value.sourceRevision))
		&& CONTENT_HASH_PATTERN.test(readString(value.rawBlockHash))
		&& isLogicalDate(value.logicalDate)
		&& (value.section === null || typeof value.section === "string")
		&& Number.isInteger(value.startLine) && Number(value.startLine) >= 0
		&& Number.isInteger(value.endLine) && Number(value.endLine) >= Number(value.startLine)
		&& MEMO_TIME_PATTERN.test(readString(value.time))
		&& CONTENT_HASH_PATTERN.test(readString(value.contentHash));
}

function isLogicalDate(value: unknown): value is string {
	if (typeof value !== "string" || !LOGICAL_DATE_PATTERN.test(value)) return false;
	const [year, month, day] = value.split("-").map(Number);
	const date = new Date(Date.UTC(year ?? 0, (month ?? 1) - 1, day ?? 0));
	return date.getUTCFullYear() === year && date.getUTCMonth() === (month ?? 1) - 1 && date.getUTCDate() === day;
}

function isVaultPath(value: unknown): value is string {
	return typeof value === "string" && value.length > 0 && !value.startsWith("/") && !value.includes("\\")
		&& !/(^|\/)\.{1,2}(\/|$)/u.test(value) && !/[\u0000-\u001f]/u.test(value);
}

function isValidDateTime(value: unknown): value is string {
	return typeof value === "string" && value.length > 0 && Number.isFinite(Date.parse(value));
}

function readString(value: unknown): string {
	return typeof value === "string" ? value : "";
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
	const keys = Object.keys(value).sort(compareText);
	return keys.length === expected.length
		&& [...expected].sort(compareText).every((key, index) => keys[index] === key);
}

function createRandomHex(fillRandomBytes: FillIdentityLedgerRandomBytes): string {
	const bytes = new Uint8Array(16);
	fillRandomBytes(bytes);
	return toHex(bytes);
}

function toHex(bytes: Uint8Array): string {
	return Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("");
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

function compareText(left: string, right: string): number {
	const leftPoints = Array.from(left, (value) => value.codePointAt(0) ?? 0);
	const rightPoints = Array.from(right, (value) => value.codePointAt(0) ?? 0);
	const length = Math.min(leftPoints.length, rightPoints.length);
	for (let index = 0; index < length; index += 1) {
		const difference = (leftPoints[index] ?? 0) - (rightPoints[index] ?? 0);
		if (difference !== 0) return difference;
	}
	return leftPoints.length - rightPoints.length;
}

async function sha256Text(value: string): Promise<string> {
	return sha256Bytes(new TextEncoder().encode(value));
}

async function sha256Bytes(bytes: Uint8Array): Promise<string> {
	const cryptoApi = typeof crypto === "undefined" ? undefined : crypto;
	if (cryptoApi?.subtle === undefined) throw new Error("Web Crypto SHA-256 is unavailable.");
	const input = new Uint8Array(bytes.byteLength);
	input.set(bytes);
	const digest = await cryptoApi.subtle.digest("SHA-256", input.buffer);
	return toHex(new Uint8Array(digest));
}

function fillCryptoRandom(target: Uint8Array): void {
	const cryptoApi = typeof crypto === "undefined" ? undefined : crypto;
	if (cryptoApi?.getRandomValues === undefined) throw new Error("Web Crypto random source is unavailable.");
	cryptoApi.getRandomValues(target);
}
