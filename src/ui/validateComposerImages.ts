import type { App } from "obsidian";
import { parseMarkdownReferences } from "../utils/markdownReferences";
import type { ComposerImageLink } from "./ComposerImageState";
import { t } from "../i18n";

export function validateComposerImages(app: App, links: readonly ComposerImageLink[], sourcePath: string): void {
	for (const link of links) {
		const reference = parseMarkdownReferences(link.link.slice(1))[0];
		let target = reference?.target ?? "";
		if (reference?.syntax === "markdown_link") {
			try { target = decodeURIComponent(target); } catch { target = ""; }
		}
		const resolved = reference?.valid && target ? app.metadataCache.getFirstLinkpathDest(target, sourcePath) : null;
		if (!resolved || resolved.path !== link.path) throw new Error(t("composer.imageLinkChanged", { path: link.path }));
	}
}
