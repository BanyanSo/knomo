import test from "node:test";
import assert from "node:assert/strict";
import { validateComposerImages } from "../src/ui/validateComposerImages";
import type { ComposerImageLink } from "../src/ui/ComposerImageState";

function link(markdown: string): ComposerImageLink {
	return { from: 0, to: markdown.length, link: markdown, path: "Attachments/图片 (1).png", sourcePath: "Daily/2026-09-21.md" };
}

test("image validation resolves generated Wiki and escaped Markdown against the actual save path", () => {
	for (const markdown of ["![[Attachments/图片 (1).png]]", "![图片](../Attachments/%E5%9B%BE%E7%89%87%20(1).png)", "![](<../Attachments/图片 (1).png>)"]) {
		const calls: Array<[string, string]> = [];
		const app = { metadataCache: { getFirstLinkpathDest: (target: string, source: string) => {
			calls.push([target, source]);
			return { path: "Attachments/图片 (1).png" };
		} } };
		validateComposerImages(app as never, [link(markdown)], "Archive/2026-09-22.md");
		assert.equal(calls[0][1], "Archive/2026-09-22.md");
		assert.ok(calls[0][0].endsWith("Attachments/图片 (1).png"));
	}
});

test("unresolved or different attachments refuse a save, but unrelated user links are not inspected", () => {
	for (const resolved of [null, { path: "other.png" }]) {
		const app = { metadataCache: { getFirstLinkpathDest: () => resolved } };
		assert.throws(() => validateComposerImages(app as never, [link("![[image.png]]")], "New/2026-09-22.md"), /Attachments/);
	}
	validateComposerImages({} as never, [], "Daily/a.md");
});
