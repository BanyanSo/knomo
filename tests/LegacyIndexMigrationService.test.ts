import assert from "node:assert/strict";
import test from "node:test";

import { IdentityLedgerService } from "../src/services/IdentityLedgerService";
import {
	canonicalIdentityLedgerJson,
	createIdentityLedgerMemoId,
	getIdentityLedgerRootPath,
	sha256IdentityLedgerText,
} from "../src/services/IdentityLedgerProtocol";
import { LegacyIndexMigrationService } from "../src/services/LegacyIndexMigrationService";
import { LegacyIndexReader } from "../src/services/LegacyIndexReader";
import { LowPriorityWorkQueue } from "../src/services/LowPriorityWorkQueue";
import { InMemoryMemoCatalogStore } from "../src/services/MemoCatalogStore";
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
	const reader = new LegacyIndexReader(vault.app, "knomo", () => "Knomo");
	const completionStore = new InMemoryMemoCatalogStore();
	let sourceLoadCount = 0;
	let observationBatchReadCount = 0;
	const source = {
		inspect: () => reader.inspect(),
		isSourcePath: (path: string) => reader.isSourcePath(path),
		load: async () => {
			sourceLoadCount += 1;
			return reader.load();
		},
	};
	const migration = new LegacyIndexMigrationService(vault.app, source, target, {
		getCatalogCoverage: async () => completeCoverage(),
		getObservationBatches: async () => {
			observationBatchReadCount += 1;
			return [{
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
			}];
		},
		completionStore,
	});
	const sourceBytesBefore = {
		daily: vault.read(dailyPath),
		index: vault.read(LEGACY_INDEX_PATH),
		pluginData: vault.read(PLUGIN_DATA_PATH),
	};

	const first = await migration.run();
	const second = await migration.run();
	const unchangedSourceEvent = await migration.run({ sourceChanged: true });

	assert.equal(first.status, "ready");
	assert.deepEqual(first.cleanupCandidate, {
		legacySystemRoot: "Knomo/_knomo-system",
		sourceRevision: first.sourceRevision,
	});
	assert.equal(first.importedEventCount, 7);
	assert.equal(second.importedEventCount, 0);
	assert.equal(unchangedSourceEvent.importedEventCount, 0);
	assert.equal(sourceLoadCount, 3);
	assert.equal(observationBatchReadCount, 1);
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

	const retainedTarget = createIdentityService(vault);
	await retainedTarget.initialize();
	let retainedSourceLoadCount = 0;
	let retainedObservationBatchReadCount = 0;
	const retainedMigration = new LegacyIndexMigrationService(vault.app, {
		inspect: () => reader.inspect(),
		isSourcePath: (path) => reader.isSourcePath(path),
		load: async () => {
			retainedSourceLoadCount += 1;
			return reader.load();
		},
	}, retainedTarget, {
		getCatalogCoverage: async () => completeCoverage(),
		getObservationBatches: async () => {
			retainedObservationBatchReadCount += 1;
			return [];
		},
		completionStore,
	});
	const retainedReport = await retainedMigration.run();
	assert.equal(retainedReport.status, "ready");
	assert.equal(retainedReport.sourceRevision, first.sourceRevision);
	assert.equal(retainedReport.importedEventCount, 0);
	assert.deepEqual(retainedReport.importedMemoIds, [LEGACY_MEMO_B, LEGACY_MEMO_A].sort());
	assert.equal(retainedSourceLoadCount, 0);
	assert.equal(retainedObservationBatchReadCount, 0);
	vault.replace(PLUGIN_DATA_PATH, JSON.stringify({
		settings: {},
		randomReunionReviewStates: {
			[LEGACY_MEMO_A]: {
				memoId: LEGACY_MEMO_A,
				reviewCount: 3,
				lastReviewedAt: "2026-08-22T05:00:00.000Z",
			},
		},
	}));
	const changedReport = await retainedMigration.run({ sourceChanged: true });
	assert.equal(changedReport.status, "partial");
	assert.equal(retainedSourceLoadCount, 1);
	assert.equal(retainedObservationBatchReadCount, 1);

	const restartedVault = new InMemoryVault(Object.fromEntries(
		Object.entries(vault.snapshot()).filter(([path]) => !path.startsWith("Knomo/_knomo-system/")),
	));
	const restartedTarget = createIdentityService(restartedVault);
	await restartedTarget.initialize();
	const restartedMigration = new LegacyIndexMigrationService(
		restartedVault.app,
		new LegacyIndexReader(restartedVault.app, "knomo", () => "Knomo"),
		restartedTarget,
		{ getCatalogCoverage: async () => completeCoverage(), getObservationBatches: async () => [] },
	);
	assert.equal((await restartedMigration.run()).status, "not_applicable");
	assert.equal(restartedTarget.resolveObservation(observation)?.memoId, LEGACY_MEMO_A);
	assert.deepEqual(restartedTarget.getReviewState(LEGACY_MEMO_A), {
		reviewCount: 2,
		lastReviewedAt: "2026-08-22T05:00:00.000Z",
	});
	assert.equal(restartedTarget.getActiveDeletes()[0]?.memoId, LEGACY_MEMO_B);
});

test("停止统一队列会取消 active 旧版升级且不持久化 Identity", async () => {
	const dailyPath = "Daily/2026-08-22.md";
	const rawBlock = "- 09:00 正文";
	const vault = new InMemoryVault({
		[dailyPath]: `## Memos\n${rawBlock}\n`,
		[LEGACY_INDEX_PATH]: JSON.stringify({
			schemaVersion: 2,
			period: "2026-08",
			memos: {
				[LEGACY_MEMO_A]: legacyMemoRecord({
					memoId: LEGACY_MEMO_A,
					createdAt: "2026-08-22T09:00:00.000Z",
					path: dailyPath,
					rawBlock,
					content: "正文",
				}),
			},
		}),
	});
	await vault.app.vault.createFolder(IDENTITY_ROOT);
	await vault.app.vault.createFolder(`${IDENTITY_ROOT}/writers`);
	const target = createIdentityService(vault);
	await target.initialize();
	const observation = makeObservation(dailyPath, rawBlock, "正文");
	const workQueue = new LowPriorityWorkQueue(() => ({
		setTimeout: (callback, delay) => globalThis.setTimeout(callback, delay) as unknown as number,
		clearTimeout: (timer) => globalThis.clearTimeout(timer as unknown as NodeJS.Timeout),
	}));
	let releaseBatches = (): void => undefined;
	const batchesGate = new Promise<void>((resolve) => { releaseBatches = resolve; });
	let markBatchesStarted = (): void => undefined;
	const batchesStarted = new Promise<void>((resolve) => { markBatchesStarted = resolve; });
	const migration = new LegacyIndexMigrationService(
		vault.app,
		new LegacyIndexReader(vault.app, "knomo", () => "Knomo"),
		target,
		{
			getCatalogCoverage: async () => completeCoverage(),
			getObservationBatches: async () => {
				markBatchesStarted();
				await batchesGate;
				return [{
					file: {
						sourcePath: dailyPath,
						logicalDate: observation.logicalDate,
						sourceRevision: observation.sourceRevision,
						mtime: 0,
						size: rawBlock.length,
						parserVersion: 3,
						settingsFingerprint: "test",
						observationCount: 1,
						auditedAt: 0,
					},
					observations: [observation],
					catalogRevision: 1,
				}];
			},
			workQueue,
		},
	);
	const running = migration.run();
	await batchesStarted;

	workQueue.stop();
	releaseBatches();

	await assert.rejects(running, /stopped/u);
	assert.equal(vault.paths().filter((path) => path.endsWith(".jsonl")).length, 0);
});

test("旧目录存在但 Catalog 未完成时只等待 Daily 扫描，不读取旧文件或 observation", async () => {
	const vault = new InMemoryVault({
		[LEGACY_INDEX_PATH]: JSON.stringify({ schemaVersion: 2, period: "2026-08", memos: {} }),
	});
	await vault.app.vault.createFolder(IDENTITY_ROOT);
	await vault.app.vault.createFolder(`${IDENTITY_ROOT}/writers`);
	const target = createIdentityService(vault);
	await target.initialize();
	const reader = new LegacyIndexReader(vault.app, "knomo", () => "Knomo");
	let sourceLoadCount = 0;
	let observationBatchReadCount = 0;
	const migration = new LegacyIndexMigrationService(vault.app, {
		inspect: () => reader.inspect(),
		isSourcePath: (path) => reader.isSourcePath(path),
		load: async () => {
			sourceLoadCount += 1;
			return reader.load();
		},
	}, target, {
		getCatalogCoverage: async () => ({ ...completeCoverage(), kind: "partial" }),
		getObservationBatches: async () => {
			observationBatchReadCount += 1;
			return [];
		},
	});

	const report = await migration.run();

	assert.equal(report.status, "waiting_catalog");
	assert.equal(sourceLoadCount, 0);
	assert.equal(observationBatchReadCount, 0);
});

test("Knomo 初始化未完成时等待初始化，不读取 Catalog、旧文件或 observation", async () => {
	const vault = new InMemoryVault({
		[LEGACY_INDEX_PATH]: JSON.stringify({ schemaVersion: 2, period: "2026-08", memos: {} }),
	});
	const reader = new LegacyIndexReader(vault.app, "knomo", () => "Knomo");
	const target = createIdentityService(vault);
	await target.initialize();
	let coverageReadCount = 0;
	let sourceLoadCount = 0;
	let observationBatchReadCount = 0;
	const migration = new LegacyIndexMigrationService(vault.app, {
		inspect: () => reader.inspect(),
		isSourcePath: (path) => reader.isSourcePath(path),
		load: async () => {
			sourceLoadCount += 1;
			return reader.load();
		},
	}, target, {
		isTargetReady: () => false,
		getCatalogCoverage: async () => {
			coverageReadCount += 1;
			return completeCoverage();
		},
		getObservationBatches: async () => {
			observationBatchReadCount += 1;
			return [];
		},
	});

	const report = await migration.run();

	assert.equal(report.status, "waiting_initialization");
	assert.equal(coverageReadCount, 0);
	assert.equal(sourceLoadCount, 0);
	assert.equal(observationBatchReadCount, 0);
});

test("从旧 monthlyMemoFolder 发现来源，并只审计合法空文件和派生产物", async () => {
	const oldRoot = "Old Memos";
	const vault = new InMemoryVault({
		[`${oldRoot}/_knomo-system/indexes/memo-index-2026-08.json`]: "",
		[`${oldRoot}/_knomo-system/pending-memo-creates.json`]: "",
		[`${oldRoot}/_knomo-system/indexes/memo-summary.json`]: "not-read",
		[`${oldRoot}/_knomo-system/indexes/time-buoy/time-buoy-2026-08 conflict.json`]: "not-read",
		[`${oldRoot}/_knomo-system/backups/rebuild-index-20260827-120000/indexes/memo-index-2026-08.json`]: "not-read",
		[`${oldRoot}/_knomo-system/backups/rebuild-monthly-2026-08-20260827-120000/monthly/2026-08.md`]: "not-read",
		[`${oldRoot}/_knomo-system/backups/time-buoy-rebuild-2026-08-27T12-00-00/time-buoy-2026-08.json`]: "not-read",
		[`${oldRoot}/_knomo-system/backups/monthly-format-1787891200000/indexes/memo-summary.json`]: "not-read",
		[`${oldRoot}/_knomo-system/backups/monthly-folder-1787891200000/monthly/nested/2026-08.md`]: "not-read",
	});
	const readBinary = vault.app.vault.readBinary.bind(vault.app.vault);
	const readPaths: string[] = [];
	vault.app.vault.readBinary = async (file) => {
		readPaths.push(file.path);
		return readBinary(file);
	};
	const reader = new LegacyIndexReader(vault.app, "knomo", () => oldRoot);

	assert.deepEqual(reader.inspect(), {
		kind: "present",
		legacySystemRoot: `${oldRoot}/_knomo-system`,
		sourceId: `legacy-index:${oldRoot}`,
	});
	const result = await reader.load();
	assert.equal(result.kind, "ready");
	if (result.kind !== "ready") return;
	assert.deepEqual(result.snapshot.memos, []);
	assert.deepEqual(result.snapshot.pendingMemos, []);
	assert.deepEqual(result.snapshot.reviews, []);
	assert.deepEqual(result.snapshot.diagnostics, []);
	assert.deepEqual(readPaths.sort(), [
		`${oldRoot}/_knomo-system/indexes/memo-index-2026-08.json`,
		`${oldRoot}/_knomo-system/pending-memo-creates.json`,
	].sort());
});

test("Legacy Index 的 createdAt 兜底按当前设备日历时区读取", async () => {
	const originalTimeZone = process.env.TZ;
	process.env.TZ = "Asia/Shanghai";
	try {
		const vault = new InMemoryVault({
			[LEGACY_INDEX_PATH]: JSON.stringify({
				schemaVersion: 2,
				period: "2026-08",
				memos: {
					[LEGACY_MEMO_A]: legacyMemoRecord({
						memoId: LEGACY_MEMO_A,
						createdAt: "2026-08-31T22:04:15.000Z",
						path: "Daily/legacy-memo.md",
						rawBlock: "- 正文",
						content: "正文",
					}),
				},
			}),
		});

		const result = await new LegacyIndexReader(vault.app, "knomo", () => "Knomo").load();
		assert.equal(result.kind, "ready");
		if (result.kind !== "ready") return;
		const memo = result.snapshot.memos.find((item) => item.memoId === LEGACY_MEMO_A);
		assert.equal(memo?.evidence.logicalDate, "2026-09-01");
		assert.equal(memo?.evidence.time, "06:04:15");
	} finally {
		if (originalTimeZone === undefined) delete process.env.TZ;
		else process.env.TZ = originalTimeZone;
	}
});

test("旧备份目录中的额外文件归类为 unknown", async () => {
	const extraPath = "Knomo/_knomo-system/backups/rebuild-index-20260827-120000/private-note.txt";
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
		"Knomo/_knomo-system/backups/rebuild-index-20260827-120000/indexes/memo-index-2026-08.json": "not-read",
		[extraPath]: "不要删除",
	});

	const result = await new LegacyIndexReader(vault.app, "knomo", () => "Knomo").load();

	assert.equal(result.kind, "ready");
	if (result.kind !== "ready") return;
	assert.equal(result.snapshot.diagnostics.some((item) => item.code === "legacy_inventory_unknown_file"
		&& item.sourcePath === extraPath), true);
});

test("旧记录通过一次 observation 查找索引匹配，并按时间预算主动让出事件循环", async () => {
	const recordCount = 20;
	const dailyPath = "Daily/2026-08-22.md";
	const memos: Record<string, unknown> = {};
	const observations: MemoObservation[] = [];
	let sourcePathReadCount = 0;
	for (let index = 0; index < recordCount; index += 1) {
		const memoId = `20260822${String(index).padStart(8, "0")}`;
		const content = `正文 ${index}`;
		const rawBlock = `- 14:26 ${content}`;
		memos[memoId] = legacyMemoRecord({
			memoId,
			createdAt: "2026-08-22T14:26:00.000Z",
			path: dailyPath,
			rawBlock,
			content,
		});
		const observation = {
			...makeObservation(dailyPath, rawBlock, content),
			time: "14:26",
			startLine: index + 1,
			endLine: index + 1,
		};
		Object.defineProperty(observation, "sourcePath", {
			enumerable: true,
			get: () => {
				sourcePathReadCount += 1;
				return dailyPath;
			},
		});
		observations.push(observation);
	}
	const vault = new InMemoryVault({
		[LEGACY_INDEX_PATH]: JSON.stringify({ schemaVersion: 2, period: "2026-08", memos }),
	});
	await vault.app.vault.createFolder(IDENTITY_ROOT);
	await vault.app.vault.createFolder(`${IDENTITY_ROOT}/writers`);
	const target = createIdentityService(vault);
	await target.initialize();
	let yieldCount = 0;
	let elapsedMs = 0;
	const migration = new LegacyIndexMigrationService(
		vault.app,
		new LegacyIndexReader(vault.app, "knomo", () => "Knomo"),
		target,
		{
			getCatalogCoverage: async () => completeCoverage(),
			getObservationBatches: async () => [{
				file: {
					sourcePath: dailyPath,
					logicalDate: "2026-08-22",
					sourceRevision: "a".repeat(64),
					mtime: 0,
					size: recordCount,
					parserVersion: 4,
					settingsFingerprint: "test",
					observationCount: observations.length,
					auditedAt: 0,
				},
				observations,
				catalogRevision: 1,
			}],
			yieldControl: async () => { yieldCount += 1; },
			sliceBudgetMs: 8,
			now: () => {
				elapsedMs += 3;
				return elapsedMs;
			},
		},
	);

	const report = await migration.run();

	assert.equal(report.status, "ready");
	assert.equal(report.importedMemoIds.length, recordCount);
	assert.equal(sourcePathReadCount < recordCount * 8, true);
	assert.equal(yieldCount > 2, true);
});

test("raw block hash 歧义时继续使用包含 section 的 tuple 唯一匹配", async () => {
	const dailyPath = "Daily/2026-08-22.md";
	const rawBlock = "- 09:00 相同正文";
	const vault = new InMemoryVault({
		[LEGACY_INDEX_PATH]: JSON.stringify({
			schemaVersion: 2,
			period: "2026-08",
			memos: {
				[LEGACY_MEMO_A]: legacyMemoRecord({
					memoId: LEGACY_MEMO_A,
					createdAt: "2026-08-22T09:00:00.000Z",
					path: dailyPath,
					rawBlock,
					content: "相同正文",
					section: "## 工作",
				}),
			},
		}),
	});
	await vault.app.vault.createFolder(IDENTITY_ROOT);
	await vault.app.vault.createFolder(`${IDENTITY_ROOT}/writers`);
	const target = createIdentityService(vault);
	await target.initialize();
	const workObservation = { ...makeObservation(dailyPath, rawBlock, "相同正文"), section: "## 工作" };
	const lifeObservation = { ...makeObservation(dailyPath, rawBlock, "相同正文"), section: "## 生活", startLine: 5, endLine: 5 };
	const migration = new LegacyIndexMigrationService(
		vault.app,
		new LegacyIndexReader(vault.app, "knomo", () => "Knomo"),
		target,
		{
			getCatalogCoverage: async () => completeCoverage(),
			getObservationBatches: async () => [{
				file: {
					sourcePath: dailyPath,
					logicalDate: workObservation.logicalDate,
					sourceRevision: workObservation.sourceRevision,
					mtime: 0,
					size: rawBlock.length * 2,
					parserVersion: 4,
					settingsFingerprint: "test",
					observationCount: 2,
					auditedAt: 0,
				},
				observations: [workObservation, lifeObservation],
				catalogRevision: 1,
			}],
		},
	);

	const report = await migration.run();

	assert.equal(report.status, "ready");
	assert.deepEqual(report.importedMemoIds, [LEGACY_MEMO_A]);
	assert.equal(target.resolveObservation(workObservation)?.memoId, LEGACY_MEMO_A);
	assert.equal(target.resolveObservation(lifeObservation), null);
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
			getCatalogCoverage: async () => completeCoverage(),
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
	assert.equal(report.cleanupCandidate, null);
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
		{ getCatalogCoverage: async () => completeCoverage(), getObservationBatches: async () => [] },
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

test("旧数据 sourceRevision 只反映语义内容，普通设置和提示记录不改变 revision", async () => {
	const reviewState = {
		[LEGACY_MEMO_A]: {
			memoId: LEGACY_MEMO_A,
			reviewCount: 2,
			lastReviewedAt: "2026-08-22T05:00:00.000Z",
		},
	};
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
		[PLUGIN_DATA_PATH]: JSON.stringify({ settings: { dailyHeading: "## Memos" }, randomReunionReviewStates: reviewState }),
	});
	const reader = new LegacyIndexReader(vault.app, "knomo", () => "Knomo");
	const before = await reader.load();
	vault.replace(PLUGIN_DATA_PATH, JSON.stringify({
		settings: { dailyHeading: "## Notes", mobileCompactMode: "on" },
		randomReunionReviewStates: reviewState,
		legacyMigrationNoticeSourceRevision: "already-shown",
	}));
	const afterSettingsSave = await reader.load();
	vault.replace(PLUGIN_DATA_PATH, JSON.stringify({
		settings: { dailyHeading: "## Notes", mobileCompactMode: "on" },
		randomReunionReviewStates: {
			[LEGACY_MEMO_A]: { ...reviewState[LEGACY_MEMO_A], reviewCount: 3 },
		},
	}));
	const afterLegacyChange = await reader.load();

	assert.equal(before.kind, "ready");
	assert.equal(afterSettingsSave.kind, "ready");
	assert.equal(afterLegacyChange.kind, "ready");
	if (before.kind !== "ready" || afterSettingsSave.kind !== "ready" || afterLegacyChange.kind !== "ready") return;
	assert.equal(before.snapshot.sourceRevision, await sha256IdentityLedgerText(canonicalIdentityLedgerJson({
		memos: before.snapshot.memos,
		pendingMemos: before.snapshot.pendingMemos,
		reviews: before.snapshot.reviews,
	})));
	assert.equal(afterSettingsSave.snapshot.sourceRevision, before.snapshot.sourceRevision);
	assert.notEqual(afterLegacyChange.snapshot.sourceRevision, before.snapshot.sourceRevision);
});

test("LegacyIndexReader 解析和合并按时间预算让出主线程", async () => {
	const memos = Object.fromEntries(Array.from({ length: 10 }, (_, index) => {
		const memoId = `202608220900${index.toString().padStart(4, "0")}`;
		return [memoId, legacyMemoRecord({
			memoId,
			createdAt: "2026-08-22T09:00:00.000Z",
			path: "Daily/2026-08-22.md",
			rawBlock: `- 09:00 memo-${index}`,
			content: `memo-${index}`,
		})];
	}));
	const vault = new InMemoryVault({
		[LEGACY_INDEX_PATH]: JSON.stringify({ schemaVersion: 2, period: "2026-08", memos }),
	});
	let elapsedMs = 0;
	let yieldCount = 0;

	const result = await new LegacyIndexReader(vault.app, "knomo", () => "Knomo").load({
		yieldControl: async () => { yieldCount += 1; },
		sliceBudgetMs: 8,
		now: () => {
			elapsedMs += 3;
			return elapsedMs;
		},
	});

	assert.equal(result.kind, "ready");
	assert.equal(yieldCount > 1, true);
});

test("LegacyIndexReader 在读取前响应取消信号", async () => {
	const vault = new InMemoryVault({
		[LEGACY_INDEX_PATH]: JSON.stringify({ schemaVersion: 2, period: "2026-08", memos: {} }),
	});
	const cancellation = new AbortController();
	cancellation.abort();

	await assert.rejects(
		() => new LegacyIndexReader(vault.app, "knomo", () => "Knomo").load({
			cancellationSignal: cancellation.signal,
			yieldControl: async () => {},
		}),
		/Legacy index load was cancelled/u,
	);
});

test("旧系统目录存在未知文件时保留诊断且不生成清理提示候选", async () => {
	const dailyPath = "Daily/2026-08-22.md";
	const rawBlock = "- 09:00 正文";
	const vault = new InMemoryVault({
		[dailyPath]: `## Memos\n${rawBlock}\n`,
		[LEGACY_INDEX_PATH]: JSON.stringify({
			schemaVersion: 2,
			period: "2026-08",
			memos: {
				[LEGACY_MEMO_A]: legacyMemoRecord({
					memoId: LEGACY_MEMO_A,
					createdAt: "2026-08-22T09:00:00.000Z",
					path: dailyPath,
					rawBlock,
					content: "正文",
				}),
			},
		}),
		"Knomo/_knomo-system/private-note.txt": "不要删除",
	});
	await vault.app.vault.createFolder(IDENTITY_ROOT);
	await vault.app.vault.createFolder(`${IDENTITY_ROOT}/writers`);
	const target = createIdentityService(vault);
	await target.initialize();
	const observation = makeObservation(dailyPath, rawBlock, "正文");
	const migration = new LegacyIndexMigrationService(
		vault.app,
		new LegacyIndexReader(vault.app, "knomo", () => "Knomo"),
		target,
		{
			getCatalogCoverage: async () => completeCoverage(),
			getObservationBatches: async () => [{
				file: {
					sourcePath: dailyPath,
					logicalDate: observation.logicalDate,
					sourceRevision: observation.sourceRevision,
					mtime: 0,
					size: rawBlock.length,
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
	assert.equal(report.cleanupCandidate, null);
	assert.equal(report.diagnostics.some((item) => item.code === "legacy_inventory_unknown_file"
		&& item.sourcePath === "Knomo/_knomo-system/private-note.txt"), true);
});

test("Catalog 未完整覆盖时旧版数据升级等待 Daily 扫描且不生成清理提示候选", async () => {
	const dailyPath = "Daily/2026-08-22.md";
	const rawBlock = "- 09:00 正文";
	const vault = new InMemoryVault({
		[dailyPath]: `## Memos\n${rawBlock}\n`,
		[LEGACY_INDEX_PATH]: JSON.stringify({
			schemaVersion: 2,
			period: "2026-08",
			memos: {
				[LEGACY_MEMO_A]: legacyMemoRecord({
					memoId: LEGACY_MEMO_A,
					createdAt: "2026-08-22T09:00:00.000Z",
					path: dailyPath,
					rawBlock,
					content: "正文",
				}),
			},
		}),
	});
	await vault.app.vault.createFolder(IDENTITY_ROOT);
	await vault.app.vault.createFolder(`${IDENTITY_ROOT}/writers`);
	const target = createIdentityService(vault);
	await target.initialize();
	const observation = makeObservation(dailyPath, rawBlock, "正文");
	const migration = new LegacyIndexMigrationService(
		vault.app,
		new LegacyIndexReader(vault.app, "knomo", () => "Knomo"),
		target,
		{
			getCatalogCoverage: async () => ({ ...completeCoverage(), kind: "partial" }),
			getObservationBatches: async () => [{
				file: {
					sourcePath: dailyPath,
					logicalDate: observation.logicalDate,
					sourceRevision: observation.sourceRevision,
					mtime: 0,
					size: rawBlock.length,
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

	assert.equal(report.status, "waiting_catalog");
	assert.equal(report.cleanupCandidate, null);
});

test("迁移后二次读取的旧数据 revision 变化时不生成清理提示候选", async () => {
	const dailyPath = "Daily/2026-08-22.md";
	const rawBlock = "- 09:00 正文";
	const vault = new InMemoryVault({
		[dailyPath]: `## Memos\n${rawBlock}\n`,
		[LEGACY_INDEX_PATH]: JSON.stringify({
			schemaVersion: 2,
			period: "2026-08",
			memos: {
				[LEGACY_MEMO_A]: legacyMemoRecord({
					memoId: LEGACY_MEMO_A,
					createdAt: "2026-08-22T09:00:00.000Z",
					path: dailyPath,
					rawBlock,
					content: "正文",
				}),
			},
		}),
	});
	await vault.app.vault.createFolder(IDENTITY_ROOT);
	await vault.app.vault.createFolder(`${IDENTITY_ROOT}/writers`);
	const target = createIdentityService(vault);
	await target.initialize();
	const observation = makeObservation(dailyPath, rawBlock, "正文");
	const reader = new LegacyIndexReader(vault.app, "knomo", () => "Knomo");
	let loadCount = 0;
	const changingSource = {
		inspect: () => reader.inspect(),
		isSourcePath: (path: string) => reader.isSourcePath(path),
		load: async () => {
			const result = await reader.load();
			loadCount += 1;
			if (loadCount !== 2 || result.kind !== "ready") return result;
			return {
				kind: "ready" as const,
				snapshot: { ...result.snapshot, sourceRevision: "f".repeat(64) },
			};
		},
	};
	const migration = new LegacyIndexMigrationService(vault.app, changingSource, target, {
		getCatalogCoverage: async () => completeCoverage(),
		getObservationBatches: async () => [{
			file: {
				sourcePath: dailyPath,
				logicalDate: observation.logicalDate,
				sourceRevision: observation.sourceRevision,
				mtime: 0,
				size: rawBlock.length,
				parserVersion: 3,
				settingsFingerprint: "test",
				observationCount: 1,
				auditedAt: 0,
			},
			observations: [observation],
			catalogRevision: 1,
		}],
	});

	const report = await migration.run();

	assert.equal(report.status, "attention");
	assert.equal(report.cleanupCandidate, null);
	assert.equal(report.diagnostics.some((item) => item.code === "legacy_source_changed_during_migration"), true);
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

function completeCoverage() {
	return {
		kind: "complete" as const,
		sharedConfigurationComplete: true,
		coveredFromDate: null,
		pendingFileCount: 0,
		coveredFileCount: 1,
		totalFileCount: 1,
	};
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
	section?: string;
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
			heading: input.section ?? "## Memos",
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
