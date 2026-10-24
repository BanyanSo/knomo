import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import type { TFile as FileType } from "obsidian";
import { ensureObsidianStub } from "./helpers/obsidianStub";
import { getPreferredMemoBlockReferenceText } from "../src/utils/references";

test("列表、搜索、浮标和完整句柄读取保留正文引用，不读取引用目标分区", async () => {
	const fixture = await makeFixture();
	await fixture.seed("Folder/Target (1).md", "2026-09-01", "## Memos\n- 10:30 target ^anchor\n");
	const content = "[[Target#^anchor|原别名]] [[Target#^anchor]] @2026-09-08";
	await fixture.seed("Daily/2026-09-02.md", "2026-09-02", "## Memos\n"
		+ Array.from({ length: 30 }, () => `- 11:00 ${content}\n`).join(""));
	let targetReads = 0;
	fixture.catalog.getFileRevisionBatch = async () => { targetReads++; throw new Error("Reference target must not be loaded."); };
	const page = await fixture.read.query({ fromDate: "2026-09-02", limit: 30 });
	assert.equal(page.items.length, 30);
	assert.equal(new Set(page.items.map(item => item.key)).size, 30, "同文仍为独立 occurrence");
	assert.ok(page.items.every(item => item.content === content && item.createdAt === "2026-09-02T11:00"));
	assert.ok(page.items.every(item => item.capabilities.markdown.explicitBlockReference && item.capabilities.markdown.openLinks));
	const search = await fixture.read.query({ text: "原别名", hasReference: true, limit: 30 });
	assert.deepEqual(search.items.map(item => item.key), page.items.map(item => item.key));
	assert.equal((await fixture.read.count({ fromDate: "2026-09-02", hasReference: true })).count, 30);
	const buoy = await fixture.read.queryTimeBuoyPage({ today: "2026-09-08", tab: "today", limit: 30 });
	assert.equal(buoy.items.length, 30);
	assert.ok(buoy.items.every(item => item.memo.contentSnapshot === content));
	assert.deepEqual((await fixture.read.readMemoItems(page.items.map(item => item.observationHandle))).map(item => item.key), page.items.map(item => item.key));
	assert.equal(targetReads, 0);
});

test("当前 Markdown 的 alias、相对路径、同名目标、错误原文和分钟秒精度贯穿查询", async () => {
	const fixture = await makeFixture();
	const content = "source [[Target|自定义]] [相对来源](../Folder/Target%20(1).md#%5Eanchor \"title\")"
		+ " [[Target#Heading]] [[Other/Target|同名目标]] [web](https://example.com) [broken](bad%ZZ.md)";
	await fixture.seed("Daily/2026-09-02.md", "2026-09-02", `## Memos\n- 11:00 ${content}\n- 11:00:27 ${content}\n`);
	const page = await fixture.read.query({ hasLink: true, hasReference: true, limit: 10 });
	assert.equal(page.items.length, 2);
	assert.deepEqual(page.items.map(item => item.createdAt), ["2026-09-02T11:00:27", "2026-09-02T11:00"]);
	assert.ok(page.items.every(item => item.content === content));
	assert.ok(page.items.every(item => item.links.some(link => link.target === "Other/Target")));
	assert.equal(getPreferredMemoBlockReferenceText(page.items[0]!.content), '[相对来源](../Folder/Target%20(1).md#%5Eanchor "title")');
	assert.equal((await fixture.read.count({ hasReference: true })).count, 2);
});

test("缺失目标、目标后到、重命名和同文多锚点不改变来源正文或选中 occurrence", async () => {
	const fixture = await makeFixture();
	const sourcePath = "Daily/2026-09-02.md", targetPath = "Folder/Target (1).md";
	const source = await fixture.seed(sourcePath, "2026-09-02", "## Memos\n- 11:00 [[Target#^anchor|原别名]]\n");
	const before = (await fixture.read.query({ sourcePaths: [sourcePath], limit: 10 })).items[0]!;
	const checkSource = async () => {
		const current = (await fixture.read.readMemoItems([before.observationHandle]))[0]!;
		assert.equal(current.content, source.content);
		assert.deepEqual(current.observationHandle, before.observationHandle);
		assert.equal(getPreferredMemoBlockReferenceText(current.content), "[[Target#^anchor|原别名]]");
	};
	await checkSource();
	await fixture.seed(targetPath, "2026-09-01", "## Memos\n- 10:30 same ^anchor\n");
	await checkSource();
	await fixture.seed(targetPath, "2026-09-01", "## Memos\n- 10:30 same ^anchor\n- 10:30 same ^anchor\n");
	await checkSource();
	fixture.files.delete(targetPath);
	await fixture.catalog.deleteFile(targetPath);
	await fixture.seed("Other/Target (1).md", "2026-09-01", "## Memos\n- 10:30:27 same ^anchor\n");
	await checkSource();
});

async function makeFixture() {
	await ensureObsidianStub();
	const { TFile } = await import("obsidian");
	const { DiaryMemoParser } = await import("../src/services/DiaryMemoParser");
	const { MemoCatalogService } = await import("../src/services/MemoCatalogService");
	const { InMemoryMemoCatalogStore } = await import("../src/services/MemoCatalogStore");
	const { CatalogReadService } = await import("../src/services/CatalogReadService");
	const store = new InMemoryMemoCatalogStore();
	const catalog = new MemoCatalogService(store);
	await catalog.open();
	const files = new Map<string, FileType>();
	const read = new CatalogReadService({ catalog, now: () => new Date("2026-09-08T12:00:00Z") });
	const parser = new DiaryMemoParser(async bytes => createHash("sha256").update(bytes).digest("hex"));
	const seed = async (path: string, date: string, content: string) => {
		const parsed = await parser.parse({ sourcePath: path, logicalDate: date, bytes: Buffer.from(content) });
		const size = Buffer.byteLength(content);
		files.set(path, Object.assign(new TFile(), { path, stat: { mtime: 1, size } }));
		await catalog.replaceFile({ inventory: { sourcePath: path, logicalDate: date, mtime: 1, size }, sourceRevision: parsed.sourceRevision,
			observations: parsed.observations, parserVersion: 1, settingsFingerprint: "test", auditedAt: 1 });
		await store.setCoverage({ kind: "complete", coveredFromDate: "2026-09-01", pendingFileCount: 0, coveredFileCount: files.size, totalFileCount: files.size });
		return parsed.observations[0]!;
	};
	return { seed, files, read, catalog };
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
	assert.ok(before.every(item => item.key !== current.key));
	await fixture.read.recordReview(current);
	assert.equal((await fixture.read.getRandomReunionItems(2)).length, 1);
});
