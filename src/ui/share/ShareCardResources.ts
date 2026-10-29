import { TFile } from "obsidian";
import type { App } from "obsidian";
import type { CatalogReadService } from "../../services/CatalogReadService";
import type { MemoViewItem } from "../../types/memoView";
import { toCatalogMemoView } from "../../types/memoView";
import { sha256Bytes } from "../../utils/sha256";
import { decodePercentEncodedImagePath } from "../../utils/markdownImages";
import { ShareCardError, createShareCardSnapshot } from "./ShareCardContent";
import type { ShareCardSnapshot } from "./ShareCardContent";

export async function readShareCardSnapshot(app: App, reads: CatalogReadService, selected: MemoViewItem, locale: string, signal: AbortSignal): Promise<ShareCardSnapshot> {
	if (!selected.catalog || selected.status !== "active") throw new ShareCardError("stale");
	const [current] = await reads.readMemoItems([selected.catalog.observationHandle], signal).catch(() => {
		signal.throwIfAborted(); throw new ShareCardError("stale");
	});
	if (!current) throw new ShareCardError("stale");
	const file = app.vault.getAbstractFileByPath(current.sourcePath);
	if (!(file instanceof TFile)) throw new ShareCardError("stale");
	// 只校验选中 revision，不解析其他 Memo、不补造新句柄。
	const bytes = await app.vault.readBinary(file).catch(() => { throw new ShareCardError("stale"); });
	const revision = await sha256Bytes(new Uint8Array(bytes));
	signal.throwIfAborted();
	if (revision !== selected.catalog.observationHandle.sourceRevision) throw new ShareCardError("stale");
	return createShareCardSnapshot(toCatalogMemoView(current), locale);
}

const imageTypes: Readonly<Record<string, string>> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", svg: "image/svg+xml", bmp: "image/bmp", avif: "image/avif" };
const MAX_IMAGE_BYTES = 32_000_000;

export async function loadShareCardImage(app: App, path: string, sourcePath: string, signal: AbortSignal): Promise<Blob> {
	signal.throwIfAborted();
	if (/^https?:\/\//iu.test(path)) {
		const controller = new AbortController();
		const cancel = () => controller.abort(); signal.addEventListener("abort", cancel, { once: true });
		const timer = window.setTimeout(cancel, 20_000);
		try {
		// 与正文远程图片相同的地址；使用 CORS 读取，不能导出时明确失败，不借助代理绕过。
		const response = await fetch(path, { signal: controller.signal, credentials: "omit", mode: "cors", referrerPolicy: "no-referrer" });
		if (!response.ok || !response.headers.get("content-type")?.startsWith("image/")) throw new ShareCardError("image");
		if (Number(response.headers.get("content-length")) > MAX_IMAGE_BYTES) throw new ShareCardError("limit");
		const reader = response.body?.getReader(); if (!reader) throw new ShareCardError("image");
		const parts: ArrayBuffer[] = []; let size = 0;
		try {
			while (true) { const part = await reader.read(); if (part.done) break;
				size += part.value.byteLength; if (size > MAX_IMAGE_BYTES) throw new ShareCardError("limit");
				parts.push(new Uint8Array(part.value).buffer);
			}
		} finally { await reader.cancel(); }
		return new Blob(parts, { type: response.headers.get("content-type")! });
		} catch (error) { if (error instanceof ShareCardError) throw error; throw new ShareCardError("image"); }
		finally { window.clearTimeout(timer); signal.removeEventListener("abort", cancel); }
	}
	if (/^[\w+.-]+:/u.test(path) || path.startsWith("//")) throw new ShareCardError("unsupported");
	const file = app.metadataCache.getFirstLinkpathDest(decodePercentEncodedImagePath(path), sourcePath);
	if (!(file instanceof TFile)) throw new ShareCardError("image");
	const type = imageTypes[file.extension.toLowerCase()]; if (!type) throw new ShareCardError("unsupported", "embed");
	if (file.stat.size > MAX_IMAGE_BYTES) throw new ShareCardError("limit");
	const bytes = await app.vault.readBinary(file).catch(() => { throw new ShareCardError("image"); }); signal.throwIfAborted();
	return new Blob([bytes], { type });
}

export async function saveShareCardToVault(app: App, file: File): Promise<void> {
	const stem = file.name.replace(/\.png$/u, "");
	let path = file.name; let suffix = 2;
	while (app.vault.getAbstractFileByPath(path)) path = `${stem}-${suffix++}.png`;
	// createBinary 拒绝同名竞争，不覆盖现有文件。
	await app.vault.createBinary(path, await file.arrayBuffer());
}
