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
	let reads = 0; let changed = false;
	const app = { vault: { getAbstractFileByPath(path: string) { assert.equal(path, observation.sourcePath); return Object.assign(new TFile(), { path }); },
		readBinary: async () => { reads++; return changed ? new TextEncoder().encode("- 10:00 替换正文").buffer : bytes.buffer; } } } as unknown as App;
	const catalog = { readMemoItems: async (handles: unknown[]) => { assert.equal(handles.length, 1); assert.strictEqual(handles[0], selected.catalog!.observationHandle); return [current]; } } as unknown as CatalogReadService;
	const snapshot = await readShareCardSnapshot(app, catalog, selected, "en", new AbortController().signal);
	assert.equal(snapshot.date, "2026-10-27"); assert.equal(reads, 1);
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
	const file = new File([new Uint8Array([137, 80, 78, 71])], "Memo-2026-10-27.png", { type: "image/png" });
	const app = { vault: { getAbstractFileByPath: (path: string) => path === file.name ? {} : null,
		createBinary: async (path: string, bytes: ArrayBuffer) => { assert.equal(bytes.byteLength, 4); writes.push(path); } } } as unknown as App;
	await saveShareCardToVault(app, file);
	assert.deepEqual(writes, ["Memo-2026-10-27-1.png"]);
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
