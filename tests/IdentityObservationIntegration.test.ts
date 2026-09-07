import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import type { Component } from "obsidian";
import type { CatalogRevisionTransition } from "../src/services/CatalogIndexCoordinator";
import type { IdentityLedgerEvent } from "../src/types/identityLedger";

import { ensureObsidianStub } from "./helpers/obsidianStub";

const PATH = "Daily/2026-08-22.md";
const DATE = "2026-08-22";

test("真实 Daily 提交链连续创建重复 Memo，独立 occurrence 不生成 Identity", async (context) => {
	for (const position of ["top", "bottom"] as const) {
		await context.test(position, async () => {
			const fixture = await createFixture(position);
			try {
				for (let count = 1; count <= 10; count += 1) {
					const result = await fixture.command.create("same");
					assert.equal(result.localRefreshPending, false);
					assert.equal(result.followUpPending, false);
					assert.equal(result.memoId, null);
					assert.equal(result.memo?.observation.occurrenceIndex, position === "top" ? 0 : count - 1);
					const batch = (await fixture.store.getFileRevisionBatch(PATH))!;
					assert.deepEqual(batch.observations.map((item) => item.occurrenceIndex), Array.from({ length: count }, (_, index) => index));
					await fixture.drain();
					assert.equal(fixture.events().length, 0);
				}
				assert.equal(fixture.transitions.filter((transition) => transition.insertedObservation !== null).length, 0);
				fixture.vault.replace(PATH, "普通 Daily 文字\n\n" + fixture.vault.read(PATH));
				await fixture.coordinator.refreshPaths([PATH]);
				await fixture.drain();
				await fixture.coordinator.rebuildLocalCatalog();
				await fixture.drain();
				assert.equal((await fixture.store.getFileRevisionBatch(PATH))!.observations.length, 10);
				assert.equal(fixture.events().length, 0);
				assert.doesNotMatch(fixture.vault.read(PATH)!, /memoId|<!--|knomo-id/u);
			} finally {
				fixture.unload();
			}
		});
	}
});

test("重复正文新插入和 Catalog 重建后旧 edit 句柄仍拒绝，不换取刷新后的 occurrence", async () => {
	const fixture = await createFixture("top");
	try {
		const first = (await fixture.command.create("same")).memo!;
		await fixture.command.create("same");
		const before = fixture.vault.read(PATH);
		await assert.rejects(() => fixture.command.edit(first, "wrong target"));
		assert.equal(fixture.vault.read(PATH), before);
		await fixture.coordinator.rebuildLocalCatalog();
		await fixture.drain();
		await assert.rejects(() => fixture.command.edit(first, "wrong target"));
		assert.equal(fixture.vault.read(PATH), before);
		const current = (await fixture.command.getReadService().query({ limit: 10 })).items;
		assert.equal(current.length, 2);
		assert.notEqual(current[0]!.key, current[1]!.key);
		await fixture.command.edit(current[1]!, "selected occurrence");
		const after = (await fixture.store.getFileRevisionBatch(PATH))!.observations;
		assert.equal(after.find((item) => item.startLine === current[1]!.observationHandle.startLine)?.content, "selected occurrence");
		assert.equal(after.find((item) => item.startLine === current[0]!.observationHandle.startLine)?.content, "same");
		assert.equal(fixture.events().length, 0);
	} finally {
		fixture.unload();
	}
});
async function createFixture(position: "top" | "bottom") {
	await ensureObsidianStub();
	const { TFile } = await import("obsidian");
	const { CatalogIndexCoordinator } = await import("../src/services/CatalogIndexCoordinator");
	const { DailyMemoWriteGateway } = await import("../src/services/DailyMemoWriteGateway");
	const { DiaryMemoParser } = await import("../src/services/DiaryMemoParser");
	const { IdentityLedgerService } = await import("../src/services/IdentityLedgerService");
	const { getIdentityLedgerRootPath } = await import("../src/services/IdentityLedgerProtocol");
	const { IdentityRevisionTransitionQueue } = await import("../src/services/IdentityRevisionTransitionQueue");
	const { MarkdownMutationService } = await import("../src/services/MarkdownMutationService");
	const { MemoCatalogService } = await import("../src/services/MemoCatalogService");
	const { MemoCommandService } = await import("../src/services/MemoCommandService");
	const { InMemoryMemoCatalogStore } = await import("../src/services/MemoCatalogStore");
	const { InMemoryVault } = await import("./helpers/InMemoryVault");
	const vault = new InMemoryVault({ [PATH]: "## Memos\n" });
	const cleanups: Array<() => void> = [];
	Object.assign(vault.app, { workspace: {
		getActiveViewOfType: () => null,
		on: () => ({}),
		containerEl: { doc: { visibilityState: "visible" }, win: { setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout } },
	} });
	Object.assign(vault.app.vault, { on: () => ({}) });
	const root = getIdentityLedgerRootPath("Knomo");
	await vault.app.vault.createFolder(root);
	await vault.app.vault.createFolder(`${root}/writers`);
	const identity = new IdentityLedgerService(vault.app, {
		getRootPath: () => root,
		getWriterId: async () => "w_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
	});
	await identity.initialize();
	const store = new InMemoryMemoCatalogStore();
	const catalog = new MemoCatalogService(store);
	const parser = new DiaryMemoParser(async (bytes) => createHash("sha256").update(bytes).digest("hex"));
	const transitions: CatalogRevisionTransition[] = [];
	const queue = new IdentityRevisionTransitionQueue({ store, getCurrentSourceRevision: async (path) => (await store.getFile(path))?.sourceRevision ?? null });
	const coordinator = new CatalogIndexCoordinator(vault.app, catalog, parser,
		async () => ({ folder: "Daily", format: "YYYY-MM-DD" }), {
			onRevisionTransition: async (transition) => { transitions.push(transition); await queue.enqueue(transition); },
		});
	coordinator.start({ registerEvent: () => undefined, registerDomEvent: () => undefined, register: (cleanup: () => void) => { cleanups.push(cleanup); } } as unknown as Component);
	await coordinator.initialize();
	await coordinator.waitForIdle();
	const mutation = new MarkdownMutationService(vault.app, {
		getWriteHeading: () => "## Memos",
		getDailyFileForDate: async () => {
			const file = vault.app.vault.getAbstractFileByPath(PATH);
			assert.ok(file instanceof TFile);
			return file;
		},
		getLogicalDateForPath: async () => DATE,
		getMemoTimeFormat: () => "HH:mm",
		getInsertPosition: () => position,
		updateCatalogPartition: (input) => coordinator.replaceCommittedFile(input),
		refreshCatalogPaths: (paths) => coordinator.refreshPaths(paths),
		now: () => new Date(2026, 7, 22, 9, 0, 0),
		random: () => 0,
	}, new DailyMemoWriteGateway(vault.app, parser));
	const command = new MemoCommandService(vault.app, catalog, {
		getDailyPathForDate: async () => PATH,
		getMemoTimeFormat: () => "HH:mm",
		refreshCatalogPaths: (paths) => coordinator.refreshPaths(paths),
		refreshLocalCatalog: () => coordinator.refreshLocalCatalog(),
		rebuildLocalCatalog: () => coordinator.rebuildLocalCatalog(),
		now: () => new Date(2026, 7, 22, 9, 0, 0),
		random: () => 0,
	}, mutation, identity);
	return {
		vault, identity, store, coordinator, mutation, command, transitions,
		drain: () => queue.drain((transition, isCurrent) => identity.reconcileRevision(transition.before?.observations ?? [], transition.after.observations, transition.insertedObservation, transition.allowIdentityAdoption, isCurrent)),
		events: () => vault.paths().filter((path) => path.endsWith(".jsonl")).flatMap((path) => vault.read(path)!.trim().split("\n").map((line) => JSON.parse(line) as IdentityLedgerEvent)),
		unload: () => cleanups.splice(0).forEach((cleanup) => cleanup()),
	};
}
