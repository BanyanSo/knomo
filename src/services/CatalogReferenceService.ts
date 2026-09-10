import { TFile } from "obsidian";
import type { App } from "obsidian";
import type { MemoObservation, ObservationHandle } from "../types/catalog";
import { parseMarkdownReferences, type MarkdownReference } from "../utils/markdownReferences";
import type { MemoCatalogService } from "./MemoCatalogService";

export interface CatalogReference extends MarkdownReference {
	state: "resolved" | "unresolved" | "external";
	targetPath: string | null;
	fragment: string | null;
	observation: ObservationHandle | null;
	targetTime: string | null;
}

// 按需读取当前 metadata 与 Catalog，不缓存历史目标；文件到达、rename、锚点变化后下次查询立即重新解析。
export class CatalogReferenceService {
	constructor(private readonly app: App, private readonly catalog: MemoCatalogService) {}

	async resolve(source: MemoObservation): Promise<CatalogReference[]> {
		const links: MarkdownReference[] = [...parseMarkdownReferences(source.content),
			...source.links.filter((link) => link.syntax === "url").map((link) => ({ ...link, raw: link.target, valid: true }))];
		return Promise.all(links.map(async (link): Promise<CatalogReference> => {
			const unresolved: CatalogReference = { ...link, state: "unresolved", targetPath: null, fragment: null, observation: null, targetTime: null };
			try {
				if (!link.valid) return unresolved;
				if (/^(?:[a-z][a-z\d+.-]*:|\/\/)/iu.test(link.target)) return { ...unresolved, state: "external" };
				const separator = link.target.indexOf("#");
				const path = decodeURIComponent(separator < 0 ? link.target : link.target.slice(0, separator));
				const fragment = separator < 0 ? null : decodeURIComponent(link.target.slice(separator + 1));
				let file: TFile | null;
				if (path === "") {
					const current = this.app.vault.getAbstractFileByPath(source.sourcePath);
					file = current instanceof TFile ? current : null;
				} else if (link.syntax === "markdown_link") {
					const parts = path.startsWith("/") ? [] : source.sourcePath.split("/").slice(0, -1);
					for (const part of path.split("/")) {
						if (part === "..") { if (parts.length === 0) return unresolved; parts.pop(); }
						else if (part !== "." && part !== "") parts.push(part);
					}
					const current = this.app.vault.getAbstractFileByPath(parts.join("/"));
					file = current instanceof TFile ? current : null;
				} else {
					file = this.app.metadataCache.getFirstLinkpathDest(path, source.sourcePath);
				}
				if (file === null) return { ...unresolved, fragment };
				const base = { ...unresolved, targetPath: file.path, fragment };
				if (fragment === null || fragment === "") return { ...base, state: "resolved" };
				const cache = this.app.metadataCache.getFileCache(file);
				if (cache === null) return base;
				if (!fragment.startsWith("^")) {
					return { ...base, state: cache.headings?.some((heading) => heading.heading === fragment) ? "resolved" : "unresolved" };
				}
				const blockId = fragment.slice(1);
				const block = cache.blocks?.[blockId];
				if (block === undefined) return base;
				const batch = await this.catalog.getFileRevisionBatch(file.path);
				if (batch !== null && (batch.file.mtime !== file.stat.mtime || batch.file.size !== file.stat.size)) return base;
				const matches = batch?.observations.filter((item) => item.existingBlockId === blockId
					&& item.startLine <= block.position.start.line && item.endLine >= block.position.start.line) ?? [];
				// 同文件多锚点或 Catalog 与 metadata 未对齐时，不能猜测目标 Memo。
				const allAnchors = batch?.observations.filter((item) => item.existingBlockId === blockId) ?? [];
				if (allAnchors.length === 0) return { ...base, state: "resolved" };
				if (matches.length !== 1 || allAnchors.length !== 1) return base;
				const observation = matches[0];
				return { ...base, state: "resolved", observation, targetTime: `${observation.logicalDate} ${observation.time}` };
			} catch {
				// metadata/文件暂不可读时保留链接原文，后续查询重新解析。
				return unresolved;
			}
		}));
	}
}
