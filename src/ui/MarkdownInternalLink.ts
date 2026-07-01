export interface MarkdownInternalLinkInfo {
	element: HTMLAnchorElement;
	linktext: string;
	sourcePath: string;
}

export function getMarkdownInternalLinkInfo(target: EventTarget | null): MarkdownInternalLinkInfo | null {
	const targetNode = target as Node | null;
	if (targetNode === null || !targetNode.instanceOf(Element)) {
		return null;
	}
	const linkEl = targetNode.closest("a.internal-link");
	if (!linkEl?.instanceOf(HTMLAnchorElement)) {
		return null;
	}
	const linktext = linkEl.getAttribute("data-href") ?? linkEl.getAttribute("href");
	const sourcePath = linkEl.getAttr("data-knomo-source-path");
	if (!linktext || sourcePath === null) {
		return null;
	}
	return {
		element: linkEl,
		linktext,
		sourcePath,
	};
}
