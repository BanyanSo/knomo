import assert from "node:assert/strict";
import test, { before } from "node:test";
import { readFileSync } from "node:fs";
import type { KnomoQuickCommand, QuickCommandView } from "../src/ui/KnomoQuickCommands";
import { ensureObsidianStub } from "./helpers/obsidianStub";

let createHandler: typeof import("../src/ui/KnomoProtocolHandler").createKnomoProtocolHandler;
let Controller: typeof import("../src/ui/KnomoQuickCommands").KnomoQuickCommandController;
let createCommands: typeof import("../src/ui/KnomoQuickCommands").createKnomoQuickCommands;
let Plugin: typeof import("../src/main").default;

before(async () => {
	await ensureObsidianStub();
	({ createKnomoProtocolHandler: createHandler } = await import("../src/ui/KnomoProtocolHandler"));
	({ KnomoQuickCommandController: Controller, createKnomoQuickCommands: createCommands } = await import("../src/ui/KnomoQuickCommands"));
	({ default: Plugin } = await import("../src/main"));
});

function harness() {
	type Leaf = { view: QuickCommandView; setViewState(): Promise<void> };
	const calls: KnomoQuickCommand[] = [];
	const errors: unknown[] = [];
	const work: Promise<void>[] = [];
	const layouts: Array<() => void> = [];
	const state = {
		active: true, layoutReady: true, enabled: true, created: 0, opened: 0, revealed: 0,
		leaves: [] as Leaf[], leaf: null as Leaf | null, ready: async () => true,
	};
	const workspace = {
		getLeavesOfType: () => state.leaves,
		getLeaf: () => {
			state.created++;
			const leaf: Leaf = {
				view: { waitForQuickCommands: () => state.ready(), executeQuickCommand: (command) => { calls.push(command); } },
				setViewState: async () => { state.leaves.push(leaf); },
			};
			return leaf;
		},
		revealLeaf: async (_leaf: Leaf) => { state.revealed++; },
		setActiveLeaf: (leaf: Leaf) => { state.leaf = leaf; },
	};
	const controller = new Controller<Leaf>({
		getLeaves: workspace.getLeavesOfType, getActiveLeaf: () => state.leaf,
		createLeaf: workspace.getLeaf, openLeaf: (leaf) => leaf.setViewState(), loadLeaf: async () => {},
		revealLeaf: workspace.revealLeaf, focusLeaf: workspace.setActiveLeaf, getView: (leaf) => leaf.view,
		isTimeBuoyEnabled: () => state.enabled, showNotice: (message) => { errors.push(message); },
	});
	// 调用真实 activateView，验证 URL 的纯打开入口仍使用原有 Leaf 复用逻辑。
	const plugin = Object.assign(Object.create(Plugin.prototype), {
		app: { workspace }, requestMobileNavbarSync: () => {},
	});
	const handler = createHandler({
		onLayoutReady: (callback) => { if (state.layoutReady) callback(); else layouts.push(callback); },
		isActive: () => state.active,
		openView: () => {
			state.opened++;
			const task = plugin.activateView() as Promise<void>;
			work.push(task);
			return task;
		},
		quickCommands: {
			cancel: () => controller.cancel(),
			execute: (command) => { const task = controller.execute(command); work.push(task); return task; },
		},
		onError: (error) => { errors.push(error); },
	});
	return { state, handler, calls, errors, controller,
		flush: async () => { await Promise.all(work); },
		layout: () => { state.layoutReady = true; layouts.splice(0).forEach((callback) => callback()); },
	};
}

test("原生 knomo 注册绑定现有 activateView 和共享 Controller", () => {
	const source = readFileSync("src/main.ts", "utf8");
	assert.match(source, /registerObsidianProtocolHandler\("knomo", createKnomoProtocolHandler\(/);
	assert.match(source, /openView: \(\) => this\.activateView\(\)/);
	assert.match(source, /quickCommands: this\.quickCommandController/);
});

test("URL open-view 仅打开 Knomo，重复调用复用已有视图", async () => {
	const h = harness();
	h.handler({ action: "knomo", command: "open-view" });
	await h.flush();
	h.handler({ action: "knomo", command: "open-view" });
	await h.flush();
	assert.equal(h.state.created, 1);
	assert.equal(h.state.revealed, 2);
	assert.deepEqual(h.calls, []);
});

test("六个 URL 命令逐一走真实 QuickCommandController 并复用同一个 View", async () => {
	const h = harness();
	const ids = createCommands(async () => {}).map((command) => command.id);
	for (const command of ids) {
		h.handler({ action: "knomo", command, content: "不得插入正文" });
		await h.flush();
	}
	assert.deepEqual(h.calls, ids);
	assert.equal(h.state.created, 1);
	assert.equal(h.state.opened, 0);
	assert.deepEqual(h.errors, []);
});

test("缺失、空值和非 allow-list 命令不打开 View，也不执行命令", async () => {
	const h = harness();
	h.handler({ action: "knomo" });
	for (const command of ["", " ", "New-memo", "new-memo ", "clear-trash", "constructor", "toString", "%6Eew-memo"]) {
		h.handler({ action: "knomo", command });
	}
	await h.flush();
	assert.equal(h.state.created, 0);
	assert.deepEqual(h.calls, []);
});

test("布局恢复前不创建 View，只执行最后一个合法请求；非法请求不替换它", async () => {
	const h = harness();
	h.state.layoutReady = false;
	h.handler({ action: "knomo", command: "open-view" });
	h.handler({ action: "knomo", command: "new-memo" });
	h.handler({ action: "knomo", command: "on-this-day" });
	h.handler({ action: "knomo", command: "bad" });
	assert.equal(h.state.created, 0);
	h.layout();
	await h.flush();
	assert.equal(h.state.created, 1);
	assert.deepEqual(h.calls, ["on-this-day"]);
});

test("布局恢复前卸载后，不执行已排队或新收到的 URL", async () => {
	const h = harness();
	h.state.layoutReady = false;
	h.handler({ action: "knomo", command: "new-memo" });
	h.state.active = false;
	h.controller.dispose();
	h.layout();
	h.handler({ action: "knomo", command: "open-view" });
	await h.flush();
	assert.equal(h.state.created, 0);
});

test("URL 保留 Controller 初始化等待、last-request-wins 和取消行为", async () => {
	for (const cancel of [false, true]) {
		const h = harness();
		let resolve!: (ready: boolean) => void;
		let entered!: () => void;
		const waiting = new Promise<void>((done) => { entered = done; });
		h.state.ready = () => new Promise<boolean>((done) => { resolve = done; entered(); });
		h.handler({ action: "knomo", command: "new-memo" });
		await waiting;
		assert.deepEqual(h.calls, []);
		h.state.ready = async () => true;
		h.handler({ action: "knomo", command: "record-stats" });
		if (cancel) h.controller.cancel();
		resolve(true);
		await h.flush();
		assert.deepEqual(h.calls, cancel ? [] : ["record-stats"]);
		assert.equal(h.state.created, 1);
	}
});

test("URL time-buoy 仍受功能开关控制，禁用时不创建 View", async () => {
	const h = harness();
	h.state.enabled = false;
	h.handler({ action: "knomo", command: "time-buoy" });
	await h.flush();
	assert.equal(h.state.created, 0);
	assert.equal(h.errors.length, 1);
});

test("open-view 取消等待初始化的 Quick Command，复用已打开的 Leaf", async () => {
	const h = harness();
	let resolve!: (ready: boolean) => void;
	let entered!: () => void;
	const waiting = new Promise<void>((done) => { entered = done; });
	h.state.ready = () => new Promise<boolean>((done) => { resolve = done; entered(); });
	h.handler({ action: "knomo", command: "new-memo" });
	await waiting;
	h.handler({ action: "knomo", command: "open-view" });
	resolve(true);
	await h.flush();
	assert.equal(h.state.created, 1);
	assert.equal(h.state.opened, 1);
	assert.deepEqual(h.calls, []);
});

test("宿主路由契约模拟：Vault 名称、ID、编码名称、缺省目标及多实例隔离", async () => {
	// 仅模拟宿主选择目标后才分发的边界，不将该测试当作 Obsidian 路由验收。
	for (const vault of ["ef6ca3e3b524d22f", "My Vault", "工作 笔记", "100% 笔记", undefined]) {
		for (const stripVault of [false, true]) {
			const wrong = harness();
			const target = harness();
			const url = `obsidian://knomo?command=new-memo${vault === undefined ? "" : `&vault=${encodeURIComponent(vault)}`}`;
			const parsed = new URL(url);
			const params = { action: "knomo", ...Object.fromEntries(parsed.searchParams) };
			assert.equal(parsed.searchParams.get("vault"), vault ?? null);
			// 原生路由会选中对应 Vault；1.13 桌面端在分发前消耗 vault 参数。
			if (stripVault) delete (params as Record<string, string>).vault;
			target.handler(params);
			await target.flush();
			await wrong.flush();
			assert.deepEqual(target.calls, ["new-memo"]);
			assert.equal(wrong.state.created, 0);
			assert.deepEqual(wrong.calls, []);
		}
	}
});
