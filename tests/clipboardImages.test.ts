import test from "node:test";
import assert from "node:assert/strict";
import { classifyClipboardImages } from "../src/ui/clipboardImages";

function data(types: string[], text = "", html = "", invalid = false, names: string[] = []): DataTransfer {
	const files = types.map((type, index) => ({ name: names[index] ?? "", type, size: invalid ? 0 : 3, arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer }));
	return { getData: (type: string) => type === "text/plain" ? text : html,
		items: files.map(file => ({ kind: "file", type: file.type, getAsFile: () => file })), files } as unknown as DataTransfer;
}

test("clipboard decision preserves every nonempty text/HTML and mixed-file paste", () => {
	for (const text of ["hello", "\n", " ", "https://example.com", "**markdown**"]) {
		assert.equal(classifyClipboardImages(data(["image/png"], text)).type, "native");
	}
	assert.equal(classifyClipboardImages(data(["image/png"], "", '<img src="x">')).type, "native");
	for (const types of [["image/png", "application/pdf"], [""], []]) assert.equal(classifyClipboardImages(data(types)).type, "native");
	assert.equal(classifyClipboardImages(null).type, "native");
});

test("clipboard names all supported formats once in item order with original bytes", async () => {
	const result = classifyClipboardImages(data(["image/png", "image/jpeg", "image/gif", "image/webp"]), new Date(2026, 8, 21, 1, 2, 3));
	assert.equal(result.type, "images");
	if (result.type !== "images") return;
	assert.deepEqual(result.files.map(file => file.name), ["png", "jpg", "gif", "webp"].map(ext => `Pasted image 20260921010203.${ext}`));
	assert.deepEqual([...new Uint8Array(await result.files[0].arrayBuffer())], [1, 2, 3]);
});

test("unsupported or empty images reject the whole batch; files fallback does not dedupe actual images", () => {
	assert.equal(classifyClipboardImages(data(["image/png", "image/svg+xml"])).type, "reject");
	assert.equal(classifyClipboardImages(data(["image/png"], "", "", true)).type, "reject");
	const clipboard = data(["image/png", "image/png"]);
	Object.assign(clipboard, { items: [] });
	const result = classifyClipboardImages(clipboard);
	assert.equal(result.type, "images");
	if (result.type === "images") assert.equal(result.files.length, 2);
	Object.assign(clipboard, { items: [{ kind: "file", type: "image/png", getAsFile: () => null }] });
	assert.equal(classifyClipboardImages(clipboard).type, "reject");
});

test("clipboard preserves available names and aligns extensions with the supplied image type", async () => {
	const cases = [
		["旅行 照片 (1).jpg", "image/jpeg", "旅行 照片 (1).jpg"],
		["设计稿.JPEG", "image/jpeg", "设计稿.JPEG"],
		["image.png", "image/png", "image.png"],
		["设计稿.jpg", "image/png", "设计稿.png"],
		["设计稿", "image/webp", "设计稿.webp"],
		["设计.v2.gif", "image/gif", "设计.v2.gif"],
	];
	for (const fallback of [false, true]) {
		const clipboard = data(cases.map(item => item[1]), "", "", false, cases.map(item => item[0]));
		if (fallback) Object.assign(clipboard, { items: [] });
		const result = classifyClipboardImages(clipboard);
		assert.equal(result.type, "images");
		if (result.type !== "images") return;
		assert.deepEqual(result.files.map(file => file.name), cases.map(item => item[2]));
		assert.deepEqual([...new Uint8Array(await result.files[0].arrayBuffer())], [1, 2, 3]);
	}
});

test("clipboard filenames cannot introduce paths or invalid Windows names", () => {
	const cases = [
		["C:\\photos\\旅行.png", "旅行.png"], ["../../旅行.png", "旅行.png"],
		['草稿:a?b*.png', "草稿_a_b_.png"], ["a\u0000b.png", "a_b.png"],
		["CON.png", "_CON.png"], ["lpt1.jpg", "_lpt1.png"],
		["CON.preview.png", "_CON.preview.png"], ["COM¹.png", "_COM¹.png"],
		["图[1]#版本^a`b`.png", "图_1__版本_a_b_.png"],
		["  照片.png.  ", "照片.png"],
		["", "Pasted image 20260922010203.png"], ["...", "Pasted image 20260922010203.png"],
		[".png", "Pasted image 20260922010203.png"],
	];
	for (const [name, expected] of cases) {
		const result = classifyClipboardImages(data(["image/png"], "", "", false, [name]), new Date(2026, 8, 22, 1, 2, 3));
		assert.equal(result.type, "images");
		if (result.type === "images") assert.equal(result.files[0].name, expected, name);
	}
});

test("clipboard filenames replace every ASCII control character and preserve adjacent Unicode", () => {
	for (const code of [...Array.from({ length: 32 }, (_, index) => index), 127]) {
		const result = classifyClipboardImages(data(["image/png"], "", "", false, [`图${String.fromCharCode(code)}😀.png`]));
		assert.equal(result.type, "images");
		if (result.type === "images") assert.equal(result.files[0].name, "图_😀.png", `control ${code}`);
	}
	const result = classifyClipboardImages(data(["image/png"], "", "", false, ["图 ~😀.png"]));
	if (result.type !== "images") assert.fail("Expected image input");
	assert.equal(result.files[0].name, "图 ~😀.png");
});

test("same-name clipboard images retain separate inputs for host collision handling", () => {
	const result = classifyClipboardImages(data(["image/png", "image/png"], "", "", false, ["照片.png", "照片.png"]));
	assert.equal(result.type, "images");
	if (result.type === "images") assert.deepEqual(result.files.map(file => file.name), ["照片.png", "照片.png"]);
});
