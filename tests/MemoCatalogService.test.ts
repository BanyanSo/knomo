import assert from "node:assert/strict";
import test from "node:test";

import { buildCatalogPartition, MemoCatalogService } from "../src/services/MemoCatalogService";
import { InMemoryMemoCatalogStore } from "../src/services/MemoCatalogStore";
import type { CatalogInventoryEntry, MemoObservation } from "../src/types/catalog";

test("文件分区替换和删除不会留下旧 observation", async () => {
	const store = new InMemoryMemoCatalogStore();
	const service = new MemoCatalogService(store);
	await service.open();
	const inventory = makeInventory("Journal/2026-08-09.md", "2026-08-09");

	await service.replaceFile(makePartitionInput(inventory, [makeObservation(inventory, 1, "09:00", "old")], "sha-old"));
	await service.replaceFile(makePartitionInput(inventory, [makeObservation(inventory, 4, "10:00", "new")], "sha-new"));
	let page = await service.query({ limit: 50 });
	assert.deepEqual(page.items.map((item) => item.content), ["new"]);

	await service.deleteFile(inventory.sourcePath);
	page = await service.query({ limit: 50 });
	assert.deepEqual(page.items, []);
	assert.deepEqual(await store.listFiles(), []);
});

test("文件 revision 批次始终返回该文件的全部 observations", async () => {
	const store = new InMemoryMemoCatalogStore();
	const service = new MemoCatalogService(store);
	await service.open();
	const inventory = makeInventory("Journal/2026-08-09.md", "2026-08-09");
	await service.replaceFile(makePartitionInput(inventory, [
		makeObservation(inventory, 1, "09:00", "first"),
		makeObservation(inventory, 4, "10:00", "second"),
	], "sha-batch"));

	assert.equal((await service.query({ limit: 1 })).items.length, 1);
	const batch = await service.getFileRevisionBatch(inventory.sourcePath);
	assert.ok(batch);
	assert.equal(batch.file.sourceRevision, "sha-batch");
	assert.equal(batch.file.observationCount, 2);
	assert.deepEqual(batch.observations.map((item) => item.content), ["first", "second"]);
	assert.equal(batch.catalogRevision, 1);
});

test("reference aggregate 只统计 Daily 可重建的显式 block reference", async () => {
	const inventory = makeInventory("Journal/2026-08-10.md", "2026-08-10");
	const observation = makeObservation(
		inventory,
		2,
		"11:00",
		"[Markdown](Third#^block-c) [[Note#^block-a]] ![[Other#^block-b]]\n```md\n[[False#^hidden]]\n```",
	);
	const partition = buildCatalogPartition(makePartitionInput(inventory, [observation], "sha-ref"));

	assert.deepEqual(partition.observations[0].explicitReferenceTargets, ["Third#^block-c", "Note#^block-a", "Other#^block-b"]);
	assert.equal(partition.aggregate.explicitReferenceCount, 3);
	assert.deepEqual(partition.aggregate.explicitReferenceTargets, ["Third#^block-c", "Note#^block-a", "Other#^block-b"]);
});

test("search index 排除 fenced code 文本", async () => {
	const inventory = makeInventory("Journal/2026-08-11.md", "2026-08-11");
	const store = new InMemoryMemoCatalogStore();
	const service = new MemoCatalogService(store);
	await service.open();
	await service.replaceFile(makePartitionInput(inventory, [makeObservation(
		inventory,
		1,
		"12:00",
		"visible token\n```md\nsecret fenced token\n```",
	)], "sha-search"));

	assert.equal((await service.query({ limit: 50, text: "visible token" })).items.length, 1);
	assert.equal((await service.query({ limit: 50, text: "secret fenced" })).items.length, 0);
});

test("有界内存降级超过容量后保持 partial coverage", async () => {
	const store = new InMemoryMemoCatalogStore(2);
	await store.open();
	await store.setCoverage({
		kind: "complete",
		coveredFromDate: "2026-08-01",
		pendingFileCount: 0,
		coveredFileCount: 3,
		totalFileCount: 3,
	});
	for (let day = 1; day <= 3; day += 1) {
		const logicalDate = `2026-08-0${day}`;
		const inventory = makeInventory(`Journal/${logicalDate}.md`, logicalDate);
		await store.replaceFilePartition(buildCatalogPartition(makePartitionInput(
			inventory,
			[makeObservation(inventory, 1, "09:00", logicalDate)],
			`sha-${day}`,
		)));
	}
	const coverage = await store.getCoverage();
	assert.equal(coverage.kind, "partial");
	assert.equal(coverage.coveredFromDate, "2026-08-02");
	assert.equal(coverage.coveredFileCount, 2);
	assert.equal(coverage.pendingFileCount, 1);
	assert.equal((await store.query({ limit: 50 })).items.length, 2);
});

function makeInventory(sourcePath: string, logicalDate: string): CatalogInventoryEntry {
	return { sourcePath, logicalDate, mtime: 100, size: 200 };
}

function makePartitionInput(
	inventory: CatalogInventoryEntry,
	observations: MemoObservation[],
	sourceRevision: string,
) {
	return {
		inventory,
		sourceRevision,
		observations,
		parserVersion: 1,
		settingsFingerprint: "settings-v1",
		auditedAt: 123,
	};
}

function makeObservation(
	inventory: CatalogInventoryEntry,
	startLine: number,
	time: string,
	content: string,
): MemoObservation {
	return {
		sourcePath: inventory.sourcePath,
		sourceRevision: "sha",
		logicalDate: inventory.logicalDate,
		section: "## Memos",
		startLine,
		endLine: startLine,
		time,
		content,
		contentHash: `hash-${startLine}`,
		existingBlockId: null,
		tags: [],
		links: [],
		images: [],
		tasks: [],
		timeBuoyDates: [],
	};
}
