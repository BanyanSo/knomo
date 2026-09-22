import { EditorSelection, Transaction } from "@codemirror/state";
import { isolateHistory } from "@codemirror/commands";
import { AttachmentBatchError, type AttachmentService, type ImageAttachment, type ImageAttachmentInput } from "../services/AttachmentService";
import type { ComposerEditor } from "./ComposerEditor";
import { composerImageLinks, imageRangeTouched, setComposerImageLinks } from "./ComposerImageState";
import { classifyClipboardImages } from "./clipboardImages";
import { t } from "../i18n";

export interface ComposerImageCapture {
	from: number;
	to: number;
	sourcePath: string;
	current: boolean;
	sameSession(): boolean;
}

interface ImageTask {
	capture: ComposerImageCapture;
	files: readonly ImageAttachmentInput[];
	attachments?: ImageAttachment[];
	finish(): void;
}

interface ComposerImageOptions {
	attachments: Pick<AttachmentService, "createImageEmbedLinks">;
	getSourcePath(): string | null;
	canInsert(): boolean;
	onPendingChanged(): void;
	onError(message: string): void;
}

export class ComposerImageController {
	private readonly captures = new Set<ComposerImageCapture>();
	private tasks: ImageTask[] = [];
	private active: ImageTask | null = null;
	private disposed = false;
	private inserting = false;

	constructor(readonly editor: ComposerEditor, private readonly options: ComposerImageOptions) {
		const input = editor.input;
		input.addEventListener("paste", this.onPaste, { capture: true });
		input.addEventListener("composer-transactions", this.onTransactions);
		input.addEventListener("composer-reset", this.onReset);
		input.addEventListener("composer-compositionend", this.onCompositionEnd);
		input.addEventListener("keydown", this.onKeydown, { capture: true });
		input.addEventListener("beforeinput", this.onBeforeInput, { capture: true });
	}

	get pending(): boolean { return this.tasks.length > 0; }

	capture(): ComposerImageCapture | undefined {
		if (this.disposed || this.editor.readOnly || !this.options.canInsert()) return;
		const sourcePath = this.options.getSourcePath();
		if (sourcePath === null) { this.options.onError(t("composer.imageSourceUnavailable")); return; }
		const selection = this.editor.view.state.selection.main;
		const capture = { from: selection.from, to: selection.to, sourcePath, current: true, sameSession: this.editor.capture().sameSession };
		this.captures.add(capture);
		return capture;
	}

	isCurrent(capture: ComposerImageCapture | undefined): boolean {
		return !!capture && capture.current && capture.sameSession() && !this.disposed && this.options.canInsert();
	}

	release(capture: ComposerImageCapture | undefined): void {
		if (capture && !this.tasks.some(task => task.capture === capture)) this.captures.delete(capture);
	}

	insert(files: readonly ImageAttachmentInput[], capture = this.capture()): Promise<void> {
		if (!files.length || !this.isCurrent(capture)) { this.release(capture); return Promise.resolve(); }
		const target = capture!;
		for (const old of [...this.captures]) {
			if (old !== target && target.from < target.to && old.from < target.to && old.to > target.from) this.cancel(old);
		}
		return new Promise(resolve => {
			this.tasks.push({ capture: target, files, finish: resolve });
			this.options.onPendingChanged();
			this.pump();
		});
	}

	cancelAll(): void {
		for (const capture of [...this.captures]) this.cancel(capture);
	}

	private cancel(capture: ComposerImageCapture, message?: string): void {
		capture.current = false;
		this.captures.delete(capture);
		const task = this.tasks.find(item => item.capture === capture);
		if (task) {
			this.tasks = this.tasks.filter(item => item !== task);
			if (this.active === task) this.active = null;
			task.finish();
			if (task.attachments) this.reportRetained(task.attachments.map(item => item.path));
			this.options.onPendingChanged();
		}
		if (message) this.options.onError(message);
		// 正文事件派发期间不嵌套编辑事务。
		queueMicrotask(() => this.pump());
	}

	private assertCurrent(task: ImageTask): void {
		if (!this.isCurrent(task.capture) || this.editor.readOnly) throw new Error(t("composer.imageCancelled"));
		if (this.options.getSourcePath() !== task.capture.sourcePath) {
			throw new Error(t("composer.imageSourceChanged"));
		}
	}

	private pump(): void {
		if (this.disposed || this.active || !this.tasks.length) return;
		const task = this.tasks[0];
		this.active = task;
		void this.run(task);
	}

	private async run(task: ImageTask): Promise<void> {
		try {
			this.assertCurrent(task);
			task.attachments = await this.options.attachments.createImageEmbedLinks(task.capture.sourcePath, task.files, () => this.assertCurrent(task));
			this.assertCurrent(task);
			if (!this.editor.composing) this.commit(task);
		} catch (error) {
			const paths = error instanceof AttachmentBatchError ? error.createdPaths : task.attachments?.map(item => item.path) ?? [];
			const uncertain = error instanceof AttachmentBatchError ? error.uncertainPath : null;
			const reason = error instanceof Error ? error.message : String(error);
			const message = [task.capture.current || reason !== t("composer.imageCancelled") ? `${t("error.imageInsertFailed")}: ${reason}` : "",
				this.retainedMessage(paths, uncertain)].filter(Boolean).join("\n");
			if (message) this.options.onError(message);
			this.complete(task);
		}
	}

	private commit(task: ImageTask): void {
		try {
			this.assertCurrent(task);
			const attachments = task.attachments!;
			const { from, to, sourcePath } = task.capture;
			const state = this.editor.view.state;
			const text = attachments.map(item => item.link).join("\n");
			const changes = state.changes({ from, to, insert: text });
			const links = state.field(composerImageLinks).filter(link => !imageRangeTouched(changes, link.from, link.to))
				.map(link => ({ ...link, from: changes.mapPos(link.from, 1), to: changes.mapPos(link.to, -1) }));
			let offset = from;
			for (const attachment of attachments) {
				links.push({ ...attachment, sourcePath, from: offset, to: offset + attachment.link.length });
				offset += attachment.link.length + 1;
			}
			const selection = state.selection.main;
			const nextSelection = selection.from === from && selection.to === to
				? EditorSelection.single(from + text.length) : state.selection.map(changes, 1);
			this.captures.delete(task.capture);
			this.inserting = true;
			try {
				this.editor.view.dispatch({ changes, selection: nextSelection,
					effects: setComposerImageLinks.of(links), annotations: [Transaction.userEvent.of("input.paste.image"), isolateHistory.of("full")] });
			} finally { this.inserting = false; }
			this.complete(task);
		} catch (error) {
			this.options.onError([error instanceof Error ? error.message : String(error),
				this.retainedMessage(task.attachments?.map(item => item.path) ?? [])].filter(Boolean).join("\n"));
			this.complete(task);
		}
	}

	private complete(task: ImageTask): void {
		this.captures.delete(task.capture);
		this.tasks = this.tasks.filter(item => item !== task);
		if (this.active === task) this.active = null;
		task.finish();
		this.options.onPendingChanged();
		this.pump();
	}

	private reportRetained(paths: readonly string[], uncertain: string | null = null): void {
		const message = this.retainedMessage(paths, uncertain);
		if (message) this.options.onError(message);
	}

	private retainedMessage(paths: readonly string[], uncertain: string | null = null): string {
		const messages: string[] = [];
		if (paths.length) messages.push(t("composer.imagesRetained", { paths: paths.join("\n") }));
		if (uncertain) messages.push(t("composer.imageWriteUncertain", { path: uncertain }));
		return messages.join("\n");
	}

	private readonly onPaste = (event: ClipboardEvent): void => {
		if (event.defaultPrevented || this.editor.readOnly || !this.options.canInsert()) return;
		const result = classifyClipboardImages(event.clipboardData);
		if (result.type === "native") return;
		event.preventDefault();
		event.stopImmediatePropagation();
		if (this.editor.composing) { this.options.onError(t("composer.finishComposition")); return; }
		if (result.type === "reject") { this.options.onError(t("composer.imageUnsupported")); return; }
		void this.insert(result.files);
	};

	private readonly onTransactions = (event: CustomEvent<readonly Transaction[]>): void => {
		for (const tr of event.detail) {
			if (tr.isUserEvent("undo") || tr.isUserEvent("redo")) { this.cancelAll(); continue; }
			if (!tr.docChanged) continue;
			// 清空正文结束旧任务，包括恰好位于删除范围两端的空锚点。
			if (tr.startState.doc.length > 0 && tr.newDoc.length === 0) { this.cancelAll(); continue; }
			for (const capture of [...this.captures]) {
				if (imageRangeTouched(tr.changes, capture.from, capture.to)) {
					this.cancel(capture, t("composer.imageRangeChanged")); continue;
				}
				const empty = capture.from === capture.to;
				capture.from = tr.changes.mapPos(capture.from, empty && !this.inserting ? -1 : 1);
				capture.to = empty ? capture.from : tr.changes.mapPos(capture.to, -1);
			}
		}
	};
	private readonly onReset = (): void => this.cancelAll();
	private readonly onCompositionEnd = (): void => { if (this.active?.attachments) this.commit(this.active); };
	private readonly onKeydown = (event: KeyboardEvent): void => {
		if (!this.editor.composing && (event.metaKey || event.ctrlKey) && !event.altKey && ["z", "y"].includes(event.key.toLowerCase())) this.cancelAll();
	};
	private readonly onBeforeInput = (event: InputEvent): void => {
		if (!this.editor.composing && ["historyUndo", "historyRedo"].includes(event.inputType)) this.cancelAll();
	};

	dispose(): void {
		this.disposed = true;
		this.cancelAll();
		const input = this.editor.input;
		input.removeEventListener("paste", this.onPaste, { capture: true });
		input.removeEventListener("composer-transactions", this.onTransactions);
		input.removeEventListener("composer-reset", this.onReset);
		input.removeEventListener("composer-compositionend", this.onCompositionEnd);
		input.removeEventListener("keydown", this.onKeydown, { capture: true });
		input.removeEventListener("beforeinput", this.onBeforeInput, { capture: true });
	}
}
