import type { ImageAttachmentInput } from "../services/AttachmentService";

const imageExtensions: Readonly<Record<string, string>> = {
	"image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp",
};

export type ClipboardImageDecision =
	| { type: "native" }
	| { type: "reject" }
	| { type: "images"; files: ImageAttachmentInput[] };

function getClipboardImageName(name: string, extension: string, stamp: string): string {
	// 只保留文件名，统一清理跨设备非法字符及会干扰 Wiki/行内代码解析的字符。
	const basename = Array.from(name.split(/[\\/]/u).pop()!, char =>
		char.charCodeAt(0) <= 0x1f || char.charCodeAt(0) === 0x7f ? "_" : char
	).join("").replace(/[<>:"|?*#[\]^`]/gu, "_").trim().replace(/[. ]+$/u, "");
	const dot = basename.lastIndexOf(".");
	const suffix = dot >= 0 ? basename.slice(dot + 1) : "";
	let stem = (dot >= 0 ? basename.slice(0, dot) : basename).trim().replace(/[. ]+$/u, "");
	if (!stem) return `Pasted image ${stamp}.${extension}`;
	// Windows 设备名即使带扩展名也不可用；加前缀保留原名称主体。
	if (/^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/iu.test(stem)) stem = `_${stem}`;
	const normalizedSuffix = suffix.toLowerCase();
	const matching = normalizedSuffix === extension || extension === "jpg" && normalizedSuffix === "jpeg";
	return `${stem}.${matching ? suffix : extension}`;
}

export function classifyClipboardImages(data: DataTransfer | null, now = new Date()): ClipboardImageDecision {
	if (!data || data.getData("text/plain").length > 0 || data.getData("text/html").length > 0) return { type: "native" };
	const items = Array.from(data.items ?? []).filter(item => item.kind === "file");
	const candidates = items.length
		? items.map(item => ({ type: item.type, file: item.getAsFile() }))
		: Array.from(data.files ?? []).map(file => ({ type: file.type, file }));
	if (!candidates.length || candidates.some(item => !item.type.startsWith("image/"))) return { type: "native" };
	if (candidates.some(item => !imageExtensions[item.type] || !item.file || item.file.size === 0)) return { type: "reject" };
	const pad = (value: number) => String(value).padStart(2, "0");
	const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
	return { type: "images", files: candidates.map(item => ({
		name: getClipboardImageName(item.file!.name ?? "", imageExtensions[item.type], stamp),
		size: item.file!.size,
		arrayBuffer: () => item.file!.arrayBuffer(),
	})) };
}
