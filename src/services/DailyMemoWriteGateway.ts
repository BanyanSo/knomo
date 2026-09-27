import { MarkdownView, normalizePath, TFile } from "obsidian";
import type { App, Editor } from "obsidian";

import type { DiaryMemoParseResult, DiaryMemoParseRuntime } from "./DiaryMemoParser";
import { DiaryMemoParser } from "./DiaryMemoParser";

export type DailyWriteMode = "active_editor" | "vault_process";

export interface DailyWritePrepareInput {
	// Trash 在编辑器路径中也必须确认磁盘基线；普通命令保持原行为。
	requireDiskMatch?: boolean;
	file: TFile;
	logicalDate: string;
	expectedRevision: string | null;
	// 同步复核当前 Daily 配置，供提交前和 Vault.process 回调内调用。
	validateTarget?: (sourcePath: string, logicalDate: string) => void;
	update: (content: string, parsed: DiaryMemoParseResult) => string;
}

export interface PreparedDailyWrite {
	readonly sourcePath: string;
	validateTarget?: DailyWritePrepareInput["validateTarget"];
	requireDiskMatch?: boolean;
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

export interface DailyMemoWriteGatewayOptions {
	sliceBudgetMs?: number;
	maxLinesPerSlice?: number;
	yieldControl?: () => Promise<void>;
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
		private readonly options: DailyMemoWriteGatewayOptions = {},
	) {}

	async prepare(input: DailyWritePrepareInput): Promise<PreparedDailyWrite> {
		const sourcePath = normalizePath(input.file.path);
		const target = { ...input, sourcePath };
		this.assertTarget(target);
		const editor = this.getActiveEditor(input.file);
		const mode: DailyWriteMode = editor === null ? "vault_process" : "active_editor";
		const beforeContent = editor?.getValue() ?? await this.app.vault.cachedRead(input.file);
		if (input.requireDiskMatch && await this.app.vault.read(input.file) !== beforeContent) {
			throw new StaleDailyWriteError(input.file.path);
		}
		this.assertTarget(target);
		const before = await this.parse(sourcePath, input.logicalDate, beforeContent);
		if (input.expectedRevision !== null && input.expectedRevision !== before.sourceRevision) {
			throw new StaleDailyWriteError(input.file.path);
		}
		this.assertTarget(target);
		const afterContent = input.update(beforeContent, before);
		const after = await this.parse(sourcePath, input.logicalDate, afterContent);
		this.assertTarget(target);
		return {
			sourcePath,
			validateTarget: input.validateTarget,
			requireDiskMatch: input.requireDiskMatch,
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
		this.assertTarget(prepared);
		if (prepared.mode === "active_editor") {
			if (prepared.requireDiskMatch && await this.app.vault.read(prepared.file) !== prepared.beforeContent) {
				throw new StaleDailyWriteError(prepared.file.path);
			}
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
		this.assertTarget(prepared);
		if (currentContent !== prepared.beforeContent) {
			throw new StaleDailyWriteError(prepared.file.path);
		}
		const afterContent = prepared.update(currentContent, prepared.before);
		this.assertTarget(prepared);
		if (afterContent !== prepared.afterContent) {
			throw new StaleDailyWriteError(prepared.file.path);
		}
		return afterContent;
	}

	private assertTarget(target: Pick<PreparedDailyWrite, "file" | "sourcePath" | "logicalDate" | "validateTarget">): void {
		// TFile 会随重命名改变 path；同文和同路径均不能替代准备时选定的文件对象。
		if (normalizePath(target.file.path) !== target.sourcePath
			|| this.app.vault.getAbstractFileByPath(target.sourcePath) !== target.file) {
			throw new StaleDailyWriteError(target.sourcePath);
		}
		target.validateTarget?.(target.sourcePath, target.logicalDate);
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
			|| view.file !== file) {
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
		}, this.getParserRuntime());
	}

	private getParserRuntime(): DiaryMemoParseRuntime {
		return {
			sliceBudgetMs: this.options.sliceBudgetMs ?? 8,
			maxLinesPerSlice: this.options.maxLinesPerSlice ?? 256,
			yieldControl: this.options.yieldControl ?? (() => new Promise<void>((resolve) => {
				this.app.workspace.containerEl.win.setTimeout(resolve, 0);
			})),
		};
	}
}
