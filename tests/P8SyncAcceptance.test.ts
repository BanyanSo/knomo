import assert from "node:assert/strict";
import test from "node:test";
import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import type { Component, TFile } from "obsidian";
import { ensureObsidianStub } from "./helpers/obsidianStub";

test("P8 两个独立本地 IDB：Daily 先到可操作，后到快照不影响正文，删除 IDB 后仍可恢复", async () => {
	await ensureObsidianStub();
	const { InMemoryVault } = await import("./helpers/InMemoryVault");
	const { CatalogIndexCoordinator } = await import("../src/services/CatalogIndexCoordinator");
	const { DiaryMemoParser } = await import("../src/services/DiaryMemoParser");
	const { MemoCatalogService } = await import("../src/services/MemoCatalogService");
	const { IndexedDbMemoCatalogStore } = await import("../src/services/IndexedDbMemoCatalogStore");
	const { CatalogReadService } = await import("../src/services/CatalogReadService");
	const { CatalogReferenceService } = await import("../src/services/CatalogReferenceService");
	const { MarkdownMutationService } = await import("../src/services/MarkdownMutationService");
	const { IndependentTrashService } = await import("../src/services/IndependentTrashService");
	const { TrashSnapshotStore } = await import("../src/services/TrashSnapshotStore");
	const daily = "Daily/2026-09-01.md";
	const body = "## Memos\n- 10:30 independent duplicate #project\n- 10:30 independent duplicate #project\n"
		+ "- 11:22:33 work item [[Target]] @2026-09-08\n  - [ ] task\n";
	const a = new InMemoryVault({ [daily]: body });
	const b = new InMemoryVault();
	b.deliverFrom(a, [daily]);
	const cleanup: Array<() => void> = [];
	async function device(vault: InstanceType<typeof InMemoryVault>, name: string) {
		Object.assign(vault.app, { workspace: { activeLeaf: null, getActiveViewOfType: () => null, on: () => ({}),
			containerEl: { doc: { visibilityState: "visible" }, win: { setTimeout, clearTimeout } } },
			metadataCache: { getFirstLinkpathDest: () => vault.app.vault.getAbstractFileByPath("Target.md"), getFileCache: () => null } });
		Object.assign(vault.app.vault, { on: () => ({}), delete: async (file: TFile) => vault.remove(file.path) });
		const factory = new IDBFactory();
		const store = new IndexedDbMemoCatalogStore(name, { factory, keyRange: IDBKeyRange });
		const catalog = new MemoCatalogService(store);
		let stop = () => {};
		const start = async () => {
			const instance = new CatalogIndexCoordinator(vault.app, catalog, new DiaryMemoParser(),
				async () => ({ folder: "Daily", format: "YYYY-MM-DD" }));
			instance.start({ registerEvent: () => {}, registerDomEvent: () => {}, register: (fn: () => void) => { stop = fn; } } as unknown as Component);
			await instance.initialize(); await instance.waitForIdle(); return instance;
		};
		let coordinator = await start();
		cleanup.push(() => stop());
		const options = { getLogicalDateForPath: async () => "2026-09-01",
			getDailyFileForDate: async () => vault.app.vault.getAbstractFileByPath(daily) as TFile,
			updateCatalogPartition: (input: import("../src/services/MarkdownMutationService").MarkdownCatalogCommitInput) => coordinator.replaceCommittedFile(input),
			refreshCatalogPaths: (paths: readonly string[]) => coordinator.refreshPaths(paths) };
		const trashStore = new TrashSnapshotStore(vault.app, "Knomo");
		const trash = new IndependentTrashService(vault.app, trashStore, { ...options,
			getOriginalDailyFile: async (path) => vault.app.vault.getAbstractFileByPath(path) as TFile | null });
		const mutations = new MarkdownMutationService(vault.app, { ...options, getWriteHeading: () => "## Memos", getMemoTimeFormat: () => "HH:mm:ss" });
		const read = new CatalogReadService({ catalog, references: new CatalogReferenceService(vault.app, catalog),
			getTrashService: () => trash, now: () => new Date(2026, 8, 8), random: () => 0 });
		return { catalog, read, mutations, trash, trashStore, reset: async () => {
			stop();
			await new Promise<void>((resolve, reject) => {
				const request = factory.deleteDatabase(name);
				request.onsuccess = () => resolve(); request.onerror = () => reject(request.error);
				request.onblocked = () => reject(new Error("IDB deletion blocked"));
			});
			coordinator = await start();
		} };
	}
	try {
		const da = await device(a, "p8-A");
		const db = await device(b, "p8-B");
		const query = await db.read.query({ limit: 10, text: "duplicate", tags: ["project"] });
		assert.equal(query.items.length, 2);
		assert.notEqual(query.items[0]!.key, query.items[1]!.key);
		assert.equal((await db.read.getRandomReunionItems(10)).length, 3);
		assert.equal((await db.read.queryTimeBuoysForDate("2026-09-08")).items.length, 1);
		const task = (await db.read.query({ limit: 10 })).items.find((item) => item.tasks.length > 0)!;
		assert.equal(task.createdAt, "2026-09-01T11:22:33");
		assert.equal(task.derivedReferences?.[0]?.state, "unresolved");
		await b.app.vault.create("Target.md", "target arrives");
		assert.equal((await db.read.query({ limit: 10 })).items.find((item) => item.tasks.length > 0)!.derivedReferences?.[0]?.state, "resolved");
		await db.mutations.toggleTask({ observation: task.observationHandle, taskIndex: 0, checked: true });
		await assert.rejects(() => db.mutations.edit({ observation: query.items[0]!.observationHandle, content: "wrong occurrence" }));
		const fresh = await db.read.query({ limit: 10, text: "duplicate" });
		await db.mutations.edit({ observation: fresh.items[0]!.observationHandle, content: "edited independently #project" });
		assert.equal((await db.read.query({ limit: 10, text: "duplicate" })).items.length, 1);
		assert.match(b.read(daily)!, /10:30 edited independently/u);
		const aMemo = (await da.read.query({ limit: 10, text: "duplicate" })).items[0]!;
		const deleted = await da.trash.delete(aMemo.observationHandle);
		const before = b.read(daily);
		b.deliverFrom(a, ["Knomo/knomo-trash.json"]);
		assert.equal(b.read(daily), before);
		assert.equal((await db.read.query({ limit: 10 })).items.length, 3);
		await db.reset();
		assert.equal((await db.read.query({ limit: 10 })).items.length, 3);
		assert.equal((await db.trashStore.query()).items.length, 1);
		await db.trash.restore(deleted.snapshotId);
		assert.equal((await db.read.query({ limit: 10, text: "duplicate" })).items.length, 2);
		assert.equal((await db.trashStore.query()).items.length, 0);
		assert.equal((await da.trashStore.query()).items.length, 1);
		assert.match(b.read(daily)!, /11:22:33/u);
	} finally { cleanup.forEach((stop) => stop()); }
});
