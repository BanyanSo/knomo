import { TFile } from "obsidian";
import type { App } from "obsidian";

import type { MemoRecord } from "../types/memo";
import type { ReferenceMode } from "../types/settings";
import { MarkdownBlockService } from "./MarkdownBlockService";

type EnsureReferenceBlockId = (memo: MemoRecord) => Promise<string>;

// 职责：读取或生成 Obsidian blockId，并生成块引用文本。
export class ReferenceService {
	constructor(
		private readonly app: App,
		private readonly markdownBlockService = new MarkdownBlockService(),
		private readonly ensureReferenceBlockId: EnsureReferenceBlockId = async () => {
			throw new Error("Reference service is not initialized.");
		},
	) {}

	async createReferenceText(
		memo: MemoRecord,
		mode: ReferenceMode,
		sourcePath?: string,
	): Promise<string> {
		const activeSourcePath = sourcePath ?? "";
		const file = this.app.vault.getAbstractFileByPath(memo.dailyRef.path);
		if (!(file instanceof TFile)) {
			throw new Error("Reference target daily note file does not exist.");
		}
		const blockId = await this.getExistingBlockId(file, memo) ?? await this.ensureReferenceBlockId(memo);
		const link = this.app.fileManager.generateMarkdownLink(file, activeSourcePath, `#^${blockId}`);
		return mode === "embed" ? `!${link}` : link;
	}

	private async getExistingBlockId(file: TFile, memo: MemoRecord): Promise<string | null> {
		const currentContent = await this.app.vault.cachedRead(file);
		const location = this.markdownBlockService.findMemoBlock(currentContent, {
			lineNumberHint: memo.dailyRef.lineNumberHint,
			lastKnownBlock: memo.dailyRef.lastKnownBlock,
			lastKnownHash: memo.dailyRef.lastKnownHash,
			contentHash: memo.contentHash,
			allowLineHintTimeMatch: true,
		}, "daily_block_missing");
		return location.parsedBlock?.blockId ?? null;
	}
}
