import assert from "node:assert/strict";
import test from "node:test";
import { KnomoBasicDataRecovery } from "../src/services/KnomoBasicDataRecovery";
import { KnomoMutationBarrier } from "../src/services/KnomoMutationBarrier";

test("确认重建串行执行，失败保留未完成状态，并合并重复点击", async () => {
	const steps: string[] = [];
	let fail = true;
	const recovery = new KnomoBasicDataRecovery({
		signal: new AbortController().signal,
		prepare: async () => { steps.push("pending"); },
		rebuildReplicas: async () => { steps.push("replicas"); },
		initialize: async () => { if (fail) throw new Error("read failed"); steps.push("config"); },
		rebuildCatalog: async () => { steps.push("catalog"); },
		importIdentities: async () => { steps.push("identity"); },
		complete: async () => { steps.push("complete"); },
	});
	const first = recovery.run();
	assert.equal(recovery.run(), first);
	await assert.rejects(first, /read failed/);
	assert.deepEqual(steps, ["pending", "replicas"]);
	fail = false;
	await recovery.run();
	assert.deepEqual(steps.slice(2), ["pending", "replicas", "config", "catalog", "identity", "complete"]);
});

test("重建等待已有 Daily 操作结束且拒绝新操作，失败后解除暂停", async () => {
	const barrier = new KnomoMutationBarrier();
	let finish!: () => void;
	const running = barrier.wrap(() => new Promise<void>((resolve) => { finish = resolve; }))();
	await Promise.resolve();
	let recovered = false;
	const recovery = barrier.runPaused(async () => { recovered = true; throw new Error("failed"); });
	await assert.rejects(barrier.wrap(async () => undefined)(), /being rebuilt/);
	assert.equal(recovered, false);
	finish();
	await running;
	await assert.rejects(recovery, /failed/);
	assert.equal(recovered, true);
	await barrier.wrap(async () => undefined)();
});
