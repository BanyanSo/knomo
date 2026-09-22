import type { ImageAttachmentInput } from "../services/AttachmentService";

const imageExtensions: Readonly<Record<string, string>> = {
	"image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp",
};

export type ClipboardImageDecision =
	| { type: "native" }
	| { type: "reject" }
	| { type: "images"; files: ImageAttachmentInput[] };

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
		name: `Pasted image ${stamp}.${imageExtensions[item.type]}`,
		size: item.file!.size,
		arrayBuffer: () => item.file!.arrayBuffer(),
	})) };
}
