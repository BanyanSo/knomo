import test from "node:test";
import assert from "node:assert/strict";
import type { Plugin } from "obsidian";
import { BeaconService, BeaconSourceUnavailableError, BeaconSourceUnlocatedError, type BeaconSource } from "../src/services/BeaconService";
import { PluginDataStore } from "../src/services/PluginDataStore";
import { DiaryMemoParser } from "../src/services/DiaryMemoParser";
import { createDailyMemoBodyProof, observationHandleKey, type ConfirmedDailyMemoPresentation } from "../src/services/DailyMemoPresentationChange";
import { buildPluginDataWithBeacon, buildPluginDataWithSettings, getBeaconData, parseBeaconReference } from "../src/utils/pluginData";
import { sameBeaconHandle, type BeaconReference } from "../src/types/beacon";
import type { ObservationHandle, MemoObservation } from "../src/types/catalog";
import { createReferenceMemo } from "./helpers/referenceMemo";
import { buildBeaconPresentation } from "../src/ui/BeaconPresentation";
import { toCatalogMemoView } from "../src/types/memoView";

const PATH = "Daily/2026-11-16.md", DATE = "2026-11-16";
const BODY = "## Memos\n- 08:30 first\n- 08:30 same ^duplicate\n- 08:30 same ^duplicate\n";

test("灯标只保存一条引用，缺省、损坏字段与旧 settings 封装不丢失其它数据", async () => {
	const h = await fixture();
	assert.equal(h.service.getSnapshot().state, "unset");
	await h.service.set(h.source.observations[0]!);
	const ref = parseBeaconReference(getBeaconData(h.data));
	assert.ok(ref?.bodyProof);
	assert.equal("content" in ref, false);
	assert.deepEqual(h.data.unknown, { keep: true });
	assert.deepEqual(h.data.shuffleDayHistory, []);
	const wrapped = buildPluginDataWithBeacon({ memoTimeFormat: "HH:mm" }, ref);
	assert.deepEqual(wrapped.settings, { memoTimeFormat: "HH:mm" });
	assert.deepEqual(buildPluginDataWithSettings(h.data, { test: 1 } as never).beacon, ref);
	assert.equal(parseBeaconReference({ ...ref, logicalDate: "2026-02-30" }), null);
	assert.equal(parseBeaconReference({ ...ref, handle: { ...ref.handle, sourcePath: "../a.md" } }), null);
	assert.equal(parseBeaconReference({ ...ref, bodyProof: { digest: "bad", startLine: 0 } }), null);
	assert.deepEqual(parseBeaconReference({ ...ref, bodyProof: undefined }), { handle: ref.handle, logicalDate: DATE });
	assert.equal(getBeaconData(buildPluginDataWithBeacon(h.data, undefined)), undefined);
});

test("保存成功前不切换；失败保留原选择且释放后续操作队列", async () => {
	const h = await fixture();
	await h.service.set(h.source.observations[0]!);
	const old = structuredClone(h.data.beacon);
	h.failSave = true;
	const bad = h.service.set(h.source.observations[1]!);
	const good = h.service.set(h.source.observations[2]!);
	assert.deepEqual(h.data.beacon, old);
	await assert.rejects(bad, /save failed/u);
	await good;
	assert.equal(h.service.getSnapshot().memo?.catalog?.observationHandle.startLine, h.source.observations[2]!.startLine);
	assert.ok(sameBeaconHandle(parseBeaconReference(h.data.beacon)!.handle, h.source.observations[2]!));
});

test("设置写盘期间源正文变化，保存完成后重新校验且不发布旧卡片", async () => {
	for (const notify of [false, true]) {
		const h = await fixture(); await h.service.set(h.source.observations[0]!);
		const target = pickHandle(h.source.observations[1]!);
		const gate = deferred<void>(), saving = deferred<void>();
		h.saveGate = gate.promise; h.onSaving = () => saving.resolve();
		const setting = h.service.set(target); await saving.promise;
		await h.write(BODY.replace("same ^duplicate", "changed ^duplicate"));
		const published: ObservationHandle[] = [];
		h.service.subscribe(() => {
			const handle = h.service.getSnapshot().memo?.catalog?.observationHandle;
			if (handle) published.push(handle);
		});
		if (notify) h.service.sourceChanged(PATH);
		h.saveGate = undefined; gate.resolve(); await setting;
		assert.equal(published.some(handle => sameBeaconHandle(handle, target)), false);
		assert.equal(h.service.getSnapshot().reason, "unlocated");
		assert.equal(h.service.getSnapshot().memo, undefined);
		assert.ok(sameBeaconHandle(parseBeaconReference(h.data.beacon)!.handle, target));
	}
});

test("设置写盘期间已观察删除，同路径重建不能继承；首次选择和不同 Daily 同样受保护", async () => {
	for (const previous of ["unset", "same-daily", "other-daily"] as const) for (const recreateBeforeSave of [false, true]) {
		const h = await fixture();
		if (previous !== "unset") await h.service.set(h.source.observations[0]!);
		const path = previous === "other-daily" ? "Daily/2026-11-15.md" : PATH;
		const date = previous === "other-daily" ? "2026-11-15" : DATE;
		if (previous === "other-daily") await h.write(BODY, path, date);
		const target = pickHandle(h.source.observations[1]!);
		const gate = deferred<void>(), saving = deferred<void>();
		h.saveGate = gate.promise; h.onSaving = () => saving.resolve();
		const setting = h.service.set(target); await saving.promise;
		h.sourceError = new BeaconSourceUnlocatedError();
		h.service.sourceChanged(path, "delete");
		if (recreateBeforeSave) {
			h.sourceError = undefined; await h.write(BODY, path, date); h.service.sourceChanged(path);
		}
		const published: ObservationHandle[] = [];
		h.service.subscribe(() => {
			const handle = h.service.getSnapshot().memo?.catalog?.observationHandle;
			if (handle) published.push(handle);
		});
		h.saveGate = undefined; gate.resolve(); await setting;
		h.sourceError = undefined; await h.write(BODY, path, date);
		h.service.sourceChanged(path); await h.service.refresh();
		assert.equal(published.some(handle => sameBeaconHandle(handle, target)), false, `${previous}, recreateBeforeSave=${recreateBeforeSave}`);
		assert.equal(h.service.getSnapshot().reason, "unlocated");
		assert.equal(h.service.getSnapshot().memo, undefined);
		assert.ok(sameBeaconHandle(parseBeaconReference(h.data.beacon)!.handle, target));
		await h.service.reload(); assert.equal(h.service.getSnapshot().reason, "unlocated");
		await h.service.set(h.source.observations[1]!); assert.equal(h.service.getSnapshot().state, "ready");
	}
});

test("设置写盘期间仅文件头变化可重新取得当前灯标，旧来源删除不污染新来源", async () => {
	for (const otherDaily of [false, true]) {
		const h = await fixture(); await h.service.set(h.source.observations[0]!);
		if (otherDaily) await h.write(BODY, "Daily/2026-11-15.md", "2026-11-15");
		const target = pickHandle(h.source.observations[1]!);
		const gate = deferred<void>(), saving = deferred<void>();
		h.saveGate = gate.promise; h.onSaving = () => saving.resolve();
		const setting = h.service.set(target); await saving.promise;
		if (otherDaily) h.service.sourceChanged(PATH, "delete");
		else { await h.write("---\ntitle: header\n---\n" + BODY); h.service.sourceChanged(PATH); }
		h.saveGate = undefined; gate.resolve(); await setting;
		assert.equal(h.service.getSnapshot().state, "ready");
		assert.ok(sameBeaconHandle(h.service.getSnapshot().memo!.catalog!.observationHandle, h.source.observations[1]!));
		assert.ok(sameBeaconHandle(parseBeaconReference(h.data.beacon)!.handle, h.source.observations[1]!));
	}
});

test("设置写盘期间收到改名只跟随明确新路径，改名后删除再重建旧路径不能继承", async () => {
	for (const deleted of [false, true]) {
		const h = await fixture();
		const target = pickHandle(h.source.observations[1]!);
		const gate = deferred<void>(), saving = deferred<void>();
		h.saveGate = gate.promise; h.onSaving = () => saving.resolve();
		const setting = h.service.set(target); await saving.promise;
		const renamed = "Archive/2026-11-16.md";
		await h.write(BODY, renamed); h.service.sourceChanged(PATH, "rename", renamed);
		if (deleted) {
			h.service.sourceChanged(renamed, "delete");
			await h.write(BODY); h.service.sourceChanged(PATH);
		}
		h.saveGate = undefined; gate.resolve(); await setting;
		assert.equal(h.service.getSnapshot().state, deleted ? "unavailable" : "ready");
		if (deleted) assert.equal(h.service.getSnapshot().memo, undefined);
		else {
			assert.equal(h.service.getSnapshot().memo?.dailyRef.path, renamed);
			assert.equal(parseBeaconReference(h.data.beacon)!.handle.sourcePath, renamed);
		}
	}
});

test("共享存储与连续设置、移除按触发顺序处理，旧菜单及旧提示不移除新选择", async () => {
	const h = await fixture();
	await h.service.set(h.source.observations[0]!);
	const oldMenu = h.service.getSnapshot().selection, oldStatus = oldMenu;
	const snapshots: number[] = [];
	const off = h.service.subscribe(() => snapshots.push(h.service.getSnapshot().selection));
	await Promise.all([
		h.service.set(h.source.observations[1]!),
		h.store.mutate(data => ({ nextData: { ...(data as object), other: "saved concurrently" }, result: undefined })),
		h.service.remove(oldMenu), h.service.remove(oldStatus),
	]);
	assert.equal(h.data.other, "saved concurrently");
	assert.ok(sameBeaconHandle(parseBeaconReference(h.data.beacon)!.handle, h.source.observations[1]!));
	assert.ok(snapshots.length >= 2);
	await h.service.remove(h.service.getSnapshot().selection);
	assert.equal(h.service.getSnapshot().state, "unset");
	assert.equal("beacon" in h.data, false);
	off();
});

test("共享读改写再次核对磁盘选择，外部替换后的旧移除不会覆盖它", async () => {
	const h = await fixture();
	await h.service.set(h.source.observations[0]!);
	const token = h.service.getSnapshot().selection;
	h.data.beacon = reference(h.source.observations[1]!, h.source);
	await h.service.remove(token);
	assert.ok(sameBeaconHandle(parseBeaconReference(h.data.beacon)!.handle, h.source.observations[1]!));
	assert.equal(h.service.getSnapshot().memo?.catalog?.observationHandle.startLine, h.source.observations[1]!.startLine);
});

test("损坏引用不自动重写，无可信日期；用户可明确移除或替换", async () => {
	const h = await fixture({ beacon: { handle: "bad", logicalDate: "wrong" }, settings: {}, unknown: true });
	assert.equal(h.service.getSnapshot().state, "unavailable");
	assert.equal(h.service.getSnapshot().logicalDate, undefined);
	await h.service.refresh();
	assert.deepEqual(h.data.beacon, { handle: "bad", logicalDate: "wrong" });
	await h.service.set(h.source.observations[0]!);
	assert.equal(h.service.getSnapshot().state, "ready");
	h.data.beacon = { bad: 1 };
	await h.service.reload();
	await h.service.remove(h.service.getSnapshot().selection);
	assert.equal(h.data.unknown, true);
	assert.equal(h.service.getSnapshot().state, "unset");
});

test("data.json 读取失败暂停灯标变更，恢复重载后重新校验", async () => {
	const h = await fixture();
	await h.service.set(h.source.observations[0]!);
	const previous = structuredClone(h.data);
	h.failRead = true;
	await h.service.reload();
	assert.equal(h.service.getSnapshot().reason, "unreadable");
	await assert.rejects(h.service.set(h.source.observations[1]!));
	await assert.rejects(h.service.remove(h.service.getSnapshot().selection));
	assert.deepEqual(h.data, previous);
	h.failRead = false;
	await h.service.reload();
	assert.equal(h.service.getSnapshot().state, "ready");
});

test("设置只接受当前完整 Observation，不能用同文、旧行号或 Block ID 代替", async () => {
	const h = await fixture();
	const original = h.source.observations[1]!;
	for (const patch of [{ endLine: 100 }, { rawBlockHash: "fnv1a-00000000" }, { sourceRevision: "0".repeat(64) }]) {
		await assert.rejects(h.service.set({ ...original, ...patch }));
		assert.equal(h.service.getSnapshot().state, "unset");
	}
	await h.service.set(original);
	assert.ok(sameBeaconHandle(parseBeaconReference(h.data.beacon)!.handle, original));
});

test("重新启动验证未变源；仅文件头变化通过完整正文证明按相对区间跟随", async () => {
	const h = await fixture();
	await h.service.set(h.source.observations[2]!);
	const saved = parseBeaconReference(structuredClone(h.data.beacon))!;
	await h.write("---\ntitle: header\n---\n" + BODY);
	await h.service.reload();
	assert.equal(h.service.getSnapshot().state, "ready");
	assert.equal(parseBeaconReference(h.data.beacon)!.handle.startLine, h.source.observations[2]!.startLine);
	assert.notEqual(parseBeaconReference(h.data.beacon)!.handle.sourceRevision, saved.handle.sourceRevision);
	assert.equal(h.service.getSnapshot().memo?.contentSnapshot, "same");
});

test("外部正文增删、改写、重排不靠唯一同文恢复；来源暂不可读不清空选择", async () => {
	for (const body of [BODY + "- 09:00 neighbor\n", BODY.replace("first", "edited"), BODY.replace("- 08:30 first\n", "")]) {
		const h = await fixture();
		await h.service.set(h.source.observations[2]!);
		const saved = structuredClone(h.data.beacon);
		await h.write(body);
		h.service.sourceChanged(PATH);
		assert.equal(h.service.getSnapshot().memo, undefined);
		await h.service.refresh();
		assert.equal(h.service.getSnapshot().reason, "unlocated");
		assert.deepEqual(h.data.beacon, saved);
	}
	const h = await fixture();
	await h.service.set(h.source.observations[0]!);
	h.sourceError = new BeaconSourceUnavailableError(); h.service.sourceChanged(PATH);
	await h.service.refresh(); assert.equal(h.service.getSnapshot().reason, "unreadable");
	assert.ok(h.data.beacon);
	h.sourceError = undefined; await h.service.refresh(); assert.equal(h.service.getSnapshot().state, "ready");
});

test("无正文摘要的旧引用仅接受同 revision；Catalog 落后只定位不显示旧正文", async () => {
	const h = await fixture();
	h.data.beacon = { handle: pickHandle(h.source.observations[0]!), logicalDate: DATE };
	await h.service.reload(); assert.equal(h.service.getSnapshot().state, "ready");
	h.catalogReady = false; h.service.sourceChanged(PATH); await h.service.refresh();
	assert.equal(h.service.getSnapshot().state, "locating");
	assert.equal(h.service.getSnapshot().memo, undefined);
	h.catalogReady = true; await h.service.refresh(); assert.equal(h.service.getSnapshot().state, "ready");
	// 校验成功会补上与当前 revision 一致的摘要；显式缺省摘要后不能跨 revision。
	h.data.beacon = { handle: pickHandle(h.source.observations[0]!), logicalDate: DATE };
	await h.write("---\na: b\n---\n" + BODY); await h.service.reload();
	assert.equal(h.service.getSnapshot().reason, "unlocated");
});

test("明确删除事件后同路径重建不能继承，暂时缺失恢复仍可校验", async () => {
	const h = await fixture();
	await h.service.set(h.source.observations[0]!);
	h.service.sourceChanged(PATH, "delete");
	await h.write(BODY); h.service.sourceChanged(PATH); await h.service.refresh();
	assert.equal(h.service.getSnapshot().reason, "unlocated");
	assert.ok(h.data.beacon);
	await h.service.set(h.source.observations[0]!); assert.equal(h.service.getSnapshot().state, "ready");
});

test("明确改名只在同 Daily 日期和源证明有效时跟随，不猜测重启期间改名", async () => {
	const h = await fixture();
	await h.service.set(h.source.observations[1]!);
	const renamed = "Archive/2026-11-16.md";
	await h.write(BODY, renamed);
	h.service.sourceChanged(PATH, "rename", renamed); await h.service.refresh();
	assert.equal(h.service.getSnapshot().state, "ready");
	assert.equal(parseBeaconReference(h.data.beacon)!.handle.sourcePath, renamed);
	h.service.sourceChanged(renamed, "rename", "Archive/2026-11-17.md");
	await h.write(BODY, "Archive/2026-11-17.md", "2026-11-17"); await h.service.refresh();
	assert.equal(h.service.getSnapshot().reason, "unlocated");
	assert.equal(parseBeaconReference(h.data.beacon)!.handle.sourcePath, renamed);
});

test("内部提交连续映射跟随目标与同文邻项；空映射保留，只有确认删除目标才清理", async () => {
	const h = await fixture();
	await h.service.set(h.source.observations[2]!);
	let before = h.source;
	await h.write(BODY.replace("first", "changed\n  second line"));
	h.service.confirmed(await change(before, h.source)); await h.service.refresh();
	assert.equal(h.service.getSnapshot().state, "ready");
	assert.ok(sameBeaconHandle(parseBeaconReference(h.data.beacon)!.handle, h.source.observations[2]!));
	before = h.source;
	const selected = before.observations[2]!;
	await h.write(BODY.replace("- 08:30 first\n", ""));
	const ambiguous = await change(before, h.source, true);
	h.service.confirmed(ambiguous, before.observations[0]); await h.service.refresh();
	assert.equal(h.service.getSnapshot().reason, "unlocated");
	assert.ok(sameBeaconHandle(parseBeaconReference(h.data.beacon)!.handle, selected));
	await h.service.set(h.source.observations[1]!);
	before = h.source;
	const removed = before.observations[1]!;
	await h.write("## Memos\n- 08:30 same ^duplicate\n");
	h.service.sourceChanged(PATH);
	h.service.confirmed(await change(before, h.source, true), removed); await h.service.refresh();
	assert.equal(h.service.getSnapshot().state, "unset");
	assert.equal(h.data.beacon, undefined);
});

test("Daily 已提交而引用保存或删除清理失败，不回滚正文；本 runtime 条件重试", async () => {
	const h = await fixture();
	await h.service.set(h.source.observations[0]!);
	const before = h.source, saved = structuredClone(h.data.beacon);
	await h.write(BODY.replace("first", "committed"));
	h.failSave = true;
	h.service.confirmed(await change(before, h.source)); await h.service.refresh();
	assert.deepEqual(h.data.beacon, saved);
	assert.equal(h.service.getSnapshot().memo?.contentSnapshot, "committed");
	assert.equal(h.failures.length, 1);
	await h.service.refresh(); assert.notDeepEqual(h.data.beacon, saved);
	const beforeDelete = h.source;
	await h.write("## Memos\n"); h.failSave = true;
	h.service.confirmed(await change(beforeDelete, h.source, true), beforeDelete.observations[0]);
	await h.service.refresh(); assert.ok(h.data.beacon); assert.equal(h.service.getSnapshot().memo, undefined);
	await h.service.refresh(); assert.equal(h.data.beacon, undefined);
});

test("旧查询、内部映射和重试晚到不覆盖用户后来确认的选择或外部重载", async () => {
	const h = await fixture();
	await h.service.set(h.source.observations[0]!);
	const gate = deferred<BeaconSource>(); h.nextSource = gate.promise;
	h.service.sourceChanged(PATH); const old = h.service.refresh();
	await h.service.set(h.source.observations[1]!);
	gate.resolve(h.source); await old;
	assert.equal(h.service.getSnapshot().memo?.catalog?.observationHandle.startLine, h.source.observations[1]!.startLine);
	const before = h.source; await h.write(BODY.replace("first", "committed"));
	h.failSave = true; h.service.confirmed(await change(before, h.source)); await h.service.refresh();
	await h.service.set(h.source.observations[2]!); await h.service.refresh();
	assert.ok(sameBeaconHandle(parseBeaconReference(h.data.beacon)!.handle, h.source.observations[2]!));
	h.data.beacon = reference(h.source.observations[0]!, h.source); await h.service.reload();
	assert.ok(sameBeaconHandle(h.service.getSnapshot().memo!.catalog!.observationHandle, h.source.observations[0]!));
});

test("默认流只按完整当前句柄去重，等待同文件旧卡，保留同文邻项与外部窗口", async () => {
	const h = await fixture(); await h.service.set(h.source.observations[1]!);
	const memos = h.source.observations.map(item => toCatalogMemoView(catalogItem(item)));
	const snapshot = h.service.getSnapshot();
	assert.deepEqual(buildBeaconPresentation(snapshot, memos).memos.map(memo => memo.id), [memos[1]!.id, memos[0]!.id, memos[2]!.id]);
	assert.equal(buildBeaconPresentation(snapshot, [memos[1]!]).memos.length, 1);
	assert.equal(buildBeaconPresentation({ ...snapshot, previousSources: [{ sourcePath: PATH, sourceRevision: h.source.sourceRevision }] }, memos).snapshot.state, "ready");
	const renamedOld = structuredClone(memos[1]!); renamedOld.catalog!.observationHandle.sourcePath = "Old/2026-11-16.md";
	const renamedSnapshot = { ...snapshot, previousSources: [{ sourcePath: "Old/2026-11-16.md", sourceRevision: h.source.sourceRevision }] };
	assert.equal(buildBeaconPresentation(renamedSnapshot, [renamedOld]).snapshot.state, "locating");
	renamedOld.catalog!.observationHandle.sourceRevision = "0".repeat(64);
	assert.equal(buildBeaconPresentation(renamedSnapshot, [renamedOld]).snapshot.state, "ready");
	assert.equal(buildBeaconPresentation(snapshot, []).memos.length, 1);
	const old = structuredClone(memos[2]!); old.catalog!.observationHandle.sourceRevision = "0".repeat(64);
	assert.equal(buildBeaconPresentation(snapshot, [old]).snapshot.state, "locating");
	assert.deepEqual(buildBeaconPresentation(snapshot, [old]).memos, [old]);
	assert.equal(buildBeaconPresentation({ state: "unavailable", selection: 1 }, memos).memos.length, 3);
	const malformed = structuredClone(memos[1]!); malformed.catalog!.observationHandle.endLine++;
	assert.equal(buildBeaconPresentation(snapshot, [malformed]).memos.length, 2);
});

test("无灯标不额外读取，销毁或配置变化使旧异步结果失效", async () => {
	const h = await fixture(); await h.service.refresh(); assert.equal(h.reads, 0);
	await h.service.set(h.source.observations[0]!);
	const gate = deferred<BeaconSource>(); h.nextSource = gate.promise;
	h.service.sourceChanged(PATH); const pending = h.service.refresh();
	h.service.configurationChanged(); gate.resolve(h.source); await pending;
	assert.equal(h.service.getSnapshot().state, "locating");
	h.sourceError = new BeaconSourceUnlocatedError(); await h.service.refresh();
	assert.equal(h.service.getSnapshot().reason, "unlocated");
	h.service.dispose(); await assert.rejects(h.service.set(h.source.observations[0]!));
});

test("相同磁盘引用重载保留本 runtime 未保存的映射和删除清理，外部换选则丢弃", async () => {
	for (const clear of [false, true]) {
		const h = await fixture(); await h.service.set(h.source.observations[0]!);
		const before = h.source;
		await h.write(clear ? "## Memos\n" : BODY.replace("first", "changed"));
		h.failSave = true;
		h.service.confirmed(await change(before, h.source, clear), clear ? before.observations[0] : undefined);
		await h.service.refresh(); assert.ok(h.data.beacon);
		h.failRead = true; await h.service.reload(); h.failRead = false;
		await h.service.reload();
		assert.equal(h.service.getSnapshot().state, clear ? "unset" : "ready");
		if (clear) assert.equal(h.data.beacon, undefined);
		else assert.equal(h.service.getSnapshot().memo?.contentSnapshot, "changed");
	}
});

test("内部引用保存进行中触发移除或下一次提交，接住已落盘的 CAS 前值", async () => {
	for (const next of ["remove", "commit"] as const) {
		const h = await fixture(); await h.service.set(h.source.observations[0]!);
		const token = h.service.getSnapshot().selection, before = h.source;
		await h.write(BODY.replace("first", "first commit"));
		const gate = deferred<void>(), saving = deferred<void>(); h.saveGate = gate.promise; h.onSaving = () => saving.resolve();
		h.service.confirmed(await change(before, h.source)); const first = h.service.refresh();
		await saving.promise;
		let later: Promise<void>;
		if (next === "remove") later = h.service.remove(token);
		else {
			const intermediate = h.source; await h.write(BODY.replace("first", "second commit"));
			h.service.confirmed(await change(intermediate, h.source)); later = h.service.refresh();
		}
		h.saveGate = undefined; gate.resolve(); await Promise.all([first, later]);
		assert.equal(h.service.getSnapshot().state, next === "remove" ? "unset" : "ready");
		if (next === "remove") assert.equal(h.data.beacon, undefined);
		else {
			assert.equal(h.service.getSnapshot().memo?.contentSnapshot, "second commit");
			assert.equal(parseBeaconReference(h.data.beacon)!.handle.sourceRevision, h.source.sourceRevision);
		}
	}
});

function catalogItem(observation: MemoObservation) {
	const base = createReferenceMemo().catalog!;
	const handle = pickHandle(observation), key = observationHandleKey(handle);
	const current = { ...base.observation, ...observation, observationKey: key, createdAtKey: DATE + "T" + observation.time };
	return { ...base, key, renderKey: key, observationHandle: handle, observation: current,
		resolved: { ...base.resolved, observation: current }, content: observation.content, createdAt: observation.logicalDate + "T" + observation.time,
		sourcePath: observation.sourcePath, timeBuoyDates: observation.timeBuoyDates, tasks: observation.tasks };
}

function pickHandle(h: ObservationHandle): ObservationHandle {
	return { sourcePath: h.sourcePath, sourceRevision: h.sourceRevision, startLine: h.startLine, endLine: h.endLine, rawBlockHash: h.rawBlockHash };
}
function reference(handle: ObservationHandle, source: BeaconSource): BeaconReference {
	return { handle: pickHandle(handle), logicalDate: source.logicalDate, bodyProof: source.bodyProof };
}
async function change(before: BeaconSource, after: BeaconSource, missing = false): Promise<ConfirmedDailyMemoPresentation> {
	return { change: { sourcePath: before.path, beforeSourceRevision: before.sourceRevision, sourceRevision: after.sourceRevision,
		logicalDate: after.logicalDate, replacements: before.observations.map((item, index) => ({ before: pickHandle(item), after: missing ? null : after.observations[index] ? pickHandle(after.observations[index]!) : null })),
		inserted: null, changed: null }, observations: after.observations, bodyProof: after.bodyProof };
}
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { resolve, promise }; }

async function fixture(initial: Record<string, unknown> = { settings: {}, unknown: { keep: true }, shuffleDayHistory: [] }) {
	const parser = new DiaryMemoParser();
	const h = { data: structuredClone(initial), failRead: false, failSave: false, reads: 0, failures: [] as unknown[],
		saveGate: undefined as Promise<void> | undefined, onSaving: undefined as (() => void) | undefined,
		source: null as unknown as BeaconSource, nextSource: undefined as Promise<BeaconSource> | undefined,
		sourceError: undefined as Error | undefined, catalogReady: true,
		write: async (content: string, path = PATH, logicalDate = DATE) => {
			const parsed = await parser.parse({ sourcePath: path, logicalDate, bytes: new TextEncoder().encode(content) });
			h.source = { path, logicalDate, ...parsed, bodyProof: await createDailyMemoBodyProof(content) };
		} };
	await h.write(BODY);
	const plugin = { loadData: async () => { if (h.failRead) throw new Error("read failed"); return structuredClone(h.data); },
		saveData: async (data: Record<string, unknown>) => { if (h.failSave) { h.failSave = false; throw new Error("save failed"); }
			h.onSaving?.(); await h.saveGate; h.data = structuredClone(data); } } as unknown as Plugin;
	const store = new PluginDataStore(plugin);
	const service = new BeaconService(store, {
		readSource: async path => { h.reads++; if (h.nextSource) { const promise = h.nextSource; h.nextSource = undefined; return promise; }
			if (h.sourceError) throw h.sourceError; if (path !== h.source.path) throw new BeaconSourceUnavailableError(); return h.source; },
		isSourceCurrent: async source => source.sourceRevision === h.source.sourceRevision && source.path === h.source.path,
		readMemo: async handle => { const observation = h.source.observations.find(item => sameBeaconHandle(item, handle)); return h.catalogReady && observation ? catalogItem(observation) : null; },
		onFailure: error => h.failures.push(error),
	});
	await service.reload();
	return Object.assign(h, { store, service });
}
