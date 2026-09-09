import assert from "node:assert/strict";
import test from "node:test";
import { KnomoStartupBootstrapService } from "../src/services/KnomoStartupBootstrapService";
import type { KnomoCurrentConfigStatus } from "../src/types/knomoConfig";
import { InMemoryVault } from "./helpers/InMemoryVault";

function fixture(layoutReady = true) {
 const vault = new InMemoryVault({ "Daily/2026-08-22.md": "- 09:00 memo\n" });
 let readyCallback = () => {};
 const workspace = { layoutReady, onLayoutReady: (callback: () => void) => { readyCallback = callback; } };
 Object.assign(vault.app, { workspace });
 let status: KnomoCurrentConfigStatus = "ready";
 const calls: string[] = [];
 const cancellation = new AbortController();
 const options = {
  currentConfig: { initialize: async () => { calls.push("config"); }, getStatus: () => status, getLastError: () => "config unreadable" },
  cancellationSignal: cancellation.signal,
 };
 const service = new KnomoStartupBootstrapService(vault.app, options);
 return { vault, service, calls, cancellation, options, setStatus: (value: KnomoCurrentConfigStatus) => { status = value; },
  layoutReady: () => { workspace.layoutReady = true; readyCallback(); } };
}

test("启动等待布局并合并并发请求，只初始化配置且不访问 Trash", async () => {
	const f = fixture(false);
 const first = f.service.initialize();
 assert.strictEqual(f.service.initialize(), first);
 assert.deepEqual(f.calls, []);
 f.layoutReady(); await first;
 assert.equal(f.service.getSnapshot().status, "ready");
 assert.deepEqual(f.calls, ["config", "config"]);
 assert.equal(f.vault.read("Daily/2026-08-22.md"), "- 09:00 memo\n");
 assert.equal(f.vault.paths().some(p => /identity|receipts|writer|current-state|segments/.test(p)), false);
});

test("布局就绪前卸载取消，后到回调不再创建文件", async () => {
 const f = fixture(false); const pending = f.service.initialize();
 f.cancellation.abort(); await assert.rejects(pending, /cancelled/);
 f.layoutReady(); await Promise.resolve(); assert.deepEqual(f.calls, []);
});

test("当前配置不可读时显式失败，重试成功且不创建目录", async () => {
 const f = fixture(); f.setStatus("unavailable");
 await assert.rejects(f.service.initialize(), /unreadable/);
 assert.equal(f.service.getSnapshot().status, "unavailable");
 f.setStatus("ready"); await f.service.retryInitialization();
 assert.equal(f.service.getSnapshot().status, "ready");
 assert.deepEqual(f.vault.paths(), ["Daily/2026-08-22.md"]);
});

test("配置阶段取消不能标记就绪", async () => { const g = fixture(); g.options.currentConfig.initialize = async () => { g.cancellation.abort(); };
 await assert.rejects(g.service.initialize(), /cancelled/);
 assert.notEqual(g.service.getSnapshot().status, "ready");
});

test("损坏 Trash 不参与启动初始化，启动不创建恢复目录或单文件", async () => {
 const f = fixture();
 await f.vault.app.vault.create("Knomo/knomo-trash.json", "broken");
 f.vault.app.vault.read = async () => { throw new Error("Trash must not be read during startup"); };
 f.vault.app.vault.createFolder = async () => { throw new Error("No startup folders"); };
 await f.service.initialize();
 assert.equal(f.service.getSnapshot().status, "ready");
 assert.equal(f.vault.read("Knomo/knomo-trash.json"), "broken");
});
