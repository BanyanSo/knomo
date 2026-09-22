import test from "node:test";
import assert from "node:assert/strict";
import { classifyClipboardImages } from "../src/ui/clipboardImages";

function data(types: string[], text = "", html = "", invalid = false): DataTransfer {
	const files = types.map(type => ({ type, size: invalid ? 0 : 3, arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer }));
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
