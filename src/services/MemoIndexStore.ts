import { normalizePath, TFile, TFolder, Vault } from "obsidian";
import type { App } from "obsidian";

import type { MemoIndex } from "../types";
import type { MemoRecord } from "../types/memo";
import { KnomoError } from "../types/serviceError";
import { formatMonthPeriod } from "../utils/date";
import { isRecord } from "../utils/object";
import {
	getIndexFolderPath as getConfiguredIndexFolderPath,
	getSystemFolderPath,
} from "../utils/path";
import { ensureFolder, ensureTextFile, getParentFolderPath } from "../utils/vault";

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
		return parseIndex(data, period);
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
		return parseIndex(data, period);
	}

	async loadAll(monthlyMemoFolder: string): Promise<MemoRecord[]> {
		const periods = this.listExistingPeriods(monthlyMemoFolder);
		return this.loadPeriods(monthlyMemoFolder, periods);
	}

	async loadPeriods(monthlyMemoFolder: string, periods: string[]): Promise<MemoRecord[]> {
		const uniquePeriods = [...new Set(periods)];
		const memos: MemoRecord[] = [];
		for (const period of uniquePeriods) {
			const index = await this.loadPeriod(monthlyMemoFolder, period);
			memos.push(...Object.values(index.memos));
		}
		return memos.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
	}

	async findMemoById(monthlyMemoFolder: string, memoId: string): Promise<MemoRecord | null> {
		const memos = await this.loadAll(monthlyMemoFolder);
		return memos.find((memo) => memo.id === memoId) ?? null;
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
			const index = parseIndex(data, period);
			const nextIndex = mergeIndex(index);
			return `${JSON.stringify(nextIndex, null, "\t")}\n`;
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

	async purgeDeletedMemo(monthlyMemoFolder: string, memoId: string): Promise<void> {
		const memo = await this.findMemoById(monthlyMemoFolder, memoId);
		if (memo === null) {
			throw new Error(`Memo not found: ${memoId}`);
		}
		if (memo.status !== "deleted") {
			throw new KnomoError("trash_only_purge");
		}

		const period = formatMonthPeriod(new Date(memo.createdAt));
		await this.mergePeriod(monthlyMemoFolder, period, (index) => {
			const currentMemo = index.memos[memoId];
			if (currentMemo === undefined) {
				throw new Error(`Memo not found: ${memoId}`);
			}
			if (currentMemo.status !== "deleted") {
				throw new KnomoError("trash_only_purge");
			}
			const nextMemos = { ...index.memos };
			delete nextMemos[memoId];
			return {
				...index,
				updatedAt: new Date().toISOString(),
				memos: nextMemos,
			};
		});
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
		const indexFolder = this.app.vault.getAbstractFileByPath(this.getIndexFolderPath(monthlyMemoFolder));
		if (!(indexFolder instanceof TFolder)) {
			return [formatMonthPeriod(new Date())];
		}

		const periods = indexFolder.children
			.filter((child): child is TFile => child instanceof TFile)
			.map((file) => file.name.match(/^memo-index-(\d{4}-\d{2})\.json$/)?.[1] ?? null)
			.filter((period): period is string => period !== null);
		return periods.length > 0 ? periods.sort((left, right) => right.localeCompare(left)) : [formatMonthPeriod(new Date())];
	}

	private getIndexFolderPath(monthlyMemoFolder: string): string {
		return this.indexFolderPathOverride === undefined
			? getConfiguredIndexFolderPath(monthlyMemoFolder)
			: normalizePath(this.indexFolderPathOverride);
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
	const parsed = JSON.parse(data) as unknown;
	if (!isMemoIndex(parsed)) {
		throw new Error(`Invalid memo-index schema for ${period}.`);
	}
	return parsed;
}

function createEmptyIndex(period: string): MemoIndex {
	return {
		schemaVersion: 2,
		period,
		updatedAt: new Date().toISOString(),
		memos: {},
	};
}

function isMemoIndex(value: unknown): value is MemoIndex {
	if (!isRecord(value)) {
		return false;
	}
	return value.schemaVersion === 2 && typeof value.period === "string" && isRecord(value.memos);
}
