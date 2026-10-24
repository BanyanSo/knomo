import type { MetadataCache } from "obsidian";
import { parseMarkdownReferences } from "../utils/markdownReferences";

export function shouldRefreshMarkdownReferences(
	metadataCache: Pick<MetadataCache, "getFirstLinkpathDest"> | undefined,
	markdown: string,
	sourcePath: string,
	changedPaths: readonly string[],
): boolean {
	if (changedPaths.length === 0) return false;
	if (changedPaths.includes(sourcePath)) return true;
	// 嵌入可能有传递依赖，代码、公式和 HTML 可能由其它宿主处理器生成内容。
	if (/[`<$]|~{3}|!\[/u.test(markdown)) return true;
	const links = parseMarkdownReferences(markdown);
	let end = 0;
	for (const link of links) {
		if (!link.valid || link.startOffset === undefined || markdown.slice(end, link.startOffset).includes("[")) return true;
		end = link.startOffset + link.raw.length;
	}
	// 未解析的方括号可能是宿主支持的其它链接或扩展语法，保守重试。
	if (markdown.slice(end).includes("[")) return true;
	for (const link of links) {
		if (/^(?:https?:|mailto:|tel:|\/\/)/iu.test(link.target)) continue;
		if (/^[a-z][a-z0-9+.-]*:/iu.test(link.target)) return true;
		let path = link.target.split("#")[0].trim();
		if (!path) continue;
		if (link.syntax === "markdown_link") {
			try { path = decodeURIComponent(path); }
			catch { return true; }
		} else if (path.includes("%")) return true;
		if (!metadataCache?.getFirstLinkpathDest) return true;
		const destination = metadataCache.getFirstLinkpathDest(path, sourcePath);
		// 缺失或失效目标继续随任意 metadata 变化重算，不缓存 unresolved。
		if (destination === null) return true;
		if (changedPaths.includes(destination.path)) return true;
		// 新增同名候选可能改变宿主的最优匹配，即使当前仍解析到旧文件也要刷新。
		if (changedPaths.some(changed => linkBasename(changed) === linkBasename(path))) return true;
	}
	return false;
}

function linkBasename(path: string): string {
	return path.slice(path.lastIndexOf("/") + 1).replace(/\.md$/iu, "").toLowerCase();
}
