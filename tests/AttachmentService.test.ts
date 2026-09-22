import test from "node:test";
import assert from "node:assert/strict";
import { AttachmentBatchError, AttachmentService } from "../src/services/AttachmentService";
import { classifyClipboardImages } from "../src/ui/clipboardImages";

function file(name: string, content = "image") {
	return { name, size: content.length, arrayBuffer: async () => new TextEncoder().encode(content).buffer };
}

function fixture() {
	const disk = new Map<string, ArrayBuffer>();
	const paths: string[] = [];
	let create = async (path: string, bytes: ArrayBuffer) => {
		assert.equal(disk.has(path), false);
		disk.set(path, bytes);
		return { path };
	};
	let generate = (path: string) => `[[${path}]]`;
	let available = (name: string) => `Attachments/${name}`;
	const service = new AttachmentService({
		fileManager: {
			getAvailablePathForAttachment: async (name: string, source: string) => { paths.push(source); return available(name); },
			generateMarkdownLink: (attachment: { path: string }) => generate(attachment.path),
			trashFile: () => { throw new Error("Never delete images"); },
		},
		vault: {
			getAbstractFileByPath: (path: string) => disk.has(path) ? { path } : null,
			createBinary: (path: string, bytes: ArrayBuffer) => create(path, bytes),
		},
	} as never);
	return { service, disk, paths, setCreate: (value: typeof create) => { create = value; },
		setGenerate: (value: typeof generate) => { generate = value; }, setAvailable: (value: typeof available) => { available = value; } };
}

test("named clipboard images reach host allocation separately and keep valid embed links", async () => {
	for (const markdown of [false, true]) {
		const f = fixture();
		const name = "旅行_1_.png";
		f.setAvailable(candidate => f.disk.has(`Attachments/${candidate}`) ? `Attachments/旅行_1_ 1.png` : `Attachments/${candidate}`);
		if (markdown) f.setGenerate(path => `[](<${path}>)`);
		const inputs = [file("旅行[1].png", "first"), file("旅行[1].png", "second")];
		const decision = classifyClipboardImages({ getData: () => "", items: inputs.map(input => ({
			kind: "file", type: "image/png", getAsFile: () => input,
		})) } as unknown as DataTransfer);
		assert.equal(decision.type, "images");
		if (decision.type !== "images") return;
		const results = await f.service.createImageEmbedLinks("Daily/today.md", decision.files);
		assert.deepEqual(results.map(item => item.path), [`Attachments/${name}`, "Attachments/旅行_1_ 1.png"]);
		assert.equal(new TextDecoder().decode(f.disk.get(results[0].path)), "first");
		assert.equal(new TextDecoder().decode(f.disk.get(results[1].path)), "second");
		assert.deepEqual(results.map(item => item.link), results.map(item => markdown ? `![](<${item.path}>)` : `![[${item.path}]]`));
	}
});

test("attachments preserve bytes and source, order, and exactly one embed prefix", async () => {
	for (const markdown of [false, true]) {
		const f = fixture();
		if (markdown) f.setGenerate(path => `![](${path})`);
		const result = await f.service.createImageEmbedLinks("Daily/past.md", [file("first.png", "first"), file("second.gif", "second")]);
		assert.deepEqual(result.map(item => item.path), ["Attachments/first.png", "Attachments/second.gif"]);
		assert.deepEqual(f.paths, ["Daily/past.md", "Daily/past.md"]);
		assert.equal(result[0].link, markdown ? "![](Attachments/first.png)" : "![[Attachments/first.png]]");
		assert.equal(new TextDecoder().decode(f.disk.get(result[1].path)), "second");
	}
});

test("batch failure retains prior images and reports uncertain writes without continuing", async () => {
	for (const writesBeforeThrow of [false, true]) {
		const f = fixture();
		let calls = 0;
		f.setCreate(async (path, bytes) => {
			calls++;
			if (calls === 1 || writesBeforeThrow) f.disk.set(path, bytes);
			if (calls === 2) throw new Error("disk error");
			return { path };
		});
		await assert.rejects(f.service.createImageEmbedLinks("Daily/a.md", [file("a.png"), file("b.png"), file("c.png")]), (error: unknown) => {
			assert.ok(error instanceof AttachmentBatchError);
			assert.deepEqual(error.createdPaths, ["Attachments/a.png"]);
			assert.equal(error.uncertainPath, "Attachments/b.png");
			return true;
		});
		assert.equal(calls, 2);
		assert.equal(f.disk.size, writesBeforeThrow ? 2 : 1);
	}
});

test("empty batch member fails before writes, and link-generation failure retains the created image", async () => {
	const f = fixture();
	await assert.rejects(f.service.createImageEmbedLinks("Daily/a.md", [file("a.png"), file("empty.png", "")]));
	assert.equal(f.disk.size, 0);
	f.setGenerate(() => { throw new Error("link failed"); });
	await assert.rejects(f.service.createImageEmbedLinks("Daily/a.md", [file("a.png")]), (error: unknown) => {
		assert.ok(error instanceof AttachmentBatchError);
		assert.deepEqual(error.createdPaths, ["Attachments/a.png"]);
		assert.equal(error.uncertainPath, null);
		return true;
	});
	assert.equal(f.disk.size, 1);
});

test("cancel during disk I/O retains completed file and starts no next file", async () => {
	const f = fixture();
	let current = true;
	f.setCreate(async (path, bytes) => { f.disk.set(path, bytes); current = false; return { path }; });
	await assert.rejects(f.service.createImageEmbedLinks("Daily/a.md", [file("a.png"), file("b.png")], () => {
		if (!current) throw new Error("cancelled");
	}), (error: unknown) => {
		assert.ok(error instanceof AttachmentBatchError);
		assert.deepEqual(error.createdPaths, ["Attachments/a.png"]);
		return true;
	});
	assert.equal(f.disk.size, 1);
});

test("confirmed pre-write collision requests a new host filename, never overwrites", async () => {
	const f = fixture();
	f.disk.set("Attachments/a.png", new ArrayBuffer(1));
	let calls = 0;
	f.setAvailable(() => ++calls === 1 ? "Attachments/a.png" : "Attachments/a 1.png");
	const result = await f.service.createImageEmbedLinks("Daily/a.md", [file("a.png")]);
	assert.equal(result[0].path, "Attachments/a 1.png");
	assert.equal(f.disk.get("Attachments/a.png")!.byteLength, 1);
});

test("explicit concurrent EEXIST retries a host path, ambiguous failures do not", async () => {
	const f = fixture();
	let names = 0;
	f.setAvailable(() => `Attachments/image${++names}.png`);
	let writes = 0;
	f.setCreate(async (path, bytes) => {
		if (++writes === 1) throw Object.assign(new Error("exists"), { code: "EEXIST" });
		f.disk.set(path, bytes);
		return { path };
	});
	const images = await f.service.createImageEmbedLinks("Daily/a.md", [file("image.png")]);
	assert.equal(images[0].path, "Attachments/image2.png");
	assert.equal(writes, 2);
	const blocked = fixture();
	blocked.setCreate(async () => { throw Object.assign(new Error("exists"), { code: "EEXIST" }); });
	await assert.rejects(blocked.service.createImageEmbedLinks("Daily/a.md", [file("image.png")]));
	assert.equal(blocked.paths.length, 3);
});
