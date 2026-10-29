import { createShareCardElement } from "./ShareCardDom";
import type { ShareCardSnapshot } from "./ShareCardContent";

export interface ShareCardCapabilities { share: boolean; copy: boolean; save: boolean }

type ShareWindow = Window & { File: typeof File; ClipboardItem: typeof ClipboardItem; URL: typeof URL };

export function shareCardFile(blob: Blob, snapshot: Pick<ShareCardSnapshot, "date" | "time">, win: Window): File {
	// 原始分钟精度只在文件名补零，不把占位秒数写回记录或卡片。
	const date = snapshot.date.replace(/-/gu, "");
	const time = snapshot.time.replace(/:/gu, "").padEnd(6, "0");
	return new (win as ShareWindow).File([blob], `Knomo-${date}-${time}.png`, { type: "image/png" });
}

export function getShareCardCapabilities(window: Window, mobile: boolean, file?: File): ShareCardCapabilities {
	const win = window as ShareWindow;
	let share = false;
	try { share = typeof win.navigator.share === "function" && typeof win.navigator.canShare === "function" && win.navigator.canShare({ files: [file ?? new win.File([new Uint8Array([137, 80, 78, 71])], "Knomo.png", { type: "image/png" })] }); } catch { /* 宿主拒绝能力探测时隐藏入口。 */ }
	return { share, copy: typeof win.ClipboardItem === "function" && typeof win.navigator.clipboard?.write === "function"
		&& (!win.ClipboardItem.supports || win.ClipboardItem.supports("image/png")), save: !mobile };
}

// 调用者在点击栈内调用；图片已提前就绪，不在用户激活后等待编码。
export function outputShareCard(action: "share" | "copy" | "save", file: File, window: Window): Promise<void> {
	const win = window as ShareWindow;
	if (action === "share") return win.navigator.share({ files: [file] });
	if (action === "copy") return win.navigator.clipboard.write([new win.ClipboardItem({ "image/png": file })]);
	const url = win.URL.createObjectURL(file);
	const anchor = createShareCardElement(win.document, "a"); anchor.href = url; anchor.download = file.name;
	win.document.body.append(anchor);
	try { anchor.click(); } finally { anchor.remove(); win.setTimeout(() => win.URL.revokeObjectURL(url), 30_000); }
	return Promise.resolve();
}
