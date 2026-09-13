import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import type { App, CachedMetadata, TFile as FileType } from "obsidian";
import { ensureObsidianStub } from "./helpers/obsidianStub";

test("引用和 backlink 按当前文件上下文解析，保留原 alias 与分钟/秒精度", async () => {
	const fixture = await makeFixture();
	await fixture.seed("Folder/Target (1).md", "2026-09-01", "## Memos\n- 10:30 target ^anchor\n");
	const source = await fixture.seed("Daily/2026-09-02.md", "2026-09-02",
		"## Memos\n- 11:00 source [[Target|自定义]] [source](../Folder/Target%20(1).md#%5Eanchor \"title\") [[Target#Heading]] [web](https://example.com) [broken](bad%ZZ.md)\n");
	fixture.cache.set("Folder/Target (1).md", { blocks: { anchor: { position: { start: { line: 1 } } } }, headings: [{ heading: "Heading" }] } as unknown as CachedMetadata);
	let links = await fixture.references.resolve(source);
	assert.deepEqual(links.map((link) => link.state), ["resolved", "resolved", "resolved", "external", "unresolved"]);
	assert.equal(links[1]?.targetTime, "2026-09-01 10:30");
	assert.equal(links[1]?.raw, '[source](../Folder/Target%20(1).md#%5Eanchor "title")');
	assert.equal(links[0]?.displayText, "自定义");
	assert.ok(fixture.lookups.every((lookup) => lookup.source === source.sourcePath));
	assert.equal((await fixture.read.queryBacklinks("Folder/Target (1).md", "^anchor", { limit: 10 })).items.length, 1);
	await fixture.seed("Folder/Target (1).md", "2026-09-01", "## Memos\n- 10:30:27 target ^anchor\n");
	links = await fixture.references.resolve(source);
	assert.equal(links[1]?.targetTime, "2026-09-01 10:30:27");
	fixture.cache.set("Folder/Target (1).md", {});
	assert.equal((await fixture.references.resolve(source))[1]?.state, "unresolved");
	assert.equal((await fixture.read.queryBacklinks("Folder/Target (1).md", "^anchor", { limit: 10 })).items.length, 0);
});

test("目标后到、rename 与同文多锚点不会通过历史身份或 basename 猜测", async () => {
	const fixture = await makeFixture();
	const source = await fixture.seed("Daily/2026-09-02.md", "2026-09-02", "## Memos\n- 11:00 [[Target#^anchor|原别名]]\n");
	assert.equal((await fixture.references.resolve(source))[0]?.state, "unresolved");
	await fixture.seed("Folder/Target (1).md", "2026-09-01", "## Memos\n- 10:30 same ^anchor\n");
	fixture.cache.set("Folder/Target (1).md", { blocks: { anchor: { position: { start: { line: 1 } } } } } as unknown as CachedMetadata);
	assert.equal((await fixture.references.resolve(source))[0]?.state, "resolved");
	await fixture.seed("Folder/Target (1).md", "2026-09-01", "## Memos\n- 10:30 same ^anchor\n- 10:30 same ^anchor\n");
	assert.equal((await fixture.references.resolve(source))[0]?.state, "unresolved");
	fixture.files.delete("Folder/Target (1).md");
	await fixture.seed("Other/Target (1).md", "2026-09-01", "## Memos\n- 10:30 same ^anchor\n");
	const link = (await fixture.references.resolve(source))[0];
	assert.equal(link?.state, "unresolved");
	assert.equal(link?.raw, "[[Target#^anchor|原别名]]");
});

async function makeFixture() {
	await ensureObsidianStub();
	const { TFile } = await import("obsidian");
	const { DiaryMemoParser } = await import("../src/services/DiaryMemoParser");
	const { MemoCatalogService } = await import("../src/services/MemoCatalogService");
	const { InMemoryMemoCatalogStore } = await import("../src/services/MemoCatalogStore");
	const { CatalogReferenceService } = await import("../src/services/CatalogReferenceService");
	const { CatalogReadService } = await import("../src/services/CatalogReadService");
	const store = new InMemoryMemoCatalogStore();
	const catalog = new MemoCatalogService(store);
	await catalog.open();
	const files = new Map<string, FileType>();
	const cache = new Map<string, CachedMetadata>();
	const lookups: Array<{ path: string; source: string }> = [];
	const app = { vault: { getAbstractFileByPath: (path: string) => files.get(path) ?? null }, metadataCache: {
		getFirstLinkpathDest: (path: string, source: string) => { lookups.push({ path, source }); return path === "Target" ? files.get("Folder/Target (1).md") ?? null : null; },
		getFileCache: (file: FileType) => cache.get(file.path) ?? null,
	} } as unknown as App;
	const references = new CatalogReferenceService(app, catalog);
	const read = new CatalogReadService({ catalog, references, now: () => new Date("2026-09-08T12:00:00Z"),
	});
	const parser = new DiaryMemoParser(async (bytes) => createHash("sha256").update(bytes).digest("hex"));
	const seed = async (path: string, date: string, content: string) => {
		const parsed = await parser.parse({ sourcePath: path, logicalDate: date, bytes: Buffer.from(content) });
		const size = Buffer.byteLength(content);
		files.set(path, Object.assign(new TFile(), { path, stat: { mtime: 1, size } }));
		await catalog.replaceFile({ inventory: { sourcePath: path, logicalDate: date, mtime: 1, size }, sourceRevision: parsed.sourceRevision,
			observations: parsed.observations, parserVersion: 1, settingsFingerprint: "test", auditedAt: 1 });
		await store.setCoverage({ kind: "complete", coveredFromDate: "2026-09-01", pendingFileCount: 0, coveredFileCount: files.size, totalFileCount: files.size });
		return parsed.observations[0]!;
	};
	return { seed, files, cache, references, read, lookups, catalog };
}

test("同文 occurrence 的 review 独立，文件 delta 后拒绝旧句柄且不转移权重", async () => {
	const fixture = await makeFixture();
	await fixture.seed("Daily/2026-09-02.md", "2026-09-02", "## Memos\n- 11:00 same content\n- 11:00 same content\n");
	const before = (await fixture.read.query({ limit: 10 })).items;
	assert.notEqual(before[0]!.key, before[1]!.key);
	await fixture.read.recordReview(before[0]!);
	await fixture.read.recordReview(before[1]!);
	await fixture.seed("Daily/2026-09-02.md", "2026-09-02", "## Memos\n- 11:00 same content\n");
	await assert.rejects(() => fixture.read.recordReview(before[0]!), /stale/u);
	await assert.rejects(() => fixture.read.recordReview(before[1]!), /stale/u);
	const current = (await fixture.read.query({ limit: 10 })).items[0]!;
	assert.ok(before.every((item) => item.key !== current.key));
	await fixture.read.recordReview(current);
	assert.equal((await fixture.read.getRandomReunionItems(2)).length, 1);
});
