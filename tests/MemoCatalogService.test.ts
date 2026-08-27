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

test("文件聚合提供全库统计和标签 facet 所需的 memo 级指标", () => {
	const inventory = makeInventory("Journal/2026-08-12.md", "2026-08-12");
	const tagged = makeObservation(inventory, 1, "09:15", "中文 hello 42 ![[photo.png]]");
	tagged.tags = ["#Project/Alpha", "#project/alpha"];
	tagged.images = [{ path: "photo.png", altText: "", syntax: "obsidian_embed" }];
	const plain = makeObservation(inventory, 3, "21:45", "second memo");
	const partition = buildCatalogPartition(makePartitionInput(inventory, [tagged, plain], "sha-summary"));

	assert.equal(partition.aggregate.memoCount, 2);
	assert.equal(partition.aggregate.wordCount, 6);
	assert.equal(partition.aggregate.imageMemoCount, 1);
	assert.equal(partition.aggregate.taggedMemoCount, 1);
	assert.equal(partition.aggregate.untaggedMemoCount, 1);
	assert.deepEqual(partition.aggregate.hourCounts, [
		0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0,
		0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0,
	]);
	assert.deepEqual(partition.aggregate.tagMemoCounts, { "project/alpha": 1 });
	assert.deepEqual(partition.aggregate.tagDisplayNames, { "project/alpha": "Project/Alpha" });
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

test("移动端大仓库内存 fallback 使用明确上限并保持 coverage 降级", async () => {
	const { IN_MEMORY_CATALOG_OBSERVATION_LIMIT } = await import("../src/services/MemoCatalogStore");
	const store = new InMemoryMemoCatalogStore();
	await store.open();
	const observationsPerFile = 100;
	const fileCount = Math.ceil(IN_MEMORY_CATALOG_OBSERVATION_LIMIT / observationsPerFile) + 1;
	const partitions = Array.from({ length: fileCount }, (_, index) => {
		const year = 2020 + Math.floor(index / 336);
		const yearDay = index % 336;
		const month = Math.floor(yearDay / 28) + 1;
		const day = (yearDay % 28) + 1;
		const logicalDate = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
		const inventory = makeInventory(`Journal/${logicalDate}.md`, logicalDate);
		return buildCatalogPartition(makePartitionInput(
			inventory,
			Array.from({ length: observationsPerFile }, (__, observationIndex) => makeObservation(
				inventory,
				observationIndex + 1,
				"09:00",
				`${logicalDate}-${observationIndex}`,
			)),
			`sha-${index}`,
		));
	});
	await store.replaceFilePartitions(partitions);
	await store.setCoverage({
		kind: "complete",
		coveredFromDate: partitions[0]?.file.logicalDate ?? null,
		pendingFileCount: 0,
		coveredFileCount: partitions.length,
		totalFileCount: partitions.length,
	});

	const retainedObservationCount = (await store.listFiles())
		.reduce((count, file) => count + file.observationCount, 0);
	const coverage = await store.getCoverage();
	assert.ok(retainedObservationCount <= IN_MEMORY_CATALOG_OBSERVATION_LIMIT);
	assert.equal(coverage.kind, "partial");
	assert.equal(coverage.coveredFileCount, (await store.listFiles()).length);
	assert.ok(coverage.pendingFileCount > 0);
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
		rawBlockHash: `raw-${startLine}`,
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
