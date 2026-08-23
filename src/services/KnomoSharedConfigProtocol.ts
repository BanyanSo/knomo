import { normalizePath } from "obsidian";

import { CATALOG_V2_MONTHLY_RENDERER_VERSION } from "./CatalogV2MonthlyProjection";
import type { DailyNotesConfig } from "./DailyNoteService";
import type {
	KnomoSharedConfig,
	KnomoSharedConfigEvent,
	ParsedKnomoSharedConfigSegment,
} from "../types/knomoConfig";
import type { KnomoSettings } from "../types/settings";
import { isValidMonthlyMemoFileFormat } from "../settings/normalizeSettings";
import { isValidMarkdownHeading } from "../utils/markdown";
import { isRecord } from "../utils/object";
import { normalizeVaultPath } from "../utils/path";

export const KNOMO_SHARED_CONFIG_RELATIVE_ROOT = "_knomo-data/schema/config/v1";

const WRITER_ID_PATTERN = /^w_[a-f0-9]{32}$/u;
const EVENT_ID_PATTERN = /^c_[a-f0-9]{32}$/u;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;

export class UnsupportedKnomoSharedConfigSchemaError extends Error {
	constructor() {
		super("Unsupported Knomo shared configuration schema.");
		this.name = "UnsupportedKnomoSharedConfigSchemaError";
	}
}

export function buildKnomoSharedConfig(
	dailyConfig: DailyNotesConfig,
	settings: Pick<
		KnomoSettings,
		"dailyHeading" | "legacyDailyHeadings" | "monthlyMemoFolder" | "monthlyMemoFileFormat"
		| "monthlyDateHeadingFormat" | "monthlyDateOrder"
	>,
): KnomoSharedConfig {
	const headings = [...new Set([settings.dailyHeading, ...settings.legacyDailyHeadings]
		.map((heading) => heading.trim()).filter(Boolean))];
	const config: KnomoSharedConfig = {
		schemaVersion: 1,
		daily: {
			folder: dailyConfig.folder === null || dailyConfig.folder.trim().length === 0
				? null
				: normalizeVaultPath(dailyConfig.folder),
			dateFormat: dailyConfig.format.trim(),
			headings,
		},
		monthly: {
			folder: normalizeVaultPath(settings.monthlyMemoFolder),
			fileFormat: settings.monthlyMemoFileFormat.trim(),
			dateHeadingFormat: settings.monthlyDateHeadingFormat.trim(),
			dateOrder: settings.monthlyDateOrder,
			rendererVersion: CATALOG_V2_MONTHLY_RENDERER_VERSION,
		},
	};
	assertKnomoSharedConfig(config);
	return config;
}

export function createKnomoSharedConfigEventId(): string {
	const bytes = new Uint8Array(16);
	if (typeof crypto === "undefined") throw new Error("Web Crypto random generation is unavailable.");
	crypto.getRandomValues(bytes);
	return `c_${Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("")}`;
}

export function getKnomoSharedConfigRootPath(knomoDataRoot: string): string {
	return normalizePath(`${normalizeVaultPath(knomoDataRoot)}/${KNOMO_SHARED_CONFIG_RELATIVE_ROOT}`);
}

export function getKnomoSharedConfigWriterSegmentsPath(rootPath: string, writerId: string): string {
	if (!WRITER_ID_PATTERN.test(writerId)) throw new Error("Invalid Knomo shared configuration writerId.");
	return normalizePath(`${normalizePath(rootPath)}/writers/${writerId}/segments`);
}

export function getKnomoSharedConfigSegmentPath(
	rootPath: string,
	writerId: string,
	eventId: string,
	digest: string,
): string {
	if (!EVENT_ID_PATTERN.test(eventId) || !SHA256_PATTERN.test(digest)) {
		throw new Error("Invalid Knomo shared configuration segment identity.");
	}
	return normalizePath(
		`${getKnomoSharedConfigWriterSegmentsPath(rootPath, writerId)}/segment-${eventId}-${digest}.jsonl`,
	);
}

export function serializeKnomoSharedConfigSegment(events: readonly KnomoSharedConfigEvent[]): string {
	if (events.length === 0) throw new Error("Knomo shared configuration segment must contain an event.");
	const writerId = events[0]?.writerId ?? "";
	for (const event of events) {
		assertKnomoSharedConfigEvent(event);
		if (event.writerId !== writerId) throw new Error("Knomo shared configuration segment cannot mix writers.");
	}
	return `${events.map(canonicalKnomoSharedConfigJson).join("\n")}\n`;
}

export async function parseKnomoSharedConfigSegment(
	rootPath: string,
	path: string,
	content: string | Uint8Array,
): Promise<ParsedKnomoSharedConfigSegment> {
	const normalizedPath = normalizePath(path);
	const { writerId, expectedDigest } = readSegmentIdentity(rootPath, normalizedPath);
	const bytes = typeof content === "string" ? new TextEncoder().encode(content) : content;
	const text = typeof content === "string"
		? content
		: new TextDecoder("utf-8", { fatal: true }).decode(content);
	if (text.length === 0 || text.charCodeAt(0) === 0xfeff || !text.endsWith("\n")) {
		throw new Error(`Invalid Knomo shared configuration bytes: ${normalizedPath}`);
	}
	const lines = text.slice(0, -1).split("\n");
	if (lines.some((line) => line.length === 0)) {
		throw new Error(`Knomo shared configuration contains a blank line: ${normalizedPath}`);
	}
	const events: ParsedKnomoSharedConfigSegment["events"] = [];
	for (const line of lines) {
		const parsed = JSON.parse(line) as unknown;
		assertKnomoSharedConfigEvent(parsed);
		if (parsed.writerId !== writerId) {
			throw new Error(`Knomo shared configuration writer path mismatch: ${normalizedPath}`);
		}
		if (canonicalKnomoSharedConfigJson(parsed) !== line) {
			throw new Error(`Knomo shared configuration event is not canonical JSON: ${normalizedPath}`);
		}
		events.push({
			event: parsed,
			digest: await sha256KnomoSharedConfigText(line),
			sourcePath: normalizedPath,
		});
	}
	const digest = await sha256KnomoSharedConfigBytes(bytes);
	if (digest !== expectedDigest) throw new Error(`Knomo shared configuration digest mismatch: ${normalizedPath}`);
	return { path: normalizedPath, writerId, digest, events };
}

export function canonicalKnomoSharedConfigJson(value: unknown): string {
	return JSON.stringify(toCanonicalValue(value));
}

export async function sha256KnomoSharedConfigText(value: string): Promise<string> {
	return sha256KnomoSharedConfigBytes(new TextEncoder().encode(value));
}

export function assertKnomoSharedConfigEvent(value: unknown): asserts value is KnomoSharedConfigEvent {
	if (isRecord(value) && value.schemaVersion !== 1) throw new UnsupportedKnomoSharedConfigSchemaError();
	const baseEventIds = isRecord(value) && Array.isArray(value.baseEventIds) ? value.baseEventIds : null;
	if (!isRecord(value)
		|| !hasExactKeys(value, ["schemaVersion", "eventId", "writerId", "type", "baseEventIds", "occurredAt", "config"])
		|| value.schemaVersion !== 1
		|| !EVENT_ID_PATTERN.test(readString(value.eventId))
		|| !WRITER_ID_PATTERN.test(readString(value.writerId))
		|| value.type !== "set_config"
		|| baseEventIds === null
		|| baseEventIds.some((eventId) => !EVENT_ID_PATTERN.test(readString(eventId)))
		|| new Set(baseEventIds).size !== baseEventIds.length
		|| [...baseEventIds].sort().some((eventId, index) => eventId !== baseEventIds[index])
		|| !isValidDateTime(value.occurredAt)) {
		throw new Error("Invalid Knomo shared configuration event.");
	}
	assertKnomoSharedConfig(value.config);
}

export function assertKnomoSharedConfig(value: unknown): asserts value is KnomoSharedConfig {
	if (isRecord(value) && value.schemaVersion !== 1) throw new UnsupportedKnomoSharedConfigSchemaError();
	if (!isRecord(value)
		|| !hasExactKeys(value, ["schemaVersion", "daily", "monthly"])
		|| value.schemaVersion !== 1
		|| !isRecord(value.daily)
		|| !hasExactKeys(value.daily, ["folder", "dateFormat", "headings"])
		|| !isRecord(value.monthly)
		|| !hasExactKeys(value.monthly, ["folder", "fileFormat", "dateHeadingFormat", "dateOrder", "rendererVersion"])) {
		throw new Error("Invalid Knomo shared configuration.");
	}
	const daily = value.daily;
	const monthly = value.monthly;
	if ((daily.folder !== null && !isNormalizedVaultPath(daily.folder))
		|| typeof daily.dateFormat !== "string" || daily.dateFormat.trim().length === 0
		|| !Array.isArray(daily.headings) || daily.headings.length === 0
		|| daily.headings.some((heading) => typeof heading !== "string" || !isValidMarkdownHeading(heading))
		|| new Set(daily.headings).size !== daily.headings.length
		|| !isNormalizedVaultPath(monthly.folder)
		|| typeof monthly.fileFormat !== "string" || !isValidMonthlyMemoFileFormat(monthly.fileFormat)
		|| typeof monthly.dateHeadingFormat !== "string" || !isValidMarkdownHeading(monthly.dateHeadingFormat)
		|| (monthly.dateOrder !== "asc" && monthly.dateOrder !== "desc")
		|| !Number.isInteger(monthly.rendererVersion) || Number(monthly.rendererVersion) < 1) {
		throw new Error("Invalid Knomo shared configuration.");
	}
}

async function sha256KnomoSharedConfigBytes(bytes: Uint8Array): Promise<string> {
	if (typeof crypto === "undefined" || crypto.subtle === undefined) {
		throw new Error("Web Crypto SHA-256 is unavailable.");
	}
	const input = new Uint8Array(bytes.byteLength);
	input.set(bytes);
	const digest = await crypto.subtle.digest("SHA-256", input.buffer);
	return Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, "0")).join("");
}

function readSegmentIdentity(rootPath: string, path: string): { writerId: string; expectedDigest: string } {
	const root = `${normalizePath(rootPath)}/writers/`;
	if (!path.startsWith(root)) throw new Error(`Knomo shared configuration path is outside root: ${path}`);
	const relative = path.slice(root.length);
	const match = relative.match(
		/^(w_[a-f0-9]{32})\/segments\/segment-(c_[a-f0-9]{32})-([a-f0-9]{64})\.jsonl$/u,
	);
	if (match === null) throw new Error(`Invalid Knomo shared configuration path: ${path}`);
	return { writerId: match[1] ?? "", expectedDigest: match[3] ?? "" };
}

function toCanonicalValue(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(toCanonicalValue);
	if (!isRecord(value)) return value;
	return Object.fromEntries(Object.keys(value).sort().map((key) => [key, toCanonicalValue(value[key])]));
}

function isNormalizedVaultPath(value: unknown): value is string {
	return typeof value === "string" && value.trim().length > 0
		&& !value.startsWith("/") && !value.includes("\\") && !value.split("/").includes("..")
		&& normalizePath(value) === value;
}

function isValidDateTime(value: unknown): value is string {
	return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function readString(value: unknown): string {
	return typeof value === "string" ? value : "";
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
	const keys = Object.keys(value).sort();
	return keys.length === expected.length
		&& [...expected].sort().every((key, index) => keys[index] === key);
}
