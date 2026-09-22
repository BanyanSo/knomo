import type { App } from "obsidian";
import { parseMarkdownReferences } from "../utils/markdownReferences";

export interface ImageAttachmentInput {
	name: string;
	size: number;
	arrayBuffer(): Promise<ArrayBuffer>;
}

export interface ImageAttachment {
	path: string;
	link: string;
}

export class AttachmentBatchError extends Error {
	readonly name = "AttachmentBatchError";
	constructor(
		readonly originalError: unknown,
		readonly createdPaths: readonly string[],
		readonly uncertainPath: string | null,
	) {
		super(originalError instanceof Error ? originalError.message : String(originalError));
	}
}

export class AttachmentService {
	constructor(private readonly app: App) {}

	async createImageEmbedLinks(
		sourcePath: string,
		files: readonly ImageAttachmentInput[],
		assertCurrent: () => void = () => undefined,
	): Promise<ImageAttachment[]> {
		const attachments: ImageAttachment[] = [];
		const createdPaths: string[] = [];
		let uncertainPath: string | null = null;
		try {
			if (files.some(file => file.size === 0)) throw new Error("Empty image data");
			for (const file of files) {
				assertCurrent();
				const bytes = await file.arrayBuffer();
				if (bytes.byteLength === 0) throw new Error("Empty image data");
				// 先读数据，再申请路径；路径分配并不是磁盘预留。
				let path = "";
				let attachment: Awaited<ReturnType<App["vault"]["createBinary"]>> | null = null;
				for (let attempt = 0; attempt < 3; attempt++) {
					assertCurrent();
					path = await this.app.fileManager.getAvailablePathForAttachment(file.name, sourcePath);
					assertCurrent();
					if (this.app.vault.getAbstractFileByPath(path) !== null) continue;
					// 只重试明确的 EEXIST；普通异常即使发现文件存在也不能推断未写入。
					uncertainPath = path;
					try {
						attachment = await this.app.vault.createBinary(path, bytes);
						break;
					} catch (error) {
						if (typeof error !== "object" || error === null || !("code" in error) || error.code !== "EEXIST") throw error;
						uncertainPath = null;
					}
				}
				if (attachment === null) throw new Error("Attachment filename is already in use");
				createdPaths.push(attachment.path);
				uncertainPath = null;
				assertCurrent();
				const generated = this.app.fileManager.generateMarkdownLink(attachment, sourcePath);
				const link = generated.startsWith("!") ? generated : `!${generated}`;
				const reference = parseMarkdownReferences(link.slice(1))[0];
				if (!reference?.valid || reference.raw !== link.slice(1)) throw new Error("Invalid image embed link");
				attachments.push({ path: attachment.path, link });
			}
			return attachments;
		} catch (error) {
			// 文件一旦写入就可能被其他笔记使用；失败只报告，不自动删除。
			throw new AttachmentBatchError(error, createdPaths, uncertainPath);
		}
	}
}
