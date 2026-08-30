import assert from "node:assert/strict";
import test from "node:test";

import type { App, Component } from "obsidian";

import { IdentityLedgerService } from "../src/services/IdentityLedgerService";
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
import { InMemoryVault } from "./helpers/InMemoryVault";

const WRITER_A = "w_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const WRITER_B = "w_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const MEMO_A = "01991f40-7c00-7111-9111-111111111111";
const MEMO_B = "01991f40-7c00-7222-a222-222222222222";
const MEMO_C = "01991f40-7c00-7333-b333-333333333333";
const IDENTITY_ROOT_A = getIdentityLedgerRootPath("Knomo-A");
const IDENTITY_ROOT_B = getIdentityLedgerRootPath("Knomo-B");

test("启动监听与显式初始化复用一次 Identity 全量刷新", async () => {
	const vault = await createLedgerVault();
	installVaultListenerSupport(vault);
	const service = createService(vault, WRITER_A, [], []);
	const refreshTarget = service as unknown as { refreshFromVault(): Promise<void> };
	const refreshFromVault = refreshTarget.refreshFromVault.bind(service);
	let refreshCount = 0;
	let releaseRefresh!: () => void;
	const refreshBlocked = new Promise<void>((resolve) => { releaseRefresh = resolve; });
	let notificationCount = 0;
	refreshTarget.refreshFromVault = async () => {
		refreshCount += 1;
		await refreshBlocked;
		await refreshFromVault();
	};

	service.start(createOwner(), async () => { notificationCount += 1; });
	const initialization = service.initialize();
	await new Promise<void>((resolve) => { setTimeout(resolve, 0); });

	assert.equal(refreshCount, 1);
	releaseRefresh();
	await initialization;
	await new Promise<void>((resolve) => { setTimeout(resolve, 0); });
	assert.equal(notificationCount, 1);
});

test("插件卸载会取消 active Identity 刷新，旧结果不得提交或通知", async () => {
	const vault = await createLedgerVault();
	installVaultListenerSupport(vault);
	const service = createService(vault, WRITER_A, [], []);
	const refreshTarget = service as unknown as { refreshFromVault(): Promise<void> };
	const refreshFromVault = refreshTarget.refreshFromVault.bind(service);
	let releaseRefresh!: () => void;
	const refreshBlocked = new Promise<void>((resolve) => { releaseRefresh = resolve; });
	let markRefreshStarted!: () => void;
	const refreshStarted = new Promise<void>((resolve) => { markRefreshStarted = resolve; });
	refreshTarget.refreshFromVault = async () => {
		markRefreshStarted();
		await refreshBlocked;
		await refreshFromVault();
	};
	let notificationCount = 0;
	const owner = createUnloadableOwner();

	service.start(owner.component, async () => { notificationCount += 1; });
	const initialization = service.initialize();
	await refreshStarted;
	owner.unload();
	releaseRefresh();
	await initialization;

	assert.equal(service.getStatus(), "unavailable");
	assert.equal(service.getSnapshot().eventCount, 0);
	assert.equal(notificationCount, 0);
});

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

test("1.2.9 升级保留16位数字 memoId，新格式生成规则保持不变", async () => {
	const legacyMemoId = "2026082212345601";
	const observation = makeEvidence(makeObservation("Daily/2026-08-22.md", "a".repeat(64), 1, "正文"));
	const event: IdentityLedgerEvent = {
		eventId: eventId(99),
		writerId: WRITER_A,
		memoId: legacyMemoId,
		type: "claim",
		baseBindingId: null,
		occurredAt: "2026-08-22T12:34:56.000Z",
		evidence: { observation, createIntentEventId: null },
	};
	const content = serializeIdentityLedgerSegment([event]);
	const digest = await sha256IdentityLedgerText(content);
	const parsed = await parseIdentityLedgerSegment(
		IDENTITY_ROOT_A,
		`${IDENTITY_ROOT_A}/writers/${WRITER_A}/segments/segment-${event.eventId}-${digest}.jsonl`,
		content,
	);

	assert.equal(parsed.events[0]?.event.memoId, legacyMemoId);
	assert.match(createIdentityLedgerMemoId(), /^[a-f0-9]{8}-[a-f0-9]{4}-7[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u);
	assert.throws(() => serializeIdentityLedgerSegment([{
		...event,
		memoId: "m_11111111111111111111111111111111",
	}]), /Invalid Identity Ledger event/u);
});

test("Identity Ledger 只接受当前冻结的十种基础事件", async () => {
	const observation = makeEvidence(makeObservation("Daily/2026-08-22.md", "a".repeat(64), 1, "正文"));
	const base = {
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
			type: "purge",
			baseBindingId: eventId(2),
			evidence: { deleteEventId: eventId(6) },
		},
		{
			...base,
			eventId: eventId(10),
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
		"purge",
		"repair",
	]);
	const invalidContent = `${JSON.stringify({ ...base, eventId: eventId(11), type: "authority", baseBindingId: null, evidence: {} })}\n`;
	const invalidDigest = await sha256IdentityLedgerText(invalidContent);
	await assert.rejects(() => parseIdentityLedgerSegment(
		IDENTITY_ROOT_A,
		`${IDENTITY_ROOT_A}/writers/${WRITER_A}/segments/segment-${eventId(11)}-${invalidDigest}.jsonl`,
		invalidContent,
	), /Invalid Identity Ledger event/u);
});

test("create_intent 单独存在时不产生幽灵 memo", async () => {
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

test("claim 后原 observation 原地获得 memoId 和关系", async () => {
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

test("重启后从 durable intent 安全续写唯一 claim，不重复 Daily mutation", async () => {
	const dailyPath = "Daily/2026-08-22.md";
	const vault = await createLedgerVault({ [dailyPath]: "## Memos\n- 09:00 正文\n" });
	const first = createService(vault, WRITER_A, [MEMO_A], [eventId(1)]);
	await first.initialize();
	const observation = makeObservation(dailyPath, "a".repeat(64), 1, "正文");
	await first.beginCreate({
		targetPath: dailyPath,
		logicalDate: observation.logicalDate,
		time: "09:00:37",
		contentHash: observation.contentHash,
		sourceMemoId: null,
	});
	const dailyBefore = vault.read(dailyPath);

	const restarted = createService(vault, WRITER_B, [], [eventId(2)]);
	await restarted.initialize();
	assert.equal(await restarted.reconcilePendingCreates([observation]), 1);

	assert.equal(vault.read(dailyPath), dailyBefore);
	assert.equal(restarted.resolveObservation(observation)?.memoId, MEMO_A);
	assert.equal(restarted.getCreatedAt(MEMO_A), "2026-08-22T09:00:37");
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

	const mergedAB = new InMemoryVault();
	mergedAB.deliverFrom(vaultA);
	mergedAB.deliverFrom(vaultB);
	const mergedBA = new InMemoryVault();
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

test("引用创建把 claim 与 relation 写入同一不可变 segment", async () => {
	const vault = await createLedgerVault();
	const observation = makeObservation("Daily/2026-08-22.md", "a".repeat(64), 1, "引用正文");
	const service = createService(vault, WRITER_A, [MEMO_A], [eventId(1), eventId(2), eventId(3)]);
	await service.initialize();
	const plan = await service.beginCreate({ ...createIntentInput(observation), sourceMemoId: MEMO_B });

	await service.finishCreate(plan, observation);

	assert.equal(vault.paths().filter((path) => path.endsWith(".jsonl")).length, 2);
	assert.equal(service.getSourceMemoId(MEMO_A), MEMO_B);
	assert.equal(service.getSnapshot().eventCount, 3);
});

test("Identity 持久化完成后不等待视图观察者返回", async () => {
	const vault = await createLedgerVault();
	const observation = makeObservation("Daily/2026-08-22.md", "a".repeat(64), 1, "正文");
	const service = createService(vault, WRITER_A, [MEMO_A], [eventId(1), eventId(2)]);
	await service.initialize();
	const plan = await service.beginCreate(createIntentInput(observation));
	const notificationStarted = createDeferred<void>();
	const releaseNotification = createDeferred<void>();
	(vault.app.vault as App["vault"] & { on: (...args: unknown[]) => unknown }).on = () => ({});
	service.start({
		registerEvent: () => undefined,
		register: () => undefined,
	} as unknown as Component, async () => {
		notificationStarted.resolve(undefined);
		await releaseNotification.promise;
	});
	await notificationStarted.promise;

	const binding = await withTimeout(service.finishCreate(plan, observation));

	assert.equal(binding.memoId, MEMO_A);
	releaseNotification.resolve(undefined);
});

test("identity root 不可写时保留 create plan，但 claim 失败且不触碰 Daily", async () => {
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

test("只读取用户配置根，其他目录中的 identity 不参与启动", async () => {
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

test("配置根缺失时不创建 identity，Daily 仍保持可用", async () => {
	const dailyPath = "Daily/2026-08-22.md";
	const vault = new InMemoryVault({ [dailyPath]: "## Memos\n- 09:00 正文\n" });
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
	const segmentCountBefore = vault.paths().filter((path) => path.endsWith(".jsonl")).length;

	const result = await service.reconcileRevision(
		[beforeA, anchorBefore, beforeC],
		[afterA, anchorAfter, afterC],
	);

	assert.equal(result.appendedEventCount, 2);
	assert.equal(vault.paths().filter((path) => path.endsWith(".jsonl")).length, segmentCountBefore + 1);
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

test("payload 保持 pending，只有 delete_commit 后才进入废纸篓", async () => {
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

test("purge 只追加空 tombstone，持久化后幂等隐藏 payload 且禁止恢复", async () => {
	const dailyPath = "Daily/2026-08-22.md";
	const vault = await createLedgerVault({ [dailyPath]: "## Memos\n- 09:00 正文\n" });
	const service = createService(vault, WRITER_A, [MEMO_A], [
		eventId(1), eventId(2), eventId(3), eventId(4), eventId(5),
	]);
	await service.initialize();
	const observation = makeObservation(dailyPath, "a".repeat(64), 1, "正文");
	const binding = await service.finishCreate(await service.beginCreate(createIntentInput(observation)), observation);
	const deleted = await service.recordDeletePayload(binding, {
		deletedAt: "2026-08-22T05:00:00.000Z",
		sourcePath: observation.sourcePath,
		deletedSourceRevision: "b".repeat(64),
		logicalDate: observation.logicalDate,
		section: observation.section,
		rawBlock: "- 09:00 正文",
		contentHash: observation.contentHash,
		sourceMemoId: null,
	});
	const committed = await service.recordDeleteCommit(deleted);
	const eventCountBeforePurge = service.getSnapshot().eventCount;
	const dailyBefore = vault.read(dailyPath);

	await Promise.all([service.recordPurge(committed), service.recordPurge(committed)]);

	assert.equal(service.getActiveDeletes().length, 0);
	assert.deepEqual(service.getSnapshot().memos[MEMO_A]?.purgedDeleteEventIds, [committed.deleteEventId]);
	assert.equal(service.getSnapshot().eventCount, eventCountBeforePurge + 1);
	assert.equal(service.resolveObservation(observation)?.memoId, MEMO_A);
	assert.equal(vault.read(dailyPath), dailyBefore);
	await assert.rejects(() => service.recordRestore(committed, observation), /permanently deleted/u);

	const restarted = createService(vault, WRITER_B, [], []);
	await restarted.initialize();
	assert.equal(restarted.getActiveDeletes().length, 0);
	assert.deepEqual(restarted.getSnapshot().memos[MEMO_A]?.purgedDeleteEventIds, [committed.deleteEventId]);
	await restarted.recordPurge(committed);
	assert.equal(restarted.getSnapshot().eventCount, eventCountBeforePurge + 1);

	const purgePaths = vault.paths().filter((path) => vault.read(path)?.includes('"type":"purge"') === true);
	const delayedReplica = await createLedgerVault();
	delayedReplica.deliverFrom(vault, purgePaths);
	const delayedReader = createService(delayedReplica, WRITER_B, [], []);
	await delayedReader.initialize();
	delayedReplica.deliverFrom(vault);
	await delayedReader.initialize();
	assert.equal(delayedReader.getActiveDeletes().length, 0);
	assert.deepEqual(delayedReader.getSnapshot().memos[MEMO_A]?.purgedDeleteEventIds, [committed.deleteEventId]);
});

test("两台设备并发 purge 同一删除记录后按任意同步顺序收敛", async () => {
	const baseVault = await createLedgerVault();
	const base = createService(baseVault, WRITER_A, [MEMO_A], [eventId(1), eventId(2), eventId(3), eventId(4)]);
	await base.initialize();
	const observation = makeObservation("Daily/2026-08-22.md", "a".repeat(64), 1, "正文");
	const binding = await base.finishCreate(await base.beginCreate(createIntentInput(observation)), observation);
	const deleted = await base.recordDeletePayload(binding, {
		deletedAt: "2026-08-22T05:00:00.000Z",
		sourcePath: observation.sourcePath,
		deletedSourceRevision: "b".repeat(64),
		logicalDate: observation.logicalDate,
		section: observation.section,
		rawBlock: "- 09:00 正文",
		contentHash: observation.contentHash,
		sourceMemoId: null,
	});
	const committed = await base.recordDeleteCommit(deleted);
	const vaultA = cloneVault(baseVault);
	const vaultB = cloneVault(baseVault);
	const writerA = createService(vaultA, WRITER_A, [], [eventId(10)]);
	const writerB = createService(vaultB, WRITER_B, [], [eventId(11)]);
	await writerA.initialize();
	await writerB.initialize();

	await Promise.all([writerA.recordPurge(committed), writerB.recordPurge(committed)]);
	const readerAB = createService(mergeVaults(vaultA, vaultB), WRITER_A, [], []);
	const readerBA = createService(mergeVaults(vaultB, vaultA), WRITER_B, [], []);
	await readerAB.initialize();
	await readerBA.initialize();

	assert.equal(readerAB.getActiveDeletes().length, 0);
	assert.deepEqual(readerAB.getSnapshot(), readerBA.getSnapshot());
});

test("identity 冲突期间拒绝 purge 并保留废纸篓记录", async () => {
	const baseVault = await createLedgerVault();
	const base = createService(baseVault, WRITER_A, [MEMO_A], [eventId(1), eventId(2), eventId(3), eventId(4)]);
	await base.initialize();
	const before = makeObservation("Daily/2026-08-22.md", "a".repeat(64), 1, "正文");
	const binding = await base.finishCreate(await base.beginCreate(createIntentInput(before)), before);
	const deleted = await base.recordDeletePayload(binding, {
		deletedAt: "2026-08-22T05:00:00.000Z",
		sourcePath: before.sourcePath,
		deletedSourceRevision: "b".repeat(64),
		logicalDate: before.logicalDate,
		section: before.section,
		rawBlock: "- 09:00 正文",
		contentHash: before.contentHash,
		sourceMemoId: null,
	});
	const committed = await base.recordDeleteCommit(deleted);
	const forkA = cloneVault(baseVault);
	const forkB = cloneVault(baseVault);
	const writerA = createService(forkA, WRITER_A, [], [eventId(10)]);
	const writerB = createService(forkB, WRITER_B, [], [eventId(11)]);
	await writerA.initialize();
	await writerB.initialize();
	await writerA.rebindObservation(before, makeObservation(before.sourcePath, "c".repeat(64), 1, "候选 A"), "edit");
	await writerB.rebindObservation(before, makeObservation(before.sourcePath, "d".repeat(64), 2, "候选 B"), "edit");
	const conflicted = createService(mergeVaults(forkA, forkB), WRITER_A, [], [eventId(12)]);
	await conflicted.initialize();

	await assert.rejects(() => conflicted.recordPurge(committed), /identity is conflicted/u);
	assert.equal(conflicted.getActiveDeletes().length, 1);
	assert.deepEqual(conflicted.getSnapshot().memos[MEMO_A]?.purgedDeleteEventIds, []);
});

test("重启续跑只在 Daily 精确命中删除后 revision 时 finalize", async () => {
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
		eventId: eventId(20),
		writerId: WRITER_A,
		memoId: MEMO_A,
		type: "claim",
		baseBindingId: null,
		occurredAt: "2026-08-22T00:00:00.000Z",
		evidence: { observation, createIntentEventId: null },
	};

	assert.equal(await service.importVerifiedLegacyEvents([claim]), 1);
	assert.equal(await service.verifyPersistedSnapshot(service.getSnapshot().revision), true);
	assert.equal(await service.verifyPersistedSnapshot("identity-not-the-persisted-revision"), false);
	assert.equal(await service.importVerifiedLegacyEvents([claim]), 0);
	assert.equal(service.getSnapshot().eventCount, 1);
	assert.equal(vault.paths().filter((path) => path.endsWith(".jsonl")).length, 1);
});

test("旧版 Identity 批量写入进行中时新建 intent 快速降级，不排在迁移队列后", async () => {
	const vault = await createLedgerVault();
	const service = createService(vault, WRITER_A, [MEMO_B], [eventId(30)]);
	await service.initialize();
	const observation = makeObservation("Daily/2026-08-22.md", "a".repeat(64), 1, "旧版正文");
	const claim: IdentityLedgerEvent = {
		eventId: eventId(29),
		writerId: WRITER_A,
		memoId: MEMO_A,
		type: "claim",
		baseBindingId: null,
		occurredAt: "2026-08-22T00:00:00.000Z",
		evidence: { observation: makeEvidence(observation), createIntentEventId: null },
	};
	let releaseImport!: () => void;
	const importBlocked = new Promise<void>((resolve) => { releaseImport = resolve; });
	let markImportBlocked!: () => void;
	const importReachedYield = new Promise<void>((resolve) => { markImportBlocked = resolve; });
	const importing = service.importVerifiedLegacyEvents([claim], {
		yieldControl: async () => {
			markImportBlocked();
			await importBlocked;
		},
	});
	await importReachedYield;

	const beginResult = await Promise.race([
		service.beginCreate(createIntentInput(observation)).then(() => "resolved", () => "rejected"),
		new Promise<"timeout">((resolve) => { setTimeout(() => resolve("timeout"), 100); }),
	]);
	releaseImport();
	await importing;

	assert.equal(beginResult, "rejected");
});

test("旧版 Identity 事件校验按时间预算让步，不等待 256 条固定批次", async () => {
	const vault = await createLedgerVault();
	const service = createService(vault, WRITER_A, [], []);
	await service.initialize();
	const events: IdentityLedgerEvent[] = Array.from({ length: 10 }, (_, index) => {
		const observation = makeObservation(
			"Daily/2026-08-22.md",
			(index + 1).toString(16).padStart(64, "0"),
			index + 1,
			`memo-${index + 1}`,
		);
		return {
			eventId: eventId(index + 2_000),
			writerId: WRITER_A,
			memoId: `01991f40-7c00-7000-8000-${(index + 1).toString(16).padStart(12, "0")}`,
			type: "claim",
			baseBindingId: null,
			occurredAt: "2026-08-22T06:00:00.000Z",
			evidence: { observation: makeEvidence(observation), createIntentEventId: null },
		};
	});
	let elapsedMs = 0;
	let yieldCount = 0;

	await service.importVerifiedLegacyEvents(events, {
		yieldControl: async () => { yieldCount += 1; },
		sliceBudgetMs: 8,
		now: () => {
			elapsedMs += 3;
			return elapsedMs;
		},
	});

	assert.equal(yieldCount > 1, true);
});

test("旧版事件仍在计算时取消，不得持久化任何 Identity segment", async () => {
	const vault = await createLedgerVault();
	const service = createService(vault, WRITER_A, [], []);
	await service.initialize();
	const events: IdentityLedgerEvent[] = Array.from({ length: 257 }, (_, index) => {
		const observation = makeObservation(
			"Daily/2026-08-22.md",
			(index + 1).toString(16).padStart(64, "0"),
			index + 1,
			`memo-${index + 1}`,
		);
		return {
			eventId: eventId(index + 1_000),
			writerId: WRITER_A,
			memoId: `01991f40-7c00-7000-8000-${(index + 1).toString(16).padStart(12, "0")}`,
			type: "claim",
			baseBindingId: null,
			occurredAt: "2026-08-22T06:00:00.000Z",
			evidence: { observation: makeEvidence(observation), createIntentEventId: null },
		};
	});
	const cancellation = new AbortController();
	let releaseYield = (): void => undefined;
	const yieldGate = new Promise<void>((resolve) => { releaseYield = resolve; });
	let markYieldStarted = (): void => undefined;
	const yieldStarted = new Promise<void>((resolve) => { markYieldStarted = resolve; });
	const running = service.importVerifiedLegacyEvents(events, {
		cancellationSignal: cancellation.signal,
		yieldControl: async () => {
			markYieldStarted();
			await yieldGate;
		},
	});
	await yieldStarted;

	cancellation.abort();
	releaseYield();

	await assert.rejects(running, /cancelled/u);
	assert.equal(vault.paths().filter((path) => path.endsWith(".jsonl")).length, 0);
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
			eventId: eventId(index + 100),
			writerId: WRITER_A,
			memoId: `01991f40-7c00-7000-8000-${(index + 1).toString(16).padStart(12, "0")}`,
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

function createService(
	vault: InMemoryVault,
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

function installVaultListenerSupport(vault: InMemoryVault): void {
	(vault.app.vault as App["vault"] & { on: () => object }).on = () => ({});
}

function createOwner(): Component {
	return {
		registerEvent: () => undefined,
		register: () => undefined,
	} as unknown as Component;
}

function createUnloadableOwner(): { component: Component; unload: () => void } {
	const cleanups: Array<() => void> = [];
	return {
		component: {
			registerEvent: () => undefined,
			register: (cleanup: () => void) => { cleanups.push(cleanup); },
		} as unknown as Component,
		unload: () => { cleanups.forEach((cleanup) => cleanup()); },
	};
}

async function createLedgerVault(
	initialFiles: Readonly<Record<string, string>> = {},
	rootPath = IDENTITY_ROOT_A,
): Promise<InMemoryVault> {
	const vault = new InMemoryVault(initialFiles);
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

function createDeferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
	let resolvePromise: (value: T) => void = () => undefined;
	const promise = new Promise<T>((resolve) => {
		resolvePromise = resolve;
	});
	return { promise, resolve: resolvePromise };
}

function withTimeout<T>(promise: Promise<T>, timeoutMs = 250): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const timeout = setTimeout(() => reject(new Error("Timed out waiting for Identity persistence.")), timeoutMs);
		void promise.then(
			(value) => {
				clearTimeout(timeout);
				resolve(value);
			},
			(error: unknown) => {
				clearTimeout(timeout);
				reject(error);
			},
		);
	});
}

function eventId(index: number): string {
	return `e_${index.toString(16).padStart(32, "0")}`;
}

function cloneVault(source: InMemoryVault): InMemoryVault {
	const target = new InMemoryVault();
	target.deliverFrom(source);
	return target;
}

function mergeVaults(first: InMemoryVault, second: InMemoryVault): InMemoryVault {
	const target = cloneVault(first);
	target.deliverFrom(second);
	return target;
}
