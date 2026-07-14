import { TFile, TFolder, Vault } from "obsidian";
import type { App } from "obsidian";

import type { TimeBuoyIndexEntry, TimeBuoyIndexShard, TimeBuoyIndexState } from "../types/timeBuoy";
import { isRecord } from "../utils/object";
import {
	getSystemFolderPath,
	getTimeBuoyIndexFilePath,
	getTimeBuoyIndexFolderPath,
	getTimeBuoyIndexStateFilePath,
} from "../utils/path";
import { getTimeBuoyTargetPeriod, isValidTimeBuoyDate } from "../utils/timeBuoyDate";
import { ensureTextFile } from "../utils/vault";
import type { SelfWriteTracker } from "./SelfWriteTracker";

export interface TimeBuoyMemoIndexChange {
	memoId: string;
	sourcePeriod: string;
	buoyRevision: string;
	previousDates: readonly string[];
	nextDates: readonly string[];
}

export interface TimeBuoyIndexConflictFile {
	path: string;
	targetPeriod: string | null;
}

export interface TimeBuoyConflictCleanupResult {
	deleted: number;
	failed: number;
	firstFailedPath: string | null;
}

export class TimeBuoyIndexStore {
	private writeQueue: Promise<void> = Promise.resolve();
	private writeMarkerSequence = 0;

	constructor(
		private readonly app: App,
		private readonly selfWriteTracker?: SelfWriteTracker,
	) {}

	async loadExistingPeriod(monthlyMemoFolder: string, targetPeriod: string): Promise<TimeBuoyIndexShard | null> {
		const path = getTimeBuoyIndexFilePath(monthlyMemoFolder, targetPeriod);
		const file = this.app.vault.getAbstractFileByPath(path);
		if (file === null) {
			return null;
		}
		if (!(file instanceof TFile)) {
			throw new Error(`Time buoy index path is not a file: ${path}`);
		}
		return parseTimeBuoyIndex(await this.app.vault.cachedRead(file), targetPeriod);
	}

	async loadState(monthlyMemoFolder: string): Promise<TimeBuoyIndexState | null> {
		const path = getTimeBuoyIndexStateFilePath(monthlyMemoFolder);
		const file = this.app.vault.getAbstractFileByPath(path);
		if (file === null) {
			return null;
		}
		if (!(file instanceof TFile)) {
			throw new Error(`Time buoy state path is not a file: ${path}`);
		}
		return parseTimeBuoyIndexState(await this.app.vault.cachedRead(file));
	}

	async markDirty(
		monthlyMemoFolder: string,
		affectedMemoIds: readonly string[],
		expectedPeriods: readonly string[] = [],
	): Promise<TimeBuoyIndexState> {
		return this.runWriteExclusive(() => this.writeState(monthlyMemoFolder, (current) => ({
			...current,
			updatedAt: new Date().toISOString(),
			dirty: true,
			affectedMemoIds: [...new Set([...current.affectedMemoIds, ...affectedMemoIds])].sort(),
			expectedPeriods: normalizePeriods([...current.expectedPeriods, ...expectedPeriods]),
		})));
	}

	async markClean(monthlyMemoFolder: string, expectedPeriods: readonly string[]): Promise<TimeBuoyIndexState> {
		return this.runWriteExclusive(() => this.writeState(monthlyMemoFolder, () => ({
			schemaVersion: 1,
			updatedAt: new Date().toISOString(),
			dirty: false,
			affectedMemoIds: [],
			expectedPeriods: normalizePeriods(expectedPeriods),
		})));
	}

	async applyMemoChange(monthlyMemoFolder: string, change: TimeBuoyMemoIndexChange): Promise<void> {
		await this.runWriteExclusive(async () => {
			const previousDates = normalizeDates(change.previousDates);
			const nextDates = normalizeDates(change.nextDates);
			const affectedPeriods = [...new Set([...previousDates, ...nextDates]
				.map((date) => getTimeBuoyTargetPeriod(date))
				.filter((period): period is string => period !== null))].sort();
			for (const targetPeriod of affectedPeriods) {
				await this.mergePeriod(monthlyMemoFolder, targetPeriod, (index) => {
					const dates = cloneDates(index.dates);
					for (const targetDate of previousDates) {
						if (getTimeBuoyTargetPeriod(targetDate) !== targetPeriod) {
							continue;
						}
						removeMemoFromDate(dates, targetDate, change.memoId);
					}
					for (const targetDate of nextDates) {
						if (getTimeBuoyTargetPeriod(targetDate) !== targetPeriod) {
							continue;
						}
						const entries = dates[targetDate] ?? {};
						entries[change.memoId] = {
							sourcePeriod: change.sourcePeriod,
							buoyRevision: change.buoyRevision,
						};
						dates[targetDate] = entries;
					}
					return {
						...index,
						updatedAt: new Date().toISOString(),
						dates,
					};
				});
			}
		});
	}

	async replacePeriod(
		monthlyMemoFolder: string,
		targetPeriod: string,
		dates: TimeBuoyIndexShard["dates"],
	): Promise<TimeBuoyIndexShard> {
		return this.runWriteExclusive(() => this.writeReplacement(monthlyMemoFolder, targetPeriod, dates));
	}

	async replacePeriodsWithRollback(
		monthlyMemoFolder: string,
		replacements: ReadonlyMap<string, TimeBuoyIndexShard["dates"]>,
	): Promise<void> {
		await this.runWriteExclusive(async () => {
			const snapshots: Array<{ path: string; targetPeriod: string; content: string | null }> = [];
			const writtenSnapshots: Array<{ path: string; targetPeriod: string; content: string | null }> = [];
			for (const targetPeriod of replacements.keys()) {
				const path = getTimeBuoyIndexFilePath(monthlyMemoFolder, targetPeriod);
				const file = this.app.vault.getAbstractFileByPath(path);
				snapshots.push({
					path,
					targetPeriod,
					content: file instanceof TFile ? await this.app.vault.cachedRead(file) : null,
				});
			}
			await this.backupInvalidSnapshots(monthlyMemoFolder, snapshots);
			try {
				for (const [targetPeriod, dates] of replacements) {
					const snapshot = snapshots.find((candidate) => candidate.targetPeriod === targetPeriod);
					if (snapshot?.content !== null && snapshot?.content !== undefined) {
						try {
							const current = parseTimeBuoyIndex(snapshot.content, targetPeriod);
							if (areTimeBuoyDatesEqual(current.dates, dates)) {
								continue;
							}
						} catch {
							// 无效旧分片已备份，继续由重建结果替换。
						}
					}
					if (snapshot !== undefined) {
						writtenSnapshots.push(snapshot);
					}
					await this.writeReplacement(monthlyMemoFolder, targetPeriod, dates);
				}
			} catch (error) {
				for (const snapshot of writtenSnapshots) {
					const file = this.app.vault.getAbstractFileByPath(snapshot.path);
					if (!(file instanceof TFile)) {
						continue;
					}
					if (snapshot.content === null) {
						this.markSelfWrite(snapshot.path);
						await this.app.fileManager.trashFile(file);
					} else {
						await this.app.vault.process(file, () => snapshot.content ?? "");
						this.markSelfWrite(snapshot.path);
					}
				}
				throw error;
			}
		});
	}

	private async backupInvalidSnapshots(
		monthlyMemoFolder: string,
		snapshots: ReadonlyArray<{ path: string; targetPeriod: string; content: string | null }>,
	): Promise<void> {
		const invalid = snapshots.filter((snapshot) => {
			if (snapshot.content === null) {
				return false;
			}
			try {
				parseTimeBuoyIndex(snapshot.content, snapshot.targetPeriod);
				return false;
			} catch {
				return true;
			}
		});
		if (invalid.length === 0) {
			return;
		}
		const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
		const backupFolder = `${getSystemFolderPath(monthlyMemoFolder)}/backups/time-buoy-rebuild-${timestamp}`;
		for (const snapshot of invalid) {
			const name = snapshot.path.slice(snapshot.path.lastIndexOf("/") + 1);
			const backupFile = await ensureTextFile(this.app, `${backupFolder}/${name}`);
			await this.app.vault.process(backupFile, () => snapshot.content ?? "");
		}
	}

	listStoredPeriods(monthlyMemoFolder: string): string[] {
		const folder = this.app.vault.getAbstractFileByPath(getTimeBuoyIndexFolderPath(monthlyMemoFolder));
		if (!(folder instanceof TFolder)) {
			return [];
		}
		return folder.children
			.filter((child): child is TFile => child instanceof TFile)
			.map((file) => /^time-buoy-(\d{4}-(?:0[1-9]|1[0-2]))\.json$/.exec(file.name)?.[1] ?? null)
			.filter((period): period is string => period !== null)
			.sort();
	}

	listPotentialSyncConflictFiles(monthlyMemoFolder: string): TimeBuoyIndexConflictFile[] {
		const folder = this.app.vault.getAbstractFileByPath(getTimeBuoyIndexFolderPath(monthlyMemoFolder));
		if (!(folder instanceof TFolder)) {
			return [];
		}
		const files: TimeBuoyIndexConflictFile[] = [];
		Vault.recurseChildren(folder, (child) => {
			if (!(child instanceof TFile) || child.extension !== "json") {
				return;
			}
			const stateConflict = /^time-buoy-state.+\.json$/.test(child.name);
			const match = /^time-buoy-(\d{4}-(?:0[1-9]|1[0-2])).+\.json$/.exec(child.name);
			if (match !== null) {
				files.push({ path: child.path, targetPeriod: match[1] });
			} else if (stateConflict) {
				files.push({ path: child.path, targetPeriod: null });
			}
		});
		return files.sort((left, right) => left.path.localeCompare(right.path));
	}

	async trashPotentialSyncConflictFiles(monthlyMemoFolder: string): Promise<TimeBuoyConflictCleanupResult> {
		let deleted = 0;
		let failed = 0;
		let firstFailedPath: string | null = null;
		for (const conflict of this.listPotentialSyncConflictFiles(monthlyMemoFolder)) {
			const file = this.app.vault.getAbstractFileByPath(conflict.path);
			if (!(file instanceof TFile)) {
				continue;
			}
			try {
				this.markSelfWrite(file.path);
				await this.app.fileManager.trashFile(file);
				deleted += 1;
			} catch {
				failed += 1;
				firstFailedPath ??= file.path;
			}
		}
		return { deleted, failed, firstFailedPath };
	}

	private async mergePeriod(
		monthlyMemoFolder: string,
		targetPeriod: string,
		merge: (index: TimeBuoyIndexShard) => TimeBuoyIndexShard,
	): Promise<TimeBuoyIndexShard> {
		const path = getTimeBuoyIndexFilePath(monthlyMemoFolder, targetPeriod);
		const existing = this.app.vault.getAbstractFileByPath(path);
		if (existing !== null && !(existing instanceof TFile)) {
			throw new Error(`Time buoy index path is not a file: ${path}`);
		}
		const created = existing === null;
		const file = await ensureTextFile(this.app, path);
		const nextContent = await this.app.vault.process(file, (content) => {
			const current = created && content.trim().length === 0
				? createEmptyTimeBuoyIndex(targetPeriod)
				: parseTimeBuoyIndex(content, targetPeriod);
			const next = parseTimeBuoyIndex(JSON.stringify(merge(current)), targetPeriod);
			const serialized = `${JSON.stringify(next, null, "\t")}\n`;
			return serialized === content ? content : serialized;
		});
		this.markSelfWrite(file.path);
		return parseTimeBuoyIndex(nextContent, targetPeriod);
	}

	private async writeReplacement(
		monthlyMemoFolder: string,
		targetPeriod: string,
		dates: TimeBuoyIndexShard["dates"],
	): Promise<TimeBuoyIndexShard> {
		const next = parseTimeBuoyIndex(JSON.stringify({
			schemaVersion: 2,
			targetPeriod,
			updatedAt: new Date().toISOString(),
			dates: cloneDates(dates),
		}), targetPeriod);
		const file = await ensureTextFile(this.app, getTimeBuoyIndexFilePath(monthlyMemoFolder, targetPeriod));
		const serialized = `${JSON.stringify(next, null, "\t")}\n`;
		const content = await this.app.vault.process(file, (current) => current === serialized ? current : serialized);
		this.markSelfWrite(file.path);
		return parseTimeBuoyIndex(content, targetPeriod);
	}

	private async writeState(
		monthlyMemoFolder: string,
		update: (state: TimeBuoyIndexState) => TimeBuoyIndexState,
	): Promise<TimeBuoyIndexState> {
		const path = getTimeBuoyIndexStateFilePath(monthlyMemoFolder);
		const existing = this.app.vault.getAbstractFileByPath(path);
		if (existing !== null && !(existing instanceof TFile)) {
			throw new Error(`Time buoy state path is not a file: ${path}`);
		}
		const created = existing === null;
		const file = await ensureTextFile(this.app, path);
		const content = await this.app.vault.process(file, (currentContent) => {
			let current = createTimeBuoyIndexState();
			if (!created || currentContent.trim().length > 0) {
				try {
					current = parseTimeBuoyIndexState(currentContent);
				} catch {
					current = createTimeBuoyIndexState();
				}
			}
			return `${JSON.stringify(update(current), null, "\t")}\n`;
		});
		this.markSelfWrite(file.path);
		return parseTimeBuoyIndexState(content);
	}

	private markSelfWrite(path: string): void {
		if (this.selfWriteTracker === undefined) {
			return;
		}
		const writtenAt = Date.now();
		this.writeMarkerSequence += 1;
		this.selfWriteTracker.mark(path, {
			opId: `time-buoy-index-${writtenAt}-${this.writeMarkerSequence}`,
			path,
			reason: "time_buoy_index",
			writtenAt,
			expiresAt: writtenAt + 10000,
			expectedHash: null,
		});
	}

	private async runWriteExclusive<T>(operation: () => Promise<T>): Promise<T> {
		const previous = this.writeQueue;
		let release: () => void = () => undefined;
		this.writeQueue = new Promise<void>((resolve) => {
			release = resolve;
		});
		await previous;
		try {
			return await operation();
		} finally {
			release();
		}
	}
}

export function parseTimeBuoyIndex(content: string, targetPeriod: string): TimeBuoyIndexShard {
	if (content.trim().length === 0) {
		throw new Error(`Empty time buoy index for ${targetPeriod}.`);
	}
	let value: unknown;
	try {
		value = JSON.parse(content) as unknown;
	} catch (error) {
		const message = error instanceof Error ? error.message : "Invalid JSON";
		throw new Error(`Invalid time buoy index JSON for ${targetPeriod}: ${message}`);
	}
	if (
		!isRecord(value)
		|| value.schemaVersion !== 2
		|| value.targetPeriod !== targetPeriod
		|| typeof value.updatedAt !== "string"
		|| !Number.isFinite(new Date(value.updatedAt).getTime())
		|| !isRecord(value.dates)
	) {
		throw new Error(`Invalid time buoy index schema for ${targetPeriod}.`);
	}
	const dates: TimeBuoyIndexShard["dates"] = {};
	for (const [targetDate, entriesValue] of Object.entries(value.dates)) {
		if (!isValidTimeBuoyDate(targetDate) || getTimeBuoyTargetPeriod(targetDate) !== targetPeriod || !isRecord(entriesValue)) {
			throw new Error(`Invalid time buoy index date for ${targetPeriod}: ${targetDate}.`);
		}
		const entries: Record<string, TimeBuoyIndexEntry> = {};
		for (const [memoId, entryValue] of Object.entries(entriesValue)) {
			if (
				memoId.length === 0
				|| !isRecord(entryValue)
				|| typeof entryValue.sourcePeriod !== "string"
				|| !/^\d{4}-(?:0[1-9]|1[0-2])$/.test(entryValue.sourcePeriod)
				|| typeof entryValue.buoyRevision !== "string"
				|| entryValue.buoyRevision.length === 0
			) {
				throw new Error(`Invalid time buoy index entry for ${targetPeriod}: memoId=${memoId}.`);
			}
			entries[memoId] = {
				sourcePeriod: entryValue.sourcePeriod,
				buoyRevision: entryValue.buoyRevision,
			};
		}
		dates[targetDate] = entries;
	}
	return {
		schemaVersion: 2,
		targetPeriod,
		updatedAt: value.updatedAt,
		dates,
	};
}

function createEmptyTimeBuoyIndex(targetPeriod: string): TimeBuoyIndexShard {
	return {
		schemaVersion: 2,
		targetPeriod,
		updatedAt: new Date().toISOString(),
		dates: {},
	};
}

export function parseTimeBuoyIndexState(content: string): TimeBuoyIndexState {
	if (content.trim().length === 0) {
		throw new Error("Empty time buoy index state.");
	}
	let value: unknown;
	try {
		value = JSON.parse(content) as unknown;
	} catch (error) {
		const message = error instanceof Error ? error.message : "Invalid JSON";
		throw new Error(`Invalid time buoy index state JSON: ${message}`);
	}
	if (
		!isRecord(value)
		|| value.schemaVersion !== 1
		|| typeof value.updatedAt !== "string"
		|| !Number.isFinite(new Date(value.updatedAt).getTime())
		|| typeof value.dirty !== "boolean"
		|| !Array.isArray(value.affectedMemoIds)
		|| !value.affectedMemoIds.every((memoId: unknown): memoId is string => (
			typeof memoId === "string" && memoId.length > 0
		))
		|| !Array.isArray(value.expectedPeriods)
		|| !value.expectedPeriods.every((period: unknown): period is string => (
			typeof period === "string" && isTimeBuoyPeriod(period)
		))
	) {
		throw new Error("Invalid time buoy index state schema.");
	}
	return {
		schemaVersion: 1,
		updatedAt: value.updatedAt,
		dirty: value.dirty,
		affectedMemoIds: [...new Set(value.affectedMemoIds)].sort(),
		expectedPeriods: normalizePeriods(value.expectedPeriods),
	};
}

function createTimeBuoyIndexState(): TimeBuoyIndexState {
	return {
		schemaVersion: 1,
		updatedAt: new Date().toISOString(),
		dirty: false,
		affectedMemoIds: [],
		expectedPeriods: [],
	};
}

function normalizePeriods(periods: readonly string[]): string[] {
	return [...new Set(periods.filter(isTimeBuoyPeriod))].sort();
}

function isTimeBuoyPeriod(period: string): boolean {
	return /^\d{4}-(?:0[1-9]|1[0-2])$/.test(period);
}

function normalizeDates(dates: readonly string[]): string[] {
	return [...new Set(dates.filter(isValidTimeBuoyDate))].sort();
}

function cloneDates(dates: TimeBuoyIndexShard["dates"]): TimeBuoyIndexShard["dates"] {
	const next: TimeBuoyIndexShard["dates"] = {};
	for (const [targetDate, entries] of Object.entries(dates)) {
		next[targetDate] = Object.fromEntries(Object.entries(entries).map(([memoId, entry]) => [memoId, { ...entry }]));
	}
	return next;
}

function areTimeBuoyDatesEqual(
	left: TimeBuoyIndexShard["dates"],
	right: TimeBuoyIndexShard["dates"],
): boolean {
	return JSON.stringify(sortDates(left)) === JSON.stringify(sortDates(right));
}

function sortDates(dates: TimeBuoyIndexShard["dates"]): TimeBuoyIndexShard["dates"] {
	return Object.fromEntries(Object.entries(dates)
		.sort(([left], [right]) => left.localeCompare(right))
		.map(([targetDate, entries]) => [
			targetDate,
			Object.fromEntries(Object.entries(entries).sort(([left], [right]) => left.localeCompare(right))),
		]));
}

function removeMemoFromDate(dates: TimeBuoyIndexShard["dates"], targetDate: string, memoId: string): void {
	const entries = dates[targetDate];
	if (entries === undefined) {
		return;
	}
	delete entries[memoId];
	if (Object.keys(entries).length === 0) {
		delete dates[targetDate];
	}
}
