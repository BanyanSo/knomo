import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import type { Component } from "obsidian";
import type { CatalogRevisionTransition } from "../src/services/CatalogIndexCoordinator";
import type { IdentityLedgerEvent } from "../src/types/identityLedger";
import { hashMemoContent } from "../src/utils/hash";
import { ensureObsidianStub } from "./helpers/obsidianStub";

const PATH = "Daily/2026-08-22.md";
const DATE = "2026-08-22";

test("真实 Daily 提交链连续创建重复 Memo，插入位置完整传递且旧身份不续接", async (context) => {
	for (const position of ["top", "bottom"] as const) {
		await context.test(position, async () => {
			const fixture = await createFixture(position);
			const { IDENTITY_REVISION_TRANSITION_QUEUE_META_KEY } = await import("../src/services/IdentityRevisionTransitionQueue");
			try {
				const expected: Array<{ memoId: string; bindingId: string }> = [];
				for (let count = 1; count <= 10; count += 1) {
					const result = await fixture.command.create("same");
					assert.equal(result.localRefreshPending, false);
					assert.equal(result.followUpPending, false);
					const transition = fixture.transitions.at(-1)!;
					assert.equal(transition.insertedObservation?.occurrenceIndex, position === "top" ? 0 : count - 1);
					assert.equal(transition.insertedObservation?.occurrenceCount, count);
					assert.deepEqual(transition.after.observations.map((item) => item.occurrenceIndex), Array.from({ length: count }, (_, index) => index));
					await fixture.drain();
					const inserted = fixture.identity.resolveObservation(transition.insertedObservation!)!;
					assert.equal(inserted.memoId, result.memoId);
					const binding = { memoId: inserted.memoId, bindingId: inserted.bindingId };
					if (position === "top") expected.unshift(binding);
					else expected.push(binding);
					assert.deepEqual(await fixture.bindings(), expected);
				}
				assert.equal(fixture.events().filter((event) => event.type === "rebind").length, 0);
				assert.equal(fixture.events().filter((event) => event.type === "claim").length, 10);
				assert.equal(await fixture.store.getMeta(IDENTITY_REVISION_TRANSITION_QUEUE_META_KEY), null);
				const persisted = fixture.events();
				fixture.vault.replace(PATH, "普通 Daily 文字\n\n" + fixture.vault.read(PATH));
				await fixture.coordinator.refreshPaths([PATH]);
				await fixture.drain();
				assert.deepEqual(await fixture.bindings(), expected);
				assert.deepEqual(fixture.events(), persisted);
				await fixture.coordinator.rebuildLocalCatalog();
				await fixture.drain();
				assert.deepEqual(await fixture.bindings(), expected);
				assert.deepEqual(fixture.events(), persisted);
				assert.doesNotMatch(fixture.vault.read(PATH)!, /memoId|<!--|knomo-id/u);
			} finally {
				fixture.unload();
			}
		});
	}
});

test("Daily 已提交但创建未结算时，位置刷新后重启恢复原 intent 且 finish 幂等", async () => {
	const fixture = await createFixture("top");
	const { IdentityLedgerService } = await import("../src/services/IdentityLedgerService");
	const { getIdentityLedgerRootPath } = await import("../src/services/IdentityLedgerProtocol");
	const { IdentityRevisionTransitionQueue, IDENTITY_REVISION_TRANSITION_QUEUE_META_KEY } = await import("../src/services/IdentityRevisionTransitionQueue");
	try {
		await fixture.command.create("same");
		await fixture.drain();
		const oldBinding = (await fixture.bindings())[0]!;
		const plan = await fixture.identity.beginCreate({ targetPath: PATH, logicalDate: DATE, time: "09:00", contentHash: hashMemoContent("same"), sourceMemoId: null });
		const saved = await fixture.mutation.create({ content: "same" });
		assert.equal(saved.catalogUpdatePending, false);
		assert.equal(fixture.events().filter((event) => event.type === "claim").length, 1);
		assert.notEqual(await fixture.store.getMeta(IDENTITY_REVISION_TRANSITION_QUEUE_META_KEY), null);
		fixture.vault.replace(PATH, "普通 Daily 文字\n\n" + fixture.vault.read(PATH));
		await fixture.coordinator.refreshPaths([PATH]);

		const restartedIdentity = new IdentityLedgerService(fixture.vault.app, {
			getRootPath: () => getIdentityLedgerRootPath("Knomo"),
			getWriterId: async () => "w_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
		});
		await restartedIdentity.initialize();
		const restartedQueue = new IdentityRevisionTransitionQueue({ store: fixture.store, getCurrentSourceRevision: async (path) => (await fixture.store.getFile(path))?.sourceRevision ?? null });
		await restartedQueue.drain((transition, isCurrent) => restartedIdentity.reconcileRevision(transition.before?.observations ?? [], transition.after.observations, transition.insertedObservation, transition.allowIdentityAdoption, isCurrent));
		const observations = (await fixture.store.getFileRevisionBatch(PATH))!.observations;
		const inserted = restartedIdentity.resolveObservation(observations[0]!)!;
		assert.equal(inserted.memoId, plan.memoId);
		const retained = restartedIdentity.resolveObservation(observations[1]!)!;
		assert.deepEqual({ memoId: retained.memoId, bindingId: retained.bindingId }, oldBinding);
		assert.equal(await fixture.store.getMeta(IDENTITY_REVISION_TRANSITION_QUEUE_META_KEY), null);
		const persisted = fixture.events();
		const retried = await restartedIdentity.finishCreate(plan, observations[0]!);
		assert.equal(retried.bindingId, inserted.bindingId);
		await restartedQueue.drain(() => { throw new Error("已恢复 transition 不应重复协调"); });
		assert.deepEqual(fixture.events(), persisted);
		assert.equal(persisted.filter((event) => event.type === "claim").length, 2);
		assert.equal(persisted.filter((event) => event.type === "rebind").length, 0);
		assert.equal(observations.length, 2);
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
		bindings: async () => (await store.getFileRevisionBatch(PATH))!.observations.map((observation) => {
			const binding = identity.resolveObservation(observation);
			assert.ok(binding);
			return { memoId: binding.memoId, bindingId: binding.bindingId };
		}),
		events: () => vault.paths().filter((path) => path.endsWith(".jsonl")).flatMap((path) => vault.read(path)!.trim().split("\n").map((line) => JSON.parse(line) as IdentityLedgerEvent)),
		unload: () => cleanups.splice(0).forEach((cleanup) => cleanup()),
	};
}
