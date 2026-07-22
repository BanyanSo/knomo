import { normalizePath, TFile, TFolder, Vault } from "obsidian";
import type { App } from "obsidian";

import type { MemoIndex } from "../types";
import type { DailyRef, MemoRecord, MemoStatus, MemoSyncStatus, MonthlyRef } from "../types/memo";
import { KnomoError } from "../types/serviceError";
import type { SyncConflictFile } from "../types/syncConflict";
import { formatMonthPeriod } from "../utils/date";
import { isRecord } from "../utils/object";
import { recoverMemoReferenceMetadata } from "../utils/references";
import {
	getIndexFolderPath as getConfiguredIndexFolderPath,
	getSystemFolderPath,
} from "../utils/path";
import { ensureFolder, ensureTextFile, getParentFolderPath } from "../utils/vault";

export type MemoIndexPeriodVisitor = (
	period: string,
	memos: readonly MemoRecord[],
) => boolean | void | Promise<boolean | void>;

export interface SyncConflictIndexCleanupResult {
	deleted: number;
	failed: number;
	firstFailedPath: string | null;
}

// 职责：按月分片读写 memo-index，并在 process 回调内完成 JSON merge。
export class MemoIndexStore {
	constructor(
		private readonly app: App,
		private readonly indexFolderPathOverride?: string,
	) {}

	getIndexFilePath(monthlyMemoFolder: string, period: string): string {
		return normalizePath(`${this.getIndexFolderPath(monthlyMemoFolder)}/memo-index-${period}.json`);
	}

	createStoreAtIndexFolder(indexFolderPath: string): MemoIndexStore {
		return new MemoIndexStore(this.app, indexFolderPath);
	}

	async loadPeriod(monthlyMemoFolder: string, period: string): Promise<MemoIndex> {
		const file = await this.getOrCreateIndexFile(monthlyMemoFolder, period);
		const data = await this.app.vault.cachedRead(file);
		return this.recoverIndexReferences(parseIndex(data, period));
	}

	async loadExistingPeriod(monthlyMemoFolder: string, period: string): Promise<MemoIndex | null> {
		const file = this.app.vault.getAbstractFileByPath(this.getIndexFilePath(monthlyMemoFolder, period));
		if (file === null) {
			return null;
		}
		if (!(file instanceof TFile)) {
			throw new Error(`Memo-index path is not a file: ${file.path}`);
		}
		const data = await this.app.vault.cachedRead(file);
		return this.recoverIndexReferences(parseIndex(data, period));
	}

	async loadExistingPeriods(monthlyMemoFolder: string, periods: string[]): Promise<MemoRecord[]> {
		const uniquePeriods = [...new Set(periods)];
		const memos: MemoRecord[] = [];
		for (const period of uniquePeriods) {
			const index = await this.loadExistingPeriod(monthlyMemoFolder, period);
			if (index !== null) {
				memos.push(...Object.values(index.memos));
			}
		}
		return this.normalizeReadableMemos(memos);
	}

	async loadAll(monthlyMemoFolder: string): Promise<MemoRecord[]> {
		const periods = this.listExistingPeriods(monthlyMemoFolder);
		return this.loadPeriods(monthlyMemoFolder, periods);
	}

	async loadAllExisting(monthlyMemoFolder: string): Promise<MemoRecord[]> {
		return this.loadExistingPeriods(monthlyMemoFolder, this.listStoredPeriods(monthlyMemoFolder));
	}

	async loadRepairRecoverableMemos(monthlyMemoFolder: string): Promise<MemoRecord[]> {
		const byId = new Map<string, MemoRecord>();
		for (const memo of await this.loadAllExistingBestEffort(monthlyMemoFolder)) {
			if (hasValidCreatedAt(memo)) {
				byId.set(memo.id, memo);
			}
		}
		for (const memo of await this.loadPotentialSyncConflictMemos(monthlyMemoFolder)) {
			if (!hasValidCreatedAt(memo)) {
				continue;
			}
			const current = byId.get(memo.id);
			if (current === undefined || memo.updatedAt.localeCompare(current.updatedAt) > 0) {
				byId.set(memo.id, memo);
			}
		}
		return this.normalizeReadableMemos([...byId.values()]);
	}

	async scanAllExisting(monthlyMemoFolder: string, visitor: MemoIndexPeriodVisitor): Promise<boolean> {
		return this.scanPeriods(monthlyMemoFolder, this.listStoredPeriods(monthlyMemoFolder), visitor);
	}

	async scanPeriods(
		monthlyMemoFolder: string,
		periods: readonly string[],
		visitor: MemoIndexPeriodVisitor,
	): Promise<boolean> {
		const uniquePeriods = [...new Set(periods)];
		for (const period of uniquePeriods) {
			const index = await this.loadPeriod(monthlyMemoFolder, period);
			const shouldContinue = await visitor(period, this.normalizeReadableMemos(Object.values(index.memos)));
			if (shouldContinue === false) {
				return false;
			}
		}
		return true;
	}

	async loadPeriods(monthlyMemoFolder: string, periods: string[]): Promise<MemoRecord[]> {
		const uniquePeriods = [...new Set(periods)];
		const memos: MemoRecord[] = [];
		for (const period of uniquePeriods) {
			const index = await this.loadPeriod(monthlyMemoFolder, period);
			memos.push(...Object.values(index.memos));
		}
		return this.normalizeReadableMemos(memos);
	}

	async findMemoByIdInPeriod(monthlyMemoFolder: string, period: string, memoId: string): Promise<MemoRecord | null> {
		const index = await this.loadPeriod(monthlyMemoFolder, period);
		return index.memos[memoId] ?? null;
	}

	async mergePeriod(
		monthlyMemoFolder: string,
		period: string,
		mergeIndex: (index: MemoIndex) => MemoIndex,
	): Promise<MemoIndex> {
		const file = await this.getOrCreateIndexFile(monthlyMemoFolder, period);
		const nextData = await this.app.vault.process(file, (data) => {
			const index = this.recoverIndexReferences(parseIndex(data, period));
			const nextIndex = mergeIndex(index);
			const serialized = `${JSON.stringify(nextIndex, null, "\t")}\n`;
			return serialized === data ? data : serialized;
		});
		return parseIndex(nextData, period);
	}

	async addMemo(
		monthlyMemoFolder: string,
		memo: MemoRecord,
		createNextMemoId: () => string,
		maxAttempts = 100,
	): Promise<MemoRecord> {
		const period = formatMonthPeriod(new Date(memo.createdAt));
		let savedMemo: MemoRecord | null = null;
		await this.mergePeriod(monthlyMemoFolder, period, (index) => {
			for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
				const candidateMemo = attempt === 0 ? memo : { ...memo, id: createNextMemoId() };
				if (index.memos[candidateMemo.id] !== undefined) {
					continue;
				}
				savedMemo = candidateMemo;
				return {
					...index,
					updatedAt: new Date().toISOString(),
					memos: {
						...index.memos,
						[candidateMemo.id]: candidateMemo,
					},
				};
			}
			throw new Error("Unable to allocate a unique memoId.");
		});
		if (savedMemo === null) {
			throw new Error("Memo index write did not return a saved memo.");
		}
		return savedMemo;
	}

	async addMemoWithId(monthlyMemoFolder: string, memo: MemoRecord): Promise<MemoRecord> {
		const period = formatMonthPeriod(new Date(memo.createdAt));
		let savedMemo: MemoRecord | null = null;
		await this.mergePeriod(monthlyMemoFolder, period, (index) => {
			const existingMemo = index.memos[memo.id];
			if (existingMemo !== undefined) {
				if (
					existingMemo.createdAt !== memo.createdAt
					|| existingMemo.dailyRef.path !== memo.dailyRef.path
				) {
					throw new Error(`memoId collision: ${memo.id}`);
				}
				savedMemo = existingMemo;
				return index;
			}
			savedMemo = memo;
			return {
				...index,
				updatedAt: new Date().toISOString(),
				memos: {
					...index.memos,
					[memo.id]: memo,
				},
			};
		});
		if (savedMemo === null) {
			throw new Error("Memo index write did not return a saved memo.");
		}
		return savedMemo;
	}

	async upsertMemo(monthlyMemoFolder: string, memo: MemoRecord): Promise<MemoRecord> {
		const period = formatMonthPeriod(new Date(memo.createdAt));
		await this.mergePeriod(monthlyMemoFolder, period, (index) => ({
			...index,
			updatedAt: new Date().toISOString(),
			memos: {
				...index.memos,
				[memo.id]: memo,
			},
		}));
		return memo;
	}

	async updateMemo(
		monthlyMemoFolder: string,
		memo: MemoRecord,
		update: (memo: MemoRecord) => MemoRecord,
	): Promise<MemoRecord> {
		const period = formatMonthPeriod(new Date(memo.createdAt));
		let updatedMemo: MemoRecord | null = null;
		await this.mergePeriod(monthlyMemoFolder, period, (index) => {
			const currentMemo = index.memos[memo.id];
			if (currentMemo === undefined) {
				throw new Error(`Memo not found: ${memo.id}`);
			}
			const nextMemo = update(currentMemo);
			updatedMemo = nextMemo;
			return {
				...index,
				updatedAt: new Date().toISOString(),
				memos: {
					...index.memos,
					[nextMemo.id]: nextMemo,
				},
			};
		});
		if (updatedMemo === null) {
			throw new Error("Memo index update did not return a memo.");
		}
		return updatedMemo;
	}

	async purgeDeletedMemoRecord(monthlyMemoFolder: string, memo: MemoRecord): Promise<void> {
		if (memo.status !== "deleted") {
			throw new KnomoError("trash_only_purge");
		}

		const period = formatMonthPeriod(new Date(memo.createdAt));
		await this.mergePeriod(monthlyMemoFolder, period, (index) => {
			const currentMemo = index.memos[memo.id];
			if (currentMemo === undefined) {
				throw new Error(`Memo not found: ${memo.id}`);
			}
			if (currentMemo.status !== "deleted") {
				throw new KnomoError("trash_only_purge");
			}
			const nextMemos = { ...index.memos };
			delete nextMemos[memo.id];
			return {
				...index,
				updatedAt: new Date().toISOString(),
				memos: nextMemos,
			};
		});
	}

	async compactDuplicateDailyBlockMemos(
		monthlyMemoFolder: string,
		periods?: ReadonlySet<string>,
	): Promise<number> {
		let removed = 0;
		for (const period of this.listStoredPeriods(monthlyMemoFolder)) {
			if (periods !== undefined && !periods.has(period)) {
				continue;
			}
			const file = this.app.vault.getAbstractFileByPath(this.getIndexFilePath(monthlyMemoFolder, period));
			if (!(file instanceof TFile)) {
				continue;
			}
			await this.app.vault.process(file, (data) => {
				const index = parseIndex(data, period);
				const memos = Object.values(index.memos);
				const dedupedMemos = dedupeRecoverableMemos(memos);
				const removedInPeriod = memos.length - dedupedMemos.length;
				if (removedInPeriod === 0) {
					return data;
				}
				removed += removedInPeriod;
				return `${JSON.stringify({
					...index,
					updatedAt: new Date().toISOString(),
					memos: toMemoRecordMap(dedupedMemos),
				}, null, "\t")}\n`;
			});
		}
		return removed;
	}

	async backupIndexes(monthlyMemoFolder: string, reason: string): Promise<string | null> {
		const backupRoot = normalizePath(`${getSystemFolderPath(monthlyMemoFolder)}/backups/${reason}-${formatBackupTimestamp(new Date())}`);
		const indexBackupRoot = normalizePath(`${backupRoot}/indexes`);
		await ensureFolder(this.app, indexBackupRoot);
		const indexFolder = this.app.vault.getAbstractFileByPath(this.getIndexFolderPath(monthlyMemoFolder));
		if (!(indexFolder instanceof TFolder)) {
			return backupRoot;
		}
		const files: TFile[] = [];
		Vault.recurseChildren(indexFolder, (child) => {
			if (child instanceof TFile) {
				files.push(child);
			}
		});
		for (const file of files) {
			const relativePath = file.path.slice(indexFolder.path.length + 1);
			const backupPath = normalizePath(`${indexBackupRoot}/${relativePath}`);
			const parentPath = getParentFolderPath(backupPath);
			if (parentPath !== null) {
				await ensureFolder(this.app, parentPath);
			}
			await this.app.vault.create(backupPath, await this.app.vault.cachedRead(file));
		}
		return backupRoot;
	}

	async restoreIndexes(monthlyMemoFolder: string, backupPath: string | null): Promise<void> {
		if (backupPath === null) {
			await this.removeIndexFilesExcept(monthlyMemoFolder, new Set());
			return;
		}
		const backupFolderPath = normalizePath(`${backupPath}/indexes`);
		const backupFolder = this.app.vault.getAbstractFileByPath(backupFolderPath);
		if (!(backupFolder instanceof TFolder)) {
			throw new KnomoError("index_backup_missing", { path: backupFolderPath });
		}
		const files: TFile[] = [];
		Vault.recurseChildren(backupFolder, (child) => {
			if (child instanceof TFile) {
				files.push(child);
			}
		});
		const backupRelativePaths = new Set(files.map((file) => file.path.slice(backupFolder.path.length + 1)));
		await this.removeIndexFilesExcept(monthlyMemoFolder, backupRelativePaths);
		const indexFolderPath = this.getIndexFolderPath(monthlyMemoFolder);
		await ensureFolder(this.app, indexFolderPath);
		for (const file of files) {
			const relativePath = file.path.slice(backupFolder.path.length + 1);
			const targetPath = normalizePath(`${indexFolderPath}/${relativePath}`);
			const parentPath = getParentFolderPath(targetPath);
			if (parentPath !== null) {
				await ensureFolder(this.app, parentPath);
			}
			const content = await this.app.vault.cachedRead(file);
			const existing = this.app.vault.getAbstractFileByPath(targetPath);
			if (existing instanceof TFile) {
				await this.app.vault.process(existing, () => content);
			} else {
				await this.app.vault.create(targetPath, content);
			}
		}
	}

	async initializeEmptyPeriods(monthlyMemoFolder: string, periods: string[]): Promise<void> {
		for (const period of [...new Set(periods)]) {
			const file = await this.getOrCreateIndexFile(monthlyMemoFolder, period);
			await this.app.vault.process(file, () => `${JSON.stringify(createEmptyIndex(period), null, "\t")}\n`);
		}
	}

	async commitCandidateIndexes(
		monthlyMemoFolder: string,
		candidateIndexFolderPath: string,
		periods: string[],
	): Promise<void> {
		const indexFolderPath = this.getIndexFolderPath(monthlyMemoFolder);
		await ensureFolder(this.app, indexFolderPath);
		for (const period of [...new Set(periods)]) {
			const candidatePath = normalizePath(`${candidateIndexFolderPath}/memo-index-${period}.json`);
			const candidateFile = this.app.vault.getAbstractFileByPath(candidatePath);
			if (!(candidateFile instanceof TFile)) {
				throw new Error(`Rebuilt memo-index does not exist: ${candidatePath}`);
			}
			const content = await this.app.vault.cachedRead(candidateFile);
			parseIndex(content, period);
			const targetPath = this.getIndexFilePath(monthlyMemoFolder, period);
			const targetFile = this.app.vault.getAbstractFileByPath(targetPath);
			if (targetFile instanceof TFile) {
				await this.app.vault.process(targetFile, () => content);
			} else {
				await this.app.vault.create(targetPath, content);
			}
		}
	}

	private async removeIndexFilesExcept(monthlyMemoFolder: string, keepRelativePaths: Set<string>): Promise<void> {
		const indexFolder = this.app.vault.getAbstractFileByPath(this.getIndexFolderPath(monthlyMemoFolder));
		if (!(indexFolder instanceof TFolder)) {
			return;
		}
		const files: TFile[] = [];
		Vault.recurseChildren(indexFolder, (child) => {
			if (child instanceof TFile) {
				files.push(child);
			}
		});
		for (const file of files) {
			const relativePath = file.path.slice(indexFolder.path.length + 1);
			if (!keepRelativePaths.has(relativePath)) {
				await this.app.fileManager.trashFile(file);
			}
		}
	}

	private async getOrCreateIndexFile(monthlyMemoFolder: string, period: string): Promise<TFile> {
		return ensureTextFile(this.app, this.getIndexFilePath(monthlyMemoFolder, period));
	}

	listExistingPeriods(monthlyMemoFolder: string): string[] {
		const periods = this.listStoredPeriods(monthlyMemoFolder);
		return periods.length > 0 ? periods : [formatMonthPeriod(new Date())];
	}

	listStoredPeriods(monthlyMemoFolder: string): string[] {
		const indexFolder = this.app.vault.getAbstractFileByPath(this.getIndexFolderPath(monthlyMemoFolder));
		if (!(indexFolder instanceof TFolder)) {
			return [];
		}

		const periods = indexFolder.children
			.filter((child): child is TFile => child instanceof TFile)
			.map((file) => file.name.match(/^memo-index-(\d{4}-\d{2})\.json$/)?.[1] ?? null)
			.filter((period): period is string => period !== null);
		return periods.sort((left, right) => right.localeCompare(left));
	}

	listPotentialSyncConflictFiles(monthlyMemoFolder: string): SyncConflictFile[] {
		return this.listPotentialSyncConflictIndexFiles(monthlyMemoFolder).map(({ file, period }) => ({
			kind: "memo-index",
			path: file.path,
			period,
		}));
	}

	async trashPotentialSyncConflictFiles(
		monthlyMemoFolder: string,
		periods?: ReadonlySet<string>,
	): Promise<SyncConflictIndexCleanupResult> {
		let deleted = 0;
		let failed = 0;
		let firstFailedPath: string | null = null;
		for (const { file, period } of this.listPotentialSyncConflictIndexFiles(monthlyMemoFolder)) {
			if (period === null || (periods !== undefined && !periods.has(period))) {
				continue;
			}
			try {
				await this.app.fileManager.trashFile(file);
				deleted += 1;
			} catch {
				failed += 1;
				firstFailedPath ??= file.path;
			}
		}
		return { deleted, failed, firstFailedPath };
	}

	private getIndexFolderPath(monthlyMemoFolder: string): string {
		return this.indexFolderPathOverride === undefined
			? getConfiguredIndexFolderPath(monthlyMemoFolder)
			: normalizePath(this.indexFolderPathOverride);
	}

	private async loadPotentialSyncConflictMemos(monthlyMemoFolder: string): Promise<MemoRecord[]> {
		const memos: MemoRecord[] = [];
		for (const { file, period } of this.listPotentialSyncConflictIndexFiles(monthlyMemoFolder)) {
			try {
				const data = await this.app.vault.cachedRead(file);
				const indexPeriod = period ?? readIndexPeriod(data);
				if (indexPeriod === null) {
					continue;
				}
				const index = this.recoverIndexReferences(parseIndex(data, indexPeriod));
				memos.push(...Object.values(index.memos));
			} catch {
				continue;
			}
		}
		return this.recoverReferences(memos);
	}

	private async loadAllExistingBestEffort(monthlyMemoFolder: string): Promise<MemoRecord[]> {
		const memos: MemoRecord[] = [];
		for (const period of this.listStoredPeriods(monthlyMemoFolder)) {
			try {
				const index = await this.loadExistingPeriod(monthlyMemoFolder, period);
				if (index !== null) {
					memos.push(...Object.values(index.memos));
				}
			} catch {
				continue;
			}
		}
		return memos;
	}

	private listPotentialSyncConflictIndexFiles(monthlyMemoFolder: string): Array<{ file: TFile; period: string | null }> {
		const indexFolder = this.app.vault.getAbstractFileByPath(this.getIndexFolderPath(monthlyMemoFolder));
		if (!(indexFolder instanceof TFolder)) {
			return [];
		}
		const files: Array<{ file: TFile; period: string | null }> = [];
		Vault.recurseChildren(indexFolder, (child) => {
			if (!(child instanceof TFile) || child.extension !== "json") {
				return;
			}
			const period = getMemoIndexSideCopyPeriod(child.name);
			if (period === null) {
				return;
			}
			files.push({
				file: child,
				period,
			});
		});
		return files.sort((left, right) => left.file.path.localeCompare(right.file.path));
	}

	private recoverIndexReferences(index: MemoIndex): MemoIndex {
		const memos = this.recoverReferences(Object.values(index.memos));
		if (memos.every((memo) => index.memos[memo.id] === memo)) {
			return index;
		}
		const recoveredMemos: Record<string, MemoRecord> = {};
		for (const memo of memos) {
			recoveredMemos[memo.id] = memo;
		}
		return {
			...index,
			memos: recoveredMemos,
		};
	}

	private recoverReferences(memos: readonly MemoRecord[]): MemoRecord[] {
		return recoverMemoReferenceMetadata(memos, (linkPath, sourcePath) => {
			const destination = this.app.metadataCache?.getFirstLinkpathDest(linkPath, sourcePath) ?? null;
			return destination?.path ?? null;
		});
	}

	private normalizeReadableMemos(memos: readonly MemoRecord[]): MemoRecord[] {
		return sortMemosByCreatedAt(dedupeRecoverableMemos(this.recoverReferences(memos)));
	}
}

function formatBackupTimestamp(date: Date): string {
	const year = date.getFullYear();
	const month = String(date.getMonth() + 1).padStart(2, "0");
	const day = String(date.getDate()).padStart(2, "0");
	const hours = String(date.getHours()).padStart(2, "0");
	const minutes = String(date.getMinutes()).padStart(2, "0");
	const seconds = String(date.getSeconds()).padStart(2, "0");
	return `${year}${month}${day}-${hours}${minutes}${seconds}`;
}

function parseIndex(data: string, period: string): MemoIndex {
	if (data.trim().length === 0) {
		return createEmptyIndex(period);
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(data) as unknown;
	} catch (error) {
		const message = error instanceof Error ? error.message : "Invalid JSON";
		throw new Error(`Invalid memo-index JSON for ${period}: ${message}`);
	}
	return parseMemoIndex(parsed, period);
}

function createEmptyIndex(period: string): MemoIndex {
	return {
		schemaVersion: 2,
		period,
		updatedAt: new Date().toISOString(),
		memos: {},
	};
}

function readIndexPeriod(data: string): string | null {
	try {
		const parsed = JSON.parse(data) as unknown;
		return isRecord(parsed) && typeof parsed.period === "string" ? parsed.period : null;
	} catch {
		return null;
	}
}

function getMemoIndexSideCopyPeriod(fileName: string): string | null {
	return fileName.match(/^memo-index-(\d{4}-\d{2}).+\.json$/)?.[1] ?? null;
}

function sortMemosByCreatedAt(memos: MemoRecord[]): MemoRecord[] {
	return memos.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
}

function hasValidCreatedAt(memo: MemoRecord): boolean {
	return Number.isFinite(new Date(memo.createdAt).getTime());
}

function dedupeRecoverableMemos(memos: MemoRecord[]): MemoRecord[] {
	const result: MemoRecord[] = [];
	const memoIndexesByDailyKey = new Map<string, number>();
	for (const memo of memos) {
		const key = getRecoverableDailyBlockKey(memo);
		if (key === null) {
			result.push(memo);
			continue;
		}
		const existingIndex = memoIndexesByDailyKey.get(key);
		if (existingIndex === undefined) {
			memoIndexesByDailyKey.set(key, result.length);
			result.push(memo);
			continue;
		}
		if (compareRecoverableMemoPriority(memo, result[existingIndex]) > 0) {
			result[existingIndex] = memo;
		}
	}
	return result;
}

function getRecoverableDailyBlockKey(memo: MemoRecord): string | null {
	if (memo.status !== "active" || memo.dailyRef.lineNumberHint === null) {
		return null;
	}
	if (
		memo.dailyRef.path.trim().length === 0
		|| memo.dailyRef.lastKnownBlock.trim().length === 0
		|| memo.dailyRef.lastKnownHash.trim().length === 0
		|| memo.contentHash.trim().length === 0
	) {
		return null;
	}
	return [
		memo.dailyRef.path,
		memo.dailyRef.heading ?? "",
		memo.dailyRef.sectionType ?? "",
		String(memo.dailyRef.lineNumberHint),
		memo.dailyRef.lastKnownBlock,
		memo.dailyRef.lastKnownHash,
		memo.contentHash,
		memo.createdAt,
	].join("\u0001");
}

function compareRecoverableMemoPriority(left: MemoRecord, right: MemoRecord): number {
	const leftIssuePriority = left.issue === null ? 1 : 0;
	const rightIssuePriority = right.issue === null ? 1 : 0;
	if (leftIssuePriority !== rightIssuePriority) {
		return leftIssuePriority - rightIssuePriority;
	}
	const leftSyncPriority = left.syncStatus === "synced" ? 1 : 0;
	const rightSyncPriority = right.syncStatus === "synced" ? 1 : 0;
	if (leftSyncPriority !== rightSyncPriority) {
		return leftSyncPriority - rightSyncPriority;
	}
	const updatedAtCompare = left.updatedAt.localeCompare(right.updatedAt);
	if (updatedAtCompare !== 0) {
		return updatedAtCompare;
	}
	return left.id < right.id ? 1 : left.id > right.id ? -1 : 0;
}

function toMemoRecordMap(memos: readonly MemoRecord[]): Record<string, MemoRecord> {
	const result: Record<string, MemoRecord> = {};
	for (const memo of memos) {
		result[memo.id] = memo;
	}
	return result;
}

function parseMemoIndex(value: unknown, period: string): MemoIndex {
	if (!isRecord(value)) {
		throw new Error(`Invalid memo-index schema for ${period}.`);
	}
	if (value.schemaVersion !== 2 || typeof value.period !== "string" || !isRecord(value.memos)) {
		throw new Error(`Invalid memo-index schema for ${period}.`);
	}

	const memos: Record<string, MemoRecord> = {};
	for (const [memoId, memo] of Object.entries(value.memos)) {
		memos[memoId] = parseMemoRecord(memo, period, memoId);
	}
	return {
		schemaVersion: 2,
		period: value.period,
		updatedAt: typeof value.updatedAt === "string" ? value.updatedAt : "",
		memos,
	};
}

function parseMemoRecord(value: unknown, period: string, memoId: string): MemoRecord {
	if (!isRecord(value)) {
		throw invalidMemoRecordError(period, memoId, "record");
	}
	const id = requireString(value, period, memoId, "id");
	if (id !== memoId) {
		throw invalidMemoRecordError(period, memoId, "id");
	}
	const dailyRef = parseDailyRef(value.dailyRef, period, memoId);
	const monthlyRef = parseMonthlyRef(value.monthlyRef, period, memoId);
	return {
		id,
		createdAt: requireString(value, period, memoId, "createdAt"),
		updatedAt: requireString(value, period, memoId, "updatedAt"),
		contentSnapshot: requireString(value, period, memoId, "contentSnapshot"),
		contentHash: requireString(value, period, memoId, "contentHash"),
		status: requireMemoStatus(value.status, period, memoId),
		syncStatus: requireMemoSyncStatus(value.syncStatus, period, memoId),
		source: requireString(value, period, memoId, "source") as MemoRecord["source"],
		version: requireNumber(value, period, memoId, "version"),
		tags: requireStringArray(value, period, memoId, "tags"),
		links: requireArray(value, period, memoId, "links") as MemoRecord["links"],
		images: requireArray(value, period, memoId, "images") as MemoRecord["images"],
		references: requireArray(value, period, memoId, "references") as MemoRecord["references"],
		sourceMemoId: requireNullableString(value, period, memoId, "sourceMemoId"),
		issue: value.issue === null || isRecord(value.issue)
			? value.issue as MemoRecord["issue"]
			: throwInvalidMemoRecord(period, memoId, "issue"),
		lastMarkdownSyncAt: requireNullableString(value, period, memoId, "lastMarkdownSyncAt"),
		lastMarkdownSyncSource: requireNullableString(value, period, memoId, "lastMarkdownSyncSource") as MemoRecord["lastMarkdownSyncSource"],
		dailyRef,
		monthlyRef,
		...optionalStringProperty(value, period, memoId, "deletedAt"),
		...optionalStringProperty(value, period, memoId, "deleteSource"),
		...optionalStringProperty(value, period, memoId, "deletedDailyBlock"),
		...optionalStringProperty(value, period, memoId, "deletedMonthlyBlock"),
	};
}

function parseDailyRef(value: unknown, period: string, memoId: string): DailyRef {
	if (!isRecord(value)) {
		throw invalidMemoRecordError(period, memoId, "dailyRef");
	}
	const sectionType = value.sectionType;
	if (sectionType !== undefined && sectionType !== "heading" && sectionType !== "root") {
		throw invalidMemoRecordError(period, memoId, "dailyRef.sectionType");
	}
	return {
		path: requireString(value, period, memoId, "dailyRef.path", "path"),
		heading: requireNullableString(value, period, memoId, "dailyRef.heading", "heading"),
		...(sectionType === undefined ? {} : { sectionType }),
		lastKnownBlock: requireString(value, period, memoId, "dailyRef.lastKnownBlock", "lastKnownBlock"),
		lastKnownHash: requireString(value, period, memoId, "dailyRef.lastKnownHash", "lastKnownHash"),
		lineNumberHint: requireNullableNumber(value, period, memoId, "dailyRef.lineNumberHint", "lineNumberHint"),
		lastSyncedAt: requireNullableString(value, period, memoId, "dailyRef.lastSyncedAt", "lastSyncedAt"),
	};
}

function parseMonthlyRef(value: unknown, period: string, memoId: string): MonthlyRef {
	if (!isRecord(value)) {
		throw invalidMemoRecordError(period, memoId, "monthlyRef");
	}
	return {
		path: requireString(value, period, memoId, "monthlyRef.path", "path"),
		dateHeading: requireString(value, period, memoId, "monthlyRef.dateHeading", "dateHeading"),
		lastKnownBlock: requireString(value, period, memoId, "monthlyRef.lastKnownBlock", "lastKnownBlock"),
		lastKnownHash: requireString(value, period, memoId, "monthlyRef.lastKnownHash", "lastKnownHash"),
		lineNumberHint: requireNullableNumber(value, period, memoId, "monthlyRef.lineNumberHint", "lineNumberHint"),
		lastSyncedAt: requireNullableString(value, period, memoId, "monthlyRef.lastSyncedAt", "lastSyncedAt"),
	};
}

function requireString(value: Record<string, unknown>, period: string, memoId: string, field: string, fieldKey = field): string {
	const fieldValue = readField(value, fieldKey);
	if (typeof fieldValue !== "string") {
		throw invalidMemoRecordError(period, memoId, field);
	}
	return fieldValue;
}

function requireNullableString(value: Record<string, unknown>, period: string, memoId: string, field: string, fieldKey = field): string | null {
	const fieldValue = readField(value, fieldKey);
	if (typeof fieldValue !== "string" && fieldValue !== null) {
		throw invalidMemoRecordError(period, memoId, field);
	}
	return fieldValue;
}

function requireNumber(value: Record<string, unknown>, period: string, memoId: string, field: string): number {
	const fieldValue = readField(value, field);
	if (typeof fieldValue !== "number" || !Number.isFinite(fieldValue)) {
		throw invalidMemoRecordError(period, memoId, field);
	}
	return fieldValue;
}

function requireNullableNumber(value: Record<string, unknown>, period: string, memoId: string, field: string, fieldKey = field): number | null {
	const fieldValue = readField(value, fieldKey);
	if ((typeof fieldValue !== "number" || !Number.isFinite(fieldValue)) && fieldValue !== null) {
		throw invalidMemoRecordError(period, memoId, field);
	}
	return fieldValue;
}

function requireArray(value: Record<string, unknown>, period: string, memoId: string, field: string): unknown[] {
	const fieldValue = readField(value, field);
	if (!Array.isArray(fieldValue)) {
		throw invalidMemoRecordError(period, memoId, field);
	}
	return fieldValue;
}

function requireStringArray(value: Record<string, unknown>, period: string, memoId: string, field: string): string[] {
	const fieldValue = requireArray(value, period, memoId, field);
	if (!fieldValue.every((item) => typeof item === "string")) {
		throw invalidMemoRecordError(period, memoId, field);
	}
	return fieldValue;
}

function requireMemoStatus(value: unknown, period: string, memoId: string): MemoStatus {
	if (value !== "active" && value !== "deleted" && value !== "error") {
		throw invalidMemoRecordError(period, memoId, "status");
	}
	return value;
}

function requireMemoSyncStatus(value: unknown, period: string, memoId: string): MemoSyncStatus {
	if (
		value !== "synced" &&
		value !== "pending_monthly" &&
		value !== "monthly_failed" &&
		value !== "monthly_delete_failed"
	) {
		throw invalidMemoRecordError(period, memoId, "syncStatus");
	}
	return value;
}

function optionalStringProperty(
	value: Record<string, unknown>,
	period: string,
	memoId: string,
	field: "deletedAt" | "deleteSource" | "deletedDailyBlock" | "deletedMonthlyBlock",
): Partial<Pick<MemoRecord, typeof field>> {
	const fieldValue = value[field];
	if (fieldValue === undefined) {
		return {};
	}
	if (typeof fieldValue !== "string") {
		throw invalidMemoRecordError(period, memoId, field);
	}
	return { [field]: fieldValue };
}

function readField(value: Record<string, unknown>, field: string): unknown {
	return field.split(".").reduce<unknown>((current, key) => (
		isRecord(current) ? current[key] : undefined
	), value);
}

function throwInvalidMemoRecord(period: string, memoId: string, field: string): never {
	throw invalidMemoRecordError(period, memoId, field);
}

function invalidMemoRecordError(period: string, memoId: string, field: string): Error {
	return new Error(`Invalid memo-index record for ${period}: memoId=${memoId}, field=${field}.`);
}
