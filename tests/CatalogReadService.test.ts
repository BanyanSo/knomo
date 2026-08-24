import assert from "node:assert/strict";
import { setImmediate as waitImmediate } from "node:timers/promises";
import test from "node:test";

import type { CatalogObservation, MemoObservation } from "../src/types/catalog";
import type {
	IdentityLedgerBinding,
	IdentityLedgerDeleteRecord,
	IdentityLedgerMaterializedMemo,
	IdentityLedgerObservationState,
	IdentityLedgerReader,
	IdentityLedgerStatus,
} from "../src/types/identityLedger";

import { ensureObsidianStub } from "./helpers/obsidianStub";

test("Catalog observation 在 Identity Ledger 关系到达后原地获得 memoId", async () => {
	await ensureObsidianStub();
	const { CatalogReadService } = await import("../src/services/CatalogReadService");
	const { MemoCatalogService } = await import("../src/services/MemoCatalogService");
	const { InMemoryMemoCatalogStore } = await import("../src/services/MemoCatalogStore");
	const store = new InMemoryMemoCatalogStore();
	const catalog = new MemoCatalogService(store);
	const observation = makeObservation("Daily/2026-08-22.md", "2026-08-22", 1, "first memo");
	await seedCatalog(catalog, store, [observation]);
	const identity = createIdentityReader();
	const service = new CatalogReadService({ catalog, identityLedger: identity.reader });

	const before = await service.query({ limit: 50 });
	assert.equal(before.items[0]?.memoId, null);
	assert.equal(before.items[0]?.resolved.kind, "observed");

	const binding = makeBinding(observation, "2026082212345601", "identity-1");
	identity.setState(observation.content, { kind: "identified", binding }, "ready", "identity-1");
	const after = await service.query({ limit: 50 });

	assert.equal(after.invalidated, false);
	assert.equal(after.items[0]?.renderKey, before.items[0]?.renderKey);
	assert.equal(after.items[0]?.memoId, binding.memoId);
	assert.equal(after.items[0]?.resolved.kind, "identified");
});

test("Identity 冲突只降级相关 observation，不阻断其他 Catalog 内容", async () => {
	await ensureObsidianStub();
	const { CatalogReadService } = await import("../src/services/CatalogReadService");
	const { MemoCatalogService } = await import("../src/services/MemoCatalogService");
	const { InMemoryMemoCatalogStore } = await import("../src/services/MemoCatalogStore");
	const store = new InMemoryMemoCatalogStore();
	const catalog = new MemoCatalogService(store);
	const conflicted = makeObservation("Daily/2026-08-22.md", "2026-08-22", 1, "conflicted memo");
	const unaffected = makeObservation("Daily/2026-08-22.md", "2026-08-22", 3, "unaffected memo");
	await seedCatalog(catalog, store, [conflicted, unaffected]);
	const identity = createIdentityReader();
	identity.setState(conflicted.content, {
		kind: "conflicted",
		memoIds: ["2026082212345601", "2026082212345602"],
		bindings: [],
	}, "conflicted", "identity-conflict");
	const service = new CatalogReadService({ catalog, identityLedger: identity.reader });

	const page = await service.query({ limit: 50 });
	const conflictedItem = page.items.find((item) => item.content === conflicted.content);
	const unaffectedItem = page.items.find((item) => item.content === unaffected.content);

	assert.equal(page.items.length, 2);
	assert.equal(page.status.identity, "conflicted");
	assert.equal(conflictedItem?.resolved.kind, "ambiguous");
	assert.equal(conflictedItem?.capabilities.identity.repair, "conflicted");
	assert.equal(unaffectedItem?.resolved.kind, "observed");
	assert.equal(unaffectedItem?.capabilities.markdown.edit, true);
});

test("Catalog 查询失败时返回可展示的降级状态并请求后台扫描", async () => {
	await ensureObsidianStub();
	const { CatalogReadService } = await import("../src/services/CatalogReadService");
	const { MemoCatalogService } = await import("../src/services/MemoCatalogService");
	const { InMemoryMemoCatalogStore } = await import("../src/services/MemoCatalogStore");
	class FailingStore extends InMemoryMemoCatalogStore {
		override async query(): Promise<never> {
			throw new Error("catalog unavailable");
		}
	}
	let scanRequests = 0;
	const service = new CatalogReadService({
		catalog: new MemoCatalogService(new FailingStore()),
		identityLedger: createIdentityReader().reader,
		requestObservationScan: () => { scanRequests += 1; },
	});

	const page = await service.query({ limit: 50 });
	await waitImmediate();

	assert.equal(page.readState, "storage_unavailable");
	assert.equal(page.status.content, "unavailable");
	assert.equal(page.degraded, true);
	assert.equal(scanRequests, 1);
});

test("旧 Index 仅有安全跳过项时保留设置诊断，不占用主视图状态提示", async () => {
	await ensureObsidianStub();
	const { CatalogReadService } = await import("../src/services/CatalogReadService");
	const { MemoCatalogService } = await import("../src/services/MemoCatalogService");
	const { InMemoryMemoCatalogStore } = await import("../src/services/MemoCatalogStore");
	const store = new InMemoryMemoCatalogStore();
	const catalog = new MemoCatalogService(store);
	const observation = makeObservation("Daily/2026-08-22.md", "2026-08-22", 1, "known memo");
	await seedCatalog(catalog, store, [observation]);
	const service = new CatalogReadService({
		catalog,
		identityLedger: createIdentityReader().reader,
		getLegacyImportStatus: () => "partial",
	});

	const page = await service.query({ limit: 20 });

	assert.equal(page.status.migration, "none");
});

test("回收站忽略过期 resolution snapshot，并按当前 Catalog 显示删除记录", async () => {
	await ensureObsidianStub();
	const { CatalogReadService } = await import("../src/services/CatalogReadService");
	const { MemoCatalogService } = await import("../src/services/MemoCatalogService");
	const { InMemoryMemoCatalogStore } = await import("../src/services/MemoCatalogStore");
	const store = new InMemoryMemoCatalogStore();
	const catalog = new MemoCatalogService(store);
	const observation = makeObservation("Daily/2026-08-22.md", "2026-08-22", 1, "deleted memo");
	await seedCatalog(catalog, store, [observation]);
	const identity = createIdentityReader();
	const binding = makeBinding(observation, "2026082212345601", "identity-1");
	identity.setState(observation.content, { kind: "identified", binding }, "ready", "identity-1");
	const service = new CatalogReadService({ catalog, identityLedger: identity.reader });
	await service.materializeResolutionSnapshot();
	await catalog.deleteFile(observation.sourcePath);
	identity.setActiveDeletes([{
		memoId: binding.memoId,
		deleteEventId: "e_22222222222222222222222222222222",
		deleteCommitEventId: "e_33333333333333333333333333333333",
		baseBindingId: binding.bindingId,
		evidence: {
			deletedAt: "2026-08-22T13:00:00.000Z",
			sourcePath: observation.sourcePath,
			deletedSourceRevision: observation.sourceRevision,
			logicalDate: observation.logicalDate,
			section: observation.section,
			rawBlock: "- 12:34 deleted memo",
			contentHash: observation.contentHash,
			sourceMemoId: null,
		},
	}], "identity-2");

	const page = await service.listDeleted(20);

	assert.equal(page.items.length, 1);
	assert.equal(page.items[0]?.memoId, binding.memoId);
});

async function seedCatalog(
	catalog: import("../src/services/MemoCatalogService").MemoCatalogService,
	store: import("../src/services/MemoCatalogStore").MemoCatalogStore,
	observations: readonly MemoObservation[],
): Promise<void> {
	await catalog.open();
	await catalog.replaceFile({
		inventory: {
			sourcePath: observations[0]?.sourcePath ?? "Daily/2026-08-22.md",
			logicalDate: observations[0]?.logicalDate ?? "2026-08-22",
			mtime: 1,
			size: 1,
		},
		sourceRevision: observations[0]?.sourceRevision ?? "revision-1",
		observations,
		parserVersion: 1,
		settingsFingerprint: "settings-1",
		auditedAt: 1,
	});
	await store.setCoverage({
		kind: "complete",
		coveredFromDate: "2026-08-22",
		pendingFileCount: 0,
		coveredFileCount: 1,
		totalFileCount: 1,
	});
}

function createIdentityReader(): {
	reader: IdentityLedgerReader;
	setState: (
		content: string,
		state: IdentityLedgerObservationState,
		status: IdentityLedgerStatus,
		revision: string,
	) => void;
	setActiveDeletes: (records: IdentityLedgerDeleteRecord[], revision: string) => void;
} {
	let revision = "identity-absent";
	let status: IdentityLedgerStatus = "absent";
	const states = new Map<string, IdentityLedgerObservationState>();
	const memos: Record<string, IdentityLedgerMaterializedMemo> = {};
	let activeDeletes: IdentityLedgerDeleteRecord[] = [];
	const reader: IdentityLedgerReader = {
		getRevision: () => revision,
		getStatus: () => status,
		getSnapshot: () => ({
			revision,
			eventCount: Object.keys(memos).length,
			memos,
			pendingIntents: [],
			quarantinedEventIds: [],
		}),
		resolveObservation: (observation) => {
			const state = states.get(observation.content);
			return state?.kind === "identified" ? state.binding : null;
		},
		resolveObservationState: (observation) => states.get(observation.content) ?? { kind: "unbound" },
		getSourceMemoId: () => null,
		getReviewState: () => ({ reviewCount: 0, lastReviewedAt: null }),
		getActiveDeletes: () => activeDeletes,
	};
	return {
		reader,
		setState: (content, state, nextStatus, nextRevision) => {
			states.set(content, state);
			status = nextStatus;
			revision = nextRevision;
			if (state.kind === "conflicted") {
				for (const memoId of state.memoIds) {
					memos[memoId] = {
						memoId,
						bindings: [],
						conflicted: true,
						conflictBaseBindingId: null,
						sourceMemoIds: [],
						reviewCount: 0,
						lastReviewedAt: null,
					};
				}
			}
		},
		setActiveDeletes: (records, nextRevision) => {
			activeDeletes = records;
			revision = nextRevision;
		},
	};
}

function makeObservation(sourcePath: string, logicalDate: string, startLine: number, content: string): MemoObservation {
	return {
		sourcePath,
		sourceRevision: "a".repeat(64),
		rawBlockHash: `raw-${startLine}`,
		logicalDate,
		section: "Memos",
		startLine,
		endLine: startLine,
		time: "12:34",
		content,
		contentHash: `content-${startLine}`,
		existingBlockId: null,
		tags: [],
		links: [],
		images: [],
		tasks: [],
		timeBuoyDates: [],
	};
}

function makeBinding(
	observation: MemoObservation | CatalogObservation,
	memoId: string,
	identityRevision: string,
): IdentityLedgerBinding {
	return {
		memoId,
		bindingId: "e_11111111111111111111111111111111",
		identityRevision,
		evidence: {
			sourcePath: observation.sourcePath,
			sourceRevision: observation.sourceRevision,
			rawBlockHash: observation.rawBlockHash,
			logicalDate: observation.logicalDate,
			section: observation.section,
			startLine: observation.startLine,
			endLine: observation.endLine,
			time: observation.time,
			contentHash: observation.contentHash,
		},
	};
}
