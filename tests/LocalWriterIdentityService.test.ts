import assert from "node:assert/strict";
import test from "node:test";
import type { App } from "obsidian";

import {
	LOCAL_WRITER_ID_STORAGE_KEY,
	LocalWriterIdentityService,
} from "../src/services/LocalWriterIdentityService";

const WRITER_A = "w_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const WRITER_B = "w_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

test("首次并发获取只生成并持久化一个本地 writerId", async () => {
	const harness = createHarness(null);
	let createCount = 0;
	const service = new LocalWriterIdentityService(harness.app, () => {
		createCount += 1;
		return WRITER_A;
	});

	const first = service.getWriterId();
	const second = service.getWriterId();

	assert.equal(first, second);
	assert.deepEqual(await Promise.all([first, second]), [WRITER_A, WRITER_A]);
	assert.equal(createCount, 1);
	assert.equal(harness.saveCount(), 1);
	assert.equal(harness.value(), WRITER_A);
});

test("插件服务重建后从 Vault 本地存储恢复同一个 writerId", async () => {
	const harness = createHarness(null);
	const first = new LocalWriterIdentityService(harness.app, () => WRITER_A);
	assert.equal(await first.getWriterId(), WRITER_A);

	const restored = new LocalWriterIdentityService(harness.app, () => WRITER_B);

	assert.equal(await restored.getWriterId(), WRITER_A);
	assert.equal(harness.saveCount(), 1);
});

test("同一 Vault 的不同本地实例不共享 writer identity", async () => {
	const first = new LocalWriterIdentityService(createHarness(null).app, () => WRITER_A);
	const second = new LocalWriterIdentityService(createHarness(null).app, () => WRITER_B);

	assert.equal(await first.getWriterId(), WRITER_A);
	assert.equal(await second.getWriterId(), WRITER_B);
});

test("本地 writerId 保存失败时不返回未持久化 identity", async () => {
	const harness = createHarness(null, { failSave: true });
	const service = new LocalWriterIdentityService(harness.app, () => WRITER_A);

	await assert.rejects(() => service.getWriterId(), /local storage unavailable/u);
	assert.equal(harness.value(), null);
});

test("本地存储静默丢弃 writerId 时回读校验失败", async () => {
	const harness = createHarness(null, { discardSave: true });
	const service = new LocalWriterIdentityService(harness.app, () => WRITER_A);

	await assert.rejects(() => service.getWriterId(), /was not persisted/u);
	assert.equal(harness.value(), null);
});

test("已有但非法的本地 writer identity 不被静默替换", async () => {
	const harness = createHarness("invalid-writer");
	const service = new LocalWriterIdentityService(harness.app, () => WRITER_A);

	await assert.rejects(() => service.getWriterId(), /writerId is invalid/u);
	assert.equal(harness.saveCount(), 0);
	assert.equal(harness.value(), "invalid-writer");
});

function createHarness(
	initialValue: unknown,
	options: { failSave?: boolean; discardSave?: boolean } = {},
): {
	app: Pick<App, "loadLocalStorage" | "saveLocalStorage">;
	saveCount: () => number;
	value: () => unknown;
} {
	let value = initialValue;
	let saveCount = 0;
	return {
		app: {
			loadLocalStorage: (key: string) => {
				assert.equal(key, LOCAL_WRITER_ID_STORAGE_KEY);
				return value;
			},
			saveLocalStorage: (key: string, nextValue: unknown | null) => {
				assert.equal(key, LOCAL_WRITER_ID_STORAGE_KEY);
				saveCount += 1;
				if (options.failSave === true) throw new Error("local storage unavailable");
				if (options.discardSave !== true) value = nextValue;
			},
		},
		saveCount: () => saveCount,
		value: () => value,
	};
}
