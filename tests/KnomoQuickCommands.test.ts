import assert from "node:assert/strict";
import test, { before } from "node:test";
import type { KnomoQuickCommand, QuickCommandView } from "../src/ui/KnomoQuickCommands";
import { ensureObsidianStub } from "./helpers/obsidianStub";

let createKnomoQuickCommands: typeof import("../src/ui/KnomoQuickCommands").createKnomoQuickCommands;
let KnomoQuickCommandController: typeof import("../src/ui/KnomoQuickCommands").KnomoQuickCommandController;
let translate: typeof import("../src/i18n").translate;

before(async () => {
	await ensureObsidianStub();
	({ createKnomoQuickCommands, KnomoQuickCommandController } = await import("../src/ui/KnomoQuickCommands"));
	({ translate } = await import("../src/i18n"));
});

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (error: Error) => void;
	const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
	return { promise, resolve, reject };
}

function harness() {
	type Leaf = { view: QuickCommandView };
	const calls: Array<{ leaf: Leaf; command: KnomoQuickCommand }> = [];
	const notices: string[] = [];
	const state = {
		leaves: [] as Leaf[], active: null as Leaf | null, enabled: true, created: 0, revealed: 0,
		open: async (_leaf: Leaf) => {}, load: async (_leaf: Leaf) => {}, reveal: async (_leaf: Leaf) => {}, ready: async () => true,
	};
	const makeLeaf = (): Leaf => {
		const leaf: Leaf = { view: {
			waitForQuickCommands: () => state.ready(),
			executeQuickCommand: (command) => { calls.push({ leaf, command }); },
		} };
		return leaf;
	};
	const controller = new KnomoQuickCommandController<Leaf>({
		getLeaves: () => state.leaves,
		getActiveLeaf: () => state.active,
		createLeaf: () => { state.created += 1; return makeLeaf(); },
		openLeaf: async (leaf) => { state.leaves.push(leaf); await state.open(leaf); },
		loadLeaf: (leaf) => state.load(leaf),
		revealLeaf: async (leaf) => {
			state.revealed += 1;
			state.active = leaf;
			controller.activeLeafChanged(leaf);
			await state.reveal(leaf);
		},
		focusLeaf: (leaf) => { state.active = leaf; controller.activeLeafChanged(leaf); },
		getView: (leaf) => leaf.view,
		isTimeBuoyEnabled: () => state.enabled,
		showNotice: (message) => { notices.push(message); },
	});
	return { state, controller, calls, notices, makeLeaf };
}

test("六个独立全局命令使用稳定本地 ID、现有名称且无默认快捷键", async () => {
	const called: KnomoQuickCommand[] = [];
	const commands = createKnomoQuickCommands(async (id) => { called.push(id); });
	const ids = ["new-memo", "random-revisit", "shuffle-day", "time-buoy", "record-stats", "on-this-day"];
	assert.deepEqual(commands.map((command) => command.id), ids);
	assert.deepEqual(commands.map((command) => command.name), ["New memo", "Random revisit", "Shuffle day", "Time buoy", "Record statistics", "On this day"]);
	for (const command of commands) {
		assert.equal(command.hotkeys, undefined);
		assert.equal(command.editorCallback, undefined);
		assert.equal(command.checkCallback, undefined);
		await command.callback?.();
	}
	assert.deepEqual(called, ids);
	assert.deepEqual(["command.newMemo", "nav.random", "nav.shuffleDay", "nav.timeBuoy", "nav.recordStats", "filter.anniversary"].map(
		(key) => translate("zh-CN", key as Parameters<typeof translate>[1]),
	), ["新建 Memo", "随机重逢", "往日漫游", "时光浮标", "记录统计", "那年今日"]);
});

test("每个命令均可从空工作区打开，后续复用同一视图", async () => {
	for (const command of createKnomoQuickCommands(async () => {})) {
		const h = harness();
		await h.controller.execute(command.id as KnomoQuickCommand);
		await h.controller.execute(command.id as KnomoQuickCommand);
		assert.equal(h.state.created, 1);
		assert.equal(h.calls.length, 2);
		assert.equal(h.calls[0].leaf, h.calls[1].leaf);
		assert.deepEqual(h.notices, []);
	}
});

test("打开期间连续执行只创建一个标签页且只有最后一个目标生效", async () => {
	const h = harness();
	const opening = deferred<void>();
	h.state.open = () => opening.promise;
	const first = h.controller.execute("new-memo");
	await Promise.resolve();
	const second = h.controller.execute("random-revisit");
	const last = h.controller.execute("record-stats");
	assert.equal(h.state.created, 1);
	assert.equal(h.calls.length, 0);
	opening.resolve();
	await Promise.all([first, second, last]);
	assert.deepEqual(h.calls.map((call) => call.command), ["record-stats"]);
	assert.equal(h.state.revealed, 1);
});

test("多视图优先当前 Knomo，否则复用第一个，不跨视图执行", async () => {
	const h = harness();
	const first = h.makeLeaf();
	const second = h.makeLeaf();
	h.state.leaves = [first, second];
	h.state.active = second;
	await h.controller.execute("new-memo");
	h.state.active = h.makeLeaf();
	await h.controller.execute("on-this-day");
	assert.deepEqual(h.calls.map((call) => call.leaf), [second, first]);
	assert.equal(h.state.created, 0);
});

test("时光浮标关闭时不打开、不切页；等待期间关闭时不进入功能", async () => {
	const h = harness();
	h.state.enabled = false;
	await h.controller.execute("time-buoy");
	assert.equal(h.state.created, 0);
	assert.equal(h.state.revealed, 0);
	assert.equal(h.notices.length, 1);
	h.state.enabled = true;
	const opening = deferred<void>();
	h.state.open = () => opening.promise;
	const work = h.controller.execute("time-buoy");
	await Promise.resolve();
	h.state.enabled = false;
	opening.resolve();
	await work;
	assert.equal(h.state.revealed, 0);
	assert.deepEqual(h.calls, []);
	assert.equal(h.notices.length, 2);
});

test("打开失败只提示一次，下一次命令可以重试", async () => {
	const h = harness();
	h.state.open = async () => { h.state.leaves = []; throw new Error("open failed"); };
	await h.controller.execute("new-memo");
	assert.equal(h.notices.length, 1);
	h.state.open = async () => {};
	await h.controller.execute("new-memo");
	assert.equal(h.calls.length, 1);
});

test("就绪失败报告错误；业务加载不参与入口等待", async () => {
	const h = harness();
	h.state.ready = async () => false;
	await h.controller.execute("on-this-day");
	assert.equal(h.calls.length, 0);
	assert.equal(h.notices.length, 1);
	h.state.ready = async () => true;
	await h.controller.execute("on-this-day");
	assert.equal(h.calls.length, 1);
});

test("等待就绪时的切页、普通导航、视图关闭或卸载使旧入口失效", async () => {
	for (const action of ["switch", "navigate", "close", "unload"] as const) {
		const h = harness();
		const entered = deferred<void>();
		const ready = deferred<boolean>();
		h.state.ready = () => { entered.resolve(); return ready.promise; };
		const work = h.controller.execute("new-memo");
		await entered.promise;
		if (action === "switch") { h.state.active = h.makeLeaf(); h.controller.activeLeafChanged(h.state.active); }
		if (action === "navigate") h.controller.cancel();
		if (action === "close") h.state.leaves = [];
		if (action === "unload") h.controller.dispose();
		ready.resolve(true);
		await work;
		assert.deepEqual(h.calls, [], action);
		assert.deepEqual(h.notices, [], action);
	}
});

test("旧 reveal 完成后不能执行旧入口，最后一个命令仍有效", async () => {
	const h = harness();
	const firstReveal = deferred<void>();
	const entered = deferred<void>();
	h.state.reveal = () => { entered.resolve(); return firstReveal.promise; };
	const first = h.controller.execute("new-memo");
	await entered.promise;
	h.state.reveal = async () => {};
	await h.controller.execute("shuffle-day");
	firstReveal.resolve();
	await first;
	assert.deepEqual(h.calls.map((call) => call.command), ["shuffle-day"]);
});

test("卸载后不会启动尚未开始的打开任务", async () => {
	const h = harness();
	const work = h.controller.execute("new-memo");
	h.controller.dispose();
	await work;
	assert.deepEqual(h.state.leaves, []);
	assert.deepEqual(h.calls, []);
});

test("休眠视图加载期间用户切页，加载完成后不 reveal 也不聚焦", async () => {
	const h = harness();
	h.state.leaves = [h.makeLeaf()];
	const load = deferred<void>();
	h.state.load = () => load.promise;
	const work = h.controller.execute("new-memo");
	h.state.active = h.makeLeaf();
	h.controller.activeLeafChanged(h.state.active);
	load.resolve();
	await work;
	assert.equal(h.state.revealed, 0);
	assert.equal(h.calls.length, 0);
});
