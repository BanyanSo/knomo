import assert from "node:assert/strict";
import test from "node:test";
import { LegacyIndexReader } from "../src/services/LegacyIndexReader";
import { hashMemoContent, hashText } from "../src/utils/hash";
import { InMemoryVault } from "./helpers/InMemoryVault";
const LEGACY_MEMO_A = "2026082209000001";
const LEGACY_MEMO_B = "2026082108000002";
const LEGACY_MEMO_C = "2026082209000003";
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
