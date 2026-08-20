import { MarkdownView, normalizePath, TFile } from "obsidian";
import type { App, Editor } from "obsidian";

import type { DiaryMemoParseResult } from "./DiaryMemoParser";
import { DiaryMemoParser } from "./DiaryMemoParser";

export type CatalogV2DailyWriteMode = "active_editor" | "vault_process";

export interface CatalogV2DailyWritePrepareInput {
	file: TFile;
	logicalDate: string;
	headings: readonly string[];
	expectedRevision: string | null;
	update: (content: string, parsed: DiaryMemoParseResult) => string;
}

export interface CatalogV2PreparedDailyWrite {
	file: TFile;
	logicalDate: string;
	headings: readonly string[];
	mode: CatalogV2DailyWriteMode;
	beforeContent: string;
	afterContent: string;
	before: DiaryMemoParseResult;
	after: DiaryMemoParseResult;
	editor: Editor | null;
}

export interface CatalogV2DailyWriteResult {
	mode: CatalogV2DailyWriteMode;
	before: DiaryMemoParseResult;
	after: DiaryMemoParseResult;
}

export class CatalogV2StaleDailyError extends Error {
	constructor(path: string) {
		super(`Daily changed before the catalog v2 write: ${path}`);
		this.name = "CatalogV2StaleDailyError";
	}
}

export class CatalogV2DailyWriteGateway {
	constructor(
		private readonly app: App,
		private readonly parser = new DiaryMemoParser(),
	) {}

	async prepare(input: CatalogV2DailyWritePrepareInput): Promise<CatalogV2PreparedDailyWrite> {
		const editor = this.getActiveEditor(input.file);
		const mode: CatalogV2DailyWriteMode = editor === null ? "vault_process" : "active_editor";
		const beforeContent = editor?.getValue() ?? await this.app.vault.cachedRead(input.file);
		const before = await this.parse(input.file.path, input.logicalDate, input.headings, beforeContent);
		if (input.expectedRevision !== null && input.expectedRevision !== before.sourceRevision) {
			throw new CatalogV2StaleDailyError(input.file.path);
		}
		const afterContent = input.update(beforeContent, before);
		const after = await this.parse(input.file.path, input.logicalDate, input.headings, afterContent);
		return {
			file: input.file,
			logicalDate: input.logicalDate,
			headings: [...input.headings],
			mode,
			beforeContent,
			afterContent,
			before,
			after,
			editor,
		};
	}

	async commit(prepared: CatalogV2PreparedDailyWrite): Promise<CatalogV2DailyWriteResult> {
		if (prepared.mode === "active_editor") {
			const editor = prepared.editor;
			if (editor === null || this.getActiveEditor(prepared.file) !== editor || editor.getValue() !== prepared.beforeContent) {
				throw new CatalogV2StaleDailyError(prepared.file.path);
			}
			if (prepared.beforeContent !== prepared.afterContent) {
				editor.transaction({ changes: [{
					from: { line: 0, ch: 0 },
					to: editor.offsetToPos(prepared.beforeContent.length),
					text: prepared.afterContent,
				}] });
			}
		} else {
			await this.app.vault.process(prepared.file, (content) => {
				if (content !== prepared.beforeContent) throw new CatalogV2StaleDailyError(prepared.file.path);
				return prepared.afterContent;
			});
		}
		return { mode: prepared.mode, before: prepared.before, after: prepared.after };
	}

	async prepareTransition(input: {
		file: TFile;
		logicalDate: string;
		headings: readonly string[];
		expectedRevision: string;
		afterContent: string;
	}): Promise<CatalogV2PreparedDailyWrite> {
		return this.prepare({
			file: input.file,
			logicalDate: input.logicalDate,
			headings: input.headings,
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
		headings: readonly string[],
		content: string,
	): Promise<DiaryMemoParseResult> {
		return this.parser.parse({
			sourcePath: normalizePath(sourcePath),
			logicalDate,
			headings,
			bytes: new TextEncoder().encode(content),
		});
	}
}
