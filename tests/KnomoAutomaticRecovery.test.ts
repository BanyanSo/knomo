import assert from "node:assert/strict";
import test from "node:test";
import { KnomoAutomaticRecovery } from "../src/services/KnomoAutomaticRecovery";

test("读取暂缺后台自动重试且并发请求合并", async () => {
	let attempts = 0;
	const recovery = new KnomoAutomaticRecovery({
		signal: new AbortController().signal,
		retryDelays: [0, 0],
		recover: async () => { if (++attempts < 3) throw new Error("missing"); },
		isRecovered: () => attempts === 3,
	});
	const first = recovery.run();
	assert.equal(recovery.run(), first);
	assert.equal(recovery.isRunning(), true);
	await first;
	assert.equal(attempts, 3);
	assert.equal(recovery.isRunning(), false);
});

test("持续失败只执行有限次数且保留最后错误", async () => {
	let attempts = 0;
	const recovery = new KnomoAutomaticRecovery({ signal: new AbortController().signal, retryDelays: [0],
		recover: async () => { attempts++; throw new Error("unreadable"); }, isRecovered: () => false });
	await assert.rejects(recovery.run(), /unreadable/u);
	assert.equal(attempts, 2);
});

test("卸载取消等待且不再执行后续恢复", async () => {
	const controller = new AbortController();
	let attempts = 0;
	const recovery = new KnomoAutomaticRecovery({ signal: controller.signal, retryDelays: [10000],
		recover: async () => { attempts++; }, isRecovered: () => false });
	const operation = recovery.run();
	await new Promise((resolve) => setTimeout(resolve, 0));
	controller.abort();
	await operation;
	assert.equal(attempts, 1);
});
