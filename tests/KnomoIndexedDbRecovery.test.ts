import assert from "node:assert/strict";
import test from "node:test";
import { IDBKeyRange, indexedDB } from "fake-indexeddb";
import type { App } from "obsidian";

import { hashMemoContent } from "../src/utils/hash";
import { IdentityLedgerService } from "../src/services/IdentityLedgerService";
import { getIdentityLedgerRootPath } from "../src/services/IdentityLedgerProtocol";
import { IdentityReceiptStore } from "../src/services/IdentityReceiptStore";
import { IndexedDbMemoCatalogStore } from "../src/services/IndexedDbMemoCatalogStore";
import { KnomoSharedConfigService } from "../src/services/KnomoSharedConfigService";
import { buildKnomoSharedConfig, getKnomoSharedConfigRootPath } from "../src/services/KnomoSharedConfigProtocol";
import { LocalWriterIdentityService } from "../src/services/LocalWriterIdentityService";
import type { MemoObservation } from "../src/types/catalog";
import type { KnomoSettings } from "../src/types/settings";
import { InMemoryVault } from "./helpers/InMemoryVault";

const WRITER = `w_${"a".repeat(32)}`;
const MEMO_ACTIVE = "01991f40-7c00-7111-9111-111111111111";
const MEMO_TRASH = "01991f40-7c00-7222-a222-222222222222";
const MEMO_PURGED = "01991f40-7c00-7333-b333-333333333333";
const MEMO_NEW = "01991f40-7c00-7444-8444-444444444444";

test("删除全部 Knomo IndexedDB 后从 Daily 与共享事实重建并继续写入", async () => {
	const vault = new InMemoryVault({
		"Daily/2026-08-22.md": "## Memos\n- 09:00 active edited\n- 10:00 trash\n",
	});
	await vault.app.vault.createFolder(getIdentityLedgerRootPath("Knomo"));
	await vault.app.vault.createFolder(`${getIdentityLedgerRootPath("Knomo")}/writers`);
	await vault.app.vault.createFolder("Knomo/_knomo-data");
	const localValues = new Map<string, unknown>();
	const localApp = installLocalStorage(vault, localValues);
	const writerId = await new LocalWriterIdentityService(localApp, () => WRITER).getWriterId();
	const first = createIdentity(vault, writerId, [MEMO_ACTIVE, MEMO_TRASH, MEMO_PURGED], 1);
	await first.initialize();

	const activeBefore = observation(1, "active");
	const activeBinding = await createMemo(first, activeBefore);
	const activeEdited = observation(1, "active edited", "b".repeat(64));
	await first.rebindObservation(activeBefore, activeEdited, "edit");
	await first.recordReview(first.resolveObservation(activeEdited)!, "2026-08-22T03:00:00.000Z");
	const trashBinding = await createMemo(first, observation(2, "trash"));
	const trash = await first.recordDeletePayload(trashBinding, deletePayload(observation(2, "trash")));
	await first.recordDeleteCommit(trash);
	const purgeObservation = observation(3, "purge");
	const purgeBinding = await createMemo(first, purgeObservation);
	const purge = await first.recordDeletePayload(purgeBinding, deletePayload(purgeObservation));
	const committedPurge = await first.recordDeleteCommit(purge);
	await first.recordPurge(committedPurge);

	const firstConfig = createConfig(vault, writerId, "## Shared", `c_${"1".repeat(32)}`);
	await firstConfig.initialize();
	await firstConfig.publishLocalConfig();
	const receipts = createReceipts(vault, writerId, first);
	await receipts.setMeta("historicalIdentityBootstrap", {
		state: "completed", reason: "initial_import", catalogFingerprint: "catalog-a",
		identityRevision: first.getRevision(), identityEventCount: first.getSnapshot().eventCount, authorizationRoot: "Knomo",
	});

	const databaseName = `knomo-recovery-${Date.now()}-${Math.random()}`;
	const catalog = new IndexedDbMemoCatalogStore(databaseName, { factory: indexedDB, keyRange: IDBKeyRange });
	await catalog.open();
	await catalog.setMeta("local-only", true);
	catalog.close();
	await createEmptyDatabase(`${databaseName}-shared-r1`);
	localValues.set("knomo.shared.publisherInitialization", "legacy-active-marker");
	await deleteDatabase(databaseName);
	await deleteDatabase(`${databaseName}-shared-r1`);

	const restoredWriter = await new LocalWriterIdentityService(localApp, () => `w_${"b".repeat(32)}`).getWriterId();
	assert.equal(restoredWriter, writerId);
	const restored = createIdentity(vault, restoredWriter, [MEMO_NEW], 100);
	await restored.initialize();
	const restoredConfig = createConfig(vault, restoredWriter, "## Local fallback", `c_${"2".repeat(32)}`);
	await restoredConfig.initialize();

	assert.equal(restored.resolveObservation(activeEdited)?.memoId, activeBinding.memoId);
	assert.deepEqual(restored.getReviewState(MEMO_ACTIVE), { reviewCount: 1, lastReviewedAt: "2026-08-22T03:00:00.000Z" });
	assert.equal(restored.getActiveDeletes()[0]?.memoId, MEMO_TRASH);
	assert.deepEqual(restored.getSnapshot().memos[MEMO_PURGED]?.purgedDeleteEventIds, [committedPurge.deleteEventId]);
	assert.equal(restored.resolveObservation(purgeObservation), null);
	assert.equal(restoredConfig.getEffectiveConfig().daily.headings[0], "## Shared");
	assert.equal((await createReceipts(vault, restoredWriter, restored)
		.getMeta<Record<string, unknown>>("historicalIdentityBootstrap"))?.state, "completed");

	const newObservation = observation(4, "new after recovery", "c".repeat(64));
	const newBinding = await createMemo(restored, newObservation);
	const newEdited = observation(4, "new edited", "d".repeat(64));
	await restored.rebindObservation(newObservation, newEdited, "edit");
	await restored.recordReview(restored.resolveObservation(newEdited)!, "2026-08-23T03:00:00.000Z");
	await restoredConfig.refreshLocalConfig();
	await restoredConfig.publishLocalConfig();
	assert.equal(newBinding.memoId, MEMO_NEW);
	assert.equal(restored.resolveObservation(newEdited)?.memoId, MEMO_NEW);
	assert.equal(restored.getReviewState(MEMO_NEW).reviewCount, 1);
	assert.equal(vault.paths().filter((path) => path.includes(`/writers/${writerId}/segments/`)).length > 0, true);
	assert.equal(localValues.get("knomo.shared.publisherInitialization"), "legacy-active-marker",
		"旧 marker 存在也不能让恢复后的生产路径进入 publisher recovery_required");
});

test("共享文件暂缺时删除数据库只等待，文件回来后恢复且不自动初始化", async () => {
	const source = new InMemoryVault();
	await source.app.vault.createFolder(getIdentityLedgerRootPath("Knomo"));
	await source.app.vault.createFolder(`${getIdentityLedgerRootPath("Knomo")}/writers`);
	const writer = createIdentity(source, WRITER, [MEMO_ACTIVE], 1);
	await writer.initialize();
	const memo = observation(1, "shared later");
	const binding = await writer.adoptObservation(memo);

	const partial = new InMemoryVault({ "Daily/2026-08-22.md": "## Memos\n- 09:00 shared later\n" });
	const waiting = createIdentity(partial, WRITER, [], 50);
	await waiting.initialize();
	assert.equal(waiting.getStatus(), "missing");
	assert.equal(partial.paths().some((path) => path.includes("_knomo-data/identity")), false);

	partial.deliverFrom(source);
	await waiting.reloadConfiguredRoot(false);
	assert.equal(waiting.getStatus(), "ready");
	assert.equal(waiting.resolveObservation(memo)?.memoId, binding.memoId);
});

function createIdentity(vault: InMemoryVault, writerId: string, memoIds: string[], eventStart: number): IdentityLedgerService {
	let memoIndex = 0;
	let eventIndex = eventStart;
	return new IdentityLedgerService(vault.app, {
		getRootPath: () => getIdentityLedgerRootPath("Knomo"),
		getWriterId: async () => writerId,
		createMemoId: () => memoIds[memoIndex++] ?? MEMO_NEW,
		createEventId: () => `e_${(eventIndex++).toString(16).padStart(32, "0")}`,
		now: () => new Date("2026-08-22T00:00:00.000Z"),
	});
}

function createReceipts(vault: InMemoryVault, writerId: string, identity: IdentityLedgerService): IdentityReceiptStore {
	return new IdentityReceiptStore(vault.app, {
		getRootPath: () => "Knomo",
		getWriterId: async () => writerId,
		getKnownIdentityEventIds: () => identity.getKnownIdentityEventIds(),
	});
}

function createConfig(vault: InMemoryVault, writerId: string, heading: string, eventId: string): KnomoSharedConfigService {
	return new KnomoSharedConfigService(vault.app, {
		getRootPath: () => getKnomoSharedConfigRootPath("Knomo"),
		getWriterId: async () => writerId,
		getCurrentLocale: () => "en",
		getLocalConfig: async () => buildKnomoSharedConfig(
			{ folder: "Daily", format: "YYYY-MM-DD" }, settings(heading), "en",
		),
		createEventId: () => eventId,
		now: () => new Date("2026-08-22T00:00:00.000Z"),
	});
}

function observation(line: number, content: string, revision = "a".repeat(64)): MemoObservation {
	return {
		occurrenceIndex: 0, occurrenceCount: 1, sourcePath: "Daily/2026-08-22.md", sourceRevision: revision,
		rawBlockHash: `fnv1a-${line.toString(16).padStart(8, "0")}`, logicalDate: "2026-08-22",
		section: "## Memos", startLine: line, endLine: line, time: `${String(8 + line).padStart(2, "0")}:00`,
		content, contentHash: hashMemoContent(content), existingBlockId: null, tags: [], links: [], images: [],
		tasks: [], timeBuoyDates: [],
	};
}

function deletePayload(item: MemoObservation) {
	return {
		deletedAt: "2026-08-22T05:00:00.000Z", sourcePath: item.sourcePath, deletedSourceRevision: item.sourceRevision,
		logicalDate: item.logicalDate, section: item.section, rawBlock: `- ${item.time} ${item.content}`,
		contentHash: item.contentHash, sourceMemoId: null,
	};
}

async function createMemo(service: IdentityLedgerService, item: MemoObservation) {
	return service.finishCreate(await service.beginCreate({
		targetPath: item.sourcePath,
		logicalDate: item.logicalDate,
		time: item.time,
		contentHash: item.contentHash,
		sourceMemoId: null,
	}), item);
}

function settings(heading: string): KnomoSettings {
	return {
		settingsVersion: 4, dailyHeading: heading, dailyInsertPosition: "bottom", memoTimeFormat: "HH:mm:ss",
		knomoDataRoot: "Knomo", knomoDataRootConfigured: true, monthlyMemoFolder: "Monthly",
		monthlyMemoFileFormat: "YYYY-MM.md", monthlyDateHeadingFormat: "## YYYY-MM-DD", monthlyDateOrder: "asc",
		legacyDailyHeadings: [], timeBuoyEnabled: false, mobileCompactMode: "auto", syncDebounceMs: 1000,
		desktopSidebarWidth: 248, desktopSidebarCollapsed: false, excludeMonthlyMemosFromObsidian: false, pinnedTags: [],
	};
}

function installLocalStorage(vault: InMemoryVault, values: Map<string, unknown>): Pick<App, "loadLocalStorage" | "saveLocalStorage"> {
	const app = vault.app as App & Pick<App, "loadLocalStorage" | "saveLocalStorage">;
	app.loadLocalStorage = (key: string) => values.get(key) ?? null;
	app.saveLocalStorage = (key: string, value: unknown) => { values.set(key, value); };
	return app;
}

function createEmptyDatabase(name: string): Promise<void> {
	return new Promise((resolve, reject) => {
		const request = indexedDB.open(name, 1);
		request.onerror = () => reject(request.error);
		request.onsuccess = () => { request.result.close(); resolve(); };
	});
}

function deleteDatabase(name: string): Promise<void> {
	return new Promise((resolve, reject) => {
		const request = indexedDB.deleteDatabase(name);
		request.onerror = () => reject(request.error);
		request.onsuccess = () => resolve();
	});
}
