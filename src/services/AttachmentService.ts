import type { App, TFile } from "obsidian";

export interface AttachmentRollbackFailure {
	path: string;
	error: unknown;
}

export class AttachmentBatchRollbackError extends Error {
	readonly name = "AttachmentBatchRollbackError";

	constructor(
		readonly originalError: unknown,
		readonly rollbackFailures: readonly AttachmentRollbackFailure[],
	) {
		super(
			`${getErrorMessage(originalError)}; failed to move partial attachments to Trash: ${rollbackFailures
				.map((failure) => failure.path)
				.join(", ")}`,
		);
	}
}

export class AttachmentService {
	constructor(private readonly app: App) {}

	async createImageEmbedLinks(sourcePath: string, files: readonly File[]): Promise<string[]> {
		const links: string[] = [];
		const createdAttachments: TFile[] = [];
		try {
			for (const file of files) {
				const path = await this.app.fileManager.getAvailablePathForAttachment(file.name, sourcePath);
				const attachment = await this.app.vault.createBinary(path, await file.arrayBuffer());
				createdAttachments.push(attachment);
				links.push(`!${this.app.fileManager.generateMarkdownLink(attachment, sourcePath)}`);
			}
			return links;
		} catch (error) {
			const rollbackFailures = await this.rollbackAttachments(createdAttachments);
			if (rollbackFailures.length > 0) {
				throw new AttachmentBatchRollbackError(error, rollbackFailures);
			}
			throw error;
		}
	}

	private async rollbackAttachments(attachments: readonly TFile[]): Promise<AttachmentRollbackFailure[]> {
		const failures: AttachmentRollbackFailure[] = [];
		for (let index = attachments.length - 1; index >= 0; index -= 1) {
			const attachment = attachments[index];
			try {
				await this.app.fileManager.trashFile(attachment);
			} catch (error) {
				failures.push({ path: attachment.path, error });
			}
		}
		return failures;
	}
}

function getErrorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
