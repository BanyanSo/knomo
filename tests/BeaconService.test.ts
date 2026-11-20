import test from "node:test";
import assert from "node:assert/strict";
import type { Plugin } from "obsidian";
import { BeaconService, BeaconNotSavedError, type BeaconSource } from "../src/services/BeaconService";
import { PluginDataStore } from "../src/services/PluginDataStore";
import { DiaryMemoParser } from "../src/services/DiaryMemoParser";
import type { ConfirmedDailyMemoPresentation } from "../src/services/DailyMemoPresentationChange";
import { buildPluginDataWithBeacon, buildPluginDataWithSettings, parseBeaconReference } from "../src/utils/pluginData";
import { sameBeaconHandle } from "../src/types/beacon";
import type { ObservationHandle, MemoObservation } from "../src/types/catalog";
import { createCatalogCapabilities } from "../src/services/MemoCapabilityModel";
import { buildBeaconPresentation } from "../src/ui/BeaconPresentation";
import { toCatalogMemoView } from "../src/types/memoView";
import { ensureObsidianStub } from "./helpers/obsidianStub";

const PATH = "Daily/2026-11-16.md", DATE = "2026-11-16";
const BODY = "## Memos\n- 08:00 neighbor ^first\n- 09:00 selected ^selected\n- 10:00 tail ^tail\n";

test("仅保存路径、原生 ID 和实际时间，保留其它插件数据及时间精度", async () => {
	const h = await fixture();
	assert.equal(h.service.getSnapshot().state, "unset");
	await h.service.set(h.source.observations[1]!);
	const ref = { sourcePath: PATH, blockId: "selected", memoTime: "09:00" };
	assert.deepEqual(h.data.beacon, ref);
	assert.deepEqual(h.data.unknown, { keep: true });
	assert.deepEqual(buildPluginDataWithSettings(h.data, { test: 1 } as never).beacon, ref);
	assert.deepEqual(buildPluginDataWithBeacon({ memoTimeFormat: "HH:mm" }, ref).settings, { memoTimeFormat: "HH:mm" });
	assert.deepEqual(parseBeaconReference({ ...ref, memoTime: "09:00:17" }), { ...ref, memoTime: "09:00:17" });
	for (const code of [0, 10, 31]) {
		assert.equal(parseBeaconReference({ ...ref, sourcePath: `Daily/a${String.fromCharCode(code)}b.md` }), null);
	}
	for (const invalid of [{ ...ref, sourcePath: "../a.md" }, { ...ref, sourcePath: "C:/a.md" }, { ...ref, sourcePath: "/a.md" },
		{ ...ref, sourcePath: "Daily//a.md" }, { ...ref, blockId: "bad_id" }, { ...ref, memoTime: "24:00" },
		{ ...ref, memoTime: "09:60" }, { ...ref, memoTime: "9:00" }, { handle: h.source.observations[1], logicalDate: DATE }]) {
		assert.equal(parseBeaconReference(invalid), null);
	}
});

for (const existing of [false, true]) test(`首次设置${existing ? "复用" : "生成"} ID，自己的 Daily change 不拒绝保存，移除保留锚点`, async () => {
	const h = await fixture(existing ? BODY : BODY.replace(" ^selected", ""));
	await h.service.set(h.source.observations[1]!);
	const ref = parseBeaconReference(h.data.beacon)!;
	assert.equal(ref.blockId, existing ? "selected" : "generated-1");
	assert.equal(h.anchorWrites, existing ? 0 : 1);
	await h.service.set(h.source.observations[1]!);
	assert.equal(h.anchorWrites, existing ? 0 : 1);
	await h.service.remove(h.service.getSnapshot().selection);
	assert.equal(h.data.beacon, undefined);
	assert.match(h.content(), new RegExp("\\^" + ref.blockId));
});

test("原句柄 stale 时拒绝设置，不通过 block ID 换取新句柄", async () => {
	const h = await pinned(); const selected = h.source.observations[1]!, saved = structuredClone(h.data.beacon);
	await h.write(BODY.replace("neighbor", "changed"));
	await assert.rejects(h.service.set(selected), /stale/u);
	assert.deepEqual(h.data.beacon, saved); assert.equal(h.anchorWrites, 0);
});

test("首次锚点写入后真有并发正文修改时，不保存新灯标", async () => {
	const h = await pinned(BODY.replace(" ^tail", ""));
	const oldBeacon = structuredClone(h.data.beacon);
	h.beforeRead = async path => {
		h.beforeRead = undefined;
		await h.write(h.content().replace("tail", "edited elsewhere"), path);
	};
	await assert.rejects(h.service.set(h.source.observations[2]!), /Beacon source changed/u);
	assert.equal(h.anchorWrites, 1);
	assert.match(h.content(), /edited elsewhere \^generated-1/u);
	assert.deepEqual(h.data.beacon, oldBeacon);
});

test("同源 Memo 补锚点时灯标直接交接新版本，后续索引通知保持同一就绪状态", async () => {
	const original = BODY.replace(" ^tail", "");
	const h = await pinned(original), before = h.source;
	const states: string[] = [];
	h.service.subscribe(() => states.push(h.service.getSnapshot().state));
	const after = await h.write(original.replace("tail", "tail ^added"));
	const presentation = change(before, after);
	presentation.change.updateExistingOnly = true;
	const notify = h.service.stageConfirmedAnchor(presentation);
	assert.ok(notify);
	assert.equal(h.service.getSnapshot().memo?.catalog?.observationHandle.sourceRevision, after.sourceRevision);
	assert.deepEqual(states, [], "先让窗格重绑，再发灯标通知");
	notify();
	h.service.observeSource(after);
	await h.service.refreshIfNeeded();
	assert.deepEqual(states, ["ready"]);
});

for (const existing of [false, true]) test(`活动编辑器${existing ? "已有" : "新建"} ID 尚未落盘，保留原灯标并提示保存后重试`, async () => {
	const h = await pinned(); const saved = structuredClone(h.data.beacon);
	await h.write(existing ? BODY.replace("tail", "unsaved tail") : BODY.replace(" ^tail", ""));
	h.unsaved = true;
	await assert.rejects(h.service.set(h.source.observations[2]!), BeaconNotSavedError);
	assert.deepEqual(h.data.beacon, saved);
	h.unsaved = false;
	await h.service.set(h.source.observations[2]!);
	assert.equal(h.service.getSnapshot().memo?.contentSnapshot, existing ? "unsaved tail" : "tail");
});

test("锚点已写入而配置保存失败不回滚 Daily，重试复用同一个 ID", async () => {
	const h = await pinned(BODY.replace(" ^tail", "")), saved = structuredClone(h.data.beacon);
	h.failSave = true;
	await assert.rejects(h.service.set(h.source.observations[2]!), /save/u);
	assert.deepEqual(h.data.beacon, saved); assert.equal(h.anchorWrites, 1);
	h.failSave = false; await h.service.set(h.source.observations[2]!);
	assert.equal(h.anchorWrites, 1); assert.equal(parseBeaconReference(h.data.beacon)!.blockId, "generated-1");
});

for (const body of [
	BODY.replace("selected ^selected", "completely rewritten - [x] task #tag [[Other]] ![[photo.png]] ^selected"),
	BODY.replace("09:00 selected", "17:24:36 selected"),
	BODY.replace("neighbor", "neighbor changed\n  extra").replace("tail", "tail edited"),
	BODY.replace("- 09:00 selected ^selected\n", "") + "## Later\n- 09:00 selected ^selected\n",
	BODY.replace("selected ^selected", "selected ^selected\n- 09:01 new neighbor"),
]) test(`原生锚点跟随当前解析，重启恢复：${body.slice(-70).trim()}`, async () => {
	const h = await pinned(); await h.write(body); h.service.sourceChanged(PATH); await h.service.refresh();
	assert.equal(h.service.getSnapshot().state, "ready");
	const current = h.source.observations.find(item => item.existingBlockId === "selected")!;
	assert.equal(h.service.getSnapshot().memo?.contentSnapshot, current.content);
	assert.equal(parseBeaconReference(h.data.beacon)!.memoTime, current.time);
	assert.equal(h.service.isSelectedHandle(current), true);
	await h.service.reload(); assert.equal(h.service.getSnapshot().memo?.contentSnapshot, current.content);
	assert.equal(h.anchorWrites, 0);
});

for (const [body, reason] of [
	[BODY.replace(" ^selected", ""), "missing-id"],
	[BODY.replace("^selected", "^renamed"), "missing-id"],
	[BODY + "\nNon-memo paragraph ^selected\n", "conflicting-id"],
	[BODY.replace("- 09:00 selected ^selected", "Non-memo paragraph ^selected"), "not-memo"],
] as const) test(`锚点异常 ${reason} 保留配置且不自动写 ID`, async () => {
	const h = await pinned(), saved = structuredClone(h.data.beacon);
	await h.write(body); h.service.sourceChanged(PATH); await h.service.refresh();
	assert.equal(h.service.getSnapshot().state, "unavailable"); assert.equal(h.service.getSnapshot().reason, reason);
	assert.deepEqual(h.data.beacon, saved); assert.equal(h.anchorWrites, 0);
	await h.service.remove(h.service.getSnapshot().selection); assert.equal(h.data.beacon, undefined);
});

test("其它 Daily 同名 ID 不影响当前选择；索引无关的完整解析可先展示且多个 leaf 复用读取", async () => {
	const h = await pinned(); await h.write(BODY, "Daily/2026-11-17.md", "2026-11-17");
	await h.write(BODY.replace("neighbor", "changed")); h.service.sourceChanged(PATH);
	const reads = h.reads; h.service.observeSource(h.source);
	await Promise.all([h.service.refresh(), h.service.refresh(), h.service.refresh()]);
	assert.equal(h.service.getSnapshot().state, "ready"); assert.equal(h.reads, reads);
	assert.equal(h.service.getSnapshot().memo?.dailyRef.path, PATH);
});

test("缺少整文件锚点计数时定向补读，不根据窗口中的唯一 Memo 推断", async () => {
	const h = await pinned(); h.service.configurationChanged();
	h.service.observeSource({ ...h.source, blockAnchors: undefined });
	await h.service.refresh(); assert.equal(h.service.getSnapshot().state, "ready");
	await h.write(BODY + "Non-memo ^selected\n"); h.service.configurationChanged();
	h.service.observeSource({ ...h.source, blockAnchors: undefined });
	await h.service.refresh(); assert.equal(h.service.getSnapshot().reason, "conflicting-id");
});

test("同版确认先展示当前卡片，时间只在变化时条件保存，失败仍显示当前值且可重试", async () => {
	const h = await pinned(), before = h.source, writes = h.writes;
	await h.write(BODY.replace("selected ^selected", "edited ^selected"));
	h.service.confirmed(change(before, h.source)); await h.service.refresh();
	assert.equal(h.service.getSnapshot().memo?.contentSnapshot, "edited"); assert.equal(h.writes, writes);
	const prior = h.source; await h.write(BODY.replace("09:00", "13:14:15")); h.failSave = true;
	h.service.confirmed(change(prior, h.source)); await h.service.refresh();
	assert.equal(h.service.getSnapshot().state, "ready"); assert.match(h.service.getSnapshot().memo!.createdAt, /13:14:15/u);
	assert.equal(parseBeaconReference(h.data.beacon)!.memoTime, "09:00"); assert.equal(h.failures.length, 1);
	h.failSave = false; await h.service.refresh(); assert.equal(parseBeaconReference(h.data.beacon)!.memoTime, "13:14:15");
	const completed = h.writes; await h.service.refresh(); assert.equal(h.writes, completed);
});

for (const kind of ["rename", "delete", "configuration"] as const) test(`设置期间 ${kind} 中断候选，保留原选择`, async () => {
	const h = await pinned(), saved = structuredClone(h.data.beacon);
	h.afterCreate = () => kind === "configuration" ? h.service.configurationChanged() : h.service.sourceChanged(PATH, kind, "Daily/2026-11-17.md");
	await assert.rejects(h.service.set(h.source.observations[2]!)); assert.deepEqual(h.data.beacon, saved);
});

test("设置 B 期间 A 刷新、旧读取晚到，两条源读取不会互相接管", async () => {
	const h = await pinned(); const other = await h.write(BODY.replace("selected", "other"), "Daily/2026-11-17.md", "2026-11-17");
	const entered = deferred(), release = deferred(), original = h.source;
	h.beforeRead = async path => { if (path === PATH) { entered.resolve(); await release.promise; } };
	h.service.configurationChanged(); const old = h.service.refresh(); await entered.promise;
	await h.service.set(other.observations[1]!);
	assert.equal(h.service.getSnapshot().memo?.dailyRef.path, other.path);
	release.resolve(); await old;
	assert.equal(h.service.getSnapshot().memo?.dailyRef.path, other.path); assert.equal(h.source, original);
});

for (const action of ["remove", "replace", "reload"] as const) test(`候选等待期间 ${action} 取消旧设置，旧结果不覆盖最新意图`, async () => {
	const h = await pinned(), entered = deferred(), release = deferred();
	h.afterCreate = async () => { h.afterCreate = undefined; entered.resolve(); await release.promise; };
	const first = h.service.set(h.source.observations[2]!).catch(error => error); await entered.promise;
	const latest = action === "remove" ? h.service.remove(h.service.getSnapshot().selection)
		: action === "replace" ? h.service.set(h.source.observations[0]!) : h.service.reload();
	release.resolve(); await first; await latest;
	assert.equal(parseBeaconReference(h.data.beacon)?.blockId, action === "remove" ? undefined : action === "replace" ? "first" : "selected");
});

test("设置 CAS 遇到外部换选采用读回记录，旧菜单无法移除新选择", async () => {
	const h = await pinned(), oldSelection = h.service.getSnapshot().selection;
	const external = { sourcePath: PATH, blockId: "first", memoTime: "08:00" };
	h.afterCreate = () => { h.data.beacon = external; };
	await h.service.set(h.source.observations[2]!);
	assert.deepEqual(h.data.beacon, external); assert.equal(h.service.getSnapshot().memo?.contentSnapshot, "neighbor");
	await h.service.remove(oldSelection); assert.deepEqual(h.data.beacon, external);
});

for (const kind of ["delete", "rename"] as const) test(`配置保存已经开始后候选文件 ${kind}，不把旧路径重建的卡片发布为成功`, async () => {
	const h = await pinned(), path = "Daily/2026-11-17.md", entered = deferred(), release = deferred();
	const candidate = await h.write(BODY, path, "2026-11-17");
	h.beforeSave = async () => { h.beforeSave = undefined; entered.resolve(); await release.promise; };
	const setting = h.service.set(candidate.observations[2]!); const outcome = assert.rejects(setting, /source changed/u);
	await entered.promise; h.service.sourceChanged(path, kind, "Daily/2026-11-18.md");
	await h.write(BODY.replace("tail", "recreated"), path, "2026-11-17");
	release.resolve(); await outcome; await h.service.refresh();
	assert.equal(h.service.getSnapshot().state, "unavailable"); assert.equal(h.service.getSnapshot().memo, undefined);
	assert.equal(parseBeaconReference(h.data.beacon)!.blockId, "tail");
});

test("时间同步排队期间外部换选，CAS 不覆盖新记录", async () => {
	const h = await pinned(), entered = deferred(), release = deferred();
	h.beforeLoad = async () => { h.beforeLoad = undefined; entered.resolve(); await release.promise; };
	await h.write(BODY.replace("09:00", "12:00")); h.service.sourceChanged(PATH); const refreshing = h.service.refresh(); await entered.promise;
	h.data.beacon = { sourcePath: PATH, blockId: "tail", memoTime: "10:00" };
	release.resolve(); await refreshing; await h.service.refresh();
	assert.equal(parseBeaconReference(h.data.beacon)!.blockId, "tail");
});

test("迟到保存接纳跨 Daily 同名 ID，旧菜单和原选择的改名过渡均不能接管", async () => {
	const h = await pinned(), oldSelection = h.service.getSnapshot().selection;
	const entered = deferred(), release = deferred();
	const next = await h.write(BODY.replace("selected ^selected", "new selection ^selected"), "Daily/2026-11-17.md", "2026-11-17");
	const moved = await h.write(BODY, "Daily/2026-11-18.md", "2026-11-18");
	h.service.sourceChanged(PATH, "rename", moved.path);
	h.beforeSave = async () => { h.beforeSave = undefined; entered.resolve(); await release.promise; };
	const setting = h.service.set(next.observations[1]!);
	await entered.promise;
	const removing = h.service.remove(oldSelection);
	release.resolve(); await setting; await removing;
	assert.equal(parseBeaconReference(h.data.beacon)?.sourcePath, next.path);
	assert.equal(h.service.getSnapshot().memo?.dailyRef.path, next.path);
	assert.equal(h.service.getSnapshot().previousSources, undefined);
	assert.notEqual(h.service.getSnapshot().selection, oldSelection);
});

for (const newPath of [false, true]) test(`外部时间更新保留已确认改名（${newPath ? "新路径" : "原路径"}）和选择令牌`, async () => {
	const h = await pinned(), token = h.service.getSnapshot().selection, old = h.service.getSnapshot().memo!;
	const moved = await h.write(BODY.replace("09:00", "15:00"), "Daily/2026-11-17.md", "2026-11-17");
	h.service.sourceChanged(PATH, "rename", moved.path);
	h.data.beacon = { sourcePath: newPath ? moved.path : PATH, blockId: "selected", memoTime: "14:00" };
	await h.service.reload();
	assert.deepEqual(h.data.beacon, { sourcePath: moved.path, blockId: "selected", memoTime: "15:00" });
	assert.equal(h.service.getSnapshot().selection, token);
	assert.equal(buildBeaconPresentation(h.service.getSnapshot(), [old]).snapshot.state, "locating");
});

for (const external of ["beacon", "settings"] as const) test(`最终 Daily 核对期间的外部 ${external} 写入从最新配置合并`, async () => {
	const h = await pinned(), entered = deferred(), release = deferred();
	let checks = 0;
	h.beforeValidate = async () => { if (++checks === 2) { entered.resolve(); await release.promise; } };
	const setting = h.service.set(h.source.observations[2]!);
	await entered.promise;
	const record = { sourcePath: PATH, blockId: "first", memoTime: "08:00" };
	h.data[external] = external === "beacon" ? record : { remote: true };
	release.resolve(); await setting;
	if (external === "beacon") assert.deepEqual(h.data.beacon, record);
	else {
		assert.deepEqual(h.data.settings, { remote: true });
		assert.equal(parseBeaconReference(h.data.beacon)?.blockId, "tail");
	}
});

for (const sameBytes of [true, false]) test(`插件数据读取期间的 Daily 通知重新校验字节（${sameBytes ? "同版" : "改写"}）`, async () => {
	const h = await pinned(), entered = deferred(), release = deferred();
	h.beforeLoad = async () => { h.beforeLoad = undefined; entered.resolve(); await release.promise; };
	const setting = h.service.set(h.source.observations[2]!);
	const outcome = sameBytes ? setting : assert.rejects(setting, /source changed/u);
	await entered.promise;
	if (!sameBytes) await h.write(BODY.replace("tail ^tail", "rewritten ^tail"));
	h.service.sourceChanged(PATH);
	release.resolve(); await outcome;
	assert.equal(parseBeaconReference(h.data.beacon)?.blockId, sameBytes ? "tail" : "selected");
});

for (const folder of [false, true]) test(`明确${folder ? "父目录" : "跨日期文件"}改名后复核锚点再更新路径，旧路径重建不接管`, async () => {
	const h = await pinned(), next = folder ? "Archive/2026-11-16.md" : "Daily/2026-11-17.md";
	await h.write(BODY.replace("09:00", "15:30"), next, folder ? DATE : "2026-11-17");
	h.service.sourceChanged(folder ? "Daily" : PATH, "rename", folder ? "Archive" : next);
	await h.write(BODY.replace("selected", "old path imposter")); await h.service.refresh();
	assert.equal(parseBeaconReference(h.data.beacon)!.sourcePath, next); assert.equal(parseBeaconReference(h.data.beacon)!.memoTime, "15:30");
	assert.equal(h.service.getSnapshot().memo?.contentSnapshot, "selected");
	assert.ok(h.service.getSnapshot().previousSources?.some(source => source.sourcePath === PATH));
});

test("改名复核失败保留原配置和新路径过渡，重试不会认领旧路径", async () => {
	const h = await pinned(), saved = structuredClone(h.data.beacon), next = "Daily/2026-11-17.md";
	await h.write(BODY.replace(" ^selected", ""), next, "2026-11-17");
	h.service.sourceChanged(PATH, "rename", next); await h.service.refresh();
	assert.deepEqual(h.data.beacon, saved); assert.equal(h.service.getSnapshot().reason, "missing-id");
	await h.write(BODY.replace("selected", "imposter")); await h.service.retry();
	assert.equal(h.service.getSnapshot().reason, "missing-id");
});

for (const selected of [false, true]) test(`Trash 确认删除${selected ? "所选目标" : "邻项"}，仅原锚点 occurrence 清理选择`, async () => {
	const h = await pinned(), before = h.source, index = selected ? 1 : 0;
	await h.write(BODY.replace(selected ? "- 09:00 selected ^selected\n" : "- 08:00 neighbor ^first\n", ""));
	const presentation = change(before, h.source, before.observations[index]);
	h.service.sourceChanged(PATH); h.service.confirmed(presentation, before.observations[index], before.blockAnchors);
	await h.service.refresh();
	assert.equal(h.data.beacon === undefined, selected);
	assert.equal(h.service.getSnapshot().state, selected ? "unset" : "ready");
});

test("外部删除文件、缺少删除前计数或原句柄不符都不能清理，配置清理失败不重删 Daily", async () => {
	const h = await pinned(), before = h.source, saved = structuredClone(h.data.beacon);
	await h.write(BODY.replace("- 09:00 selected ^selected\n", ""));
	const presentation = change(before, h.source, before.observations[1]);
	h.service.confirmed(presentation, before.observations[1]); await h.service.refresh(); assert.deepEqual(h.data.beacon, saved);
	h.failSave = true; h.service.confirmed(presentation, before.observations[1], before.blockAnchors); await h.service.refresh();
	assert.deepEqual(h.data.beacon, saved); assert.equal(h.failures.length, 1);
	h.failSave = false; await h.service.refresh(); assert.equal(h.data.beacon, undefined);
	const file = await pinned(); const record = structuredClone(file.data.beacon); file.service.sourceChanged(PATH, "delete"); await file.service.refresh();
	assert.deepEqual(file.data.beacon, record); assert.equal(file.service.getSnapshot().reason, "unlocated");
});

test("旧记录保留供移除或重设，磁盘配置读取失败须先恢复读取", async () => {
	const old = { handle: { bad: true }, logicalDate: DATE }, h = await fixture(BODY, { beacon: old, settings: {}, extra: 1 });
	assert.equal(h.service.getSnapshot().reason, "unlocated"); assert.deepEqual(h.data.beacon, old);
	h.failRead = true; await h.service.reload(); assert.equal(h.service.getSnapshot().reason, "unreadable");
	await assert.rejects(h.service.set(h.source.observations[0]!)); await assert.rejects(h.service.remove(h.service.getSnapshot().selection));
	assert.deepEqual(h.data.beacon, old); h.failRead = false; await h.service.reload();
	await h.service.set(h.source.observations[0]!); assert.equal(h.data.extra, 1);
});

test("配置读取失败后源事件和普通扫描不能将错误变成永久定位中，恢复只由配置重读完成", async () => {
	const h = await pinned(), saved = structuredClone(h.data.beacon), writes = h.writes;
	h.failRead = true; await h.service.reload();
	assert.equal(h.service.getSnapshot().reason, "unreadable");
	h.service.sourceChanged(PATH); h.service.observeSource(h.source); await h.service.refresh();
	assert.equal(h.service.getSnapshot().state, "unavailable");
	assert.equal(h.service.getSnapshot().reason, "unreadable");
	assert.deepEqual(h.data.beacon, saved); assert.equal(h.writes, writes);
	h.failRead = false; await h.service.retry();
	assert.equal(h.service.getSnapshot().state, "ready"); assert.equal(h.writes, writes);
});

test("配置读取失败使已启动的 Daily 核对失效并阻止时间保存", async () => {
	const h = await pinned(), saved = structuredClone(h.data.beacon), writes = h.writes;
	const loading = deferred(), stopLoading = deferred(), validating = deferred(), stopValidating = deferred();
	await h.write(BODY.replace("09:00", "11:00"));
	h.beforeLoad = async () => { loading.resolve(); await stopLoading.promise; };
	h.beforeValidate = async () => { validating.resolve(); await stopValidating.promise; };
	const reload = h.service.reload(); await loading.promise;
	const refresh = h.service.refresh(); await validating.promise;
	h.failRead = true; stopLoading.resolve(); await reload;
	h.failRead = false; h.beforeLoad = undefined; h.beforeValidate = undefined;
	stopValidating.resolve(); await refresh;
	assert.equal(h.service.getSnapshot().reason, "unreadable");
	assert.deepEqual(h.data.beacon, saved); assert.equal(h.writes, writes);
	await h.service.retry();
	assert.equal(h.service.getSnapshot().state, "ready");
	assert.equal(parseBeaconReference(h.data.beacon)?.memoTime, "11:00");
});

test("源读取失效后紧接明确改名，仍等待各 leaf 的改名前旧卡退出才展示新路径灯标", async () => {
	const h = await pinned(), oldMemo = h.service.getSnapshot().memo!, next = "Daily/2026-11-17.md";
	h.service.sourceChanged(PATH);
	await h.write(BODY, next, "2026-11-17");
	h.service.sourceChanged(PATH, "rename", next); await h.service.refresh();
	assert.equal(h.service.getSnapshot().state, "ready");
	const waiting = buildBeaconPresentation(h.service.getSnapshot(), [oldMemo]);
	assert.equal(waiting.snapshot.state, "locating");
	assert.deepEqual(waiting.memos, [oldMemo]);
	const current = h.service.getSnapshot().memo!;
	const accepted = buildBeaconPresentation(h.service.getSnapshot(), [current]);
	assert.equal(accepted.snapshot.state, "ready"); assert.equal(accepted.memos.length, 1);
	assert.equal(accepted.memos[0], current);
});

for (const sameBytes of [true, false]) test(`旧路径${sameBytes ? "同字节" : "不同字节"}重建后两个 leaf 继续展示新路径选择`, async () => {
	const h = await pinned(), oldMemo = h.service.getSnapshot().memo!, next = "Daily/2026-11-17.md";
	const selection = h.service.getSnapshot().selection;
	await h.write(BODY, next, "2026-11-17");
	h.service.sourceChanged(PATH, "rename", next); await h.service.refresh();
	const left = buildBeaconPresentation(h.service.getSnapshot(), [oldMemo]);
	const right = buildBeaconPresentation(h.service.getSnapshot(), []);
	assert.equal(left.snapshot.state, "locating"); assert.equal(right.snapshot.memo?.dailyRef.path, next);
	const recreated = await h.write(sameBytes ? BODY : BODY.replace("selected ^selected", "separate ^selected"));
	h.service.sourceChanged(PATH); h.service.observeSource(recreated);
	await new Promise<void>(resolve => setImmediate(resolve));
	assert.equal(h.service.getSnapshot().selection, selection);
	assert.equal(parseBeaconReference(h.data.beacon)?.sourcePath, next);
	const ordinary = sameBytes ? oldMemo : toCatalogMemoView(h.item(recreated.observations[1]!));
	const result = buildBeaconPresentation(h.service.getSnapshot(), [ordinary]);
	assert.deepEqual(result.memos.map(memo => memo.dailyRef.path), [next, PATH]);
});

test("旧路径证明晚到时无法解除再次改名后的等待", async () => {
	const h = await pinned(), moved = "Daily/2026-11-17.md", final = "Daily/2026-11-18.md";
	const started = deferred(), release = deferred();
	await h.write(BODY, moved, "2026-11-17");
	h.service.sourceChanged(PATH, "rename", moved); await h.service.refresh();
	h.beforeValidate = async source => { if (source.path === PATH) { started.resolve(); await release.promise; } };
	h.service.observeSource(h.source);
	await started.promise;
	await h.write(BODY, final, "2026-11-18");
	h.service.sourceChanged(moved, "rename", final); await h.service.refresh();
	release.resolve(); await new Promise<void>(resolve => setImmediate(resolve));
	assert.deepEqual(h.service.getSnapshot().previousSources?.map(source => source.sourcePath), [PATH, moved]);
	assert.equal(h.service.getSnapshot().memo?.dailyRef.path, final);
});

test("普通索引批次复用已核对的版本，并重试失败的时间保存", async () => {
	const h = await pinned(), writes = h.writes;
	let checks = 0; h.beforeValidate = () => { checks++; };
	await h.service.refreshIfNeeded(); await h.service.refreshIfNeeded();
	assert.equal(checks, 0); assert.equal(h.writes, writes);
	const edited = await h.write(BODY.replace("09:00", "11:00"));
	h.failSave = true;
	h.service.sourceChanged(PATH); h.service.observeSource(edited); await h.service.refreshIfNeeded();
	assert.equal(checks, 1); assert.equal(h.service.getSnapshot().state, "ready"); assert.equal(h.writes, writes);
	h.failSave = false; await h.service.refreshIfNeeded();
	assert.equal(parseBeaconReference(h.data.beacon)?.memoTime, "11:00");
	assert.equal(h.writes, writes + 1);
	const checksAfterSave = checks;
	await h.service.refreshIfNeeded(); assert.equal(checks, checksAfterSave);
});

test("读取配置失效时保留 Trash 删除证明，恢复读取后再清理引用", async () => {
	const h = await pinned(), before = h.source, saved = structuredClone(h.data.beacon);
	const token = h.service.getSnapshot().selection;
	h.failRead = true; await h.service.reload();
	const after = await h.write(BODY.replace("- 09:00 selected ^selected\n", ""));
	h.service.confirmed(change(before, after, before.observations[1]), before.observations[1], before.blockAnchors);
	await h.service.refreshIfNeeded();
	assert.equal(h.service.getSnapshot().reason, "unreadable"); assert.deepEqual(h.data.beacon, saved);
	h.failRead = false; await h.service.retry();
	assert.equal(h.data.beacon, undefined); assert.equal(h.service.getSnapshot().state, "unset");
	assert.notEqual(h.service.getSnapshot().selection, token);
});

test("来源暂不可读与未确认新版本不报 ID 缺失，销毁后的慢结果不发布", async () => {
	const h = await pinned(); h.readError = new Error("I/O"); h.service.configurationChanged(); await h.service.refresh();
	assert.equal(h.service.getSnapshot().reason, "unreadable"); h.readError = undefined;
	const entered = deferred(), release = deferred(); h.beforeRead = async () => { entered.resolve(); await release.promise; };
	const slow = h.service.retry(); await entered.promise; const snapshot = h.service.getSnapshot(); h.service.dispose(); release.resolve(); await slow;
	assert.equal(h.service.getSnapshot(), snapshot);
});

test("窗口内提升同版对象，窗口外只补一张；旧版普通窗口先等待且不改变普通列表", async () => {
	const h = await pinned(); const memo = h.service.getSnapshot().memo!, ordinary = [toCatalogMemoView(h.item(h.source.observations[0]!)), memo];
	const inside = buildBeaconPresentation(h.service.getSnapshot(), ordinary);
	assert.equal(inside.memos[0], memo); assert.equal(inside.memos.length, 2); assert.equal(ordinary.length, 2);
	const outside = buildBeaconPresentation(h.service.getSnapshot(), ordinary.slice(0, 1));
	assert.equal(outside.memos.length, 2); assert.equal(outside.memos[0], memo);
	await h.write(BODY.replace("selected", "edited")); h.service.sourceChanged(PATH); await h.service.refresh();
	const waiting = buildBeaconPresentation(h.service.getSnapshot(), ordinary);
	assert.equal(waiting.snapshot.state, "locating"); assert.deepEqual(waiting.memos, ordinary);
});

function deferred() { let resolve!: () => void; const promise = new Promise<void>(yes => { resolve = yes; }); return { promise, resolve }; }
function change(before: BeaconSource, after: BeaconSource, deleted?: MemoObservation): ConfirmedDailyMemoPresentation {
	return { change: { sourcePath: before.path, logicalDate: after.logicalDate, beforeSourceRevision: before.sourceRevision, sourceRevision: after.sourceRevision,
		replacements: before.observations.map(item => ({ before: item, after: item === deleted ? null : after.observations.find(next => next.existingBlockId === item.existingBlockId) ?? null })),
		inserted: null, changed: null }, observations: after.observations, blockAnchors: after.blockAnchors };
}
async function pinned(body = BODY) { const h = await fixture(body); await h.service.set(h.source.observations[1]!); return h; }
async function fixture(body = BODY, initial: Record<string, unknown> = { settings: {}, unknown: { keep: true }, shuffleDayHistory: [] }) {
	await ensureObsidianStub();
	const { toParsedCatalogMemoItem } = await import("../src/services/CatalogReadService");
	const parser = new DiaryMemoParser(), files = new Map<string, { source: BeaconSource; content: string }>();
	const h = { data: structuredClone(initial), source: null as unknown as BeaconSource, reads: 0, writes: 0, anchorWrites: 0,
		failRead: false, failSave: false, unsaved: false, failures: [] as unknown[], readError: undefined as Error | undefined,
		beforeRead: undefined as ((path: string) => void | Promise<void>) | undefined,
		beforeLoad: undefined as (() => void | Promise<void>) | undefined,
		beforeSave: undefined as (() => void | Promise<void>) | undefined,
		beforeValidate: undefined as ((source: BeaconSource) => void | Promise<void>) | undefined,
		afterCreate: undefined as (() => void | Promise<void>) | undefined,
		content: () => files.get(PATH)!.content,
		write: async (content: string, path = PATH, logicalDate = DATE) => {
			const source = { path, logicalDate, ...await parser.parse({ sourcePath: path, logicalDate, bytes: new TextEncoder().encode(content) }) };
			files.set(path, { source, content }); if (path === PATH) h.source = source; return source;
		},
		item: (observation: MemoObservation) => toParsedCatalogMemoItem(observation, createCatalogCapabilities({ kind: "partial", coveredFromDate: null,
			pendingFileCount: 0, coveredFileCount: 0, totalFileCount: 0 })),
	};
	await h.write(body);
	const store = new PluginDataStore({ loadData: async () => { await h.beforeLoad?.(); if (h.failRead) throw new Error("read failed"); return structuredClone(h.data); },
		saveData: async (data: Record<string, unknown>) => { await h.beforeSave?.(); if (h.failSave) throw new Error("save failed"); h.writes++; h.data = structuredClone(data); } } as Plugin);
	const service = new BeaconService(store, {
		readSource: async path => { h.reads++; const source = files.get(path)?.source; await h.beforeRead?.(path); if (h.readError) throw h.readError; if (!source) throw new Error("source unavailable"); return source; },
		isSourceCurrent: async source => {
			await h.beforeValidate?.(source);
			return source.sourceRevision === files.get(source.path)?.source.sourceRevision;
		},
		fromObservation: h.item,
		createBlockReference: async handle => {
			const file = files.get(handle.sourcePath)!, current = file.source.observations.find(item => sameBeaconHandle(item, handle));
			if (!current) throw new Error("stale observation");
			const blockId = current.existingBlockId ?? `generated-${h.anchorWrites + 1}`;
			let observation = current;
			if (!current.existingBlockId || h.unsaved) {
				const lines = file.content.split("\n"); lines[current.startLine] += current.existingBlockId ? " changed" : ` ^${blockId}`;
				const content = lines.join("\n");
				const parsed = h.unsaved ? await parser.parse({ sourcePath: handle.sourcePath, logicalDate: file.source.logicalDate, bytes: new TextEncoder().encode(content) })
					: await h.write(content, handle.sourcePath, file.source.logicalDate);
				observation = parsed.observations.find(item => item.startLine === current.startLine)!;
				if (!h.unsaved) { h.anchorWrites++; service.sourceChanged(handle.sourcePath); }
			}
			await h.afterCreate?.();
			return { status: "committed", observation, blockId, catalogUpdatePending: false };
		},
		onFailure: error => h.failures.push(error),
	});
	await service.reload(); return Object.assign(h, { service, store });
}
