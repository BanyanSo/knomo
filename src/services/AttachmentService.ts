import type { App } from "obsidian";

export class AttachmentService {
	constructor(private readonly app: App) {}

	async createImageEmbedLinks(sourcePath: string, files: readonly File[]): Promise<string[]> {
		const links: string[] = [];
		for (const file of files) {
			const path = await this.app.fileManager.getAvailablePathForAttachment(file.name, sourcePath);
			const attachment = await this.app.vault.createBinary(path, await file.arrayBuffer());
			links.push(`!${this.app.fileManager.generateMarkdownLink(attachment, sourcePath)}`);
		}
		return links;
	}
}
