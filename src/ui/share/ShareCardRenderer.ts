import { toCanvas } from "html-to-image";
import { ShareCardError, getShareCardImagePaths, renderShareCard } from "./ShareCardContent";
import type { ShareCardSnapshot } from "./ShareCardContent";
import { shareCardStyles } from "./ShareCardTemplates";
import type { ShareCardTemplateId } from "./ShareCardTemplates";
import { shareCardImageDimensions } from "./ShareCardImageDimensions";

export function checkShareCardDimensions(width: number, height: number, mobile: boolean): void {
	if (!Number.isFinite(width * height) || width <= 0 || height <= 0 || width > 16384 || height > 16384 || width * height > (mobile ? 12_000_000 : 32_000_000)) throw new ShareCardError("limit");
}

export class ShareCardRenderer {
	private readonly frame: HTMLIFrameElement;
	private readonly images = new Map<string, string>();
	private retainedPixels = 0;
	private closed = false;
	private readonly abort = new AbortController();
	constructor(host: HTMLElement, private readonly mobile: boolean,
		private readonly loadImage: (path: string, signal: AbortSignal) => Promise<Blob>) {
		this.frame = host.ownerDocument.createElement("iframe");
		this.frame.className = "knomo-share-render-frame";
		this.frame.title = "Share card renderer"; this.frame.setAttribute("aria-hidden", "true"); this.frame.tabIndex = -1;
		this.frame.setAttribute("sandbox", "allow-same-origin");
		host.append(this.frame);
	}
	async render(snapshot: ShareCardSnapshot, template: ShareCardTemplateId): Promise<Blob> {
		const doc = this.frame.contentDocument;
		if (!doc || this.closed) throw new ShareCardError("generation");
		for (const path of getShareCardImagePaths(snapshot)) {
			if (this.images.has(path)) continue;
			this.abort.signal.throwIfAborted();
			const blob = await this.loadImage(path, this.abort.signal);
			if (this.closed) throw new ShareCardError("generation");
			if (blob.size > 32_000_000) throw new ShareCardError("limit");
			const dimensions = shareCardImageDimensions(new Uint8Array(await blob.slice(0, 262144).arrayBuffer()));
			if (dimensions) {
				checkShareCardDimensions(dimensions[0], dimensions[1], false);
				if (this.retainedPixels + dimensions[0] * dimensions[1] > (this.mobile ? 24_000_000 : 64_000_000)) throw new ShareCardError("limit");
			}
			const url = URL.createObjectURL(blob);
			try {
				const image = doc.createElement("img"); image.src = url;
				await image.decode();
				this.abort.signal.throwIfAborted();
				const pixels = image.naturalWidth * image.naturalHeight;
				if (!pixels || this.retainedPixels + pixels > (this.mobile ? 24_000_000 : 64_000_000)) throw new ShareCardError("limit");
				// 固定动态图片的一帧，模板切换和 PNG 均复用这份资源。
				checkShareCardDimensions(image.naturalWidth, image.naturalHeight, false);
				const canvas = doc.createElement("canvas");
				const scale = Math.min(1, 780 / image.naturalWidth);
				canvas.width = Math.ceil(image.naturalWidth * scale); canvas.height = Math.ceil(image.naturalHeight * scale);
				const context = canvas.getContext("2d"); if (!context) throw new ShareCardError("generation");
				context.drawImage(image, 0, 0, canvas.width, canvas.height);
				this.images.set(path, canvas.toDataURL("image/png")); this.retainedPixels += canvas.width * canvas.height;
				image.removeAttribute("src");
				canvas.width = canvas.height = 0;
			} catch (error) { if (error instanceof ShareCardError) throw error; throw new ShareCardError("image"); }
			finally { URL.revokeObjectURL(url); }
		}
		this.abort.signal.throwIfAborted();
		doc.head.replaceChildren(); doc.body.replaceChildren();
		const style = doc.createElement("style"); style.textContent = shareCardStyles(template); doc.head.append(style);
		const card = renderShareCard(doc, snapshot, template, this.images); doc.body.append(card);
		await Promise.all(Array.from(card.querySelectorAll("img"), image => image.decode()));
		if (template === "editorial") {
			const first = card.querySelector(".content")?.firstElementChild;
			const image = first?.tagName === "P" && first.childNodes.length === 1 && first.firstElementChild?.tagName === "IMG" ? first.firstElementChild as HTMLImageElement : null;
			if (image && image.naturalWidth >= 390) { image.className = "hero"; card.prepend(image); first!.remove(); }
		}
		await doc.fonts.ready;
		this.abort.signal.throwIfAborted();
		const height = Math.ceil(card.getBoundingClientRect().height);
		checkShareCardDimensions(780, height * 2, this.mobile);
		for (const el of Array.from(card.querySelectorAll<HTMLElement>("*"))) {
			if (el.scrollWidth > el.clientWidth + 2 && el.clientWidth > 0) throw new ShareCardError("limit");
			if ((el.tagName === "TD" || el.tagName === "TH") && el.textContent?.trim() && el.getBoundingClientRect().width < 44) throw new ShareCardError("limit");
		}
		const canvas = await toCanvas(card, { width: 390, height, pixelRatio: 2, skipAutoScale: true, skipFonts: true, cacheBust: false });
		try {
			this.abort.signal.throwIfAborted();
			if (canvas.width !== 780 || canvas.height !== height * 2 || !canvas.getContext("2d")?.getImageData(0, 0, 1, 1).data[3]) throw new ShareCardError("generation");
			const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, "image/png"));
			if (!blob || blob.size === 0) throw new ShareCardError("generation");
			return blob;
		} finally { canvas.width = canvas.height = 0; }
	}
	close(): void { this.closed = true; this.abort.abort(); this.images.clear(); this.frame.remove(); }
}
