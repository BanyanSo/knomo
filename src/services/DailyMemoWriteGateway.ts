import { MarkdownView, normalizePath, TFile } from "obsidian";
import type { App, Editor } from "obsidian";

import type { DiaryMemoParseResult } from "./DiaryMemoParser";
import { DiaryMemoParser } from "./DiaryMemoParser";

export type DailyWriteMode = "active_editor" | "vault_process";

export interface DailyWritePrepareInput {
	file: TFile;
	logicalDate: string;
	expectedRevision: string | null;
	update: (content: string, parsed: DiaryMemoParseResult) => string;
}

export interface PreparedDailyWrite {
	file: TFile;
	logicalDate: string;
	mode: DailyWriteMode;
	beforeContent: string;
	afterContent: string;
	before: DiaryMemoParseResult;
	after: DiaryMemoParseResult;
	editor: Editor | null;
	update: DailyWritePrepareInput["update"];
}

export interface DailyWriteResult {
	mode: DailyWriteMode;
	before: DiaryMemoParseResult;
	after: DiaryMemoParseResult;
}

export class StaleDailyWriteError extends Error {
	constructor(path: string) {
		super(`Daily changed before the Daily write: ${path}`);
		this.name = "StaleDailyWriteError";
	}
}

export class DailyMemoWriteGateway {
	constructor(
		private readonly app: App,
		private readonly parser = new DiaryMemoParser(),
	) {}

	async prepare(input: DailyWritePrepareInput): Promise<PreparedDailyWrite> {
		const editor = this.getActiveEditor(input.file);
		const mode: DailyWriteMode = editor === null ? "vault_process" : "active_editor";
		const beforeContent = editor?.getValue() ?? await this.app.vault.cachedRead(input.file);
		const before = await this.parse(input.file.path, input.logicalDate, beforeContent);
		if (input.expectedRevision !== null && input.expectedRevision !== before.sourceRevision) {
			throw new StaleDailyWriteError(input.file.path);
		}
		const afterContent = input.update(beforeContent, before);
		const after = await this.parse(input.file.path, input.logicalDate, afterContent);
		return {
			file: input.file,
			logicalDate: input.logicalDate,
			mode,
			beforeContent,
			afterContent,
			before,
			after,
			editor,
			update: input.update,
		};
	}

	async commit(prepared: PreparedDailyWrite): Promise<DailyWriteResult> {
		if (prepared.mode === "active_editor") {
			const editor = prepared.editor;
			if (editor === null || this.getActiveEditor(prepared.file) !== editor) {
				throw new StaleDailyWriteError(prepared.file.path);
			}
			const afterContent = this.replayPreparedUpdate(prepared, editor.getValue());
			if (prepared.beforeContent !== afterContent) {
				editor.transaction({ changes: [{
					from: { line: 0, ch: 0 },
					to: editor.offsetToPos(prepared.beforeContent.length),
					text: afterContent,
				}] });
			}
		} else {
			await this.app.vault.process(prepared.file, (content) => this.replayPreparedUpdate(prepared, content));
		}
		return { mode: prepared.mode, before: prepared.before, after: prepared.after };
	}

	private replayPreparedUpdate(prepared: PreparedDailyWrite, currentContent: string): string {
		const current = this.parser.parseRevision({
			sourcePath: normalizePath(prepared.file.path),
			logicalDate: prepared.logicalDate,
			content: currentContent,
			sourceRevision: prepared.before.sourceRevision,
		});
		if (currentContent !== prepared.beforeContent) {
			throw new StaleDailyWriteError(prepared.file.path);
		}
		const afterContent = prepared.update(currentContent, current);
		if (afterContent !== prepared.afterContent) {
			throw new StaleDailyWriteError(prepared.file.path);
		}
		return afterContent;
	}

	async prepareTransition(input: {
		file: TFile;
		logicalDate: string;
		expectedRevision: string;
		afterContent: string;
	}): Promise<PreparedDailyWrite> {
		return this.prepare({
			file: input.file,
			logicalDate: input.logicalDate,
			expectedRevision: input.expectedRevision,
			update: () => input.afterContent,
		});
	}

	private getActiveEditor(file: TFile): Editor | null {
		const view = this.app.workspace.getActiveViewOfType(MarkdownView);
		if (view === null || !(view.file instanceof TFile)
			|| normalizePath(view.file.path) !== normalizePath(file.path)) {
			return null;
		}
		return view.editor;
	}

	private parse(
		sourcePath: string,
		logicalDate: string,
		content: string,
	): Promise<DiaryMemoParseResult> {
		return this.parser.parse({
			sourcePath: normalizePath(sourcePath),
			logicalDate,
			bytes: new TextEncoder().encode(content),
		});
	}
}
