import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

interface ParityMemo {
	memoId: string;
	dailyPath: string;
	createdAt: string;
	content: string;
	tags: string[];
	imageLinks: string[];
	taskCount: number;
	references: string[];
	status: "active" | "recoverableDeleted";
	deletedAt?: string;
	review: {
		reviewCount: number;
		lastReviewedAt: string | null;
	};
}

interface ParityFixture {
	schemaVersion: number;
	baselineVersion: string;
	today: string;
	memos: ParityMemo[];
	expectations: {
		substringSearch: Record<string, string[]>;
		tagFilters: Record<string, string[]>;
		librarySummary: {
			memoCount: number;
			tagCount: number;
			imageCount: number;
			taskCount: number;
			referenceCount: number;
			reviewedMemoCount: number;
		};
		historicalSameDayReview: string[];
		recordStatsDrilldowns: {
			withTag: string[];
			withoutTag: string[];
			withImage: string[];
			withTask: string[];
			withReference: string[];
			busiestDailyPaths: string[];
		};
		trash: string[];
		randomReview: {
			memoId: string;
			reviewCountBeforeOpen: number;
			reviewCountAfterSuccessfulOpen: number;
		};
	};
	intentionalDifferences: {
		monthlyLocaleSource: string;
		randomReviewTrigger: string;
		trashPermanentPurge: boolean;
		timeBuoyManualRebuild: boolean;
		monthlyExcludeDefault: boolean;
		legacyCleanup: string;
	};
}

const fixture = JSON.parse(fs.readFileSync("tests/fixtures/catalog/compat-1.2.9.json", "utf8")) as ParityFixture;

test("1.2.9 用户行为 fixture 内部一致并覆盖关键内容类型", () => {
	assert.equal(fixture.schemaVersion, 1);
	assert.equal(fixture.baselineVersion, "1.2.9");
	assert.match(fixture.today, /^\d{4}-\d{2}-\d{2}$/u);

	const memoIds = fixture.memos.map((memo) => memo.memoId);
	assert.equal(new Set(memoIds).size, memoIds.length);
	assert.equal(memoIds.every((memoId) => /^\d{16}$/u.test(memoId)), true);
	assert.equal(fixture.memos.some((memo) => /[\u3400-\u9fff]/u.test(memo.content)), true);
	assert.equal(fixture.memos.some((memo) => /[A-Za-z]/u.test(memo.content)), true);
	assert.equal(fixture.memos.some((memo) => /\d/u.test(memo.content)), true);
	assert.equal(fixture.memos.some((memo) => memo.tags.some((tag) => tag.includes("/"))), true);
	assert.equal(fixture.memos.some((memo) => memo.imageLinks.length > 0), true);
	assert.equal(fixture.memos.some((memo) => memo.taskCount > 0), true);
	assert.equal(fixture.memos.some((memo) => memo.references.length > 0), true);
	assert.equal(fixture.memos.some((memo) => memo.status === "recoverableDeleted"), true);
	assert.equal(fixture.memos.some((memo) => memo.review.reviewCount > 0), true);
});

test("1.2.9 搜索、父标签、回顾和全库统计期望可从同一 fixture 推导", () => {
	const activeMemos = fixture.memos.filter((memo) => memo.status === "active");

	for (const [query, expectedMemoIds] of Object.entries(fixture.expectations.substringSearch)) {
		assert.deepEqual(sortMemoIds(activeMemos.filter((memo) => memo.content.toLowerCase().includes(query.toLowerCase()))), expectedMemoIds);
	}
	for (const [selectedTag, expectedMemoIds] of Object.entries(fixture.expectations.tagFilters)) {
		assert.deepEqual(sortMemoIds(activeMemos.filter((memo) => memo.tags.some((tag) => tag === selectedTag || tag.startsWith(`${selectedTag}/`)))), expectedMemoIds);
	}

	assert.deepEqual(buildLibrarySummary(activeMemos), fixture.expectations.librarySummary);
	assert.deepEqual(getHistoricalSameDayMemoIds(activeMemos, fixture.today), fixture.expectations.historicalSameDayReview);
	assert.deepEqual(buildRecordStatsDrilldowns(activeMemos), fixture.expectations.recordStatsDrilldowns);
	assert.deepEqual(sortMemoIds(fixture.memos.filter((memo) => memo.status === "recoverableDeleted")), fixture.expectations.trash);

	const randomMemo = fixture.memos.find((memo) => memo.memoId === fixture.expectations.randomReview.memoId);
	assert.notEqual(randomMemo, undefined);
	assert.equal(randomMemo?.review.reviewCount, fixture.expectations.randomReview.reviewCountBeforeOpen);
	assert.equal(fixture.expectations.randomReview.reviewCountAfterSuccessfulOpen, fixture.expectations.randomReview.reviewCountBeforeOpen + 1);
});

test("Catalog 协议和验收矩阵冻结批次 0 的产品决策", () => {
	const protocol = fs.readFileSync("architecture/catalog/protocol.md", "utf8");
	const acceptance = fs.readFileSync("architecture/catalog/acceptance.md", "utf8");
	const requiredAcceptanceIds = [
		"CAT-MIG-007",
		"CAT-PURGE-001",
		"CAT-LOCALE-001",
		"CAT-EXCLUDE-001",
		"CAT-QUERY-001",
		"CAT-QUERY-002",
		"CAT-TAG-001",
		"CAT-PAGE-001",
		"CAT-SUMMARY-001",
		"CAT-REVIEW-001",
		"CAT-RANDOM-001",
		"CAT-STATS-001",
		"CAT-RANGE-001",
		"CAT-TIMEBUOY-001",
		"CAT-A11Y-001",
		"CAT-LIFECYCLE-001",
	];

	for (const acceptanceId of requiredAcceptanceIds) {
		assert.equal(acceptance.includes(`| ${acceptanceId} |`), true, `${acceptanceId} must remain in the acceptance matrix.`);
	}
	assert.equal(protocol.includes("Monthly 标题及其他 locale 相关输出只使用共享配置中的 `locale`"), true);
	assert.equal(protocol.includes("自动为对应 `memoId` 追加一次 review"), true);
	assert.equal(protocol.includes("不提供专属手动重建入口"), true);
	assert.equal(protocol.includes("不自动删除目录或旧 Monthly 文件"), true);
	assert.equal(protocol.includes("永久清理不得再次修改 Daily"), true);
	assert.equal(protocol.includes("purge tombstone 不携带正文"), true);
	assert.equal(protocol.includes("随机卡片不再提供手动“标记已回顾”"), true);
	assert.deepEqual(fixture.intentionalDifferences, {
		monthlyLocaleSource: "shared-config",
		randomReviewTrigger: "successful-card-open",
		trashPermanentPurge: true,
		timeBuoyManualRebuild: false,
		monthlyExcludeDefault: true,
		legacyCleanup: "prompt-user-delete-after-verified-migration",
	});
});

function sortMemoIds(memos: readonly ParityMemo[]): string[] {
	return [...memos]
		.sort((left, right) => right.createdAt.localeCompare(left.createdAt))
		.map((memo) => memo.memoId);
}

function buildLibrarySummary(memos: readonly ParityMemo[]): ParityFixture["expectations"]["librarySummary"] {
	return {
		memoCount: memos.length,
		tagCount: new Set(memos.flatMap((memo) => memo.tags)).size,
		imageCount: memos.reduce((sum, memo) => sum + memo.imageLinks.length, 0),
		taskCount: memos.reduce((sum, memo) => sum + memo.taskCount, 0),
		referenceCount: memos.reduce((sum, memo) => sum + memo.references.length, 0),
		reviewedMemoCount: memos.filter((memo) => memo.review.reviewCount > 0).length,
	};
}

function getHistoricalSameDayMemoIds(memos: readonly ParityMemo[], today: string): string[] {
	const todayDay = today.slice(8, 10);
	return sortMemoIds(memos.filter((memo) => memo.createdAt.slice(8, 10) === todayDay && memo.createdAt.slice(0, 10) !== today));
}

function buildRecordStatsDrilldowns(memos: readonly ParityMemo[]): ParityFixture["expectations"]["recordStatsDrilldowns"] {
	const dailyCounts = new Map<string, number>();
	for (const memo of memos) {
		dailyCounts.set(memo.dailyPath, (dailyCounts.get(memo.dailyPath) ?? 0) + 1);
	}
	const busiestCount = Math.max(...dailyCounts.values());
	return {
		withTag: sortMemoIds(memos.filter((memo) => memo.tags.length > 0)),
		withoutTag: sortMemoIds(memos.filter((memo) => memo.tags.length === 0)),
		withImage: sortMemoIds(memos.filter((memo) => memo.imageLinks.length > 0)),
		withTask: sortMemoIds(memos.filter((memo) => memo.taskCount > 0)),
		withReference: sortMemoIds(memos.filter((memo) => memo.references.length > 0)),
		busiestDailyPaths: [...dailyCounts.entries()]
			.filter(([, count]) => count === busiestCount)
			.map(([dailyPath]) => dailyPath)
			.sort(),
	};
}
