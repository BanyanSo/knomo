import { Modal, Platform, setIcon } from "obsidian";
import type { App } from "obsidian";
import { t } from "../i18n";
import { removeObsidianModalCloseButtons } from "./ObsidianModalCloseButton";
import { ShareCardError } from "./share/ShareCardContent";
import type { ShareCardSnapshot } from "./share/ShareCardContent";
import { SHARE_CARD_EDITORIAL_COVER } from "./share/ShareCardTemplateResources";
import { ShareCardRenderer } from "./share/ShareCardRenderer";
import { ShareCardSession } from "./share/ShareCardSession";
import { SHARE_CARD_TEMPLATES } from "./share/ShareCardTemplates";
import type { ShareCardTemplateId } from "./share/ShareCardTemplates";
import { getShareCardCapabilities, outputShareCard, shareCardFile } from "./share/ShareCardOutput";
import { saveShareCardToVault } from "./share/ShareCardResources";

interface ShareCardModalOptions {
	loadSnapshot: (signal: AbortSignal) => Promise<ShareCardSnapshot>;
	loadImage: (path: string, sourcePath: string, signal: AbortSignal) => Promise<Blob>;
	lockScroll: () => void;
	onClose: () => void;
	returnFocusEl?: HTMLElement | null;
}

export class KnomoShareCardModal extends Modal {
	private snapshot: ShareCardSnapshot | null = null;
	private renderer: ShareCardRenderer | null = null;
	private session: ShareCardSession<Blob> | null = null;
	private selected: ShareCardTemplateId = "paper";
	private file: File | null = null;
	private previewUrl: string | null = null;
	private statusEl!: HTMLElement;
	private previewEl!: HTMLElement;
	private actionsEl!: HTMLElement;
	private templateButtons: HTMLButtonElement[] = [];
	private closed = false;
	private outputBusy = false;
	private stale = false;
	private readonly abort = new AbortController();
	private readonly previousFocus: Element | null;
	constructor(app: App, private readonly options: ShareCardModalOptions) {
		super(app); this.previousFocus = options.returnFocusEl ?? this.containerEl.ownerDocument.activeElement;
	}
	onOpen(): void {
		this.modalEl.addClass("knomo-share-modal"); this.containerEl.addClass("knomo-share-backdrop");
		removeObsidianModalCloseButtons(this.modalEl); this.titleEl.setText(t("share.title"));
		const header = this.modalEl.createDiv({ cls: "knomo-share-header" });
		this.titleEl.before(header); header.append(this.titleEl);
		const close = header.createEl("button", { cls: "knomo-share-close", text: "×", attr: { type: "button" } });
		close.addEventListener("click", () => this.close());
		this.contentEl.empty(); this.contentEl.addClass("knomo-share-content");
		this.previewEl = this.contentEl.createDiv({ cls: "knomo-share-preview", attr: { tabindex: "0" } });
		const footer = this.contentEl.createDiv({ cls: "knomo-share-footer" });
		const templates = footer.createDiv({ cls: "knomo-share-templates", attr: { role: "group" } });
		for (const template of SHARE_CARD_TEMPLATES) {
			const button = templates.createEl("button", { text: t(`share.${template.id}`), attr: { type: "button", "aria-pressed": String(template.id === this.selected), "data-template": template.id } });
			button.addEventListener("click", () => this.select(template.id)); this.templateButtons.push(button);
		}
		this.statusEl = footer.createDiv({ cls: "knomo-share-status", attr: { role: "status", "aria-live": "polite" } });
		this.actionsEl = footer.createDiv({ cls: "knomo-share-actions" });
		this.renderer = new ShareCardRenderer(this.modalEl, Platform.isMobile, (path, signal) => this.options.loadImage(path, this.snapshot!.sourcePath, signal), SHARE_CARD_EDITORIAL_COVER);
		this.session = new ShareCardSession(async template => {
			this.snapshot ??= await this.options.loadSnapshot(this.abort.signal);
			this.abort.signal.throwIfAborted();
			return this.renderer!.render(this.snapshot, template);
		}, blob => this.publish(blob), error => this.showError(error));
		this.options.lockScroll(); this.select(this.selected); close.focus({ preventScroll: true });
	}
	private select(template: ShareCardTemplateId): void {
		if (this.closed || this.outputBusy || this.stale) return;
		this.selected = template; this.file = null; this.renderActions();
		this.setStatus(""); this.previewEl.setAttribute("aria-busy", "true");
		this.clearPreview();
		for (const button of this.templateButtons) button.setAttribute("aria-pressed", String(button.dataset.template === template));
		this.session?.select(template);
	}
	private publish(blob: Blob): void {
		if (this.closed || !this.snapshot) return;
		this.file = shareCardFile(blob, this.snapshot.date, this.containerEl.win);
		this.previewUrl = URL.createObjectURL(blob);
		this.previewEl.createEl("img", { attr: { src: this.previewUrl, alt: "", draggable: "false" } });
		this.previewEl.setAttribute("aria-busy", "false"); this.setStatus("");
		this.renderActions();
	}
	private renderActions(): void {
		this.actionsEl.empty();
		const caps = getShareCardCapabilities(this.containerEl.win, Platform.isMobile, this.file ?? undefined);
		const actions: Array<"share" | "copy" | "save" | "vault"> = [];
		if (Platform.isMobile && caps.share) actions.push("share");
		if (caps.copy) actions.push("copy"); if (caps.save) actions.push("save");
		if (!Platform.isMobile && caps.share) actions.push("share");
		if (!actions.length) actions.push("vault");
		for (const action of actions) this.addAction(action);
	}
	private addAction(action: "share" | "copy" | "save" | "vault"): void {
		const button = this.actionsEl.createEl("button", { attr: { type: "button", "data-share-action": action } });
		if (action === "share") setIcon(button.createSpan({ attr: { "aria-hidden": "true" } }), "share");
		button.createSpan({ text: t(`share.${action}`) });
		button.disabled = !this.file || this.outputBusy;
		button.addEventListener("click", () => { void this.output(action); });
	}

	private async output(action: "share" | "copy" | "save" | "vault"): Promise<void> {
		if (this.closed || !this.file || this.outputBusy) return;
		this.outputBusy = true; this.setStatus("");
		this.actionsEl.setAttribute("aria-busy", "true");
		for (const button of [...this.templateButtons, ...Array.from(this.actionsEl.querySelectorAll("button"))]) button.disabled = true;
		try {
			// 原生交付在点击栈内启动，无编码等待。
			const operation = action === "vault" ? saveShareCardToVault(this.app, this.file) : outputShareCard(action, this.file, this.containerEl.win);
			await operation;
		} catch (error) {
			if (!this.closed && !(typeof error === "object" && error !== null && "name" in error && error.name === "AbortError")) {
				this.setStatus(t("share.outputFailed"), true);
				if (!this.actionsEl.querySelector('[data-share-action="vault"]')) {
					this.addAction("vault");
				}
			}
		} finally {
			this.outputBusy = false; this.actionsEl.setAttribute("aria-busy", "false");
			if (!this.closed) for (const button of [...this.templateButtons, ...Array.from(this.actionsEl.querySelectorAll("button"))]) button.disabled = false;
		}
	}
	private setStatus(text: string, error = false): void {
		this.statusEl.setText(text); this.statusEl.classList.toggle("is-error", error);
	}
	private showError(error: unknown): void {
		const reason = error instanceof ShareCardError ? error.reason : "generation";
		this.setStatus(t(`share.error.${reason}`, { type: t(`share.kind.${error instanceof ShareCardError ? error.kind : "format"}`) }), true);
		if (reason === "stale") { this.stale = true; for (const button of this.templateButtons) button.disabled = true; }
		this.previewEl.setAttribute("aria-busy", "false");
	}
	private clearPreview(): void {
		this.previewEl.empty();
		if (this.previewUrl) URL.revokeObjectURL(this.previewUrl);
		this.previewUrl = null;
	}
	onClose(): void {
		this.closed = true; this.abort.abort(); this.session?.close(); this.renderer?.close();
		this.renderer = null; this.session = null; this.file = null; this.snapshot = null; this.templateButtons = [];
		this.clearPreview(); this.contentEl.empty(); this.options.onClose();
		if (this.previousFocus?.isConnected && this.previousFocus.instanceOf(HTMLElement)) this.previousFocus.focus({ preventScroll: true });
	}
}
