import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { DiaryMemoParser } from "../src/services/DiaryMemoParser";
import { MemoCatalogService } from "../src/services/MemoCatalogService";
import { InMemoryMemoCatalogStore } from "../src/services/MemoCatalogStore";
import { MemoRelationService, MemoRelationsChangedError, relationChangeAffects } from "../src/services/MemoRelationService";
import { observationHandleKey } from "../src/services/DailyMemoPresentationChange";
import { extractMemoRelationTargets, extractMemoRelationSummary } from "../src/utils/memoRelations";

async function fixture() {
	const store = new InMemoryMemoCatalogStore();
	const catalog = new MemoCatalogService(store);
	await catalog.open();
	const parser = new DiaryMemoParser(async bytes => createHash("sha256").update(bytes).digest("hex"));
	const seed = async (path: string, text: string, date = "2026-10-25") => {
		const parsed = await parser.parse({ sourcePath: path, logicalDate: date, bytes: Buffer.from(text) });
		await catalog.replaceFile({ inventory: { sourcePath: path, logicalDate: date, mtime: 1, size: text.length },
			sourceRevision: parsed.sourceRevision, observations: parsed.observations, blockAnchors: parsed.blockAnchors,
			parserVersion: 14, settingsFingerprint: "test", auditedAt: 1 });
		await store.setCoverage({ kind: "complete", coveredFromDate: null, coveredFileCount: (await catalog.listFiles()).length,
			totalFileCount: (await catalog.listFiles()).length, pendingFileCount: 0 });
		return parsed.observations.map(node => observationHandleKey(node));
	};
	return { store, catalog, seed, relations: new MemoRelationService(catalog) };
}

function holdFinalCoverage(store: InMemoryMemoCatalogStore) {
	const coverage = store.getCoverage.bind(store);
	let entered!: () => void, release!: () => void, calls = 0;
	const ready = new Promise<void>(resolve => { entered = resolve; });
	const gate = new Promise<void>(resolve => { release = resolve; });
	store.getCoverage = async () => {
		const result = await coverage();
		// 首次构建先读输入 coverage，第二次读取是发布前的末次校验。
		if (++calls === 2) { entered(); await gate; }
		return result;
	};
	return { ready, release };
}

test("末次 coverage 校验期间 metadata 变化，迟到旧构建不能覆盖新快照", async () => {
	const { seed, catalog, store, relations: unused } = await fixture(); unused.dispose();
	const [a] = await seed("X/A.md", "- 10:00 first ^a\n");
	const [b] = await seed("Y/A.md", "- 10:00 second ^a\n");
	await seed("B.md", "- 11:00 [[A#^a]]\n");
	let destination = "X/A.md";
	const relations = new MemoRelationService(catalog, { resolvePath: () => ({ path: destination }) });
	const probe = holdFinalCoverage(store);
	try {
		const rejected = assert.rejects(relations.read(), MemoRelationsChangedError);
		await probe.ready;
		destination = "Y/A.md"; relations.invalidateResolution(["Y/A.md"]);
		const current = await relations.read();
		assert.equal(current.referrers.get(a!), undefined);
		assert.equal(current.referrers.get(b!)?.length, 1);
		probe.release(); await rejected;
		assert.equal(await relations.read(), current, "旧构建结束后仍保留已发布的新快照");
		await relations.assertCurrent(current);
	} finally { probe.release(); relations.dispose(); }
});

test("末次 coverage 校验期间所有读取者退出，取消构建不能成为后续缓存", async () => {
	const { seed, catalog, store, relations: unused } = await fixture(); unused.dispose();
	await seed("A.md", "- 10:00 A ^a\n"); await seed("B.md", "- 11:00 [[A#^a]]\n");
	let resolutions = 0;
	const relations = new MemoRelationService(catalog, { resolvePath: () => { resolutions++; return { path: "A.md" }; } });
	const probe = holdFinalCoverage(store);
	try {
		const controller = new AbortController();
		const rejected = assert.rejects(relations.read(controller.signal));
		await probe.ready; controller.abort(); await rejected;
		probe.release(); await new Promise(resolve => setImmediate(resolve));
		const current = await relations.read();
		assert.equal(current.complete, true);
		assert.equal(resolutions, 2, "重新进入须从有效构建取得快照，不能命中已取消构建");
		await relations.assertCurrent(current);
	} finally { probe.release(); relations.dispose(); }
});

test("末次 coverage 校验期间 runtime 销毁，旧读取不能再返回成功快照", async () => {
	const { seed, store, relations } = await fixture();
	await seed("A.md", "- 10:00 A ^a\n");
	const probe = holdFinalCoverage(store);
	try {
		const rejected = assert.rejects(relations.read(), MemoRelationsChangedError);
		await probe.ready; relations.dispose(); probe.release(); await rejected;
		await assert.rejects(relations.read(), MemoRelationsChangedError);
	} finally { probe.release(); relations.dispose(); }
});

test("增量重算发布前失效不污染已发布的目标依赖和引用者集合", async () => {
	const { seed, catalog, store, relations: unused } = await fixture(); unused.dispose();
	const [a] = await seed("A.md", "- 10:00 A ^a\n");
	const [c] = await seed("C.md", "- 10:00 C ^c\n");
	await seed("B.md", "- 11:00 [[A#^a]]\n");
	const relations = new MemoRelationService(catalog);
	let release = () => {};
	let off = () => {};
	try {
		const before = await relations.read();
		await seed("B.md", "- 11:00 [[C#^c]]\n");
		const gate = holdFinalCoverage(store); release = gate.release;
		const rejected = assert.rejects(relations.read(), MemoRelationsChangedError);
		await gate.ready;
		const affected = new Set<string>();
		off = relations.subscribe(change => { for (const path of change?.paths ?? []) affected.add(path); });
		relations.invalidateResolution(["A.md"]);
		assert.ok(affected.has("B.md"), "取消前仍须按已发布的 A←B 依赖通知来源");
		assert.equal(before.referrers.get(a!)?.length, 1);
		assert.equal(before.referrers.has(c!), false);
		release(); await rejected;
		const current = await relations.read();
		assert.equal(current.referrers.has(a!), false);
		assert.equal(current.referrers.get(c!)?.length, 1);
	} finally { release(); off(); relations.dispose(); }
});

test("无关 Daily 更新复用已解析关系，改链只重算相关来源", async () => {
	const { catalog, seed } = await fixture();
	const [a] = await seed("A.md", "- 10:00 A ^a\n");
	const [b] = await seed("B.md", "- 11:00 [[A#^a]]\n");
	await seed("C.md", "- 12:00 C ^c\n");
	const calls: string[] = [];
	const relations = new MemoRelationService(catalog, { resolvePath: (path, source) => {
		calls.push(source); return { path: path + ".md" };
	} });
	try {
		const before = await relations.read(); calls.length = 0;
		await seed("C.md", "- 12:00 unrelated edit ^c\n");
		relations.invalidateResolution(["C.md"]);
		relations.retryPendingResolution();
		await relations.refreshState();
		const after = await relations.read();
		assert.deepEqual(calls, [], "无关文件修改不能重新解析 B 的链接");
		assert.equal(after.sources.get(b!), before.sources.get(b!));
		assert.equal(after.referrers.get(a!), before.referrers.get(a!));
		const [nextB] = await seed("B.md", "- 11:00 [[C#^c]]\n");
		const changed = await relations.read();
		assert.deepEqual(calls, ["B.md"]);
		assert.equal(changed.referrers.get(a!), undefined);
		assert.equal(changed.sources.get(nextB!)?.[0].handle.sourcePath, "C.md");
	} finally { relations.dispose(); }
});

test("局部 metadata 失效复用无关文件的节点集合，不重新遍历其 occurrence", async () => {
	const { catalog, seed, relations } = await fixture();
	try {
		const [a] = await seed("A.md", "- 10:00 A ^a\n");
		await seed("B.md", "- 11:00 [[A#^a]]\n");
		await seed("Far.md", Array.from({ length: 64 }, (_, i) => `- 12:00 far ${i}`).join("\n"));
		let visits = 0;
		const listFiles = catalog.listFiles.bind(catalog);
		catalog.listFiles = async () => {
			const files = await listFiles();
			for (const node of files.find(file => file.sourcePath === "Far.md")!.relations!.nodes) {
				const path = node.handle.sourcePath;
				Object.defineProperty(node.handle, "sourcePath", { get: () => { visits++; return path; } });
			}
			return files;
		};
		const before = await relations.read(); visits = 0;
		relations.invalidateResolution(["A.md"]);
		const after = await relations.read();
		assert.equal(visits, 0, "无关分区不应重新枚举节点来构造或校验相同关系");
		assert.equal(after.referrers.get(a!)?.length, 1);
		assert.equal(after.nodes.size, before.nodes.size);
	} finally { relations.dispose(); }
});

test("来源 metadata 暂不可用时重验未改正文的上下文，恢复后接续关系", async () => {
	const { catalog, seed, relations: unused } = await fixture(); unused.dispose();
	const [a] = await seed("A.md", "- 10:00 A ^a\n");
	await seed("B.md", "- 11:00 [[A#^a]]\n");
	let pending = false;
	const relations = new MemoRelationService(catalog, { resolvePath: () => ({ path: "A.md", pending }) });
	try {
		assert.equal((await relations.read()).referrers.get(a!)?.length, 1);
		pending = true; relations.invalidateResolution(["B.md"]);
		assert.equal((await relations.read()).complete, false);
		pending = false; relations.invalidateResolution(["B.md"]);
		const current = await relations.read();
		assert.equal(current.complete, true);
		assert.equal(current.referrers.get(a!)?.length, 1);
	} finally { relations.dispose(); }
});

test("展示依赖校验允许无关提交，相关改链仍拒绝旧结果", async () => {
	const { catalog, seed, relations } = await fixture();
	await seed("A.md", "- 10:00 A ^a\n");
	await seed("B.md", "- 11:00 [[A#^a]]\n");
	await seed("C.md", "- 12:00 unrelated\n");
	try {
		const before = await relations.read();
		const handle = [...before.nodes.values()].find(node => node.handle.sourcePath === "A.md")!.handle;
		await seed("C.md", "- 12:00 unrelated changed\n");
		await relations.assertCurrent(before, undefined, [handle]);
		await seed("B.md", "- 11:00 removed\n");
		await assert.rejects(() => relations.assertCurrent(before, undefined, [handle]));
		await catalog.deleteFile("A.md");
		await assert.rejects(() => relations.verifyHandle(handle));
	} finally { relations.dispose(); }
});

test("同名目标的解析变化通知旧目标与新目标，无关节点不失效", async () => {
	const { seed, catalog } = await fixture();
	await seed("X/A.md", "- 10:00 first ^a\n");
	await seed("Y/A.md", "- 10:00 second ^a\n");
	await seed("B.md", "- 11:00 [[A#^a]]\n");
	await seed("C.md", "- 12:00 unrelated\n");
	let destination = "X/A.md";
	const relations = new MemoRelationService(catalog, { resolvePath: () => ({ path: destination }) });
	try {
		const before = await relations.read();
		const affected: string[] = [];
		relations.subscribe(change => { for (const node of before.nodes.values()) if (relationChangeAffects(change, node.handle)) affected.push(node.handle.sourcePath); });
		destination = "Y/A.md";
		relations.invalidateResolution(["Y/A.md"]);
		assert.deepEqual(new Set(affected), new Set(["X/A.md", "Y/A.md", "B.md"]));
		const after = await relations.read();
		const source = [...after.nodes.values()].find(node => node.handle.sourcePath === "B.md")!;
		assert.equal(after.sources.get(observationHandleKey(source.handle))?.[0].handle.sourcePath, "Y/A.md");
	} finally { relations.dispose(); }
});

test("局部阅读在无关事件取消共享构建后继续等待新批次", async () => {
	const { seed, store, relations } = await fixture();
	await seed("A.md", "- 10:00 A ^a\n");
	await seed("C.md", "- 12:00 unrelated\n");
	const initial = await relations.read();
	const handle = [...initial.nodes.values()].find(node => node.handle.sourcePath === "A.md")!.handle;
	const coverage = store.getCoverage.bind(store);
	let entered!: () => void, release!: () => void;
	const gate = new Promise<void>(resolve => { release = resolve; });
	const ready = new Promise<void>(resolve => { entered = resolve; });
	let block = true;
	store.getCoverage = async () => { const result = await coverage(); if (block) { block = false; entered(); await gate; } return result; };
	try {
		relations.invalidateResolution(["C.md"]);
		const reading = relations.read(new AbortController().signal, [handle]);
		await ready;
		relations.invalidateResolution(["C.md"]); release();
		const current = await reading;
		await relations.assertCurrent(current);
		assert.equal(current.nodes.has(observationHandleKey(handle)), true);
	} finally { release(); relations.dispose(); }
});

test("关联按直接来源 occurrence 去重，分钟秒排序、自引与环独立处理，计数不读正文", async () => {
	const { seed, relations, catalog } = await fixture();
	const [a] = await seed("D/A.md", "- 10:00 A [[B#^b]] ^a\n");
	const [b, d, same] = await seed("D/B.md", "- 11:00 B [[A#^a]] [[A#^a|again]] ^b\n- 11:00:01 D ![[A#^a]]\n- 11:00:01 D ![[A#^a]]\n");
	const [c] = await seed("D/C.md", "- 12:00 C [[B#^b]] [[C#^c]] ^c\n");
	catalog.getFileRevisionBatch = async () => { throw Error("must not read bodies"); };
	catalog.readObservationSnapshot = async () => { throw Error("must not read bodies"); };
	const graph = await relations.read();
	assert.equal(graph.complete, true);
	assert.deepEqual(new Set(graph.referrers.get(a!)!.map(node => observationHandleKey(node.handle))), new Set([b, d, same]));
	assert.equal(observationHandleKey(graph.referrers.get(a!)![2]!.handle), b);
	assert.deepEqual(new Set(graph.referrers.get(b!)!.map(node => observationHandleKey(node.handle))), new Set([a, c]));
	assert.equal(graph.referrers.get(c!), undefined);
});

test("Markdown 结构排除快照、嵌套及懒续行引用、代码、注释；块嵌入只产生显式关系", () => {
	const text = "> [[A#^a]]\n> > [[B#^b]]\nlazy [[C#^c]]\n\nnormal [[D#^d]] ![[E#^e]]\n"
		+ "`[[F#^f]]` <!-- [[G#^g]] --> %% [[H#^h]] %%\n\n    [[I#^i]]\n\n```md\n[[J#^j]]\n```\n\\[[K#^k]]";
	assert.deepEqual(extractMemoRelationTargets(text), [{ path: "D", blockId: "d" }, { path: "E", blockId: "e" }]);
	assert.deepEqual(extractMemoRelationTargets("[[A#^a]]\n\n[[B#^b]]"), [{ path: "A", blockId: "a" }, { path: "B", blockId: "b" }]);
	assert.deepEqual(extractMemoRelationTargets("<!-- [[Hidden#^x]] --> [[A#^a]]\n"), [{ path: "A", blockId: "a" }]);
});

test("WikiLink 保留百分号和实体原文，Markdown URL 只解码一次并按来源定位", async () => {
	const { seed, relations } = await fixture();
	try {
		const [literal] = await seed("Daily/100%/A.md", "- 10:00 literal ^a\n");
		const [encodedName] = await seed("Daily/100%20/A.md", "- 10:00 percent name ^a\n");
		const [spaceName] = await seed("Daily/100 /A.md", "- 10:00 space name ^a\n");
		const [entityName] = await seed("Daily/A&amp;B.md", "- 10:00 entity name ^a\n");
		const [chinese] = await seed("Daily/中文.md", "- 10:00 中文 ^a\n");
		const [source] = await seed("Daily/Source.md", "- 11:00 [[100%/A#^a]] [[100%20/A#^a]] [[A&amp;B#^a]] [中文](./%E4%B8%AD%E6%96%87.md#%5Ea) [literal](100%25/A.md#^a)\n");
		const graph = await relations.read();
		assert.equal(graph.complete, true);
		assert.deepEqual(new Set(graph.sources.get(source!)?.map(node => observationHandleKey(node.handle))), new Set([literal, encodedName, entityName, chinese]));
		assert.equal(graph.referrers.has(spaceName!), false, "字面量 %20 的 WikiLink 不得转移到空格路径");
	} finally { relations.dispose(); }
});

test("相对路径、同文件与编码兼容，子块和 Daily 外锚点及重复锚点不升级为 Memo", async () => {
	const { seed, relations } = await fixture();
	const [a] = await seed("Daily/A (1).md", "outside ^duplicate\n\n- 10:00 A ^a\n- 10:01 dup ^duplicate\n- 10:02 parent\n  - child ^child\n");
	const [b] = await seed("Daily/B.md", "- 11:00 [A](<./A%20(1).md#%5Ea>) [[A (1)#^duplicate]] [[A (1)#^child]] [[#^b]] ^b\n");
	const graph = await relations.read();
	assert.deepEqual(graph.sources.get(b!)?.map(node => observationHandleKey(node.handle)), [a]);
});

test("Memo 自身锚点不被内部子块锚点替代，frontmatter 与注释不制造重复锚点", async () => {
	const { seed, relations } = await fixture();
	const [a] = await seed("A.md", "---\nvalue: ^a\n---\n\n- 10:00 parent ^a\n  - child ^child\n");
	const [b] = await seed("B.md", "- 11:00 [[A#^a]] [[A#^child]]\n");
	assert.deepEqual((await relations.read()).sources.get(b!)?.map(node => observationHandleKey(node.handle)), [a]);
});

test("来源改链、上下文变化与目标重命名重验证未改正文的候选", async () => {
	const { seed, catalog } = await fixture();
	const [a] = await seed("X/A.md", "- 10:00 A ^a\n");
	const [c] = await seed("Y/A.md", "- 10:00 C ^a\n");
	const [b] = await seed("B.md", "- 11:00 [[A#^a]]\n");
	let destination = "X/A.md";
	const relations = new MemoRelationService(catalog, { resolvePath: () => ({ path: destination }) });
	assert.equal((await relations.read()).referrers.get(a!)?.length, 1);
	destination = "Y/A.md"; relations.invalidate();
	const graph = await relations.read();
	assert.equal(graph.referrers.get(a!), undefined);
	assert.equal(observationHandleKey(graph.sources.get(b!)![0].handle), c);
	await seed("B.md", "- 11:00 removed link\n");
	assert.equal((await relations.read()).referrers.get(c!), undefined);
});

test("无关普通文件的 metadata 不失效关系，候选同名文件到达仍会重验证", async () => {
	const { seed, relations } = await fixture();
	await seed("A.md", "- 10:00 [[Missing#^a]]\n");
	const snapshot = await relations.read();
	let updates = 0; const off = relations.subscribe(() => { updates++; });
	relations.invalidateResolution(["Notes/Unrelated.md"]);
	assert.equal(updates, 0); await relations.assertCurrent(snapshot);
	relations.invalidateResolution(["New/Missing.md"]);
	assert.equal(updates, 1);
	await assert.rejects(() => relations.assertCurrent(snapshot)); off();
});

test("Daily 读取失败自动接续一次现有增量扫描并恢复完整结果", async () => {
	const { seed, catalog } = await fixture();
	const [a] = await seed("A.md", "- 10:00 A ^a\n");
	let failures = 1, scans = 0;
	const relations = new MemoRelationService(catalog, { getFailedFileCount: () => failures,
		requestScan: async () => { scans++; failures = 0; await seed("B.md", "- 11:00 [[A#^a]]\n"); } });
	const partial = await relations.read();
	assert.equal(partial.complete, false); assert.equal(partial.errors.length, 1);
	await new Promise(resolve => setTimeout(resolve, 25));
	const current = await relations.read();
	assert.equal(scans, 1); assert.equal(current.complete, true); assert.equal(current.referrers.get(a!)?.length, 1);
	await relations.read();
	assert.equal(scans, 1, "完整覆盖下的 metadata 重试不额外扫描 Daily");
});

test("关系返回的瞬时解析错误自动补读，多个消费者共享构建且不会补扫 Daily", async () => {
	const { catalog, seed } = await fixture();
	await seed("A.md", "- 10:00 A ^a\n"); await seed("B.md", "- 11:00 [[A#^a]]\n");
	let attempts = 0, scans = 0;
	const relations = new MemoRelationService(catalog, { resolvePath: () => {
		if (++attempts === 1) throw Error("temporary metadata I/O");
		return { path: "A.md" };
	}, requestScan: () => { scans++; } });
	try {
		const [one, two] = await Promise.all([relations.read(), relations.read()]);
		assert.equal(one, two); assert.equal(one.complete, true);
		assert.equal(attempts, 2); assert.equal(scans, 0);
	} finally { relations.dispose(); }
});

test("持续返回错误的恢复预算不被内部失效、重复 metadata 通知或重复读取重置", async () => {
	const { catalog, seed } = await fixture();
	await seed("A.md", "- 10:00 A ^a\n"); await seed("B.md", "- 11:00 [[A#^a]]\n");
	let attempts = 0;
	const relations = new MemoRelationService(catalog, { resolvePath: () => { attempts++; throw Error("persistent metadata I/O"); } });
	try {
		assert.equal((await relations.read()).errors.length, 1); assert.equal(attempts, 2);
		for (let index = 0; index < 4; index++) {
			relations.invalidateResolution(["A.md"]);
			assert.equal((await relations.read()).complete, false);
			await relations.read();
		}
		assert.equal(attempts, 6, "每轮外部读取只有一次主读取，内部补读总共只准一次");
	} finally { relations.dispose(); }
});

test("持续扫描错误最多补扫一次，重复订阅通知和读取不放大扫描，生产者运行时不补扫", async () => {
	for (const scanning of [false, true]) {
		const { catalog, seed } = await fixture();
		await seed("A.md", "- 10:00 A ^a\n");
		let scans = 0;
		const relations = new MemoRelationService(catalog, { getFailedFileCount: () => 1,
			canRequestScan: () => !scanning, requestScan: () => { scans++; } });
		const off = relations.subscribe(() => {});
		try {
			await Promise.all([relations.read(), relations.read()]);
			await new Promise(resolve => setTimeout(resolve, 10));
			for (let index = 0; index < 5; index++) { relations.invalidate(); await relations.read(); }
			assert.equal(scans, scanning ? 0 : 1);
			assert.equal((await relations.read()).recovering, undefined);
			if (!scanning) {
				relations.beginReading(); await relations.read(); await new Promise(resolve => setTimeout(resolve, 10));
				assert.equal(scans, 2, "用户重新进入主动阅读后可开始新一轮有界恢复");
			}
		} finally { off(); relations.dispose(); }
	}
});

test("已缓存关系的 coverage 探测发生瞬时 I/O 故障时共享一次补读", async () => {
	const { seed, relations, store } = await fixture();
	try {
		await seed("A.md", "- 10:00 A ^a\n"); await relations.read();
		const coverage = store.getCoverage.bind(store); let attempts = 0;
		store.getCoverage = async () => { if (++attempts === 1) throw Error("temporary coverage I/O"); return coverage(); };
		const [one, two] = await Promise.all([relations.read(), relations.read()]);
		assert.equal(one, two); assert.equal(one.complete, true); assert.equal(attempts, 2);
	} finally { relations.dispose(); }
});

test("提交前的 coverage 校验发生瞬时 I/O 故障时同样自动补读", async () => {
	const { seed, relations, store } = await fixture();
	try {
		await seed("A.md", "- 10:00 A ^a\n"); const snapshot = await relations.read();
		const coverage = store.getCoverage.bind(store); let attempts = 0;
		store.getCoverage = async () => { if (++attempts === 1) throw Error("temporary commit probe I/O"); return coverage(); };
		await relations.assertCurrent(snapshot); assert.equal(attempts, 2);
	} finally { relations.dispose(); }
});

test("真实构建读取异常只补读一次且保留异常分类；正常 unresolved 不启动扫描", async () => {
	const { catalog, seed } = await fixture();
	await seed("A.md", "- 10:00 [[Missing#^a]]\n");
	let scans = 0, attempts = 0;
	const original = catalog.listFiles.bind(catalog);
	catalog.listFiles = async () => { attempts++; throw Error("persistent storage I/O"); };
	const relations = new MemoRelationService(catalog, { requestScan: () => { scans++; } });
	try {
		await assert.rejects(relations.read(), /persistent storage I\/O/u);
		assert.equal(attempts, 2); assert.equal(scans, 0);
		catalog.listFiles = original;
		assert.equal((await relations.read()).complete, true);
		assert.equal(scans, 0);
	} finally { relations.dispose(); }
});

test("一个消费者取消不取消另一消费者的共享构建，所有消费者退出后不继续补读", async () => {
	const { catalog, seed } = await fixture();
	await seed("A.md", "- 10:00 A ^a\n");
	const relations = new MemoRelationService(catalog);
	const original = catalog.listFiles.bind(catalog);
	let entered!: () => void, release!: () => void;
	const ready = new Promise<void>(resolve => { entered = resolve; });
	const gate = new Promise<void>(resolve => { release = resolve; });
	catalog.listFiles = async () => { const result = await original(); entered(); await gate; return result; };
	try {
		const controller = new AbortController();
		const first = relations.read(controller.signal); const rejected = assert.rejects(first);
		const second = relations.read(); await ready; controller.abort(); await rejected;
		release(); assert.equal((await second).complete, true);
	} finally { release(); relations.dispose(); }
});

test("被动订阅不保活已经无人读取的构建，离开后的读取故障不安排补读", async () => {
	const { catalog, seed } = await fixture(); await seed("A.md", "- 10:00 A ^a\n");
	const relations = new MemoRelationService(catalog), off = relations.subscribe(() => {});
	let release!: () => void, entered!: () => void, attempts = 0;
	const gate = new Promise<void>(resolve => { release = resolve; }), ready = new Promise<void>(resolve => { entered = resolve; });
	catalog.listFiles = async () => { attempts++; entered(); await gate; throw Error("late I/O failure"); };
	try {
		const controller = new AbortController(); const reading = relations.read(controller.signal), rejected = assert.rejects(reading);
		await ready; controller.abort(); await rejected; release(); await new Promise(resolve => setTimeout(resolve, 20));
		assert.equal(attempts, 1);
	} finally { release(); off(); relations.dispose(); }
});

test("补扫失败或无进展且没有生产者接续时结束占位，配置暂停不盲目补扫", async () => {
	for (const failure of ["reject", "no-progress", "blocked"] as const) {
		const { catalog, seed, store } = await fixture(); await seed("A.md", "- 10:00 A ^a\n");
		await store.setCoverage({ kind: "partial", coveredFromDate: null, coveredFileCount: 1, totalFileCount: 2, pendingFileCount: 1 });
		let scans = 0;
		const relations = new MemoRelationService(catalog, { requestScan: () => { scans++; if (failure === "reject") throw Error("scan I/O"); },
			getReadBlocker: () => failure === "blocked" });
		try {
			await relations.read(); await new Promise(resolve => setTimeout(resolve, 10));
			const snapshot = await relations.read();
			assert.equal(snapshot.complete, false); assert.ok(snapshot.errors.length); assert.equal(snapshot.recovering, undefined);
			assert.equal(scans, failure === "blocked" ? 0 : 1);
		} finally { relations.dispose(); }
	}
});

test("配置故障解除后的 settle 接续恢复关系，不需要改写来源或重新进入", async () => {
	const { catalog, seed } = await fixture(); await seed("A.md", "- 10:00 A ^a\n");
	let blocked = true, changes = 0;
	const relations = new MemoRelationService(catalog, { getReadBlocker: () => blocked });
	const off = relations.subscribe(() => { changes++; });
	try {
		assert.equal((await relations.read()).complete, false);
		blocked = false; await relations.refreshState();
		assert.equal(changes, 1);
		const current = await relations.read(); assert.equal(current.complete, true); assert.deepEqual(current.errors, []);
	} finally { off(); relations.dispose(); }
});

test("暂未确认文件不抹掉其他已确认结果，扫描覆盖完整仍可处于关系部分状态", async () => {
	const { seed, catalog } = await fixture();
	const [a] = await seed("A.md", "- 10:00 A ^a\n");
	await seed("B.md", "- 11:00 [[A#^a]]\n");
	await seed("C.md", "- 12:00 [[A#^a]]\n");
	let pending = true;
	const relations = new MemoRelationService(catalog, { isFileCurrent: file => file.sourcePath !== "C.md" || !pending });
	const graph = await relations.read();
	assert.equal(graph.coverage.kind, "complete"); assert.equal(graph.complete, false);
	assert.equal(graph.referrers.get(a!)?.length, 1);
	await relations.assertCurrent(graph);
	pending = false;
	await assert.rejects(() => relations.assertCurrent(graph));
	assert.equal((await relations.read()).referrers.get(a!)?.length, 2);
});

test("读取全量关系期间 Catalog 变化会废弃整批，重试不混入旧关系", async () => {
	const { seed, catalog, relations } = await fixture();
	const [a] = await seed("A.md", "- 10:00 A ^a\n");
	await seed("B.md", "- 11:00 [[A#^a]]\n");
	const original = catalog.listFiles.bind(catalog);
	let entered!: () => void, release!: () => void;
	const ready = new Promise<void>(resolve => { entered = resolve; });
	const blocked = new Promise<void>(resolve => { release = resolve; });
	catalog.listFiles = async () => { const files = await original(); entered(); await blocked; return files; };
	const old = relations.read(); const rejected = assert.rejects(old);
	await ready;
	catalog.listFiles = original;
	await seed("B.md", "- 11:00 removed\n");
	release(); catalog.listFiles = original;
	await rejected;
	assert.equal((await relations.read()).referrers.get(a!), undefined);
});

test("目标后到与锚点恢复无需编辑来源；移除、删除与恢复按当前关系更新", async () => {
	const { seed, relations, catalog } = await fixture();
	const [b] = await seed("B.md", "- 11:00 [[A#^a]]\n");
	assert.equal((await relations.read()).sources.get(b!)?.length, 0);
	let [a] = await seed("A.md", "- 10:00 A ^a\n");
	assert.equal((await relations.read()).referrers.get(a!)?.length, 1);
	[a] = await seed("A.md", "- 10:00 edited A ^a\n");
	assert.equal((await relations.read()).referrers.get(a!)?.length, 1);
	await catalog.deleteFile("A.md");
	assert.equal((await relations.read()).sources.get(b!)?.length, 0);
	[a] = await seed("A.md", "- 10:00 edited A ^a\n");
	assert.equal((await relations.read()).referrers.get(a!)?.length, 1);
	await seed("B.md", "- 11:00 removed\n");
	assert.equal((await relations.read()).referrers.get(a!), undefined);
});

test("关系完整性独立于扫描覆盖，解析失败不永久缓存为零，metadata 事件可重试", async () => {
	const { seed, catalog, store } = await fixture();
	const [a] = await seed("A.md", "- 10:00 A ^a\n");
	await seed("B.md", "- 11:00 [[A#^a]]\n");
	let fail = true;
	const relations = new MemoRelationService(catalog, { resolvePath: () => { if (fail) throw Error("temporary read failure"); return { path: "A.md" }; } });
	const partial = await relations.read();
	assert.equal(partial.complete, false);
	assert.equal(partial.errors.length, 1);
	fail = false;
	relations.invalidate();
	assert.equal((await relations.read()).referrers.get(a!)?.length, 1);
	await store.setCoverage({ kind: "partial", coveredFromDate: null, coveredFileCount: 2, totalFileCount: 3, pendingFileCount: 1 });
	assert.equal((await relations.read()).complete, false);
});

test("批次失效、取消与 runtime 销毁拒绝旧结果，旧 occurrence 不被行号复用替换", async () => {
	const { seed, relations } = await fixture();
	const [a] = await seed("A.md", "- 10:00 A ^a\n");
	const old = await relations.read();
	await seed("A.md", "- 10:00 another ^a\n");
	await assert.rejects(() => relations.assertCurrent(old));
	assert.equal((await relations.read()).nodes.has(a!), false);
	const controller = new AbortController(); controller.abort();
	await assert.rejects(() => relations.read(controller.signal));
	relations.dispose();
	await assert.rejects(() => relations.read());
});

test("摘要仅取普通可读正文，排除关系链接和快照；短文不加省略号", () => {
	assert.equal(extractMemoRelationSummary("**后续思考** [[A#^a]]\n\n> old [[B#^b]]\n\n`code` <!-- hidden -->").text, "后续思考");
	assert.equal(extractMemoRelationSummary("短文 👨‍👩‍👦").text, "短文 👨‍👩‍👦");
	assert.equal(extractMemoRelationSummary("![[A#^a]]").text, "");
	assert.equal(extractMemoRelationSummary("![[A#^a]]").imageOnly, false);
	assert.equal(extractMemoRelationSummary("> ![[image.png]]").imageOnly, false);
	assert.equal(extractMemoRelationSummary("![[image.png]]").imageOnly, true);
});
