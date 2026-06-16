import test from "node:test";
import assert from "node:assert/strict";

import type { App, TFile } from "obsidian";

import { parseMemoCardPreview } from "../src/ui/MemoCardPreview";

test("parses memo card images in source order and removes image syntax from preview text", () => {
	const app = createAppStub([
		"image.png",
		"folder/image name.png",
		"photo.webp",
	]);
	const preview = parseMemoCardPreview(
		[
			"before ![[image.png|300]] middle ![local](<folder/image name.png>)",
			"after ![[photo.webp#fragment]] ![remote](https://example.com/a.jpg?size=1)",
		].join("\n"),
		"Daily/2026-06-11.md",
		app,
	);

	assert.equal(preview.text, "before  middle\nafter");
	assert.deepEqual(preview.images.map((image) => image.path), [
		"image.png",
		"folder/image name.png",
		"photo.webp",
		"https://example.com/a.jpg?size=1",
	]);
	assert.deepEqual(preview.images.map((image) => image.url), [
		"app://image.png",
		"app://folder/image name.png",
		"app://photo.webp",
		"https://example.com/a.jpg?size=1",
	]);
	assert.equal(preview.images[1].alt, "local");
	assert.equal(preview.images[3].isRemote, true);
});

test("skips fenced code blocks, inline code, and incomplete image syntax", () => {
	const app = createAppStub(["real.png"]);
	const preview = parseMemoCardPreview(
		[
			"keep `![inline](inline.png)`",
			"```",
			"![code](code.png)",
			"```",
			"show ![[real.png]]",
			"incomplete ![alt](missing.png",
		].join("\n"),
		"Daily/2026-06-11.md",
		app,
	);

	assert.equal(
		preview.text,
		[
			"keep `![inline](inline.png)`",
			"```",
			"![code](code.png)",
			"```",
			"show",
			"incomplete ![alt](missing.png",
		].join("\n"),
	);
	assert.deepEqual(preview.images.map((image) => image.path), ["real.png"]);
});

test("rejects unsupported url schemes without using them as image src", () => {
	const app = createAppStub([]);
	const preview = parseMemoCardPreview(
		"![bad](data:image/png;base64,abc) ![js](javascript:alert.png) ![blob](blob:https://example.com/a.png)",
		"Daily/2026-06-11.md",
		app,
	);

	assert.equal(preview.text, "");
	assert.equal(preview.images.length, 3);
	assert.deepEqual(preview.images.map((image) => image.url), [undefined, undefined, undefined]);
	assert.deepEqual(preview.images.map((image) => image.unresolved), [true, true, true]);
});

test("keeps unsupported non-image resources in preview text", () => {
	const app = createAppStub([]);
	const preview = parseMemoCardPreview("doc ![[file.pdf]] video ![clip](clip.mp4)", "Daily/2026-06-11.md", app);

	assert.equal(preview.text, "doc ![[file.pdf]] video ![clip](clip.mp4)");
	assert.equal(preview.images.length, 0);
});

test("marks missing local images unresolved and leaves pure image memo text empty", () => {
	const app = createAppStub([]);
	const preview = parseMemoCardPreview("![[missing.png]]", "Daily/2026-06-11.md", app);

	assert.equal(preview.text, "");
	assert.equal(preview.images.length, 1);
	assert.equal(preview.images[0].path, "missing.png");
	assert.equal(preview.images[0].url, undefined);
	assert.equal(preview.images[0].unresolved, true);
});

test("parses nested destinations, optional titles, escaped brackets, and Obsidian dimensions", () => {
	const app = createAppStub([
		"folder/photo(1).png",
		"folder/image name.png",
		"image.png",
	]);
	const preview = parseMemoCardPreview(
		[
			"![nested](folder/photo(1).png \"title\")",
			"![angle](<folder/image name.png> 'title')",
			"![escaped \\] alt](image.png)",
			"![[image.png|300x200]]",
		].join(" "),
		"Daily/2026-06-15.md",
		app,
	);

	assert.equal(preview.text, "");
	assert.deepEqual(preview.images.map((image) => image.path), [
		"folder/photo(1).png",
		"folder/image name.png",
		"image.png",
		"image.png",
	]);
	assert.equal(preview.images[2].alt, "escaped ] alt");
});

test("keeps malformed Markdown image syntax in preview text", () => {
	const app = createAppStub([]);
	const content = "before ![bad](photo.png \"unfinished) after";

	const preview = parseMemoCardPreview(content, "Daily/2026-06-15.md", app);

	assert.equal(preview.text, content);
	assert.equal(preview.images.length, 0);
});

test("versions local resource urls with the attachment modification time", () => {
	const app = createAppStub(["photo.png"], 1_718_438_400_000);
	const preview = parseMemoCardPreview("![[photo.png]]", "Daily/2026-06-15.md", app);

	assert.equal(preview.images[0].url, "app://photo.png?knomo-mtime=1718438400000");
	assert.equal(preview.images[0].resourcePath, "photo.png");
});

test("resolves percent-encoded Obsidian image embed paths", () => {
	const app = createAppStub(["Assets/a b c.jpg"]);
	const preview = parseMemoCardPreview("![[Assets/a%20b%20c.jpg]]", "Daily/2026-06-15.md", app);

	assert.equal(preview.text, "");
	assert.equal(preview.images[0].path, "Assets/a b c.jpg");
	assert.equal(preview.images[0].url, "app://Assets/a b c.jpg");
	assert.equal(preview.images[0].resourcePath, "Assets/a b c.jpg");
	assert.equal(preview.images[0].unresolved, undefined);
});

test("resolves percent-encoded local Markdown image paths", () => {
	const app = createAppStub(["Pasted image 20260606110900.png"]);
	const preview = parseMemoCardPreview(
		"![](Pasted%20image%2020260606110900.png) ![remote](https://example.com/Pasted%20image%2020260606110900.png)",
		"Daily/2026-06-15.md",
		app,
	);

	assert.equal(preview.text, "");
	assert.deepEqual(preview.images.map((image) => image.path), [
		"Pasted image 20260606110900.png",
		"https://example.com/Pasted%20image%2020260606110900.png",
	]);
	assert.deepEqual(preview.images.map((image) => image.url), [
		"app://Pasted image 20260606110900.png",
		"https://example.com/Pasted%20image%2020260606110900.png",
	]);
	assert.equal(preview.images[0].resourcePath, "Pasted image 20260606110900.png");
	assert.equal(preview.images[1].isRemote, true);
});

function createAppStub(paths: string[], modifiedAt?: number): App {
	const files = new Map<string, TFile>();
	for (const path of paths) {
		files.set(path, {
			path,
			stat: modifiedAt === undefined ? undefined : { mtime: modifiedAt },
		} as TFile);
	}
	return {
		metadataCache: {
			getFirstLinkpathDest: (path: string) => files.get(path) ?? null,
		},
		vault: {
			getResourcePath: (file: TFile) => `app://${file.path}`,
		},
	} as unknown as App;
}
