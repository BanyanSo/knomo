import assert from "node:assert/strict";
import test from "node:test";

import type { App } from "obsidian";

import { IdentityLedgerService } from "../src/services/IdentityLedgerService";
import { CatalogV3LegacyIdentityImporter } from "../src/services/CatalogV3LegacyIdentityImporter";
import {
	createIdentityLedgerMemoId,
	getIdentityLedgerSegmentPath,
	getIdentityLedgerRootPath,
	parseIdentityLedgerSegment,
	serializeIdentityLedgerSegment,
	sha256IdentityLedgerText,
} from "../src/services/IdentityLedgerProtocol";
import type {
	IdentityLedgerEvent,
	IdentityLedgerObservationEvidence,
} from "../src/types/identityLedger";
import type { MemoObservation } from "../src/types/catalog";
import type { CatalogFileRevisionBatch } from "../src/types/catalog";
import type { CatalogV2MaterializedState, DeletedMemoPayload, IdentityEvidence, StateOperation } from "../src/types/catalogV2";
import type { LegacyIdentitySource } from "../src/types/legacyIdentityImport";
import { CatalogV2ReplicaVault } from "./helpers/CatalogV2ReplicaVault";

const WRITER_A = "w_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const WRITER_B = "w_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const MEMO_A = "01991f40-7c00-7111-9111-111111111111";
const MEMO_B = "01991f40-7c00-7222-a222-222222222222";
const MEMO_C = "01991f40-7c00-7333-b333-333333333333";
const IDENTITY_ROOT_A = getIdentityLedgerRootPath("Knomo-A");
const IDENTITY_ROOT_B = getIdentityLedgerRootPath("Knomo-B");

test("P0 第 4 步：memoId 使用 UUIDv7 且不依赖 Vault、正文或 observation evidence", () => {
	const first = createIdentityLedgerMemoId(
		new Date("2026-08-22T00:00:00.000Z"),
		(target) => target.fill(0x11),
	);
	const second = createIdentityLedgerMemoId(
		new Date("2026-08-22T00:00:00.000Z"),
		(target) => target.fill(0x22),
	);

	assert.match(first, /^[a-f0-9]{8}-[a-f0-9]{4}-7[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u);
	assert.notEqual(first, second);
});

test("P0 第 4 步：Identity Ledger 只接受冻结的九种 V3 基础事件", async () => {
	const observation = makeEvidence(makeObservation("Daily/2026-08-22.md", "a".repeat(64), 1, "正文"));
	const base = {
		schemaVersion: 1 as const,
		writerId: WRITER_A,
		memoId: MEMO_A,
		occurredAt: "2026-08-22T00:00:00.000Z",
	};
	const events: IdentityLedgerEvent[] = [
		{
			...base,
			eventId: eventId(1),
			type: "create_intent",
			baseBindingId: null,
			evidence: {
				targetPath: observation.sourcePath,
				logicalDate: observation.logicalDate,
				time: observation.time,
				contentHash: observation.contentHash,
				sourceMemoId: null,
			},
		},
		{
			...base,
			eventId: eventId(2),
			type: "claim",
			baseBindingId: null,
			evidence: { observation, createIntentEventId: eventId(1) },
		},
		{
			...base,
			eventId: eventId(3),
			type: "rebind",
			baseBindingId: eventId(2),
			evidence: { observation, reason: "edit" },
		},
		{
			...base,
			eventId: eventId(4),
			type: "relation",
			baseBindingId: eventId(2),
			evidence: { sourceMemoId: MEMO_B },
		},
		{
			...base,
			eventId: eventId(5),
			type: "review",
			baseBindingId: eventId(2),
			evidence: { reviewedAt: "2026-08-22T01:00:00.000Z" },
		},
		{
			...base,
			eventId: eventId(6),
			type: "delete_payload",
			baseBindingId: eventId(2),
			evidence: {
				deletedAt: "2026-08-22T02:00:00.000Z",
				sourcePath: observation.sourcePath,
				deletedSourceRevision: "b".repeat(64),
				logicalDate: observation.logicalDate,
				section: observation.section,
				rawBlock: "- 09:00 正文",
				contentHash: observation.contentHash,
				sourceMemoId: null,
			},
		},
		{
			...base,
			eventId: eventId(7),
			type: "delete_commit",
			baseBindingId: eventId(2),
			evidence: { deleteEventId: eventId(6) },
		},
		{
			...base,
			eventId: eventId(8),
			type: "restore",
			baseBindingId: eventId(2),
			evidence: { observation, deleteEventId: eventId(6) },
		},
		{
			...base,
			eventId: eventId(9),
			type: "repair",
			baseBindingId: eventId(2),
			evidence: { observation },
		},
	];
	const content = serializeIdentityLedgerSegment(events);
	const digest = await sha256IdentityLedgerText(content);
	const parsed = await parseIdentityLedgerSegment(
		IDENTITY_ROOT_A,
		`${IDENTITY_ROOT_A}/writers/${WRITER_A}/segments/segment-${eventId(1)}-${digest}.jsonl`,
		content,
	);

	assert.deepEqual(parsed.events.map((item) => item.event.type), [
		"create_intent",
		"claim",
		"rebind",
		"relation",
		"review",
		"delete_payload",
		"delete_commit",
		"restore",
		"repair",
	]);
	const invalidContent = `${JSON.stringify({ ...base, eventId: eventId(10), type: "authority", baseBindingId: null, evidence: {} })}\n`;
	const invalidDigest = await sha256IdentityLedgerText(invalidContent);
	await assert.rejects(() => parseIdentityLedgerSegment(
		IDENTITY_ROOT_A,
		`${IDENTITY_ROOT_A}/writers/${WRITER_A}/segments/segment-${eventId(10)}-${invalidDigest}.jsonl`,
		invalidContent,
	), /Invalid Identity Ledger event/u);
});

test("V3-ORDER-002/004：create_intent 单独存在时不产生幽灵 memo", async () => {
	const vault = await createLedgerVault();
	const service = createService(vault, WRITER_A, [MEMO_A], [eventId(1)]);
	await service.initialize();
	const observation = makeObservation("Daily/2026-08-22.md", "a".repeat(64), 1, "正文");
	const plan = await service.beginCreate({
		targetPath: observation.sourcePath,
		logicalDate: observation.logicalDate,
		time: observation.time,
		contentHash: observation.contentHash,
		sourceMemoId: null,
	});

	assert.equal(plan.intentDurable, true);
	assert.equal(service.resolveObservation(observation), null);
	assert.equal(service.getSnapshot().pendingIntents.length, 1);
	assert.equal(vault.paths().every((path) => path.startsWith(`${IDENTITY_ROOT_A}/`)), true);
});

test("V3-ORDER-001/003：claim 后原 observation 原地获得 memoId 和关系", async () => {
	const vault = await createLedgerVault();
	const service = createService(vault, WRITER_A, [MEMO_A], [eventId(1), eventId(2), eventId(3)]);
	await service.initialize();
	const observation = makeObservation("Daily/2026-08-22.md", "a".repeat(64), 1, "正文");
	const plan = await service.beginCreate({
		targetPath: observation.sourcePath,
		logicalDate: observation.logicalDate,
		time: observation.time,
		contentHash: observation.contentHash,
		sourceMemoId: MEMO_B,
	});
	const binding = await service.finishCreate(plan, observation);

	assert.equal(binding.memoId, MEMO_A);
	assert.equal(service.resolveObservation(observation)?.memoId, MEMO_A);
	assert.equal(service.getSourceMemoId(MEMO_A), MEMO_B);
	assert.equal(service.getSnapshot().pendingIntents.length, 0);
});

test("V3-ORDER-007：重启后从 durable intent 安全续写唯一 claim，不重复 Daily mutation", async () => {
	const dailyPath = "Daily/2026-08-22.md";
	const vault = await createLedgerVault({ [dailyPath]: "## Memos\n- 09:00 正文\n" });
	const first = createService(vault, WRITER_A, [MEMO_A], [eventId(1)]);
	await first.initialize();
	const observation = makeObservation(dailyPath, "a".repeat(64), 1, "正文");
	await first.beginCreate({
		targetPath: dailyPath,
		logicalDate: observation.logicalDate,
		time: observation.time,
		contentHash: observation.contentHash,
		sourceMemoId: null,
	});
	const dailyBefore = vault.read(dailyPath);

	const restarted = createService(vault, WRITER_B, [], [eventId(2)]);
	await restarted.initialize();
	assert.equal(await restarted.reconcilePendingCreates([observation]), 1);

	assert.equal(vault.read(dailyPath), dailyBefore);
	assert.equal(restarted.resolveObservation(observation)?.memoId, MEMO_A);
});

test("P0 第 4 步：两台离线设备生成不同 memoId，事件任意合并后结果一致", async () => {
	const vaultA = await createLedgerVault();
	const vaultB = await createLedgerVault();
	const observationA = makeObservation("Daily/2026-08-22.md", "a".repeat(64), 1, "相同正文");
	const observationB = makeObservation("Daily/2026-08-23.md", "b".repeat(64), 1, "相同正文");
	const serviceA = createService(vaultA, WRITER_A, [MEMO_A], [eventId(1), eventId(2)]);
	const serviceB = createService(vaultB, WRITER_B, [MEMO_B], [eventId(3), eventId(4)]);
	await serviceA.initialize();
	await serviceB.initialize();
	await serviceA.finishCreate(await serviceA.beginCreate(createIntentInput(observationA)), observationA);
	await serviceB.finishCreate(await serviceB.beginCreate(createIntentInput(observationB)), observationB);

	const mergedAB = new CatalogV2ReplicaVault();
	mergedAB.deliverFrom(vaultA);
	mergedAB.deliverFrom(vaultB);
	const mergedBA = new CatalogV2ReplicaVault();
	mergedBA.deliverFrom(vaultB);
	mergedBA.deliverFrom(vaultA);
	const readerAB = createService(mergedAB, WRITER_A, [], []);
	const readerBA = createService(mergedBA, WRITER_B, [], []);
	await readerAB.initialize();
	await readerBA.initialize();

	assert.notEqual(MEMO_A, MEMO_B);
	assert.equal(readerAB.resolveObservation(observationA)?.memoId, MEMO_A);
	assert.equal(readerAB.resolveObservation(observationB)?.memoId, MEMO_B);
	assert.deepEqual(readerAB.getSnapshot(), readerBA.getSnapshot());
});

test("P0 第 4 步：删除本机 snapshot 后只从 immutable events 重建相同身份和关系", async () => {
	const dailyPath = "Daily/2026-08-22.md";
	const vault = await createLedgerVault({ [dailyPath]: "## Memos\n- 09:00 正文\n" });
	const observation = makeObservation(dailyPath, "a".repeat(64), 1, "正文");
	const writer = createService(vault, WRITER_A, [MEMO_A], [eventId(1), eventId(2), eventId(3), eventId(4)]);
	await writer.initialize();
	const plan = await writer.beginCreate({ ...createIntentInput(observation), sourceMemoId: MEMO_B });
	const binding = await writer.finishCreate(plan, observation);
	await writer.recordReview(binding, "2026-08-22T03:00:00.000Z");
	const expected = writer.getSnapshot();
	const dailyBefore = vault.read(dailyPath);

	const rebuilt = createService(vault, WRITER_B, [], []);
	await rebuilt.initialize();

	assert.deepEqual(rebuilt.getSnapshot(), expected);
	assert.equal(rebuilt.getSourceMemoId(MEMO_A), MEMO_B);
	assert.deepEqual(rebuilt.getReviewState(MEMO_A), {
		reviewCount: 1,
		lastReviewedAt: "2026-08-22T03:00:00.000Z",
	});
	assert.equal(vault.read(dailyPath), dailyBefore);
	assert.equal(vault.paths().some((path) => path.includes("/snapshots/")), false);
});

test("V3-FAIL-005：identity root 不可写时保留 create plan，但 claim 失败且不触碰 Daily", async () => {
	const dailyPath = "Daily/2026-08-22.md";
	const fixture = await createLedgerVault({ [dailyPath]: "## Memos\n" });
	const app = {
		...fixture.app,
		vault: {
			...fixture.app.vault,
			getAbstractFileByPath: fixture.app.vault.getAbstractFileByPath.bind(fixture.app.vault),
			createFolder: async () => { throw new Error("identity root unavailable"); },
			create: async () => { throw new Error("identity root unavailable"); },
		},
	} as unknown as App;
	const service = new IdentityLedgerService(app, {
		getRootPath: () => IDENTITY_ROOT_A,
		getWriterId: async () => WRITER_A,
		createMemoId: () => MEMO_A,
		createEventId: () => eventId(1),
		now: () => new Date("2026-08-22T00:00:00.000Z"),
	});
	await service.initialize();
	const observation = makeObservation(dailyPath, "a".repeat(64), 1, "正文");
	const before = fixture.read(dailyPath);
	const plan = await service.beginCreate(createIntentInput(observation));

	assert.equal(plan.memoId, MEMO_A);
	assert.equal(plan.intentDurable, false);
	assert.equal(service.getStatus(), "unavailable");
	await assert.rejects(() => service.finishCreate(plan, observation), /identity root unavailable/u);
	assert.equal(fixture.read(dailyPath), before);
});

test("V3-ROOT-001/004：只读取用户配置根，其他目录中的 identity 不参与启动", async () => {
	const sourceVault = await createLedgerVault({}, IDENTITY_ROOT_B);
	const source = createService(sourceVault, WRITER_B, [MEMO_B], [eventId(10), eventId(11)], () => IDENTITY_ROOT_B);
	await source.initialize();
	const observation = makeObservation("Daily/2026-08-23.md", "b".repeat(64), 1, "其他根正文");
	await source.finishCreate(await source.beginCreate(createIntentInput(observation)), observation);

	const vault = await createLedgerVault();
	vault.deliverFrom(sourceVault);
	const service = createService(vault, WRITER_A, [], [], () => IDENTITY_ROOT_A);
	await service.initialize();

	assert.equal(service.getStatus(), "absent");
	assert.equal(service.resolveObservation(observation), null);
	assert.equal(service.getSnapshot().eventCount, 0);
});

test("V3-ROOT-002/003：配置根缺失时不创建 identity，Daily 仍保持可用", async () => {
	const dailyPath = "Daily/2026-08-22.md";
	const vault = new CatalogV2ReplicaVault({ [dailyPath]: "## Memos\n- 09:00 正文\n" });
	const service = createService(vault, WRITER_A, [MEMO_A], [eventId(1)]);
	await service.initialize();
	const before = vault.snapshot();
	const observation = makeObservation(dailyPath, "a".repeat(64), 1, "正文");
	const plan = await service.beginCreate(createIntentInput(observation));

	assert.equal(service.getStatus(), "missing");
	assert.equal(plan.intentDurable, false);
	assert.deepEqual(vault.snapshot(), before);
	assert.equal(vault.read(dailyPath), "## Memos\n- 09:00 正文\n");
});

test("P1 第 5 步：完整 before/after revision 的唯一 successor 自动续接原 memoId", async () => {
	const vault = await createLedgerVault();
	const service = createService(vault, WRITER_A, [MEMO_A], [eventId(1), eventId(2), eventId(3)]);
	await service.initialize();
	const before = makeObservation("Daily/2026-08-22.md", "a".repeat(64), 1, "旧正文");
	const after = makeObservation("Daily/2026-08-22.md", "b".repeat(64), 1, "新正文");
	await service.finishCreate(await service.beginCreate(createIntentInput(before)), before);

	const result = await service.reconcileRevision([before], [after]);

	assert.deepEqual(result, { appendedEventCount: 1, conflictedMemoIds: [] });
	assert.equal(service.resolveObservation(after)?.memoId, MEMO_A);
	assert.equal(service.resolveObservation(before), null);
	const restarted = createService(vault, WRITER_B, [], []);
	await restarted.initialize();
	assert.equal(restarted.resolveObservation(after)?.memoId, MEMO_A);
});

test("P1 第 5 步：唯一内容锚点分隔出的多个一对一区间可以分别续接", async () => {
	const vault = await createLedgerVault();
	const service = createService(
		vault,
		WRITER_A,
		[MEMO_A, MEMO_C],
		[eventId(1), eventId(2), eventId(3), eventId(4), eventId(5), eventId(6)],
	);
	await service.initialize();
	const beforeA = makeObservation("Daily/2026-08-22.md", "a".repeat(64), 1, "正文 A");
	const anchorBefore = makeObservation("Daily/2026-08-22.md", "a".repeat(64), 2, "未修改锚点");
	const beforeC = makeObservation("Daily/2026-08-22.md", "a".repeat(64), 3, "正文 C");
	const afterA = makeObservation("Daily/2026-08-22.md", "b".repeat(64), 1, "正文 A 已编辑");
	const anchorAfter = makeObservation("Daily/2026-08-22.md", "b".repeat(64), 2, "未修改锚点");
	const afterC = makeObservation("Daily/2026-08-22.md", "b".repeat(64), 3, "正文 C 已编辑");
	await service.finishCreate(await service.beginCreate(createIntentInput(beforeA)), beforeA);
	await service.finishCreate(await service.beginCreate(createIntentInput(beforeC)), beforeC);

	const result = await service.reconcileRevision(
		[beforeA, anchorBefore, beforeC],
		[afterA, anchorAfter, afterC],
	);

	assert.equal(result.appendedEventCount, 2);
	assert.equal(service.resolveObservation(afterA)?.memoId, MEMO_A);
	assert.equal(service.resolveObservation(afterC)?.memoId, MEMO_C);
});

test("P1 第 5 步：一个 predecessor 出现两个 successor 时只形成该 memo 的局部冲突", async () => {
	const vault = await createLedgerVault();
	const service = createService(
		vault,
		WRITER_A,
		[MEMO_A, MEMO_C],
		[eventId(1), eventId(2), eventId(3), eventId(4), eventId(5), eventId(6), eventId(7)],
	);
	await service.initialize();
	const before = makeObservation("Daily/2026-08-22.md", "a".repeat(64), 1, "旧正文");
	const candidateA = makeObservation("Daily/2026-08-22.md", "b".repeat(64), 1, "候选 A");
	const candidateB = makeObservation("Daily/2026-08-22.md", "b".repeat(64), 3, "候选 B");
	const unrelated = makeObservation("Daily/2026-08-23.md", "c".repeat(64), 1, "无关正文");
	await service.finishCreate(await service.beginCreate(createIntentInput(before)), before);
	await service.finishCreate(await service.beginCreate(createIntentInput(unrelated)), unrelated);

	const result = await service.reconcileRevision([before], [candidateA, candidateB]);
	const conflict = service.resolveObservationState(candidateA);

	assert.deepEqual(result, { appendedEventCount: 2, conflictedMemoIds: [MEMO_A] });
	assert.equal(conflict.kind, "conflicted");
	assert.deepEqual(conflict.kind === "conflicted" ? conflict.memoIds : [], [MEMO_A]);
	assert.equal(service.resolveObservation(candidateA), null);
	assert.equal(service.resolveObservation(unrelated)?.memoId, MEMO_C);
	assert.equal(service.getStatus(), "ready");
	const unrelatedBinding = service.resolveObservation(unrelated);
	assert.notEqual(unrelatedBinding, null);
	await service.recordReview(unrelatedBinding!, "2026-08-22T04:00:00.000Z");
	assert.equal(service.getReviewState(MEMO_C).reviewCount, 1);
});

test("P1 第 5 步：并发同 successor 折叠，不同 successor 保持分叉且不采用最后写入者", async () => {
	const baseVault = await createLedgerVault();
	const base = createService(baseVault, WRITER_A, [MEMO_A], [eventId(1), eventId(2)]);
	await base.initialize();
	const before = makeObservation("Daily/2026-08-22.md", "a".repeat(64), 1, "旧正文");
	const successorA = makeObservation("Daily/2026-08-22.md", "b".repeat(64), 1, "新正文 A");
	const successorB = makeObservation("Daily/2026-08-22.md", "c".repeat(64), 1, "新正文 B");
	await base.finishCreate(await base.beginCreate(createIntentInput(before)), before);

	const sameA = cloneVault(baseVault);
	const sameB = cloneVault(baseVault);
	const sameWriterA = createService(sameA, WRITER_A, [], [eventId(10)]);
	const sameWriterB = createService(sameB, WRITER_B, [], [eventId(11)]);
	await sameWriterA.initialize();
	await sameWriterB.initialize();
	await sameWriterA.rebindObservation(before, successorA, "edit");
	await sameWriterB.rebindObservation(before, successorA, "edit");
	const sameMerged = mergeVaults(sameA, sameB);
	const sameReader = createService(sameMerged, WRITER_A, [], []);
	await sameReader.initialize();
	assert.equal(sameReader.getSnapshot().memos[MEMO_A]?.bindings.length, 1);
	assert.equal(sameReader.resolveObservation(successorA)?.memoId, MEMO_A);

	const forkA = cloneVault(baseVault);
	const forkB = cloneVault(baseVault);
	const writerA = createService(forkA, WRITER_A, [], [eventId(12)]);
	const writerB = createService(forkB, WRITER_B, [], [eventId(13)]);
	await writerA.initialize();
	await writerB.initialize();
	await writerA.rebindObservation(before, successorA, "edit");
	await writerB.rebindObservation(before, successorB, "edit");
	const mergedAB = mergeVaults(forkA, forkB);
	const mergedBA = mergeVaults(forkB, forkA);
	const readerAB = createService(mergedAB, WRITER_A, [], []);
	const readerBA = createService(mergedBA, WRITER_B, [], []);
	await readerAB.initialize();
	await readerBA.initialize();

	assert.equal(readerAB.getSnapshot().memos[MEMO_A]?.bindings.length, 2);
	assert.equal(readerAB.resolveObservationState(successorA).kind, "conflicted");
	assert.equal(readerAB.resolveObservationState(successorB).kind, "conflicted");
	assert.deepEqual(readerAB.getSnapshot(), readerBA.getSnapshot());
});

test("P1 第 5 步：显式 repair 只写 Ledger，并让各设备收敛到同一 active binding", async () => {
	const dailyPath = "Daily/2026-08-22.md";
	const baseVault = await createLedgerVault({ [dailyPath]: "## Memos\n- 09:00 候选 A\n- 09:00 候选 B\n" });
	const base = createService(baseVault, WRITER_A, [MEMO_A], [eventId(1), eventId(2)]);
	await base.initialize();
	const before = makeObservation(dailyPath, "a".repeat(64), 1, "旧正文");
	const successorA = makeObservation(dailyPath, "b".repeat(64), 1, "候选 A");
	const successorB = makeObservation(dailyPath, "b".repeat(64), 2, "候选 B");
	await base.finishCreate(await base.beginCreate(createIntentInput(before)), before);
	const forkA = cloneVault(baseVault);
	const forkB = cloneVault(baseVault);
	const writerA = createService(forkA, WRITER_A, [], [eventId(10)]);
	const writerB = createService(forkB, WRITER_B, [], [eventId(11)]);
	await writerA.initialize();
	await writerB.initialize();
	await writerA.rebindObservation(before, successorA, "edit");
	await writerB.rebindObservation(before, successorB, "edit");
	const merged = mergeVaults(forkA, forkB);
	const repairer = createService(merged, WRITER_A, [], [eventId(12)]);
	await repairer.initialize();
	const dailyBefore = merged.read(dailyPath);

	const repaired = await repairer.repairConflict(MEMO_A, successorA);

	assert.equal(repaired.memoId, MEMO_A);
	assert.equal(repairer.resolveObservation(successorA)?.bindingId, repaired.bindingId);
	assert.equal(repairer.resolveObservationState(successorB).kind, "unbound");
	assert.equal(merged.read(dailyPath), dailyBefore);
	const synced = cloneVault(merged);
	const syncedReader = createService(synced, WRITER_B, [], []);
	await syncedReader.initialize();
	assert.equal(syncedReader.resolveObservation(successorA)?.bindingId, repaired.bindingId);
	assert.deepEqual(syncedReader.getSnapshot(), repairer.getSnapshot());
});

test("P1 第 5 步：显式 adoption 只给历史 observation 建立身份且不改变 Daily", async () => {
	const dailyPath = "Daily/2026-08-22.md";
	const vault = await createLedgerVault({ [dailyPath]: "## Memos\n- 09:00 历史正文\n" });
	const service = createService(vault, WRITER_A, [MEMO_A], [eventId(1)]);
	await service.initialize();
	const observation = makeObservation(dailyPath, "a".repeat(64), 1, "历史正文");
	const before = vault.read(dailyPath);

	const binding = await service.adoptObservation(observation);

	assert.equal(binding.memoId, MEMO_A);
	assert.equal(service.resolveObservation(observation)?.memoId, MEMO_A);
	assert.equal(vault.read(dailyPath), before);
});

test("P1 第 5 步：delete payload 不能隐藏 Daily 中仍存在的 observation", async () => {
	const dailyPath = "Daily/2026-08-22.md";
	const vault = await createLedgerVault({ [dailyPath]: "## Memos\n- 09:00 正文\n" });
	const service = createService(vault, WRITER_A, [MEMO_A], [eventId(1), eventId(2)]);
	await service.initialize();
	const observation = makeObservation(dailyPath, "a".repeat(64), 1, "正文");
	const binding = await service.finishCreate(await service.beginCreate(createIntentInput(observation)), observation);
	const deleteEvent: IdentityLedgerEvent = {
		schemaVersion: 1,
		eventId: eventId(10),
		writerId: WRITER_B,
		memoId: MEMO_A,
		type: "delete_payload",
		baseBindingId: binding.bindingId,
		occurredAt: "2026-08-22T05:00:00.000Z",
		evidence: {
			deletedAt: "2026-08-22T05:00:00.000Z",
			sourcePath: dailyPath,
			deletedSourceRevision: "b".repeat(64),
			logicalDate: observation.logicalDate,
			section: observation.section,
			rawBlock: "- 09:00 正文",
			contentHash: observation.contentHash,
			sourceMemoId: null,
		},
	};
	const content = serializeIdentityLedgerSegment([deleteEvent]);
	const digest = await sha256IdentityLedgerText(content);
	await vault.app.vault.create(
		getIdentityLedgerSegmentPath(IDENTITY_ROOT_A, WRITER_B, deleteEvent.eventId, digest),
		content,
	);
	const dailyBefore = vault.read(dailyPath);
	const restarted = createService(vault, WRITER_B, [], []);
	await restarted.initialize();

	assert.equal(restarted.resolveObservation(observation)?.memoId, MEMO_A);
	assert.equal(vault.read(dailyPath), dailyBefore);
});

test("V3-DELETE-003/004：payload 保持 pending，只有 delete_commit 后才进入废纸篓", async () => {
	const vault = await createLedgerVault();
	const service = createService(vault, WRITER_A, [MEMO_A], [
		eventId(1), eventId(2), eventId(3), eventId(4), eventId(5),
	]);
	await service.initialize();
	const before = makeObservation("Daily/2026-08-22.md", "a".repeat(64), 1, "正文");
	const restored = makeObservation("Daily/2026-08-22.md", "b".repeat(64), 1, "正文");
	const binding = await service.finishCreate(await service.beginCreate(createIntentInput(before)), before);

	const deleted = await service.recordDeletePayload(binding, {
		deletedAt: "2026-08-22T05:00:00.000Z",
		sourcePath: before.sourcePath,
		deletedSourceRevision: "b".repeat(64),
		logicalDate: before.logicalDate,
		section: before.section,
		rawBlock: "- 09:00 正文",
		contentHash: before.contentHash,
		sourceMemoId: null,
	});

	assert.equal(service.getPendingDeletes().length, 1);
	assert.equal(service.getActiveDeletes().length, 0);
	const committed = await service.recordDeleteCommit(deleted);
	assert.equal(service.getPendingDeletes().length, 0);
	assert.equal(service.getActiveDeletes()[0]?.deleteEventId, committed.deleteEventId);
	const restoredBinding = await service.recordRestore(committed, restored);
	assert.equal(restoredBinding.memoId, MEMO_A);
	assert.equal(service.getActiveDeletes().length, 0);

	const restarted = createService(vault, WRITER_B, [], []);
	await restarted.initialize();
	assert.equal(restarted.resolveObservation(restored)?.memoId, MEMO_A);
	assert.equal(restarted.getActiveDeletes().length, 0);
});

test("V3-DELETE-003：重启续跑只在 Daily 精确命中删除后 revision 时 finalize", async () => {
	const vault = await createLedgerVault();
	const service = createService(vault, WRITER_A, [MEMO_A], [eventId(1), eventId(2), eventId(3)]);
	await service.initialize();
	const before = makeObservation("Daily/2026-08-22.md", "a".repeat(64), 1, "正文");
	const binding = await service.finishCreate(await service.beginCreate(createIntentInput(before)), before);
	await service.recordDeletePayload(binding, {
		deletedAt: "2026-08-22T05:00:00.000Z",
		sourcePath: before.sourcePath,
		deletedSourceRevision: "b".repeat(64),
		logicalDate: before.logicalDate,
		section: before.section,
		rawBlock: "- 09:00 正文",
		contentHash: before.contentHash,
		sourceMemoId: null,
	});

	assert.equal(await service.reconcilePendingDeletes({ [before.sourcePath]: "a".repeat(64) }), 0);
	assert.equal(service.getPendingDeletes().length, 1);
	assert.equal(await service.reconcilePendingDeletes({ [before.sourcePath]: "b".repeat(64) }), 1);
	assert.equal(service.getPendingDeletes().length, 0);
	assert.equal(service.getActiveDeletes().length, 1);
});

test("P1 第 7 步：重复导入相同旧事件不产生重复 Identity events", async () => {
	const vault = await createLedgerVault();
	const service = createService(vault, WRITER_A, [], []);
	await service.initialize();
	const observation = makeEvidence(makeObservation("Daily/2026-08-22.md", "a".repeat(64), 1, "正文"));
	const claim: IdentityLedgerEvent = {
		schemaVersion: 1,
		eventId: eventId(20),
		writerId: WRITER_A,
		memoId: MEMO_A,
		type: "claim",
		baseBindingId: null,
		occurredAt: "2026-08-22T00:00:00.000Z",
		evidence: { observation, createIntentEventId: null },
	};

	assert.equal(await service.importVerifiedLegacyEvents([claim]), 1);
	assert.equal(await service.importVerifiedLegacyEvents([claim]), 0);
	assert.equal(service.getSnapshot().eventCount, 1);
	assert.equal(vault.paths().filter((path) => path.endsWith(".jsonl")).length, 1);
});

test("P0 Identity 性能：legacy events 使用有界批量 segment 且只导入一次", async () => {
	const vault = await createLedgerVault();
	const service = createService(vault, WRITER_A, [], []);
	await service.initialize();
	const events: IdentityLedgerEvent[] = Array.from({ length: 600 }, (_, index) => {
		const observation = makeObservation(
			"Daily/2026-08-22.md",
			(index + 1).toString(16).padStart(64, "0"),
			index + 1,
			`memo-${index + 1}`,
		);
		return {
			schemaVersion: 1,
			eventId: eventId(index + 100),
			writerId: WRITER_A,
			memoId: `m_${(index + 1).toString(16).padStart(32, "0")}`,
			type: "claim",
			baseBindingId: null,
			occurredAt: "2026-08-22T06:00:00.000Z",
			evidence: { observation: makeEvidence(observation), createIntentEventId: null },
		};
	});

	assert.equal(await service.importVerifiedLegacyEvents(events), 600);
	assert.equal(service.getSnapshot().eventCount, 600);
	assert.equal(vault.paths().filter((path) => path.endsWith(".jsonl")).length, 3);
	assert.equal(await service.importVerifiedLegacyEvents(events), 0);
	assert.equal(vault.paths().filter((path) => path.endsWith(".jsonl")).length, 3);
});

test("P1 第 7 步：旧 V2 memoId、relation、review 与可恢复删除可幂等导入", async () => {
	const vault = await createLedgerVault();
	const target = createService(vault, WRITER_A, [], []);
	await target.initialize();
	const observation = makeObservation("Daily/2026-08-22.md", "a".repeat(64), 1, "正文");
	const evidence = legacyEvidence(observation);
	const deletedPayload: DeletedMemoPayload = {
		kind: "knomo.catalog-v2.deleted-payload",
		schemaVersion: 1,
		memoId: MEMO_B,
		deleteOpId: "o_66666666666666666666666666666666",
		deletedAt: "2026-08-22T06:00:00.000Z",
		sourcePath: "Daily/2026-08-21.md",
		logicalDate: "2026-08-21",
		section: "Memos",
		rawBlock: "- 08:00 已删除正文",
		contentHash: "fnv1a-22222222",
		sourceMemoId: null,
	};
	const operations: StateOperation[] = [
		legacyClaim("o_11111111111111111111111111111111", MEMO_A, evidence, 1),
		legacyClaim("o_22222222222222222222222222222222", MEMO_B, {
			...evidence,
			sourcePath: deletedPayload.sourcePath,
			logicalDate: deletedPayload.logicalDate,
			time: "08:00",
			contentHash: deletedPayload.contentHash,
		}, 2),
		legacyRelation(MEMO_A, MEMO_B, 3),
		legacyReview(MEMO_A, 4, "2026-08-22T04:00:00.000Z"),
		legacyReview(MEMO_A, 5, "2026-08-22T05:00:00.000Z"),
	];
	const state = makeLegacyState(evidence, deletedPayload);
	const source: LegacyIdentitySource = {
		load: async () => ({
			kind: "ready",
			snapshot: {
				sourceKind: "catalog_v2",
				sourceId: "v_11111111111111111111111111111111",
				sourceRevision: "f".repeat(64),
				state,
				operations,
				deletedPayloads: { [deletedPayload.deleteOpId]: deletedPayload },
				diagnostics: [],
			},
		}),
		isSourcePath: () => false,
	};
	const importer = new CatalogV3LegacyIdentityImporter(vault.app, source, target, {
		getObservationBatches: async () => [makeBatch(observation)],
	});

	const first = await importer.run();
	const second = await importer.run();

	assert.equal(first.status, "ready");
	assert.equal(first.importedEventCount, 7);
	assert.equal(second.importedEventCount, 0);
	assert.equal(target.resolveObservation(observation)?.memoId, MEMO_A);
	assert.equal(target.getSourceMemoId(MEMO_A), MEMO_B);
	assert.deepEqual(target.getReviewState(MEMO_A), {
		reviewCount: 2,
		lastReviewedAt: "2026-08-22T05:00:00.000Z",
	});
	assert.equal(target.getActiveDeletes()[0]?.memoId, MEMO_B);
	assert.equal(target.getActiveDeletes()[0]?.evidence.rawBlock, deletedPayload.rawBlock);
});

function legacyEvidence(observation: MemoObservation): IdentityEvidence {
	return {
		sourcePath: observation.sourcePath,
		sourceRevision: observation.sourceRevision,
		logicalDate: observation.logicalDate,
		section: observation.section,
		startLine: observation.startLine,
		endLine: observation.endLine,
		time: observation.time,
		contentHash: observation.contentHash,
		existingBlockId: observation.existingBlockId,
	};
}

function legacyClaim(
	opId: string,
	memoId: string,
	evidence: IdentityEvidence,
	sequence: number,
): StateOperation {
	return {
		schemaVersion: 1,
		writerId: WRITER_A,
		sequence,
		opId,
		memoId,
		occurredAt: `2026-08-22T0${sequence}:00:00.000Z`,
		type: "identity.claim",
		baseEvidence: null,
		payload: { evidence, origin: "plugin_create", createIntentOpId: null },
	};
}

function legacyRelation(memoId: string, sourceMemoId: string, sequence: number): StateOperation {
	return {
		schemaVersion: 1,
		writerId: WRITER_A,
		sequence,
		opId: "o_33333333333333333333333333333333",
		memoId,
		occurredAt: "2026-08-22T03:00:00.000Z",
		type: "relation.set_source",
		baseEvidence: null,
		payload: { sourceMemoId, supersedesRelationIds: [] },
	};
}

function legacyReview(memoId: string, sequence: number, reviewedAt: string): StateOperation {
	return {
		schemaVersion: 1,
		writerId: WRITER_A,
		sequence,
		opId: sequence === 4 ? "o_44444444444444444444444444444444" : "o_55555555555555555555555555555555",
		memoId,
		occurredAt: reviewedAt,
		type: "review.record",
		baseEvidence: null,
		payload: { reviewedAt },
	};
}

function makeLegacyState(evidence: IdentityEvidence, deletedPayload: DeletedMemoPayload): CatalogV2MaterializedState {
	const activeMemo = {
		memoId: MEMO_A,
		identityOperationIds: ["o_11111111111111111111111111111111"],
		activeBindingHeads: [{
			entryId: "o_11111111111111111111111111111111",
			source: "state" as const,
			evidence,
			baseBindingId: null,
			baseEvidence: null,
		}],
		identityBindings: [],
		deleteOperationIds: [],
		deleteVersions: [],
		restoreVersions: [],
		restoredDeleteOperationIds: [],
		purgedDeleteOperationIds: [],
		relationEntries: [{ relationId: "o_33333333333333333333333333333333", sourceMemoId: MEMO_B }],
		supersededRelationIds: [],
		sourceMemoIds: [MEMO_B],
		reviewOperationIds: ["o_44444444444444444444444444444444", "o_55555555555555555555555555555555"],
		reviewCount: 2,
		lastReviewedAt: "2026-08-22T05:00:00.000Z",
		pendingCreateIds: [],
		pendingCreateIntents: [],
	};
	const deletedEvidence: IdentityEvidence = {
		...evidence,
		sourcePath: deletedPayload.sourcePath,
		logicalDate: deletedPayload.logicalDate,
		time: "08:00",
		contentHash: deletedPayload.contentHash,
	};
	const deletedMemo = {
		...activeMemo,
		memoId: MEMO_B,
		identityOperationIds: ["o_22222222222222222222222222222222"],
		activeBindingHeads: [{
			entryId: "o_22222222222222222222222222222222",
			source: "state" as const,
			evidence: deletedEvidence,
			baseBindingId: null,
			baseEvidence: null,
		}],
		deleteOperationIds: [deletedPayload.deleteOpId],
		deleteVersions: [{
			deleteOpId: deletedPayload.deleteOpId,
			entryId: deletedPayload.deleteOpId,
			payload: { path: "Knomo/_knomo-data/state/deleted/payload.json", sha256: "1".repeat(64), byteLength: 1 },
			baseEvidence: deletedEvidence,
			baseBindingId: "o_22222222222222222222222222222222",
		}],
		relationEntries: [],
		sourceMemoIds: [],
		reviewOperationIds: [],
		reviewCount: 0,
		lastReviewedAt: null,
	};
	return {
		schemaVersion: 1,
		memos: { [MEMO_A]: activeMemo, [MEMO_B]: deletedMemo },
		quarantine: [],
		awaitingWriterIds: [],
		forkedWriterIds: [],
		processedOperationCount: 5,
	};
}

function makeBatch(observation: MemoObservation): CatalogFileRevisionBatch<MemoObservation> {
	return {
		file: {
			sourcePath: observation.sourcePath,
			sourceRevision: observation.sourceRevision,
			logicalDate: observation.logicalDate,
			mtime: 0,
			size: 0,
			parserVersion: 3,
			settingsFingerprint: "test",
			observationCount: 1,
			auditedAt: 0,
		},
		observations: [observation],
		catalogRevision: 1,
	};
}

function createService(
	vault: CatalogV2ReplicaVault,
	writerId: string,
	memoIds: readonly string[],
	eventIds: readonly string[],
	getRootPath: () => string | null = () => IDENTITY_ROOT_A,
): IdentityLedgerService {
	let memoIndex = 0;
	let eventIndex = 0;
	return new IdentityLedgerService(vault.app, {
		getRootPath,
		getWriterId: async () => writerId,
		createMemoId: () => memoIds[memoIndex++] ?? createIdentityLedgerMemoId(),
		createEventId: () => eventIds[eventIndex++] ?? eventId(100 + eventIndex),
		now: () => new Date("2026-08-22T00:00:00.000Z"),
	});
}

async function createLedgerVault(
	initialFiles: Readonly<Record<string, string>> = {},
	rootPath = IDENTITY_ROOT_A,
): Promise<CatalogV2ReplicaVault> {
	const vault = new CatalogV2ReplicaVault(initialFiles);
	await vault.app.vault.createFolder(rootPath);
	await vault.app.vault.createFolder(`${rootPath}/writers`);
	return vault;
}

function createIntentInput(observation: MemoObservation) {
	return {
		targetPath: observation.sourcePath,
		logicalDate: observation.logicalDate,
		time: observation.time,
		contentHash: observation.contentHash,
		sourceMemoId: null,
	};
}

function makeObservation(
	sourcePath: string,
	sourceRevision: string,
	startLine: number,
	content: string,
): MemoObservation {
	return {
		sourcePath,
		sourceRevision,
		rawBlockHash: `fnv1a-${startLine.toString(16).padStart(8, "0")}`,
		logicalDate: sourcePath.includes("2026-08-23") ? "2026-08-23" : "2026-08-22",
		section: "## Memos",
		startLine,
		endLine: startLine,
		time: "09:00",
		content,
		contentHash: "fnv1a-12345678",
		existingBlockId: null,
		tags: [],
		links: [],
		images: [],
		tasks: [],
		timeBuoyDates: [],
	};
}

function makeEvidence(observation: MemoObservation): IdentityLedgerObservationEvidence {
	return {
		sourcePath: observation.sourcePath,
		sourceRevision: observation.sourceRevision,
		rawBlockHash: observation.rawBlockHash,
		logicalDate: observation.logicalDate,
		section: observation.section,
		startLine: observation.startLine,
		endLine: observation.endLine,
		time: observation.time,
		contentHash: observation.contentHash,
	};
}

function eventId(index: number): string {
	return `e_${index.toString(16).padStart(32, "0")}`;
}

function cloneVault(source: CatalogV2ReplicaVault): CatalogV2ReplicaVault {
	const target = new CatalogV2ReplicaVault();
	target.deliverFrom(source);
	return target;
}

function mergeVaults(first: CatalogV2ReplicaVault, second: CatalogV2ReplicaVault): CatalogV2ReplicaVault {
	const target = cloneVault(first);
	target.deliverFrom(second);
	return target;
}
