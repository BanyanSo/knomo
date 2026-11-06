import test from "node:test";
import assert from "node:assert/strict";
import { ensureObsidianStub } from "./helpers/obsidianStub";
import { DiaryMemoParser } from "../src/services/DiaryMemoParser";
import { createCardMemo } from "./helpers/memoCardFixture";
import type { CatalogReadService } from "../src/services/CatalogReadService";
import type { App } from "obsidian";
import type { CatalogMemoItem } from "../src/types/catalogView";

test("share reads only original observation and verifies Daily revision without writes or replacement handles", async () => {
	await ensureObsidianStub();
	const { TFile } = await import("obsidian");
	const { readShareCardSnapshot } = await import("../src/ui/share/ShareCardResources");
	const bytes = new TextEncoder().encode("- 08:30 开头\n  完整正文\n- 09:00 其他 Memo\n");
	const parsed = await new DiaryMemoParser().parse({ sourcePath: "Daily/2026-10-27.md", logicalDate: "2026-10-27", bytes });
	const observation = parsed.observations[0];
	const current = { key: "selected", content: observation.content, createdAt: "2026-10-27T08:30", sourcePath: observation.sourcePath, observation, observationHandle: observation,
		tags: [], links: [], images: [], lineNumberHint: 1 } as unknown as CatalogMemoItem;
	const selected = createCardMemo({ catalog: current, contentSnapshot: "折叠节选", createdAt: current.createdAt });
	selected.createdAt = "2030-01-01T12:00:59";
	let reads = 0; let changed = false;
	const app = { vault: { getAbstractFileByPath(path: string) { assert.equal(path, observation.sourcePath); return Object.assign(new TFile(), { path }); },
		readBinary: async () => { reads++; return changed ? new TextEncoder().encode("- 10:00 替换正文").buffer : bytes.buffer; } } } as unknown as App;
	const catalog = { readMemoItems: async (handles: unknown[]) => { assert.equal(handles.length, 1); assert.strictEqual(handles[0], selected.catalog!.observationHandle); return [current]; } } as unknown as CatalogReadService;
	const snapshot = await readShareCardSnapshot(app, catalog, selected, "en", new AbortController().signal);
	assert.equal(snapshot.date, "2026-10-27"); assert.equal(snapshot.time, "08:30"); assert.equal(reads, 1);
	assert.ok(JSON.stringify(snapshot.body).includes("完整正文")); assert.ok(!JSON.stringify(snapshot.body).includes("其他 Memo"));
	changed = true;
	await assert.rejects(readShareCardSnapshot(app, catalog, selected, "en", new AbortController().signal), /stale/u);
	const staleCatalog = { readMemoItems: async () => { throw Error("selected occurrence stale"); } } as unknown as CatalogReadService;
	await assert.rejects(readShareCardSnapshot(app, staleCatalog, selected, "en", new AbortController().signal), /stale/u);
	const aborted = new AbortController(); aborted.abort();
	await assert.rejects(readShareCardSnapshot(app, catalog, selected, "en", aborted.signal), { name: "AbortError" });
});

test("local images use source-relative attachment resolution and reject notes, unsafe protocols and missing files", async () => {
	await ensureObsidianStub();
	const { TFile } = await import("obsidian");
	const { loadShareCardImage } = await import("../src/ui/share/ShareCardResources");
	const calls: string[] = [];
	const app = { metadataCache: { getFirstLinkpathDest(path: string, source: string) { calls.push(source + ":" + path); return path === "missing.png" ? null : Object.assign(new TFile(), { path, extension: path.split(".").pop() }); } },
		vault: { readBinary: async () => new Uint8Array([137, 80, 78, 71]).buffer } } as unknown as App;
	const signal = new AbortController().signal;
	const blob = await loadShareCardImage(app, "photo%20one.png", "Daily/today.md", signal);
	assert.equal(blob.type, "image/png"); assert.equal(blob.size, 4); assert.deepEqual(calls, ["Daily/today.md:photo one.png"]);
	await assert.rejects(loadShareCardImage(app, "other-note.md", "Daily/today.md", signal), /unsupported/u);
	await assert.rejects(loadShareCardImage(app, "missing.png", "Daily/today.md", signal), /image/u);
	await assert.rejects(loadShareCardImage(app, "file:///secret.png", "Daily/today.md", signal), /unsupported/u);
});

test("explicit Vault save creates a new PNG and does not overwrite an existing filename", async () => {
	await ensureObsidianStub();
	const { saveShareCardToVault } = await import("../src/ui/share/ShareCardResources");
	const writes: string[] = [];
	const file = new File([new Uint8Array([137, 80, 78, 71])], "Knomo-20261027-083000.png", { type: "image/png" });
	const existing = new Set([file.name]);
	const app = { vault: { getAbstractFileByPath: (path: string) => existing.has(path) ? {} : null,
		createBinary: async (path: string, bytes: ArrayBuffer) => { assert.ok(!existing.has(path)); assert.deepEqual(new Uint8Array(bytes), new Uint8Array([137, 80, 78, 71])); existing.add(path); writes.push(path); } } } as unknown as App;
	await saveShareCardToVault(app, file);
	await saveShareCardToVault(app, new File([file], file.name, { type: file.type }));
	assert.deepEqual(writes, ["Knomo-20261027-083000-2.png", "Knomo-20261027-083000-3.png"]);
});

test("Vault save leaves an unoccupied name unchanged and reports a conflicting create without overwriting", async () => {
	await ensureObsidianStub();
	const { saveShareCardToVault } = await import("../src/ui/share/ShareCardResources");
	const file = new File(["original PNG"], "Knomo-20261027-143025.png", { type: "image/png" });
	let conflict = false;
	const app = { vault: { getAbstractFileByPath: () => null,
		createBinary: async (path: string) => { assert.equal(path, file.name); if (conflict) throw Error("already exists"); } } } as unknown as App;
	await saveShareCardToVault(app, file);
	conflict = true;
	await assert.rejects(saveShareCardToVault(app, file), /already exists/u);
});

test("remote resources use the exact source URL, CORS and no credentials, and failures remain retryable", async () => {
	await ensureObsidianStub();
	const { loadShareCardImage } = await import("../src/ui/share/ShareCardResources");
	const originalFetch = globalThis.fetch; const originalWindow = globalThis.window;
	let attempts = 0;
	Object.assign(globalThis, { window: { setTimeout, clearTimeout } });
	globalThis.fetch = async (url, init) => {
		assert.equal(url, "https://example.test/image.png"); assert.equal(init?.credentials, "omit"); assert.equal(init?.mode, "cors");
		assert.equal(init?.referrerPolicy, "no-referrer"); attempts++;
		if (attempts === 1) throw Error("CORS");
		return new Response(new Uint8Array([137, 80, 78, 71]), { headers: { "Content-Type": "image/png" } });
	};
	try {
		const signal = new AbortController().signal;
		await assert.rejects(loadShareCardImage({} as App, "https://example.test/image.png", "Daily/today.md", signal), /image/u);
		assert.equal((await loadShareCardImage({} as App, "https://example.test/image.png", "Daily/today.md", signal)).size, 4);
		assert.equal(attempts, 2);
	} finally { globalThis.fetch = originalFetch; Object.assign(globalThis, { window: originalWindow }); }
});

test("远程图片拒绝非图片、错误响应及超限，流式超限后取消读取", async () => {
	await ensureObsidianStub();
	const { loadShareCardImage } = await import("../src/ui/share/ShareCardResources");
	const originalFetch = globalThis.fetch, originalWindow = globalThis.window;
	Object.assign(globalThis, { window: { setTimeout, clearTimeout } });
	try {
		for (const response of [new Response("bad", { status: 404 }), new Response("html", { headers: { "Content-Type": "text/html" } }),
			new Response("x", { headers: { "Content-Type": "image/png", "Content-Length": "32000001" } })]) {
			globalThis.fetch = async () => response;
			await assert.rejects(loadShareCardImage({} as App, "https://example.test/image", "Daily/today.md", new AbortController().signal),
				response.headers.has("Content-Length") ? /limit/u : /image/u);
		}
		let cancelled = 0, reads = 0;
		const stream = new ReadableStream<Uint8Array>({ pull(controller) { reads++; controller.enqueue(new Uint8Array(16_000_001)); },
			cancel() { cancelled++; } }, { highWaterMark: 0 });
		globalThis.fetch = async () => new Response(stream, { headers: { "Content-Type": "image/png" } });
		await assert.rejects(loadShareCardImage({} as App, "https://example.test/image", "Daily/today.md", new AbortController().signal), /limit/u);
		assert.equal(reads, 2); assert.equal(cancelled, 1);
	} finally { globalThis.fetch = originalFetch; Object.assign(globalThis, { window: originalWindow }); }
});

test("远程图片超时及外部取消会中止请求并释放计时器，后续请求仍可重试", async () => {
	await ensureObsidianStub();
	const { loadShareCardImage } = await import("../src/ui/share/ShareCardResources");
	const originalFetch = globalThis.fetch, originalWindow = globalThis.window;
	let timeout: () => void = () => assert.fail();
	let cleared = 0, aborted = 0;
	Object.assign(globalThis, { window: { setTimeout: (callback: () => void, delay: number) => {
		assert.equal(delay, 20_000); timeout = callback; return 7;
	}, clearTimeout: (timer: number) => { assert.equal(timer, 7); cleared++; } } });
	try {
		for (const mode of ["timeout", "abort"]) {
			globalThis.fetch = async (_url, init) => new Promise<Response>((_resolve, reject) => {
				init!.signal!.addEventListener("abort", () => { aborted++; reject(new DOMException("Aborted", "AbortError")); }, { once: true });
			});
			const controller = new AbortController();
			const pending = loadShareCardImage({} as App, "https://example.test/image", "Daily/today.md", controller.signal);
			const rejected = assert.rejects(pending, /image/u);
			if (mode === "timeout") timeout(); else controller.abort();
			await rejected;
		}
		assert.equal(aborted, 2); assert.equal(cleared, 2);
		globalThis.fetch = async () => new Response(new Uint8Array([1]), { headers: { "Content-Type": "image/png" } });
		assert.equal((await loadShareCardImage({} as App, "https://example.test/image", "Daily/today.md", new AbortController().signal)).size, 1);
		assert.equal(cleared, 3);
	} finally { globalThis.fetch = originalFetch; Object.assign(globalThis, { window: originalWindow }); }
});
