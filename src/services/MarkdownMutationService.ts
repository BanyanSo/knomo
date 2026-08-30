import { normalizePath, TFile } from "obsidian";
import type { App } from "obsidian";

import type { MemoObservation, ObservationHandle } from "../types/catalog";
import type { DailyInsertPosition } from "../types/settings";
import type {
	MarkdownBlockReferenceInput,
	MarkdownBlockReferenceResult,
	MarkdownCopyInput,
	MarkdownCreateInput,
	MarkdownCapturedObservation,
	MarkdownEditInput,
	MarkdownMoveInput,
	MarkdownMutationResult,
	MarkdownMutationService as MarkdownMutationContract,
	MarkdownRemoveInput,
	MarkdownRestoreInput,
	MarkdownTaskInput,
} from "../types/memoOperations";
import { formatDatePart, formatTimePart } from "../utils/date";
import { isValidMarkdownHeading } from "../utils/markdown";
import type { DiaryMemoParseResult } from "./DiaryMemoParser";
import {
	DailyMemoWriteGateway,
	StaleDailyWriteError,
	type PreparedDailyWrite,
} from "./DailyMemoWriteGateway";
import { MarkdownBlockService } from "./MarkdownBlockService";

export interface MarkdownCatalogCommitInput {
	file: TFile;
	logicalDate: string;
	content: string;
	parsed: DiaryMemoParseResult;
	insertedObservation?: MemoObservation;
}

export interface MarkdownMutationServiceOptions {
	getWriteHeading: () => string | null;
	getDailyFileForDate: (logicalDate: string) => Promise<TFile>;
	getLogicalDateForPath: (sourcePath: string) => Promise<string>;
	getMemoTimeFormat: () => "HH:mm" | "HH:mm:ss";
	getInsertPosition?: () => DailyInsertPosition;
	updateCatalogPartition: (input: MarkdownCatalogCommitInput) => Promise<void>;
	refreshCatalogPaths: (paths: readonly string[]) => Promise<void>;
	removeEmptyCreatedDailyFile?: (file: TFile) => Promise<void>;
	now?: () => Date;
	random?: () => number;
}

export class MarkdownMutationStaleError extends Error {
	constructor(path: string) {
		super(`Daily observation is stale or ambiguous: ${path}`);
		this.name = "MarkdownMutationStaleError";
	}
}

export class MarkdownMutationService implements MarkdownMutationContract {
	private readonly blockService = new MarkdownBlockService();
	private readonly now: () => Date;
	private readonly random: () => number;
	private readonly catalogUpdateQueues = new Map<string, Promise<void>>();

	constructor(
		private readonly app: App,
		private readonly options: MarkdownMutationServiceOptions,
		private readonly dailyGateway = new DailyMemoWriteGateway(app),
	) {
		this.now = options.now ?? (() => new Date());
		this.random = options.random ?? Math.random;
	}

	async create(input: MarkdownCreateInput): Promise<MarkdownMutationResult> {
		const content = normalizeMemoInput(input.content);
		if (content.trim().length === 0) throw new Error("Memo content is empty.");
		const createdAt = input.createdAt ?? this.now();
		const logicalDate = input.targetLogicalDate ?? formatDatePart(createdAt);
		const target = await this.getTargetFile(logicalDate);
		const rawBlock = this.blockService.buildMemoBlock(
			content,
			formatTimePart(createdAt, this.options.getMemoTimeFormat()),
		);
		return this.appendRawBlock(target.file, logicalDate, rawBlock, target.created, null, undefined, input.onDailyCommitted);
	}

	async edit(input: MarkdownEditInput): Promise<MarkdownMutationResult> {
		const content = normalizeMemoInput(input.content);
		if (content.trim().length === 0) throw new Error("Memo content is empty.");
		const file = this.getSourceFile(input.observation.sourcePath);
		const logicalDate = await this.options.getLogicalDateForPath(file.path);
		return this.withStaleRefresh([file.path], async () => {
			let beforeObservation: MemoObservation | null = null;
			let afterRawBlock = "";
			const prepared = await this.dailyGateway.prepare({
				file,
				logicalDate,
				expectedRevision: input.observation.sourceRevision,
				update: (currentContent, parsed) => {
					beforeObservation = findObservation(parsed, input.observation, file.path);
					afterRawBlock = this.blockService.buildMemoBlockWithBlockId(
						content,
						beforeObservation.time,
						beforeObservation.existingBlockId,
					);
					return replaceObservation(currentContent, beforeObservation, afterRawBlock, false);
				},
			});
			const changed = findReplacementObservation(prepared, requireObservation(beforeObservation), afterRawBlock);
			const catalogUpdatePending = await this.commitAndUpdateCatalog(prepared, input.onDailyCommitted);
			return committedResult(changed, [file.path], catalogUpdatePending);
		});
	}

	async toggleTask(input: MarkdownTaskInput): Promise<MarkdownMutationResult> {
		const file = this.getSourceFile(input.observation.sourcePath);
		const logicalDate = await this.options.getLogicalDateForPath(file.path);
		return this.withStaleRefresh([file.path], async () => {
			let beforeObservation: MemoObservation | null = null;
			let afterRawBlock = "";
			const prepared = await this.dailyGateway.prepare({
				file,
				logicalDate,
				expectedRevision: input.observation.sourceRevision,
				update: (currentContent, parsed) => {
					beforeObservation = findObservation(parsed, input.observation, file.path);
					const task = beforeObservation.tasks.find((candidate) => candidate.taskIndex === input.taskIndex);
					if (task === undefined) {
						throw new MarkdownMutationStaleError(file.path);
					}
					afterRawBlock = toggleRawBlockTask(
						getRawBlock(currentContent, beforeObservation),
						task.lineOffset,
						input.checked,
					);
					return replaceObservation(currentContent, beforeObservation, afterRawBlock, false);
				},
			});
			const changed = findReplacementObservation(prepared, requireObservation(beforeObservation), afterRawBlock);
			const catalogUpdatePending = await this.commitAndUpdateCatalog(prepared);
			return committedResult(changed, [file.path], catalogUpdatePending);
		});
	}

	async copy(input: MarkdownCopyInput): Promise<MarkdownMutationResult> {
		const sourceFile = this.getSourceFile(input.observation.sourcePath);
		const sourceLogicalDate = await this.options.getLogicalDateForPath(sourceFile.path);
		return this.withStaleRefresh([sourceFile.path], async () => {
			let sourceObservation: MemoObservation | null = null;
			await this.dailyGateway.prepare({
				file: sourceFile,
				logicalDate: sourceLogicalDate,
				expectedRevision: input.observation.sourceRevision,
				update: (content, parsed) => {
					sourceObservation = findObservation(parsed, input.observation, sourceFile.path);
					return content;
				},
			});
			const target = await this.getTargetFile(input.targetLogicalDate);
			const rawBlock = this.blockService.buildMemoBlock(
				requireObservation(sourceObservation).content,
				formatTimePart(input.createdAt ?? this.now(), this.options.getMemoTimeFormat()),
			);
			return this.appendRawBlock(target.file, input.targetLogicalDate, rawBlock, target.created);
		});
	}

	async move(input: MarkdownMoveInput): Promise<MarkdownMutationResult> {
		const sourceFile = this.getSourceFile(input.observation.sourcePath);
		const sourceLogicalDate = await this.options.getLogicalDateForPath(sourceFile.path);
		const target = await this.getTargetFile(input.targetLogicalDate);
		if (normalizePath(sourceFile.path) === normalizePath(target.file.path)) {
			throw new Error("Move target must be another Daily file.");
		}
		return this.withStaleRefresh([sourceFile.path], async () => {
			let sourceObservation: MemoObservation | null = null;
			let sourceRawBlock = "";
			const sourcePrepared = await this.dailyGateway.prepare({
				file: sourceFile,
				logicalDate: sourceLogicalDate,
				expectedRevision: input.observation.sourceRevision,
				update: (content, parsed) => {
					sourceObservation = findObservation(parsed, input.observation, sourceFile.path);
					sourceRawBlock = getRawBlock(content, sourceObservation);
					return replaceObservation(content, sourceObservation, "", true);
				},
			});
			const movedObservation = requireObservation(sourceObservation);
			const targetResult = await this.appendRawBlock(
				target.file,
				input.targetLogicalDate,
				sourceRawBlock,
				target.created,
				movedObservation.existingBlockId,
				movedObservation.section,
			);
			try {
				const sourceCatalogPending = await this.commitAndUpdateCatalog(sourcePrepared);
				return committedResult(
					targetResult.observation,
					[sourceFile.path, target.file.path],
					targetResult.catalogUpdatePending || sourceCatalogPending,
				);
			} catch (error) {
				let rollbackSucceeded = false;
				if (targetResult.observation !== null) {
					try {
						await this.remove({ observation: targetResult.observation });
						if (target.created) {
							await this.options.removeEmptyCreatedDailyFile?.(target.file).catch(() => undefined);
						}
						rollbackSucceeded = true;
					} catch {
						// 目标已被并发修改时不猜测删除，保留两份正文并报告待恢复。
					}
				}
				if (rollbackSucceeded) throw error;
				if (isStaleError(error)) {
					await this.options.refreshCatalogPaths([sourceFile.path]).catch(() => undefined);
				}
				return {
					status: "committed_content_pending",
					observation: targetResult.observation,
					sourcePaths: [normalizePath(sourceFile.path), normalizePath(target.file.path)],
					catalogUpdatePending: true,
				};
			}
		});
	}

	async remove(input: MarkdownRemoveInput): Promise<MarkdownMutationResult> {
		const file = this.getSourceFile(input.observation.sourcePath);
		const logicalDate = await this.options.getLogicalDateForPath(file.path);
		return this.withStaleRefresh([file.path], async () => {
			const prepared = await this.dailyGateway.prepare({
				file,
				logicalDate,
				expectedRevision: input.observation.sourceRevision,
				update: (content, parsed) => replaceObservation(
					content,
					findObservation(parsed, input.observation, file.path),
					"",
					true,
				),
			});
			const catalogUpdatePending = await this.commitAndUpdateCatalog(prepared);
			return committedResult(null, [file.path], catalogUpdatePending);
		});
	}

	async captureObservation(input: MarkdownRemoveInput): Promise<MarkdownCapturedObservation> {
		const file = this.getSourceFile(input.observation.sourcePath);
		const logicalDate = await this.options.getLogicalDateForPath(file.path);
		let observation: MemoObservation | null = null;
		let rawBlock = "";
		const prepared = await this.dailyGateway.prepare({
			file,
			logicalDate,
			expectedRevision: input.observation.sourceRevision,
			update: (content, parsed) => {
				observation = findObservation(parsed, input.observation, file.path);
				rawBlock = getRawBlock(content, observation);
				return replaceObservation(content, observation, "", true);
			},
		});
		return {
			observation: requireObservation(observation),
			rawBlock,
			deletedSourceRevision: prepared.after.sourceRevision,
		};
	}

	async restore(input: MarkdownRestoreInput): Promise<MarkdownMutationResult> {
		if (input.rawBlock.length === 0) throw new Error("Deleted memo payload is empty.");
		const target = await this.getTargetFile(input.targetLogicalDate);
		return this.appendRawBlock(target.file, input.targetLogicalDate, input.rawBlock, target.created, null, input.section);
	}

	async createBlockReference(input: MarkdownBlockReferenceInput): Promise<MarkdownBlockReferenceResult> {
		const file = this.getSourceFile(input.observation.sourcePath);
		const logicalDate = await this.options.getLogicalDateForPath(file.path);
		return this.withStaleRefresh([file.path], async () => {
			let beforeObservation: MemoObservation | null = null;
			let afterRawBlock = "";
			let blockId = "";
			const prepared = await this.dailyGateway.prepare({
				file,
				logicalDate,
				expectedRevision: input.observation.sourceRevision,
				update: (content, parsed) => {
					beforeObservation = findObservation(parsed, input.observation, file.path);
					if (beforeObservation.existingBlockId !== null) {
						blockId = beforeObservation.existingBlockId;
						afterRawBlock = getRawBlock(content, beforeObservation);
						return content;
					}
					if (blockId.length === 0) blockId = this.createUniqueBlockId(content);
					if (hasBlockId(content, blockId)) throw new MarkdownMutationStaleError(file.path);
					afterRawBlock = appendReferenceBlockId(getRawBlock(content, beforeObservation), blockId);
					return replaceObservation(content, beforeObservation, afterRawBlock, false);
				},
			});
			const current = requireObservation(beforeObservation);
			if (current.existingBlockId !== null) {
				return { ...committedResult(current, [file.path], false), blockId };
			}
			const changed = findReplacementObservation(prepared, current, afterRawBlock, blockId);
			const catalogUpdatePending = await this.commitAndUpdateCatalog(prepared);
			return { ...committedResult(changed, [file.path], catalogUpdatePending), blockId };
		});
	}

	private async appendRawBlock(
		file: TFile,
		logicalDate: string,
		rawBlock: string,
		createdFile: boolean,
		existingBlockId: string | null = null,
		preferredSection?: string | null,
		onDailyCommitted?: () => void,
	): Promise<MarkdownMutationResult> {
		return this.withStaleRefresh([file.path], async () => {
			try {
				const position = this.options.getInsertPosition?.() ?? "bottom";
				const section = preferredSection !== undefined
					&& (preferredSection === null || isValidMarkdownHeading(preferredSection))
					? preferredSection
					: this.options.getWriteHeading();
				const prepared = await this.dailyGateway.prepare({
					file,
					logicalDate,
					expectedRevision: null,
					update: (content, parsed) => {
						if (existingBlockId !== null && parsed.observations.some((item) => item.existingBlockId === existingBlockId)) {
							throw new Error("Moved Obsidian block ID already exists in the target Daily file.");
						}
						return insertRawBlock(content, rawBlock, section, position);
					},
				});
				const created = findAppendedObservation(prepared, rawBlock, section, position);
				const catalogUpdatePending = await this.commitAndUpdateCatalog(prepared, onDailyCommitted, created);
				return committedResult(created, [file.path], catalogUpdatePending);
			} catch (error) {
				if (createdFile) await this.options.removeEmptyCreatedDailyFile?.(file).catch(() => undefined);
				throw error;
			}
		});
	}

	private async commitAndUpdateCatalog(
		prepared: PreparedDailyWrite,
		onDailyCommitted?: () => void,
		insertedObservation?: MemoObservation,
	): Promise<boolean> {
		await this.dailyGateway.commit(prepared);
		const catalogUpdate = this.enqueueCatalogUpdate({
			file: prepared.file,
			logicalDate: prepared.logicalDate,
			content: prepared.afterContent,
			parsed: prepared.after,
			...(insertedObservation === undefined ? {} : { insertedObservation }),
		});
		try {
			onDailyCommitted?.();
		} catch {
			// Daily 已提交，阶段观察者失败不能反向把正文保存标记为失败。
		}
		try {
			await catalogUpdate;
			return false;
		} catch {
			void this.options.refreshCatalogPaths([prepared.file.path]).catch(() => undefined);
			return true;
		}
	}

	private enqueueCatalogUpdate(input: MarkdownCatalogCommitInput): Promise<void> {
		const sourcePath = normalizePath(input.file.path);
		const previous = this.catalogUpdateQueues.get(sourcePath) ?? Promise.resolve();
		const queued = previous
			.catch(() => undefined)
			.then(() => this.options.updateCatalogPartition(input));
		this.catalogUpdateQueues.set(sourcePath, queued);
		void queued.then(
			() => {
				if (this.catalogUpdateQueues.get(sourcePath) === queued) this.catalogUpdateQueues.delete(sourcePath);
			},
			() => {
				if (this.catalogUpdateQueues.get(sourcePath) === queued) this.catalogUpdateQueues.delete(sourcePath);
			},
		);
		return queued;
	}

	private async getTargetFile(logicalDate: string): Promise<{ file: TFile; created: boolean }> {
		const existingPaths = new Set(this.app.vault.getFiles().map((file) => normalizePath(file.path)));
		const file = await this.options.getDailyFileForDate(logicalDate);
		return { file, created: !existingPaths.has(normalizePath(file.path)) };
	}

	private getSourceFile(sourcePath: string): TFile {
		const file = this.app.vault.getAbstractFileByPath(normalizePath(sourcePath));
		if (!(file instanceof TFile)) throw new Error(`Daily file is unavailable: ${sourcePath}`);
		return file;
	}

	private createUniqueBlockId(content: string): string {
		const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
		for (let attempt = 0; attempt < 1000; attempt += 1) {
			let blockId = "";
			for (let index = 0; index < 6; index += 1) {
				blockId += chars.charAt(Math.min(Math.floor(this.random() * chars.length), chars.length - 1));
			}
			if (!hasBlockId(content, blockId)) return blockId;
		}
		throw new Error("Unable to create a unique reference block ID.");
	}

	private async withStaleRefresh<T>(paths: readonly string[], action: () => Promise<T>): Promise<T> {
		try {
			return await action();
		} catch (error) {
			if (!isStaleError(error)) throw error;
			await this.options.refreshCatalogPaths(paths).catch(() => undefined);
			throw error instanceof MarkdownMutationStaleError
				? error
				: new MarkdownMutationStaleError(paths[0] ?? "unknown");
		}
	}
}

function normalizeMemoInput(input: string): string {
	return input.replace(/\r\n/gu, "\n").replace(/\r/gu, "\n");
}

function committedResult(
	observation: MemoObservation | null,
	sourcePaths: readonly string[],
	catalogUpdatePending: boolean,
): MarkdownMutationResult {
	return {
		status: "committed_identity_pending",
		observation,
		sourcePaths: [...new Set(sourcePaths.map(normalizePath))],
		catalogUpdatePending,
	};
}

function findObservation(
	parsed: DiaryMemoParseResult,
	handle: ObservationHandle,
	actualPath: string,
): MemoObservation {
	if (normalizePath(handle.sourcePath) !== normalizePath(actualPath)
		|| parsed.sourceRevision !== handle.sourceRevision) {
		throw new MarkdownMutationStaleError(actualPath);
	}
	const matches = parsed.observations.filter((item) => item.sourceRevision === handle.sourceRevision
		&& item.startLine === handle.startLine
		&& item.endLine === handle.endLine
		&& item.rawBlockHash === handle.rawBlockHash);
	if (matches.length !== 1) throw new MarkdownMutationStaleError(actualPath);
	return matches[0] as MemoObservation;
}

function requireObservation(observation: MemoObservation | null): MemoObservation {
	if (observation === null) throw new Error("Daily observation was not resolved.");
	return observation;
}

function findReplacementObservation(
	prepared: PreparedDailyWrite,
	before: MemoObservation,
	afterRawBlock: string,
	existingBlockId: string | null = before.existingBlockId,
): MemoObservation {
	const matches = prepared.after.observations.filter((item) => item.startLine === before.startLine
		&& item.existingBlockId === existingBlockId
		&& normalizeRawBlock(getRawBlock(prepared.afterContent, item)) === normalizeRawBlock(afterRawBlock));
	if (matches.length !== 1) throw new Error("Changed Daily observation is not unique.");
	return matches[0] as MemoObservation;
}

function findAppendedObservation(
	prepared: PreparedDailyWrite,
	rawBlock: string,
	section: string | null,
	position: DailyInsertPosition,
): MemoObservation {
	if (prepared.after.observations.length !== prepared.before.observations.length + 1) {
		throw new Error("Create must add exactly one parsed memo observation.");
	}
	const matches = prepared.after.observations.filter((item) => item.section === section
		&& normalizeRawBlock(getRawBlock(prepared.afterContent, item)) === normalizeRawBlock(rawBlock))
		.sort((left, right) => position === "top"
			? left.startLine - right.startLine
			: right.startLine - left.startLine);
	if (matches.length === 0) throw new Error("Created Daily observation was not parsed.");
	return matches[0] as MemoObservation;
}

function isStaleError(error: unknown): boolean {
	return error instanceof MarkdownMutationStaleError || error instanceof StaleDailyWriteError;
}

function normalizeRawBlock(value: string): string {
	return value.replace(/\r\n|\r/gu, "\n").replace(/\n$/u, "");
}

function getRawBlock(content: string, observation: MemoObservation): string {
	const range = getObservationRange(content, observation);
	return content.slice(range.start, range.end);
}

function replaceObservation(
	content: string,
	observation: MemoObservation,
	replacement: string,
	removeLineEnding: boolean,
): string {
	const range = getObservationRange(content, observation);
	const end = removeLineEnding ? range.nextLineStart : range.end;
	return `${content.slice(0, range.start)}${replacement}${content.slice(end)}`;
}

function getObservationRange(
	content: string,
	observation: MemoObservation,
): { start: number; end: number; nextLineStart: number } {
	const starts = getLineStarts(content);
	const start = starts[observation.startLine];
	if (start === undefined) throw new MarkdownMutationStaleError(observation.sourcePath);
	const nextLineStart = starts[observation.endLine + 1] ?? content.length;
	let end = nextLineStart;
	if (end > start && content.charAt(end - 1) === "\n") end -= 1;
	if (end > start && content.charAt(end - 1) === "\r") end -= 1;
	return { start, end, nextLineStart };
}

function getLineStarts(content: string): number[] {
	const starts = [0];
	for (let index = 0; index < content.length; index += 1) {
		if (content.charAt(index) === "\n") starts.push(index + 1);
	}
	return starts;
}

function insertRawBlock(
	content: string,
	rawBlock: string,
	section: string | null,
	position: DailyInsertPosition,
): string {
	const firstLine = rawBlock.split(/\r\n|\r|\n/u, 1)[0] ?? "";
	if (!/^- (?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?(?: |$)/u.test(firstLine)) {
		throw new Error("A Daily memo raw block must start with a valid root-level time line.");
	}
	const eol = content.includes("\r\n") ? "\r\n" : "\n";
	const normalizedBlock = rawBlock.replace(/\r\n|\r|\n/gu, eol).replace(/(?:\r\n|\n)$/u, "");
	const headings = findHeadingOffsets(content);
	if (section === null) {
		const rootStart = findRootContentStart(content);
		const rootEnd = headings[0]?.start ?? content.length;
		const offset = position === "top"
			? rootStart
			: findBottomInsertOffset(content, rootStart, rootEnd);
		return insertAtOffset(content, offset, normalizedBlock, eol);
	}
	const headingIndex = headings.findIndex((heading) => heading.text.trim() === section.trim());
	if (headingIndex === -1) {
		const sectionBlock = `${section.replace(/\r\n|\r|\n/gu, "").trim()}${eol}${normalizedBlock}`;
		return insertAtOffset(content, content.length, sectionBlock, eol);
	}
	const offset = position === "top"
		? headings[headingIndex]?.contentStart ?? content.length
		: findBottomInsertOffset(
			content,
			headings[headingIndex]?.contentStart ?? content.length,
			headings[headingIndex + 1]?.start ?? content.length,
		);
	return insertAtOffset(content, offset, normalizedBlock, eol);
}

function insertAtOffset(content: string, offset: number, block: string, eol: string): string {
	let prefix = content.slice(0, offset);
	const suffix = content.slice(offset);
	if (prefix.length > 0 && !/(?:\r\n|\n)$/u.test(prefix)) prefix += eol;
	return `${prefix}${block}${eol}${suffix}`;
}

function findHeadingOffsets(content: string): Array<{ start: number; contentStart: number; text: string }> {
	const starts = getLineStarts(content);
	const result: Array<{ start: number; contentStart: number; text: string }> = [];
	let fence: { char: string; length: number } | null = null;
	let frontmatter = content.slice(0, getLineEnd(content, starts, 0)).trim() === "---";
	for (let lineIndex = 0; lineIndex < starts.length; lineIndex += 1) {
		const start = starts[lineIndex] ?? 0;
		const line = content.slice(start, getLineEnd(content, starts, lineIndex));
		if (frontmatter) {
			if (lineIndex > 0 && (line.trim() === "---" || line.trim() === "...")) frontmatter = false;
			continue;
		}
		const marker = /^ {0,3}(`{3,}|~{3,})/u.exec(line)?.[1];
		if (marker !== undefined) {
			if (fence === null) fence = { char: marker.charAt(0), length: marker.length };
			else if (fence.char === marker.charAt(0) && marker.length >= fence.length) fence = null;
			continue;
		}
		if (fence === null && /^ {0,3}#{1,6}(?:\s|$)/u.test(line)) {
			result.push({ start, contentStart: starts[lineIndex + 1] ?? content.length, text: line });
		}
	}
	return result;
}

function findRootContentStart(content: string): number {
	const starts = getLineStarts(content);
	if (content.slice(0, getLineEnd(content, starts, 0)).trim() !== "---") return 0;
	for (let lineIndex = 1; lineIndex < starts.length; lineIndex += 1) {
		const line = content.slice(starts[lineIndex], getLineEnd(content, starts, lineIndex)).trim();
		if (line === "---" || line === "...") return starts[lineIndex + 1] ?? content.length;
	}
	return content.length;
}

function findBottomInsertOffset(content: string, start: number, end: number): number {
	const starts = getLineStarts(content);
	let boundary = starts.findIndex((offset) => offset >= end);
	if (boundary === -1) boundary = starts.length;
	while (boundary > 0) {
		const lineIndex = boundary - 1;
		const lineStart = starts[lineIndex] ?? 0;
		if (lineStart < start) break;
		if (content.slice(lineStart, getLineEnd(content, starts, lineIndex)).trim().length > 0) break;
		boundary -= 1;
	}
	return starts[boundary] ?? end;
}

function getLineEnd(content: string, starts: readonly number[], lineIndex: number): number {
	let end = starts[lineIndex + 1] ?? content.length;
	if (end > 0 && content.charAt(end - 1) === "\n") end -= 1;
	if (end > 0 && content.charAt(end - 1) === "\r") end -= 1;
	return end;
}

function toggleRawBlockTask(rawBlock: string, lineOffset: number, checked: boolean): string {
	const parts = splitLinesWithSeparators(rawBlock);
	const target = parts[lineOffset];
	if (target === undefined || !/\[[ xX-]\]/u.test(target.text)) {
		throw new Error("Task marker is missing from the current Daily block.");
	}
	target.text = target.text.replace(/\[[ xX-]\]/u, checked ? "[x]" : "[ ]");
	return parts.map((part) => `${part.text}${part.separator}`).join("");
}

function splitLinesWithSeparators(content: string): Array<{ text: string; separator: string }> {
	const result: Array<{ text: string; separator: string }> = [];
	const pattern = /([^\r\n]*)(\r\n|\n|\r|$)/gu;
	let match = pattern.exec(content);
	while (match !== null && (match[0].length > 0 || result.length === 0)) {
		result.push({ text: match[1] ?? "", separator: match[2] ?? "" });
		if ((match[2] ?? "") === "") break;
		match = pattern.exec(content);
	}
	return result;
}

function appendReferenceBlockId(rawBlock: string, blockId: string): string {
	const parts = splitLinesWithSeparators(rawBlock);
	for (let index = parts.length - 1; index >= 0; index -= 1) {
		const part = parts[index];
		if (part === undefined || part.text.trim().length === 0) continue;
		part.text = `${part.text.replace(/\s+$/u, "")} ^${blockId}`;
		return parts.map((item) => `${item.text}${item.separator}`).join("");
	}
	throw new Error("Reference target has no effective content line.");
}

function hasBlockId(content: string, blockId: string): boolean {
	const escaped = blockId.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
	return new RegExp(`(?:^|[^A-Za-z0-9_-])\\^${escaped}\\b`, "u").test(content);
}
