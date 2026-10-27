import { Modal, Platform } from "obsidian";
import type { App } from "obsidian";
import { t } from "../i18n";
import { removeObsidianModalCloseButtons } from "./ObsidianModalCloseButton";
import { ShareCardError } from "./share/ShareCardContent";
import type { ShareCardSnapshot } from "./share/ShareCardContent";
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
	private retryButton!: HTMLButtonElement;
	private templateButtons: HTMLButtonElement[] = [];
	private closed = false;
	private outputBusy = false;
	private readonly abort = new AbortController();
	private readonly previousFocus: Element | null;
	constructor(app: App, private readonly options: ShareCardModalOptions) {
		super(app); this.previousFocus = options.returnFocusEl ?? this.containerEl.ownerDocument.activeElement;
	}
	onOpen(): void {
		this.modalEl.addClass("knomo-share-modal"); this.containerEl.addClass("knomo-share-backdrop");
		removeObsidianModalCloseButtons(this.modalEl); this.titleEl.setText(t("share.title"));
		const close = this.modalEl.createEl("button", { cls: "knomo-share-close", text: "×", attr: { type: "button", "aria-label": t("share.close") } });
		close.addEventListener("click", () => this.close());
		this.contentEl.empty(); this.contentEl.addClass("knomo-share-content");
		const capabilities = getShareCardCapabilities(this.containerEl.win, Platform.isMobile);
		if (!capabilities.share && !capabilities.copy && !capabilities.save) this.contentEl.createDiv({ cls: "knomo-share-warning", text: t("share.vaultOnly") });
		this.previewEl = this.contentEl.createDiv({ cls: "knomo-share-preview", attr: { tabindex: "0", "aria-label": t("share.preview") } });
		const footer = this.contentEl.createDiv({ cls: "knomo-share-footer" });
		const templates = footer.createDiv({ cls: "knomo-share-templates", attr: { role: "group", "aria-label": t("share.templates") } });
		for (const template of SHARE_CARD_TEMPLATES) {
			const button = templates.createEl("button", { text: t(`share.${template.id}`), attr: { type: "button", "aria-pressed": String(template.id === this.selected), "data-template": template.id } });
			button.style.setProperty("--knomo-share-swatch", template.background);
			button.addEventListener("click", () => this.select(template.id)); this.templateButtons.push(button);
		}
		this.statusEl = footer.createDiv({ cls: "knomo-share-status", attr: { role: "status", "aria-live": "polite" } });
		this.retryButton = footer.createEl("button", { text: t("share.retry"), attr: { type: "button" } });
		this.retryButton.hidden = true; this.retryButton.addEventListener("click", () => this.select(this.selected));
		this.actionsEl = footer.createDiv({ cls: "knomo-share-actions" });
		this.renderer = new ShareCardRenderer(this.modalEl, Platform.isMobile, (path, signal) => this.options.loadImage(path, this.snapshot!.sourcePath, signal));
		this.session = new ShareCardSession(async template => {
			this.snapshot ??= await this.options.loadSnapshot(this.abort.signal);
			this.abort.signal.throwIfAborted();
			return this.renderer!.render(this.snapshot, template);
		}, blob => this.publish(blob), error => this.showError(error));
		this.options.lockScroll(); this.select(this.selected); close.focus({ preventScroll: true });
	}
	private select(template: ShareCardTemplateId): void {
		if (this.closed || this.outputBusy) return;
		this.selected = template; this.file = null; this.actionsEl.empty(); this.retryButton.hidden = true;
		this.statusEl.setText(t("share.preparing")); this.previewEl.setAttribute("aria-busy", "true");
		this.clearPreview();
		for (const button of this.templateButtons) button.setAttribute("aria-pressed", String(button.dataset.template === template));
		this.session?.select(template);
	}
	private publish(blob: Blob): void {
		if (this.closed || !this.snapshot) return;
		this.file = shareCardFile(blob, this.snapshot.date, this.snapshot.time, this.containerEl.win);
		this.previewUrl = URL.createObjectURL(blob);
		this.previewEl.createEl("img", { attr: { src: this.previewUrl, alt: t("share.preview"), draggable: "false" } });
		this.previewEl.setAttribute("aria-busy", "false"); this.statusEl.setText(t("share.ready"));
		const caps = getShareCardCapabilities(this.containerEl.win, Platform.isMobile, this.file);
		const actions: Array<"share" | "copy" | "save" | "vault"> = [];
		if (Platform.isMobile && caps.share) actions.push("share");
		if (caps.copy) actions.push("copy"); if (caps.save) actions.push("save");
		if (!Platform.isMobile && caps.share) actions.push("share");
		if (!actions.length) actions.push("vault");
		for (const action of actions) this.actionsEl.createEl("button", { text: t(`share.${action}`), attr: { type: "button", "data-share-action": action } })
			.addEventListener("click", () => { void this.output(action); });
	}
	private async output(action: "share" | "copy" | "save" | "vault"): Promise<void> {
		if (this.closed || !this.file || this.outputBusy) return;
		this.outputBusy = true;
		for (const button of [...this.templateButtons, ...Array.from(this.actionsEl.querySelectorAll("button"))]) button.disabled = true;
		try {
			// 原生交付在点击栈内启动，无编码等待。
			const operation = action === "vault" ? saveShareCardToVault(this.app, this.file) : outputShareCard(action, this.file, this.containerEl.win);
			const path = await operation;
			if (!this.closed) this.statusEl.setText(action === "vault" ? t("share.savedVault", { path: path ?? "" }) : t(action === "copy" ? "share.copied" : action === "share" ? "share.handedOff" : "share.saveStarted"));
		} catch (error) {
			if (!this.closed && !(typeof error === "object" && error !== null && "name" in error && error.name === "AbortError")) {
				this.statusEl.setText(t("share.outputFailed"));
				if (Platform.isMobile && !this.actionsEl.querySelector('[data-share-action="vault"]')) {
					this.actionsEl.createEl("button", { text: t("share.vault"), attr: { type: "button", "data-share-action": "vault" } })
						.addEventListener("click", () => { void this.output("vault"); });
				}
			}
		} finally {
			this.outputBusy = false;
			if (!this.closed) for (const button of [...this.templateButtons, ...Array.from(this.actionsEl.querySelectorAll("button"))]) button.disabled = false;
		}
	}
	private showError(error: unknown): void {
		const reason = error instanceof ShareCardError ? error.reason : "generation";
		this.statusEl.setText(t(`share.error.${reason}`, { type: t(`share.kind.${error instanceof ShareCardError ? error.kind : "format"}`) })); this.retryButton.hidden = false;
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
