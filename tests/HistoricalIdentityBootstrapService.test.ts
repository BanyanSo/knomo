import assert from "node:assert/strict";
import test from "node:test";

import {
	HISTORICAL_IDENTITY_BOOTSTRAP_META_KEY,
	HistoricalIdentityBootstrapService,
} from "../src/services/HistoricalIdentityBootstrapService";
import type { CatalogFileRevisionBatch, MemoObservation } from "../src/types/catalog";
import type { IdentityLedgerBinding, IdentityLedgerSnapshot } from "../src/types/identityLedger";

test("首次安装在完整 Catalog 且无 1.2.9 数据时自动建立全部身份并完成 checkpoint", async () => {
	const fixture = createFixture();
	assert.equal(await fixture.service.initializeEligibility(), "pending");

	assert.equal(await fixture.service.run("not_applicable"), "completed");

	assert.deepEqual(fixture.adopted, fixture.observations);
	assert.deepEqual(fixture.meta.get(HISTORICAL_IDENTITY_BOOTSTRAP_META_KEY), {
		state: "completed",
		reason: "initial_import",
		catalogFingerprint: fixture.meta.get(HISTORICAL_IDENTITY_BOOTSTRAP_META_KEY)?.catalogFingerprint,
		identityRevision: "identity-1",
		identityEventCount: 2,
	});
});

test("首装身份导入只在完整且可持久写入的 Catalog 上运行", async () => {
	const fixture = createFixture({ coverageKind: "partial" });
	await fixture.service.initializeEligibility();

	assert.equal(await fixture.service.run("not_applicable"), "pending");
	assert.equal(fixture.adopted.length, 0);
	assert.equal((fixture.meta.get(HISTORICAL_IDENTITY_BOOTSTRAP_META_KEY) as { state: string }).state, "pending");
});

test("存在 1.2.9 数据时由 legacy migration 负责身份，不再全库导入", async () => {
	const fixture = createFixture();
	await fixture.service.initializeEligibility();

	assert.equal(await fixture.service.run("ready"), "completed");
	assert.equal(fixture.adopted.length, 0);
	assert.equal((fixture.meta.get(HISTORICAL_IDENTITY_BOOTSTRAP_META_KEY) as { reason: string }).reason, "legacy_source");
});

test("已有 Identity 数据且无 checkpoint 时不进入首次安装导入", async () => {
	const fixture = createFixture({ identityStatus: "ready", eventCount: 1 });

	assert.equal(await fixture.service.initializeEligibility(), "completed");
	assert.equal(await fixture.service.run("not_applicable"), "completed");
	assert.equal(fixture.adopted.length, 0);
	assert.equal(fixture.meta.has(HISTORICAL_IDENTITY_BOOTSTRAP_META_KEY), false);
});

test("完成 checkpoint 对应的 Catalog 仍有未绑定 Memo 时自动恢复首次导入", async () => {
	const fixture = createFixture();
	await fixture.service.initializeEligibility();
	await fixture.service.run("not_applicable");
	fixture.resetIdentity("ready", 1, "identity-new-memo");
	const restarted = fixture.createService();

	assert.equal(await restarted.initializeEligibility(), "completed");
	assert.equal(await restarted.run("not_applicable"), "completed");
	assert.deepEqual(fixture.adopted, [...fixture.observations, ...fixture.observations]);
	assert.equal(
		(fixture.meta.get(HISTORICAL_IDENTITY_BOOTSTRAP_META_KEY) as { identityRevision: string }).identityRevision,
		"identity-1",
	);
});

test("完成 checkpoint 但 Identity 已空时初始化立即回到 pending", async () => {
	const fixture = createFixture();
	await fixture.service.initializeEligibility();
	await fixture.service.run("not_applicable");
	fixture.resetIdentity("absent", 0, "identity-empty");
	const restarted = fixture.createService();

	assert.equal(await restarted.initializeEligibility(), "pending");
	assert.equal(await restarted.run("not_applicable"), "completed");
	assert.deepEqual(fixture.adopted, [...fixture.observations, ...fixture.observations]);
});

test("旧完成 checkpoint 缺少事件数时会恢复未绑定历史 Memo", async () => {
	const fixture = createFixture();
	await fixture.service.initializeEligibility();
	await fixture.service.run("not_applicable");
	delete (fixture.meta.get(HISTORICAL_IDENTITY_BOOTSTRAP_META_KEY) as { identityEventCount?: number }).identityEventCount;
	fixture.resetIdentity("ready", 1, "identity-new-memo");
	const restarted = fixture.createService();

	assert.equal(await restarted.initializeEligibility(), "pending");
	assert.equal(await restarted.run("not_applicable"), "completed");
	assert.deepEqual(fixture.adopted, [...fixture.observations, ...fixture.observations]);
});

test("完成 checkpoint 后 Catalog 已变化时不批量采用后来新增的 Daily Memo", async () => {
	const fixture = createFixture();
	await fixture.service.initializeEligibility();
	await fixture.service.run("not_applicable");
	fixture.addObservation(makeObservation(3));
	const restarted = fixture.createService();

	assert.equal(await restarted.initializeEligibility(), "completed");
	assert.equal(await restarted.run("not_applicable"), "completed");
	assert.deepEqual(fixture.adopted, fixture.observations.slice(0, 2));
});

test("完成 checkpoint 后有正常新增 Identity 事件时不触发历史全库导入", async () => {
	const fixture = createFixture();
	await fixture.service.initializeEligibility();
	await fixture.service.run("not_applicable");
	fixture.addObservation(makeObservation(3));
	fixture.addIdentityEvent("identity-2");
	const restarted = fixture.createService();

	assert.equal(await restarted.initializeEligibility(), "completed");
	assert.equal(await restarted.run("not_applicable"), "completed");
	assert.deepEqual(fixture.adopted, fixture.observations.slice(0, 2));
});

function createFixture(options: {
	coverageKind?: "partial" | "complete";
	identityStatus?: "absent" | "ready";
	eventCount?: number;
} = {}) {
	const observations = [makeObservation(1), makeObservation(2)];
	let batches: CatalogFileRevisionBatch<MemoObservation>[] = [{
		file: {
			sourcePath: "Daily/2026-08-22.md",
			sourceRevision: "revision-1",
			logicalDate: "2026-08-22",
			mtime: 1,
			size: 1,
			parserVersion: 1,
			settingsFingerprint: "settings-1",
			observationCount: observations.length,
			auditedAt: 1,
		},
		observations,
		catalogRevision: 1,
	}];
	const snapshot: IdentityLedgerSnapshot = {
		revision: "empty",
		eventCount: options.eventCount ?? 0,
		memos: {},
		pendingIntents: [],
		quarantinedEventIds: [],
	};
	let identityStatus = options.identityStatus ?? "absent";
	const identifiedStartLines = new Set<number>();
	const meta = new Map<string, any>();
	const adopted: MemoObservation[] = [];
	const target = {
		getStatus: () => identityStatus,
		getSnapshot: () => snapshot,
		resolveObservationState: (observation: MemoObservation) => identifiedStartLines.has(observation.startLine)
			? { kind: "identified" as const, binding: makeBinding(observation, snapshot.revision) }
			: { kind: "unbound" as const },
		adoptHistoricalObservations: async (incoming: readonly MemoObservation[]) => {
			adopted.push(...incoming);
			incoming.forEach((observation: MemoObservation) => identifiedStartLines.add(observation.startLine));
			identityStatus = "ready";
			snapshot.revision = "identity-1";
			snapshot.eventCount = incoming.length;
			return { importedEventCount: incoming.length, identityRevision: snapshot.revision, memoIds: ["memo-1", "memo-2"] };
		},
	};
	const createService = () => new HistoricalIdentityBootstrapService(target, {
		getCatalogCoverage: async () => ({
			kind: options.coverageKind ?? "complete",
			coveredFromDate: "2026-08-22",
			pendingFileCount: 0,
			coveredFileCount: 1,
			totalFileCount: 1,
		}),
		getCatalogLifecycle: () => ({ state: "ready", persistent: true, writable: true, reason: null }),
		getObservationBatches: async () => batches,
		checkpointStore: {
			getMeta: async <T>(key: string) => (meta.get(key) as T | undefined) ?? null,
			setMeta: async (key: string, value: unknown) => { meta.set(key, value); },
		},
	});
	const service = createService();
	return {
		service,
		createService,
		observations,
		adopted,
		meta,
		resetIdentity: (nextStatus: "absent" | "ready", eventCount: number, revision: string) => {
			identityStatus = nextStatus;
			snapshot.eventCount = eventCount;
			snapshot.revision = revision;
			identifiedStartLines.clear();
		},
		addObservation: (observation: MemoObservation) => {
			observations.push(observation);
			batches = [{
				...batches[0]!,
				file: { ...batches[0]!.file, sourceRevision: "revision-2", observationCount: observations.length },
				observations: [...observations],
			}];
		},
		addIdentityEvent: (revision: string) => {
			identityStatus = "ready";
			snapshot.eventCount += 1;
			snapshot.revision = revision;
		},
	};
}

function makeBinding(observation: MemoObservation, identityRevision: string): IdentityLedgerBinding {
	return {
		memoId: `memo-${observation.startLine}`,
		bindingId: `binding-${observation.startLine}`,
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

function makeObservation(startLine: number): MemoObservation {
	return {
		sourcePath: "Daily/2026-08-22.md",
		sourceRevision: "revision-1",
		startLine,
		endLine: startLine,
		rawBlockHash: `raw-${startLine}`,
		logicalDate: "2026-08-22",
		section: "## Memos",
		time: startLine === 1 ? "09:00" : "09:00:01",
		content: `正文 ${startLine}`,
		contentHash: `content-${startLine}`,
		existingBlockId: null,
		tags: [],
		links: [],
		images: [],
		tasks: [],
		timeBuoyDates: [],
	};
}
