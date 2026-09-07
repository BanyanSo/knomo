import assert from "node:assert/strict";
import test from "node:test";
import { ensureObsidianStub } from "./helpers/obsidianStub";

test("当前状态重启保留 memoId 和回顾统计，删除恢复再删除不保存历史正文", async () => {
	await ensureObsidianStub();
	const { InMemoryVault } = await import("./helpers/InMemoryVault");
	const { IdentityLedgerService } = await import("../src/services/IdentityLedgerService");
	const { KnomoCurrentStateStore } = await import("../src/services/KnomoCurrentStateStore");
	const { DiaryMemoParser } = await import("../src/services/DiaryMemoParser");
	const { KnomoDataRootMigrationService } = await import("../src/services/KnomoDataRootMigrationService");
	const vault = new InMemoryVault();
	let root = "Knomo/_knomo-data/identity";
	await vault.app.vault.createFolder(root);
	const create = () => new IdentityLedgerService(vault.app, {
		getRootPath: () => root, getWriterId: async () => "w_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
		currentStateStore: new KnomoCurrentStateStore(vault.app, () => root, "current"),
	});
	const parser = new DiaryMemoParser();
	const parsed = await parser.parse({ sourcePath: "Daily/2026-09-07.md", logicalDate: "2026-09-07", bytes: new TextEncoder().encode("- 09:00 memo\n") });
	let observation = parsed.observations[0]!;
	let service = create();
	await service.initialize();
	await service.adoptHistoricalObservations([observation]);
	const memoId = service.resolveObservation(observation)!.memoId;
	for (let i = 0; i < 3; i++) await service.recordReview(service.resolveObservation(observation)!, "2026-09-07T09:00:00Z");
	service = create();
	await service.initialize();
	assert.equal(service.resolveObservation(observation)!.memoId, memoId);
	assert.equal(service.getReviewState(memoId).reviewCount, 3);
	const edited = (await parser.parse({ sourcePath: observation.sourcePath, logicalDate: observation.logicalDate,
		bytes: new TextEncoder().encode("- 09:00 edited memo\n") })).observations[0]!;
	await service.rebindObservation(observation, edited, "edit");
	observation = edited;
	assert.equal(service.resolveObservation(observation)?.memoId, memoId);
	let location = { knomoDataRoot: "Knomo", knomoDataRootConfigured: true };
	await new KnomoDataRootMigrationService(vault.app, service, () => location, async (dataRoot) => {
		location = { knomoDataRoot: dataRoot, knomoDataRootConfigured: true };
		root = `${dataRoot}/_knomo-data/identity`;
	}, { currentIdentityState: true }).migrate("Moved");
	assert.equal(service.resolveObservation(observation)?.memoId, memoId);
	assert.equal(service.getReviewState(memoId).reviewCount, 3);
	const first = await service.recordDeletePayload(service.resolveObservation(observation)!, {
		deletedAt: "2026-09-07T10:00:00Z", sourcePath: observation.sourcePath, deletedSourceRevision: null,
		logicalDate: observation.logicalDate, section: observation.section, rawBlock: "old deleted body", contentHash: observation.contentHash, sourceMemoId: null,
	});
	await service.recordDeleteCommit(first);
	await service.recordRestore(service.getActiveDeletes()[0]!, observation);
	assert.equal(Object.values(vault.snapshot()).some((text) => text.includes("old deleted body")), false);
	const second = await service.recordDeletePayload(service.resolveObservation(observation)!, {
		...first.evidence, deletedAt: "2026-09-07T11:00:00Z", rawBlock: "current deleted body",
	});
	await service.recordDeleteCommit(second);
	service = create();
	await service.initialize();
	assert.equal(service.getActiveDeletes().length, 1);
	assert.equal(service.getActiveDeletes()[0]!.evidence.rawBlock, "current deleted body");
	await service.recordPurge(service.getActiveDeletes()[0]!);
	assert.equal(Object.values(vault.snapshot()).some((text) => text.includes("current deleted body")), false);
	assert.equal(vault.paths().filter((path) => path.startsWith("Moved/")).length, 2);
});
