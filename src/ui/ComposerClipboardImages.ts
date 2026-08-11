export interface ComposerClipboardImagePasteEvent {
	readonly defaultPrevented: boolean;
	readonly clipboardData: DataTransfer | null;
	preventDefault(): void;
}

export function handleComposerClipboardImagePaste(
	event: ComposerClipboardImagePasteEvent,
	insertImageFiles: (files: readonly File[]) => void,
): boolean {
	if (event.defaultPrevented) {
		return false;
	}
	const files = getClipboardImageFiles(event.clipboardData);
	if (files.length === 0) {
		return false;
	}
	event.preventDefault();
	insertImageFiles(files);
	return true;
}

export function getClipboardImageFiles(clipboardData: DataTransfer | null): File[] {
	if (clipboardData === null) {
		return [];
	}
	const itemFiles = Array.from(clipboardData.items)
		.filter((item) => item.kind === "file" && isImageMimeType(item.type))
		.map((item) => item.getAsFile())
		.filter((file): file is File => file !== null);
	if (itemFiles.length > 0) {
		return itemFiles;
	}
	return Array.from(clipboardData.files).filter((file) => isImageMimeType(file.type));
}

function isImageMimeType(type: string): boolean {
	return type.toLowerCase().startsWith("image/");
}
