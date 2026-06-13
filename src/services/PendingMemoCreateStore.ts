import type { App } from "obsidian";

import type { PendingMemoCreate, PendingMemoCreateJournal } from "../types/pending";
import type { KnomoSettings } from "../types/settings";
import { isRecord } from "../utils/object";
import { getPendingMemoCreateFilePath } from "../utils/path";
import { ensureTextFile } from "../utils/vault";

type GetSettings = () => KnomoSettings;

export interface PendingMemoCreateStoreLike {
	list(): Promise<PendingMemoCreate[]>;
	add(operation: PendingMemoCreate): Promise<void>;
	update(operation: PendingMemoCreate): Promise<void>;
	remove(memoId: string): Promise<void>;
}

export class PendingMemoCreateStore implements PendingMemoCreateStoreLike {
	constructor(
		private readonly app: App,
		private readonly getSettings: GetSettings,
	) {}

	async list(): Promise<PendingMemoCreate[]> {
		const file = await this.getFile();
		const journal = parseJournal(await this.app.vault.cachedRead(file));
		return Object.values(journal.operations);
	}

	async add(operation: PendingMemoCreate): Promise<void> {
		await this.updateJournal((journal) => {
			if (journal.operations[operation.memoId] !== undefined) {
				throw new Error(`Pending memo create already exists: ${operation.memoId}`);
			}
			return {
				...journal,
				operations: {
					...journal.operations,
					[operation.memoId]: operation,
				},
			};
		});
	}

	async update(operation: PendingMemoCreate): Promise<void> {
		await this.updateJournal((journal) => {
			if (journal.operations[operation.memoId] === undefined) {
				throw new Error(`Pending memo create does not exist: ${operation.memoId}`);
			}
			return {
				...journal,
				operations: {
					...journal.operations,
					[operation.memoId]: operation,
				},
			};
		});
	}

	async remove(memoId: string): Promise<void> {
		await this.updateJournal((journal) => {
			if (journal.operations[memoId] === undefined) {
				return journal;
			}
			const operations = { ...journal.operations };
			delete operations[memoId];
			return {
				...journal,
				operations,
			};
		});
	}

	private async updateJournal(update: (journal: PendingMemoCreateJournal) => PendingMemoCreateJournal): Promise<void> {
		const file = await this.getFile();
		await this.app.vault.process(file, (content) => `${JSON.stringify(update(parseJournal(content)), null, "\t")}\n`);
	}

	private async getFile() {
		return ensureTextFile(
			this.app,
			getPendingMemoCreateFilePath(this.getSettings().monthlyMemoFolder),
		);
	}
}

function parseJournal(content: string): PendingMemoCreateJournal {
	if (content.trim().length === 0) {
		return createEmptyJournal();
	}
	const parsed: unknown = JSON.parse(content);
	if (!isRecord(parsed) || parsed.schemaVersion !== 1 || !isRecord(parsed.operations)) {
		throw new Error("Invalid pending memo create journal.");
	}
	for (const [memoId, operation] of Object.entries(parsed.operations)) {
		if (!isPendingMemoCreate(operation) || operation.memoId !== memoId) {
			throw new Error(`Invalid pending memo create operation: ${memoId}`);
		}
	}
	return parsed as unknown as PendingMemoCreateJournal;
}

function createEmptyJournal(): PendingMemoCreateJournal {
	return {
		schemaVersion: 1,
		operations: {},
	};
}

function isPendingMemoCreate(value: unknown): value is PendingMemoCreate {
	if (!isRecord(value)) {
		return false;
	}
	return typeof value.memoId === "string"
		&& typeof value.opId === "string"
		&& typeof value.createdAt === "string"
		&& typeof value.content === "string"
		&& typeof value.block === "string"
		&& (typeof value.dailyTrailer === "string" || value.dailyTrailer === null)
		&& typeof value.source === "string"
		&& (typeof value.sourceMemoId === "string" || value.sourceMemoId === null)
		&& (typeof value.sourceReferenceText === "string" || value.sourceReferenceText === null)
		&& isRecord(value.settings)
		&& isPreparedWrite(value.dailyWrite)
		&& (value.monthlyWrite === null || isPreparedWrite(value.monthlyWrite));
}

function isPreparedWrite(value: unknown): boolean {
	if (!isRecord(value)) {
		return false;
	}
	return typeof value.path === "string"
		&& typeof value.beforeHash === "string"
		&& typeof value.afterHash === "string"
		&& typeof value.blockOccurrencesBefore === "number"
		&& isRecord(value.ref);
}
