import { moment as obsidianMoment, normalizePath } from "obsidian";

import {
	DEFAULT_MONTHLY_DATE_HEADING_FORMAT,
	DEFAULT_MONTHLY_MEMO_FILE_FORMAT,
} from "../constants";
import type { MemoObservation } from "../types/catalog";
import type { KnomoSettings, MonthlyDateOrder } from "../types/settings";
import { translate } from "../i18n";
import { normalizeVaultPath } from "../utils/path";
import { MarkdownBlockService } from "./MarkdownBlockService";
import { canonicalJson, sha256Bytes, sha256Text } from "./CanonicalJson";
import { CooperativeYieldController, stableSortCooperatively } from "./CooperativeTask";
import type { CooperativeTaskRuntime } from "./CooperativeTask";

export const MONTHLY_ARCHIVE_MARKER = "knomo:monthly-archive";
const MONTHLY_ARCHIVE_COMMENT = `<!-- ${MONTHLY_ARCHIVE_MARKER} -->`;

const MONTHLY_PERIOD_PATTERN = /^\d{4}-(?:0[1-9]|1[0-2])$/;
const LOGICAL_DATE_PATTERN = /^\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])$/;
const DATE_TOKEN_RUN_PATTERN = /[A-Za-z]+/g;
const DATE_TOKENS = ["YYYY", "MMMM", "dddd", "MM", "DD", "M", "D"] as const;
const MONTHLY_LOCALE_PATTERN = /^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/u;

export type MonthlyProjectionSettings = Pick<
	KnomoSettings,
	"monthlyMemoFolder" | "monthlyMemoFileFormat" | "monthlyDateHeadingFormat" | "monthlyDateOrder"
> & { locale: string };

export interface MonthlyProjectionInput {
	period: string;
	settings: MonthlyProjectionSettings;
	observations: readonly MemoObservation[];
	sourceDigest?: string;
	preservedMarker?: string;
}

export interface MonthlyProjectionResult {
	period: string;
	path: string;
	content: string;
	bytes: Uint8Array;
	sourceDigest: string;
	outputHash: string;
	semanticHash: string;
	outputSha256: string;
	observationCount: number;
}

export async function buildMonthlyProjection(
	input: MonthlyProjectionInput,
	markdownBlockService = new MarkdownBlockService(),
	runtime?: CooperativeTaskRuntime,
): Promise<MonthlyProjectionResult> {
	assertMonthlyPeriod(input.period);
	const monthlyLocale = normalizeMonthlyLocaleKey(input.settings.locale);
	const yieldController = runtime === undefined ? null : new CooperativeYieldController(runtime);
	const matchingObservations: MemoObservation[] = [];
	for (const observation of input.observations) {
		if (observation.logicalDate.startsWith(`${input.period}-`)) matchingObservations.push(observation);
		if (yieldController?.shouldYield()) await yieldController.yieldNow();
	}
	const observations = await stableSortCooperatively(matchingObservations, compareMonthlyObservations, runtime);
	const byDate = new Map<string, MemoObservation[]>();
	for (const observation of observations) {
		assertLogicalDate(observation.logicalDate);
		const values = byDate.get(observation.logicalDate) ?? [];
		values.push(observation);
		byDate.set(observation.logicalDate, values);
		if (yieldController?.shouldYield()) await yieldController.yieldNow();
	}
	const dates = await stableSortCooperatively(
		[...byDate.keys()],
		(left, right) => compareMonthlyDates(left, right, input.settings.monthlyDateOrder),
		runtime,
	);
	const sections: string[] = [];
	for (const logicalDate of dates) {
		const heading = formatMonthlyDateHeading(input.settings.monthlyDateHeadingFormat, logicalDate, monthlyLocale);
		const blocks: string[] = [];
		for (const observation of byDate.get(logicalDate) ?? []) {
			blocks.push(markdownBlockService.buildMemoBlockWithBlockId(
				observation.content,
				observation.time,
				observation.existingBlockId,
			));
			if (yieldController?.shouldYield()) await yieldController.yieldNow();
		}
		sections.push([heading, ...blocks].join("\n\n"));
		if (yieldController?.shouldYield()) await yieldController.yieldNow();
	}
	const projectionHeader = input.preservedMarker ?? buildMonthlyProjectionHeader(monthlyLocale);
	const content = [
		projectionHeader,
		`# ${input.period}`,
		...sections,
	].join("\n\n") + "\n";
	const bytes = new TextEncoder().encode(content);
	let sourceDigest = input.sourceDigest;
	if (sourceDigest === undefined) {
		const semanticObservations: unknown[] = [];
		for (const observation of observations) {
			semanticObservations.push({
				sourcePath: observation.sourcePath,
				sourceRevision: observation.sourceRevision,
				startLine: observation.startLine,
				endLine: observation.endLine,
				logicalDate: observation.logicalDate,
				section: observation.section,
				time: observation.time,
				content: observation.content,
				contentHash: observation.contentHash,
				existingBlockId: observation.existingBlockId,
			});
			if (yieldController?.shouldYield()) await yieldController.yieldNow();
		}
		sourceDigest = await sha256Text(canonicalJson({
			period: input.period,
			targetPath: getMonthlyArchivePath(input.settings, input.period),
			fileFormat: input.settings.monthlyMemoFileFormat,
			dateHeadingFormat: input.settings.monthlyDateHeadingFormat.trim() || DEFAULT_MONTHLY_DATE_HEADING_FORMAT,
			dateOrder: input.settings.monthlyDateOrder,
			locale: monthlyLocale,
			observations: semanticObservations,
		}));
	}
	const outputHash = await sha256Bytes(bytes);
	return {
		period: input.period,
		path: getMonthlyArchivePath(input.settings, input.period),
		content,
		bytes,
		sourceDigest,
		outputHash,
		semanticHash: sourceDigest,
		outputSha256: outputHash,
		observationCount: observations.length,
	};
}

export function hasKnomoMonthlyArchiveMarker(content: string): boolean {
	return extractLeadingMonthlyArchiveMarker(content) !== null;
}

export function extractLegacyMonthlyArchiveMarker(content: string): string | null {
	const marker = extractLeadingMonthlyArchiveMarker(content);
	return marker !== null && marker.trim() !== MONTHLY_ARCHIVE_COMMENT ? marker : null;
}

export function getMonthlyArchivePath(
	settings: Pick<KnomoSettings, "monthlyMemoFolder" | "monthlyMemoFileFormat">,
	period: string,
): string {
	assertMonthlyPeriod(period);
	const folder = normalizeVaultPath(settings.monthlyMemoFolder);
	const format = settings.monthlyMemoFileFormat.trim() || DEFAULT_MONTHLY_MEMO_FILE_FORMAT;
	return normalizePath(`${folder}/${format.replace(/YYYY-MM/g, period)}`);
}

export function getMonthlyConflictPeriod(
	settings: Pick<KnomoSettings, "monthlyMemoFolder" | "monthlyMemoFileFormat">,
	path: string,
): string | null {
	const normalizedPath = normalizePath(path);
	const fileName = normalizedPath.split("/").pop() ?? "";
	const period = fileName.match(/\d{4}-(?:0[1-9]|1[0-2])/)?.[0] ?? null;
	if (period === null) return null;
	const canonicalPath = getMonthlyArchivePath(settings, period);
	if (normalizedPath === canonicalPath || parentPath(normalizedPath) !== parentPath(canonicalPath)) return null;
	const canonicalName = canonicalPath.split("/").pop() ?? "";
	const canonicalStem = stripMarkdownExtension(canonicalName);
	const fileStem = stripMarkdownExtension(fileName);
	if (!fileStem.startsWith(canonicalStem) || fileStem === canonicalStem) return null;
	return /^[-\s(._]/.test(fileStem.slice(canonicalStem.length)) ? period : null;
}

export function getMonthlyCanonicalPeriod(
	settings: Pick<KnomoSettings, "monthlyMemoFolder" | "monthlyMemoFileFormat">,
	path: string,
): string | null {
	const normalizedPath = normalizePath(path);
	const period = normalizedPath.match(/\d{4}-(?:0[1-9]|1[0-2])/)?.[0] ?? null;
	return period !== null && getMonthlyArchivePath(settings, period) === normalizedPath ? period : null;
}

export function normalizeMonthlyLocaleKey(value: unknown): string {
	if (typeof value !== "string") return "en";
	const normalized = value.trim().replace(/_/g, "-").toLowerCase();
	if (normalized === "zh") return "zh-cn";
	return MONTHLY_LOCALE_PATTERN.test(normalized) ? normalized : "en";
}

export function formatMonthlyDateHeading(format: string, logicalDate: string, locale: string): string {
	assertLogicalDate(logicalDate);
	const [yearText, monthText, dayText] = logicalDate.split("-");
	const year = Number(yearText);
	const month = Number(monthText);
	const day = Number(dayText);
	const date = new Date(Date.UTC(year, month - 1, day));
	if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
		throw new Error(`Invalid Monthly logical date: ${logicalDate}`);
	}
	const requestedLocale = normalizeMonthlyLocaleKey(locale);
	const localizedDate = obsidianMoment.utc(logicalDate, "YYYY-MM-DD", true);
	localizedDate.locale("en");
	localizedDate.locale(requestedLocale);
	const resolvedLocale = normalizeMonthlyLocaleKey(localizedDate.locale());
	if (!areCompatibleLocaleKeys(requestedLocale, resolvedLocale)) localizedDate.locale("en");
	const values: Record<(typeof DATE_TOKENS)[number], string> = {
		YYYY: yearText ?? "",
		MMMM: localizedDate.format("MMMM"),
		MM: monthText ?? "",
		M: String(month),
		DD: dayText ?? "",
		D: String(day),
		dddd: localizedDate.format("dddd"),
	};
	const resolvedFormat = format.trim() || DEFAULT_MONTHLY_DATE_HEADING_FORMAT;
	return resolvedFormat.replace(DATE_TOKEN_RUN_PATTERN, (run) => formatDateTokenRun(run, values));
}

function areCompatibleLocaleKeys(requested: string, resolved: string): boolean {
	return requested === resolved
		|| requested.startsWith(`${resolved}-`)
		|| resolved.startsWith(`${requested}-`);
}

function formatDateTokenRun(
	run: string,
	values: Readonly<Record<(typeof DATE_TOKENS)[number], string>>,
): string {
	let offset = 0;
	let output = "";
	while (offset < run.length) {
		const token = DATE_TOKENS.find((candidate) => run.startsWith(candidate, offset));
		if (token === undefined) return run;
		output += values[token];
		offset += token.length;
	}
	return output;
}

function compareMonthlyObservations(left: MemoObservation, right: MemoObservation): number {
	return compareText(left.logicalDate, right.logicalDate)
		|| compareText(normalizeMemoTime(left.time), normalizeMemoTime(right.time))
		|| compareText(left.sourcePath, right.sourcePath)
		|| left.startLine - right.startLine
		|| left.endLine - right.endLine
		|| compareText(left.contentHash, right.contentHash);
}

function compareMonthlyDates(left: string, right: string, order: MonthlyDateOrder): number {
	return order === "desc" ? compareText(right, left) : compareText(left, right);
}

function compareText(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0;
}

function normalizeMemoTime(time: string): string {
	return time.length === 5 ? `${time}:00` : time;
}

function buildMonthlyProjectionHeader(locale: string): string {
	const noticeLocale = locale.startsWith("zh") ? "zh-CN" : "en";
	return [
		MONTHLY_ARCHIVE_COMMENT,
		`<small>${translate(noticeLocale, "archive.deterministicReadOnlyComment")}</small>`,
	].join("\n\n");
}

function extractLeadingMonthlyArchiveMarker(content: string): string | null {
	const leadingLength = content.match(/^\uFEFF?\s*/u)?.[0].length ?? 0;
	if (!content.startsWith("<!--", leadingLength)) return null;
	const endIndex = content.indexOf("-->", leadingLength + 4);
	if (endIndex === -1) return null;
	const comment = content.slice(leadingLength, endIndex + 3);
	return /^<!--[ \t]*knomo:monthly-archive(?=\s|-->)/u.test(comment) ? comment : null;
}

function assertMonthlyPeriod(period: string): void {
	if (!MONTHLY_PERIOD_PATTERN.test(period)) throw new Error(`Invalid Monthly period: ${period}`);
}

function assertLogicalDate(logicalDate: string): void {
	if (!LOGICAL_DATE_PATTERN.test(logicalDate)) throw new Error(`Invalid Monthly logical date: ${logicalDate}`);
}

function parentPath(path: string): string {
	const index = path.lastIndexOf("/");
	return index === -1 ? "" : path.slice(0, index);
}

function stripMarkdownExtension(fileName: string): string {
	return fileName.replace(/\.md$/i, "");
}
