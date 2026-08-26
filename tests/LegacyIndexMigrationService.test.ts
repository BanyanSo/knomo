import assert from "node:assert/strict";
import test from "node:test";

import { IdentityLedgerService } from "../src/services/IdentityLedgerService";
import { createIdentityLedgerMemoId, getIdentityLedgerRootPath } from "../src/services/IdentityLedgerProtocol";
import { LegacyIndexMigrationService } from "../src/services/LegacyIndexMigrationService";
import { LegacyIndexReader } from "../src/services/LegacyIndexReader";
import type { MemoObservation } from "../src/types/catalog";
import { hashMemoContent, hashText } from "../src/utils/hash";
import { InMemoryVault } from "./helpers/InMemoryVault";

const LEGACY_MEMO_A = "2026082209000001";
const LEGACY_MEMO_B = "2026082108000002";
const LEGACY_MEMO_C = "2026082209000003";
const IDENTITY_ROOT = getIdentityLedgerRootPath("Knomo");
const LEGACY_INDEX_PATH = "Knomo/_knomo-system/indexes/memo-index-2026-08.json";
const PLUGIN_DATA_PATH = ".obsidian/plugins/knomo/data.json";

test("1.2.9 Memo Index 直接、幂等迁移到 Identity Ledger，旧源与 Daily 字节保持不变", async () => {
	const activeRawBlock = "- 09:00 正文";
	const deletedRawBlock = "- 08:00 已删除正文";
	const dailyPath = "Daily/2026-08-22.md";
	const dailyContent = `## Memos\n${activeRawBlock}\n`;
	const legacyIndex = JSON.stringify({
		schemaVersion: 2,
		period: "2026-08",
		updatedAt: "2026-08-22T10:00:00.000Z",
		memos: {
			[LEGACY_MEMO_A]: legacyMemoRecord({
				memoId: LEGACY_MEMO_A,
				createdAt: "2026-08-22T09:00:00.000Z",
				path: dailyPath,
				rawBlock: activeRawBlock,
				content: "正文",
				sourceMemoId: LEGACY_MEMO_B,
			}),
			[LEGACY_MEMO_B]: legacyMemoRecord({
				memoId: LEGACY_MEMO_B,
				createdAt: "2026-08-21T08:00:00.000Z",
				path: "Daily/2026-08-21.md",
				rawBlock: deletedRawBlock,
				content: "已删除正文",
				status: "deleted",
				deletedAt: "2026-08-22T06:00:00.000Z",
			}),
		},
	}, null, "\t");
	const pluginData = JSON.stringify({
		settings: {},
		randomReunionReviewStates: {
			[LEGACY_MEMO_A]: {
				memoId: LEGACY_MEMO_A,
				reviewCount: 2,
				lastReviewedAt: "2026-08-22T05:00:00.000Z",
			},
		},
	});
	const vault = new InMemoryVault({
		[dailyPath]: dailyContent,
		[LEGACY_INDEX_PATH]: legacyIndex,
		[PLUGIN_DATA_PATH]: pluginData,
	});
	await vault.app.vault.createFolder(IDENTITY_ROOT);
	await vault.app.vault.createFolder(`${IDENTITY_ROOT}/writers`);
	const target = createIdentityService(vault);
	await target.initialize();
	const observation = makeObservation(dailyPath, activeRawBlock, "正文");
	const source = new LegacyIndexReader(vault.app, "knomo", () => "Knomo");
	const migration = new LegacyIndexMigrationService(vault.app, source, target, {
		getObservationBatches: async () => [{
			file: {
				sourcePath: dailyPath,
				logicalDate: observation.logicalDate,
				sourceRevision: observation.sourceRevision,
				mtime: 0,
				size: dailyContent.length,
				parserVersion: 3,
				settingsFingerprint: "test",
				observationCount: 1,
				auditedAt: 0,
			},
			observations: [observation],
			catalogRevision: 1,
		}],
	});
	const sourceBytesBefore = {
		daily: vault.read(dailyPath),
		index: vault.read(LEGACY_INDEX_PATH),
		pluginData: vault.read(PLUGIN_DATA_PATH),
	};

	const first = await migration.run();
	const second = await migration.run();

	assert.equal(first.status, "ready");
	assert.equal(first.importedEventCount, 7);
	assert.equal(second.importedEventCount, 0);
	assert.deepEqual(first.importedMemoIds, [LEGACY_MEMO_B, LEGACY_MEMO_A].sort());
	assert.equal(target.resolveObservation(observation)?.memoId, LEGACY_MEMO_A);
	assert.equal(target.getSourceMemoId(LEGACY_MEMO_A), LEGACY_MEMO_B);
	assert.deepEqual(target.getReviewState(LEGACY_MEMO_A), {
		reviewCount: 2,
		lastReviewedAt: "2026-08-22T05:00:00.000Z",
	});
	assert.equal(target.getActiveDeletes()[0]?.memoId, LEGACY_MEMO_B);
	assert.equal(target.getActiveDeletes()[0]?.evidence.rawBlock, deletedRawBlock);
	assert.deepEqual({
		daily: vault.read(dailyPath),
		index: vault.read(LEGACY_INDEX_PATH),
		pluginData: vault.read(PLUGIN_DATA_PATH),
	}, sourceBytesBefore);
});

test("已有同 memoId binding 与旧 Index 证据不一致时跳过迁移", async () => {
	const dailyPath = "Daily/2026-08-22.md";
	const rawBlock = "- 09:00 旧 Index 正文";
	const dailyContent = `## Memos\n${rawBlock}\n`;
	const vault = new InMemoryVault({
		[dailyPath]: dailyContent,
		[LEGACY_INDEX_PATH]: JSON.stringify({
			schemaVersion: 2,
			period: "2026-08",
			memos: {
				[LEGACY_MEMO_A]: legacyMemoRecord({
					memoId: LEGACY_MEMO_A,
					createdAt: "2026-08-22T09:00:00.000Z",
					path: dailyPath,
					rawBlock,
					content: "旧 Index 正文",
				}),
			},
		}),
	});
	await vault.app.vault.createFolder(IDENTITY_ROOT);
	await vault.app.vault.createFolder(`${IDENTITY_ROOT}/writers`);
	const target = createIdentityService(vault);
	await target.initialize();
	const unrelated = makeObservation("Daily/2026-08-20.md", "- 09:00 无关正文", "无关正文");
	await target.importVerifiedLegacyEvents([{
		eventId: "e_99999999999999999999999999999999",
		writerId: "w_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
		memoId: LEGACY_MEMO_A,
		type: "claim",
		baseBindingId: null,
		occurredAt: "2026-08-20T09:00:00.000Z",
		evidence: {
			observation: {
				sourcePath: unrelated.sourcePath,
				sourceRevision: unrelated.sourceRevision,
				rawBlockHash: unrelated.rawBlockHash,
				logicalDate: unrelated.logicalDate,
				section: unrelated.section,
				startLine: unrelated.startLine,
				endLine: unrelated.endLine,
				time: unrelated.time,
				contentHash: unrelated.contentHash,
			},
			createIntentEventId: null,
		},
	}]);
	const observation = makeObservation(dailyPath, rawBlock, "旧 Index 正文");
	const migration = new LegacyIndexMigrationService(
		vault.app,
		new LegacyIndexReader(vault.app, "knomo", () => "Knomo"),
		target,
		{
			getObservationBatches: async () => [{
				file: {
					sourcePath: dailyPath,
					logicalDate: observation.logicalDate,
					sourceRevision: observation.sourceRevision,
					mtime: 0,
					size: dailyContent.length,
					parserVersion: 3,
					settingsFingerprint: "test",
					observationCount: 1,
					auditedAt: 0,
				},
				observations: [observation],
				catalogRevision: 1,
			}],
		},
	);

	const report = await migration.run();

	assert.equal(report.status, "partial");
	assert.deepEqual(report.importedMemoIds, []);
	assert.deepEqual(report.skippedMemoIds, [LEGACY_MEMO_A]);
	assert.equal(report.diagnostics.some((item) => item.code === "legacy_binding_mismatch"), true);
	assert.equal(target.getSnapshot().memos[LEGACY_MEMO_A]?.bindings[0]?.evidence.sourcePath, unrelated.sourcePath);
});

test("1.2.9 sourceMemoId 为空时从 references 和正文 block reference 恢复关系", async () => {
	const sourcePath = "Daily/2026-08-21.md";
	const sourceRawBlock = "- 08:00 来源正文 ^source-block";
	const referencedContent = "通过 references 引用";
	const linkedContent = "通过正文引用 [[Daily/2026-08-21#^source-block]]";
	const vault = new InMemoryVault({
		[sourcePath]: `## Memos\n${sourceRawBlock}\n`,
		[LEGACY_INDEX_PATH]: JSON.stringify({
			schemaVersion: 2,
			period: "2026-08",
			memos: {
				[LEGACY_MEMO_B]: legacyMemoRecord({
					memoId: LEGACY_MEMO_B,
					createdAt: "2026-08-21T08:00:00.000Z",
					path: sourcePath,
					rawBlock: sourceRawBlock,
					content: "来源正文",
				}),
				[LEGACY_MEMO_A]: legacyMemoRecord({
					memoId: LEGACY_MEMO_A,
					createdAt: "2026-08-22T09:00:00.000Z",
					path: "Daily/2026-08-22.md",
					rawBlock: `- 09:00 ${referencedContent}`,
					content: referencedContent,
					references: [{ memoId: LEGACY_MEMO_B, referenceText: "[[Daily/2026-08-21#^source-block]]" }],
				}),
				[LEGACY_MEMO_C]: legacyMemoRecord({
					memoId: LEGACY_MEMO_C,
					createdAt: "2026-08-22T09:10:00.000Z",
					path: "Daily/2026-08-22.md",
					rawBlock: `- 09:10 ${linkedContent}`,
					content: linkedContent,
				}),
			},
		}),
	});
	Object.assign(vault.app, {
		metadataCache: {
			getFirstLinkpathDest: (linkPath: string) => linkPath === "Daily/2026-08-21"
				? vault.app.vault.getAbstractFileByPath(sourcePath)
				: null,
		},
	});

	const result = await new LegacyIndexReader(vault.app, "knomo", () => "Knomo").load();

	assert.equal(result.kind, "ready");
	if (result.kind !== "ready") return;
	const byMemoId = new Map(result.snapshot.memos.map((memo) => [memo.memoId, memo]));
	assert.equal(byMemoId.get(LEGACY_MEMO_A)?.sourceMemoId, LEGACY_MEMO_B);
	assert.equal(byMemoId.get(LEGACY_MEMO_C)?.sourceMemoId, LEGACY_MEMO_B);
});

test("旧 reviewCount 超出安全上限时只记录诊断，不展开 Ledger 事件", async () => {
	const vault = new InMemoryVault({
		[LEGACY_INDEX_PATH]: JSON.stringify({
			schemaVersion: 2,
			period: "2026-08",
			memos: {
				[LEGACY_MEMO_A]: legacyMemoRecord({
					memoId: LEGACY_MEMO_A,
					createdAt: "2026-08-22T09:00:00.000Z",
					path: "Daily/2026-08-22.md",
					rawBlock: "- 09:00 正文",
					content: "正文",
				}),
			},
		}),
		[PLUGIN_DATA_PATH]: JSON.stringify({
			randomReunionReviewStates: {
				[LEGACY_MEMO_A]: {
					memoId: LEGACY_MEMO_A,
					reviewCount: 1001,
					lastReviewedAt: "2026-08-22T05:00:00.000Z",
				},
			},
		}),
	});

	const result = await new LegacyIndexReader(vault.app, "knomo", () => "Knomo").load();

	assert.equal(result.kind, "ready");
	if (result.kind !== "ready") return;
	assert.deepEqual(result.snapshot.reviews, []);
	assert.equal(result.snapshot.diagnostics.some((item) => item.code === "legacy_review_record_invalid"), true);
});

test("旧插件数据存在但读取失败时迁移报告 unavailable", async () => {
	const vault = new InMemoryVault({
		[LEGACY_INDEX_PATH]: JSON.stringify({ schemaVersion: 2, period: "2026-08", memos: {} }),
		[PLUGIN_DATA_PATH]: JSON.stringify({ randomReunionReviewStates: {} }),
	});
	const adapter = vault.app.vault.adapter as typeof vault.app.vault.adapter & {
		readBinary(path: string): Promise<ArrayBuffer>;
	};
	const readBinary = adapter.readBinary.bind(adapter);
	adapter.readBinary = async (path) => {
		if (path === PLUGIN_DATA_PATH) throw new Error("plugin data unavailable");
		return readBinary(path);
	};
	await vault.app.vault.createFolder(IDENTITY_ROOT);
	await vault.app.vault.createFolder(`${IDENTITY_ROOT}/writers`);
	const target = createIdentityService(vault);
	await target.initialize();
	const migration = new LegacyIndexMigrationService(
		vault.app,
		new LegacyIndexReader(vault.app, "knomo", () => "Knomo"),
		target,
		{ getObservationBatches: async () => [] },
	);

	const report = await migration.run();

	assert.equal(report.status, "unavailable");
	assert.equal(report.diagnostics.some((item) => item.detail.includes("plugin data unavailable")), true);
});

test("同一旧 memoId 的不一致同步副本进入诊断，不猜测性绑定", async () => {
	const canonical = JSON.stringify({
		schemaVersion: 2,
		period: "2026-08",
		memos: {
			[LEGACY_MEMO_A]: legacyMemoRecord({
				memoId: LEGACY_MEMO_A,
				createdAt: "2026-08-22T09:00:00.000Z",
				path: "Daily/2026-08-22.md",
				rawBlock: "- 09:00 正文 A",
				content: "正文 A",
			}),
		},
	});
	const conflict = JSON.stringify({
		schemaVersion: 2,
		period: "2026-08",
		memos: {
			[LEGACY_MEMO_A]: legacyMemoRecord({
				memoId: LEGACY_MEMO_A,
				createdAt: "2026-08-22T09:00:00.000Z",
				path: "Daily/2026-08-22.md",
				rawBlock: "- 09:00 正文 B",
				content: "正文 B",
			}),
		},
	});
	const vault = new InMemoryVault({
		[LEGACY_INDEX_PATH]: canonical,
		"Knomo/_knomo-system/indexes/memo-index-2026-08 conflict.json": conflict,
	});
	const result = await new LegacyIndexReader(vault.app, "knomo", () => "Knomo").load();

	assert.equal(result.kind, "attention");
	if (result.kind !== "attention") return;
	assert.equal(result.diagnostics.some((item) => item.code === "legacy_identity_conflict" && item.memoId === LEGACY_MEMO_A), true);
});

test("未知旧 Index schema 进入诊断，不按 1.2.9 格式宽松解释", async () => {
	const vault = new InMemoryVault({
		[LEGACY_INDEX_PATH]: JSON.stringify({
			schemaVersion: 3,
			period: "2026-08",
			memos: {},
		}),
	});
	const result = await new LegacyIndexReader(vault.app, "knomo", () => "Knomo").load();

	assert.equal(result.kind, "attention");
	if (result.kind !== "attention") return;
	assert.equal(result.diagnostics.some((item) => item.code === "legacy_memo_index_invalid"), true);
});

function createIdentityService(vault: InMemoryVault): IdentityLedgerService {
	let eventIndex = 0;
	return new IdentityLedgerService(vault.app, {
		getRootPath: () => IDENTITY_ROOT,
		getWriterId: async () => "w_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
		createMemoId: () => createIdentityLedgerMemoId(),
		createEventId: () => `e_${(++eventIndex).toString(16).padStart(32, "0")}`,
		now: () => new Date("2026-08-24T00:00:00.000Z"),
	});
}

function makeObservation(sourcePath: string, rawBlock: string, content: string): MemoObservation {
	return {
		sourcePath,
		sourceRevision: "a".repeat(64),
		rawBlockHash: hashText(rawBlock),
		logicalDate: "2026-08-22",
		section: "## Memos",
		startLine: 1,
		endLine: 1,
		time: "09:00",
		content,
		contentHash: hashMemoContent(content),
		existingBlockId: null,
		tags: [],
		links: [],
		images: [],
		tasks: [],
		timeBuoyDates: [],
	};
}

function legacyMemoRecord(input: {
	memoId: string;
	createdAt: string;
	path: string;
	rawBlock: string;
	content: string;
	status?: "active" | "deleted" | "error";
	deletedAt?: string;
	sourceMemoId?: string | null;
	references?: { memoId: string; referenceText: string }[];
}) {
	return {
		id: input.memoId,
		createdAt: input.createdAt,
		updatedAt: input.deletedAt ?? input.createdAt,
		contentSnapshot: input.content,
		contentHash: hashMemoContent(input.content),
		status: input.status ?? "active",
		syncStatus: "synced",
		source: "plugin_input",
		version: 1,
		tags: [],
		links: [],
		images: [],
		references: input.references ?? [],
		sourceMemoId: input.sourceMemoId ?? null,
		issue: null,
		lastMarkdownSyncAt: input.createdAt,
		lastMarkdownSyncSource: "file_watch",
		dailyRef: {
			path: input.path,
			heading: "## Memos",
			sectionType: "heading",
			lastKnownBlock: input.rawBlock,
			lastKnownHash: hashText(input.rawBlock),
			lineNumberHint: 2,
			lastSyncedAt: input.createdAt,
		},
		monthlyRef: {
			path: "Knomo/2026-08.md",
			dateHeading: "## 2026-08-22",
			lastKnownBlock: input.rawBlock,
			lastKnownHash: hashText(input.rawBlock),
			lineNumberHint: 2,
			lastSyncedAt: input.createdAt,
		},
		...(input.deletedAt === undefined ? {} : {
			deletedAt: input.deletedAt,
			deleteSource: "plugin",
			deletedDailyBlock: input.rawBlock,
			deletedMonthlyBlock: input.rawBlock,
		}),
	};
}
