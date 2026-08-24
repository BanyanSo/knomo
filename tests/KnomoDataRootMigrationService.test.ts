import assert from "node:assert/strict";
import test from "node:test";

import {
	getIdentityLedgerRootPath,
	serializeIdentityLedgerSegment,
	sha256IdentityLedgerText,
} from "../src/services/IdentityLedgerProtocol";
import { IdentityLedgerService } from "../src/services/IdentityLedgerService";
import { KnomoDataRootMigrationService } from "../src/services/KnomoDataRootMigrationService";
import type { IdentityLedgerClaimEvent } from "../src/types/identityLedger";
import type { MemoObservation } from "../src/types/catalog";
import { InMemoryVault } from "./helpers/InMemoryVault";

const WRITER_A = "w_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const MEMO_A = "01991f40-7c00-7111-9111-111111111111";

test("首次设置动作只创建配置根下的最小 Identity Ledger", async () => {
	const vault = new InMemoryVault();
	let location = { knomoDataRoot: "Knomo", knomoDataRootConfigured: false };
	const ledger = createLedger(vault, () => location);
	await ledger.initialize();
	const migration = new KnomoDataRootMigrationService(
		vault.app,
		ledger,
		() => location,
		async (nextRoot) => { location = { knomoDataRoot: nextRoot, knomoDataRootConfigured: true }; },
	);

	const result = await migration.migrate("Custom/Knomo");
	const identityRoot = getIdentityLedgerRootPath("Custom/Knomo");

	assert.equal(result.status, "initialized");
	assert.deepEqual(location, { knomoDataRoot: "Custom/Knomo", knomoDataRootConfigured: true });
	assert.notEqual(vault.app.vault.getAbstractFileByPath(`${identityRoot}/writers`), null);
	assert.equal(vault.app.vault.getAbstractFileByPath(`${identityRoot}/events`), null);
	assert.equal(vault.app.vault.getAbstractFileByPath("Custom/Knomo/_knomo-data/catalog"), null);
	assert.equal(vault.app.vault.getAbstractFileByPath("Custom/Knomo/_knomo-data/schema"), null);
	assert.equal(vault.app.vault.getAbstractFileByPath("_knomo-identity"), null);
	assert.equal(ledger.getStatus(), "absent");
});

test("显式迁移复制并验证全部事件，切换后 memoId、关系和 review 不变", async () => {
	const dailyPath = "Daily/2026-08-22.md";
	const vault = new InMemoryVault({ [dailyPath]: "## Memos\n- 09:00 正文\n" });
	let location = { knomoDataRoot: "Knomo-A", knomoDataRootConfigured: false };
	const ledger = createLedger(vault, () => location);
	const commits: string[] = [];
	const migration = new KnomoDataRootMigrationService(
		vault.app,
		ledger,
		() => location,
		async (nextRoot) => {
			commits.push(nextRoot);
			location = { knomoDataRoot: nextRoot, knomoDataRootConfigured: true };
		},
	);
	await migration.migrate("Knomo-A");
	const observation = makeObservation(dailyPath);
	const plan = await ledger.beginCreate({
		targetPath: dailyPath,
		logicalDate: observation.logicalDate,
		time: observation.time,
		contentHash: observation.contentHash,
		sourceMemoId: "01991f40-7c00-7222-a222-222222222222",
	});
	const binding = await ledger.finishCreate(plan, observation);
	await ledger.recordReview(binding, "2026-08-22T03:00:00.000Z");
	const expected = ledger.getSnapshot();
	const dailyBefore = vault.read(dailyPath);
	const sourceRoot = getIdentityLedgerRootPath("Knomo-A");
	const sourcePaths = vault.paths().filter((path) => path.startsWith(`${sourceRoot}/`));

	const result = await migration.migrate("Knomo-B");
	const targetRoot = getIdentityLedgerRootPath("Knomo-B");

	assert.equal(result.status, "migrated");
	assert.deepEqual(commits, ["Knomo-A", "Knomo-B"]);
	assert.equal(location.knomoDataRoot, "Knomo-B");
	assert.equal(ledger.resolveObservation(observation)?.memoId, MEMO_A);
	assert.deepEqual(ledger.getSnapshot(), expected);
	assert.equal(ledger.getSourceMemoId(MEMO_A), "01991f40-7c00-7222-a222-222222222222");
	assert.deepEqual(ledger.getReviewState(MEMO_A), {
		reviewCount: 1,
		lastReviewedAt: "2026-08-22T03:00:00.000Z",
	});
	for (const sourcePath of sourcePaths) {
		assert.equal(vault.read(sourcePath), vault.read(`${targetRoot}${sourcePath.slice(sourceRoot.length)}`));
	}
	assert.equal(vault.read(dailyPath), dailyBefore);
});

test("手动移动但未改配置时不搜索，用户明确选择目标后才采用", async () => {
	const observation = makeObservation("Daily/2026-08-22.md");
	const claim = makeClaim(observation);
	const content = serializeIdentityLedgerSegment([claim]);
	const digest = await sha256IdentityLedgerText(content);
	const targetRoot = getIdentityLedgerRootPath("Knomo-B");
	const targetPath = `${targetRoot}/writers/${WRITER_A}/segments/segment-${claim.eventId}-${digest}.jsonl`;
	const vault = new InMemoryVault({ [targetPath]: content });
	let location = { knomoDataRoot: "Knomo-A", knomoDataRootConfigured: true };
	const ledger = createLedger(vault, () => location);
	await ledger.initialize();

	assert.equal(ledger.getStatus(), "missing");
	assert.equal(ledger.resolveObservation(observation), null);

	const migration = new KnomoDataRootMigrationService(
		vault.app,
		ledger,
		() => location,
		async (nextRoot) => { location = { knomoDataRoot: nextRoot, knomoDataRootConfigured: true }; },
	);
	const result = await migration.migrate("Knomo-B");

	assert.equal(result.status, "adopted");
	assert.equal(location.knomoDataRoot, "Knomo-B");
	assert.equal(ledger.resolveObservation(observation)?.memoId, MEMO_A);
});

test("已配置根丢失时不创建新 Ledger，也不切换配置", async () => {
	const vault = new InMemoryVault({ "Daily/2026-08-22.md": "## Memos\n" });
	let location = { knomoDataRoot: "Knomo-A", knomoDataRootConfigured: true };
	const ledger = createLedger(vault, () => location);
	await ledger.initialize();
	let commitCount = 0;
	const migration = new KnomoDataRootMigrationService(
		vault.app,
		ledger,
		() => location,
		async (nextRoot) => {
			commitCount += 1;
			location = { knomoDataRoot: nextRoot, knomoDataRootConfigured: true };
		},
	);

	await assert.rejects(() => migration.migrate("Knomo-A"), /configured Identity Ledger root is missing/u);

	assert.equal(commitCount, 0);
	assert.equal(vault.app.vault.getAbstractFileByPath(getIdentityLedgerRootPath("Knomo-A")), null);
	assert.equal(vault.read("Daily/2026-08-22.md"), "## Memos\n");
});

test("目标存在冲突字节时验证失败，配置保持旧根", async () => {
	const vault = new InMemoryVault();
	let location = { knomoDataRoot: "Knomo-A", knomoDataRootConfigured: false };
	const ledger = createLedger(vault, () => location);
	const migration = new KnomoDataRootMigrationService(
		vault.app,
		ledger,
		() => location,
		async (nextRoot) => { location = { knomoDataRoot: nextRoot, knomoDataRootConfigured: true }; },
	);
	await migration.migrate("Knomo-A");
	const observation = makeObservation("Daily/2026-08-22.md");
	await ledger.finishCreate(await ledger.beginCreate({
		targetPath: observation.sourcePath,
		logicalDate: observation.logicalDate,
		time: observation.time,
		contentHash: observation.contentHash,
		sourceMemoId: null,
	}), observation);
	const sourceRoot = getIdentityLedgerRootPath("Knomo-A");
	const sourcePath = vault.paths().find((path) => path.startsWith(`${sourceRoot}/`));
	assert.notEqual(sourcePath, undefined);
	const targetRoot = getIdentityLedgerRootPath("Knomo-B");
	const targetPath = `${targetRoot}${(sourcePath as string).slice(sourceRoot.length)}`;
	await vault.app.vault.create(targetPath, "conflicting bytes\n");

	await assert.rejects(() => migration.migrate("Knomo-B"), /target contains conflicting Identity Ledger bytes/u);

	assert.equal(location.knomoDataRoot, "Knomo-A");
	assert.equal(ledger.resolveObservation(observation)?.memoId, MEMO_A);
});

test("数据根迁移拒绝互相嵌套的源目录和目标目录", async () => {
	const vault = new InMemoryVault();
	let location = { knomoDataRoot: "Knomo-A", knomoDataRootConfigured: false };
	const ledger = createLedger(vault, () => location);
	const migration = new KnomoDataRootMigrationService(
		vault.app,
		ledger,
		() => location,
		async (nextRoot) => { location = { knomoDataRoot: nextRoot, knomoDataRootConfigured: true }; },
	);
	await migration.migrate("Knomo-A");

	await assert.rejects(
		() => migration.migrate("Knomo-A/Nested"),
		/nested source and target roots/u,
	);
	assert.equal(location.knomoDataRoot, "Knomo-A");
});

test("复制期间源 Ledger 发生变化时不切换配置", async () => {
	const vault = new InMemoryVault();
	let location = { knomoDataRoot: "Knomo-A", knomoDataRootConfigured: false };
	const ledger = createLedger(vault, () => location);
	const migration = new KnomoDataRootMigrationService(
		vault.app,
		ledger,
		() => location,
		async (nextRoot) => { location = { knomoDataRoot: nextRoot, knomoDataRootConfigured: true }; },
	);
	await migration.migrate("Knomo-A");
	const observation = makeObservation("Daily/2026-08-22.md");
	await ledger.finishCreate(await ledger.beginCreate({
		targetPath: observation.sourcePath,
		logicalDate: observation.logicalDate,
		time: observation.time,
		contentHash: observation.contentHash,
		sourceMemoId: null,
	}), observation);

	const sourceRoot = getIdentityLedgerRootPath("Knomo-A");
	const targetRoot = getIdentityLedgerRootPath("Knomo-B");
	const lateClaim = makeClaim(observation, eventId(99));
	const lateContent = serializeIdentityLedgerSegment([lateClaim]);
	const lateDigest = await sha256IdentityLedgerText(lateContent);
	const latePath = `${sourceRoot}/writers/${WRITER_A}/segments/segment-${lateClaim.eventId}-${lateDigest}.jsonl`;
	const writableVault = vault.app.vault as unknown as {
		create(path: string, content: string): Promise<unknown>;
	};
	const originalCreate = writableVault.create.bind(writableVault);
	let injected = false;
	writableVault.create = async (path, content) => {
		const created = await originalCreate(path, content);
		if (!injected && path.startsWith(`${targetRoot}/`)) {
			injected = true;
			await originalCreate(latePath, lateContent);
		}
		return created;
	};

	await assert.rejects(
		() => migration.migrate("Knomo-B"),
		/source changed during migration/u,
	);

	assert.equal(location.knomoDataRoot, "Knomo-A");
	assert.equal(vault.read(latePath), lateContent);
});

function createLedger(
	vault: InMemoryVault,
	getLocation: () => { knomoDataRoot: string; knomoDataRootConfigured: boolean },
): IdentityLedgerService {
	let eventIndex = 0;
	return new IdentityLedgerService(vault.app, {
		getRootPath: () => {
			const location = getLocation();
			return location.knomoDataRootConfigured
				? getIdentityLedgerRootPath(location.knomoDataRoot)
				: null;
		},
		getWriterId: async () => WRITER_A,
		createMemoId: () => MEMO_A,
		createEventId: () => eventId(++eventIndex),
		now: () => new Date("2026-08-22T00:00:00.000Z"),
	});
}

function makeObservation(sourcePath: string): MemoObservation {
	return {
		sourcePath,
		sourceRevision: "a".repeat(64),
		rawBlockHash: "fnv1a-00000001",
		logicalDate: "2026-08-22",
		section: "## Memos",
		startLine: 1,
		endLine: 1,
		time: "09:00",
		content: "正文",
		contentHash: "fnv1a-12345678",
		existingBlockId: null,
		tags: [],
		links: [],
		images: [],
		tasks: [],
		timeBuoyDates: [],
	};
}

function makeClaim(observation: MemoObservation, claimEventId = eventId(1)): IdentityLedgerClaimEvent {
	return {
		schemaVersion: 1,
		eventId: claimEventId,
		writerId: WRITER_A,
		memoId: MEMO_A,
		type: "claim",
		baseBindingId: null,
		occurredAt: "2026-08-22T00:00:00.000Z",
		evidence: {
			observation: {
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
			createIntentEventId: null,
		},
	};
}

function eventId(index: number): string {
	return `e_${index.toString(16).padStart(32, "0")}`;
}
