import assert from "node:assert/strict";
import test from "node:test";
import { LegacyIndexReader } from "../src/services/LegacyIndexReader";
import { hashMemoContent, hashText } from "../src/utils/hash";
import { InMemoryVault } from "./helpers/InMemoryVault";
const LEGACY_MEMO_A = "2026082209000001";
const LEGACY_INDEX_PATH = "Knomo/_knomo-system/indexes/memo-index-2026-08.json";
const PLUGIN_DATA_PATH = ".obsidian/plugins/knomo/data.json";

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
	const reader = new LegacyIndexReader(vault.app, () => oldRoot);

	assert.deepEqual(reader.inspect(), {
		kind: "present",
		legacySystemRoot: `${oldRoot}/_knomo-system`,
		sourceId: `legacy-index:${oldRoot}`,
	});
	const result = await reader.load();
	assert.equal(result.kind, "ready");
	if (result.kind !== "ready") return;
	assert.deepEqual(result.snapshot.memos, []);
	assert.deepEqual(result.snapshot.diagnostics, []);
	assert.deepEqual(readPaths.sort(), [
		`${oldRoot}/_knomo-system/indexes/memo-index-2026-08.json`,
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
						content: "正文", status: "deleted",
					}),
				},
			}),
		});

		const result = await new LegacyIndexReader(vault.app, () => "Knomo").load();
		assert.equal(result.kind, "ready");
		if (result.kind !== "ready") return;
		const memo = result.snapshot.memos.find((item) => item.memoId === LEGACY_MEMO_A);
		assert.equal(memo?.deletedPayload?.logicalDate, "2026-09-01");
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

	const result = await new LegacyIndexReader(vault.app, () => "Knomo").load();

	assert.equal(result.kind, "ready");
	if (result.kind !== "ready") return;
	assert.equal(result.snapshot.diagnostics.some((item) => item.code === "legacy_inventory_unknown_file"
		&& item.sourcePath === extraPath), true);
});

test("同一旧 memoId 的不一致同步副本进入诊断，不覆盖恢复副本", async () => {
	const canonical = JSON.stringify({
		schemaVersion: 2,
		period: "2026-08",
		memos: {
			[LEGACY_MEMO_A]: legacyMemoRecord({
				memoId: LEGACY_MEMO_A,
				createdAt: "2026-08-22T09:00:00.000Z",
				path: "Daily/2026-08-22.md",
				rawBlock: "- 09:00 正文 A",
				content: "正文 A", status: "deleted",
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
				content: "正文 B", status: "deleted",
			}),
		},
	});
	const vault = new InMemoryVault({
		[LEGACY_INDEX_PATH]: canonical,
		"Knomo/_knomo-system/indexes/memo-index-2026-08 conflict.json": conflict,
	});
	const result = await new LegacyIndexReader(vault.app, () => "Knomo").load();

	assert.equal(result.kind, "attention");
	if (result.kind !== "attention") return;
	assert.equal(result.diagnostics.some((item) => item.code === "legacy_record_conflict" && item.memoId === LEGACY_MEMO_A), true);
});

test("未知旧 Index schema 进入诊断，不按 1.2.9 格式宽松解释", async () => {
	const vault = new InMemoryVault({
		[LEGACY_INDEX_PATH]: JSON.stringify({
			schemaVersion: 3,
			period: "2026-08",
			memos: {},
		}),
	});
	const result = await new LegacyIndexReader(vault.app, () => "Knomo").load();

	assert.equal(result.kind, "attention");
	if (result.kind !== "attention") return;
	assert.equal(result.diagnostics.some((item) => item.code === "legacy_memo_index_invalid"), true);
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

	const result = await new LegacyIndexReader(vault.app, () => "Knomo").load({
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
		() => new LegacyIndexReader(vault.app, () => "Knomo").load({
			cancellationSignal: cancellation.signal,
			yieldControl: async () => {},
		}),
		/Legacy index load was cancelled/u,
	);
});
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

test("迁移 reader 忽略历史关系、review 和 pending，不访问 metadata 或插件数据", async () => {
	const record = legacyMemoRecord({ memoId: LEGACY_MEMO_A, createdAt: "2026-08-22T09:00:00Z",
		path: "Daily/2026-08-22.md", rawBlock: "- 09:00 引用 [[missing#^block]]", content: "引用", status: "deleted" });
	const vault = new InMemoryVault({
		[LEGACY_INDEX_PATH]: JSON.stringify({ schemaVersion: 2, period: "2026-08", memos: { [LEGACY_MEMO_A]: record } }),
		[PLUGIN_DATA_PATH]: "invalid old review data",
		"Knomo/_knomo-system/pending-memo-creates.json": "invalid old journal",
	});
	Object.assign(vault.app, { metadataCache: { getFirstLinkpathDest: () => { throw new Error("No historical relation lookup"); } } });
	vault.app.vault.adapter.readBinary = async () => { throw new Error("No plugin data read"); };
	const reader = new LegacyIndexReader(vault.app, () => "Knomo");
	const first = await reader.load();
	assert.equal(first.kind, "ready");
	if (first.kind !== "ready") return;
	assert.deepEqual(first.snapshot.diagnostics, []);
	assert.deepEqual(Object.keys(first.snapshot.memos[0]!).sort(), ["deletedPayload", "memoId", "status"]);
	vault.replace(LEGACY_INDEX_PATH, JSON.stringify({ schemaVersion: 2, period: "2026-08",
		memos: { [LEGACY_MEMO_A]: { ...record, sourceMemoId: "invalid retired relation", references: [{ memoId: "other" }] } } }));
	const second = await reader.load();
	assert.equal(second.kind, "ready");
	if (second.kind === "ready") assert.deepEqual(second.snapshot, first.snapshot);
});
