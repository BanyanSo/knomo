import assert from "node:assert/strict";
import test from "node:test";
import { LocalMemoReviewStore } from "../src/services/LocalMemoReviewStore";

test("review 保存在设备本地，revision key 不复用；重置和读取失败不阻断候选", () => {
	let saved: unknown;
	const storage = { loadLocalStorage: () => saved, saveLocalStorage: (_key: string, value: unknown) => { saved = value; } };
	const reviews = new LocalMemoReviewStore(storage);
	reviews.record("path/line/revision-1", "2026-09-08T00:00:00Z");
	assert.equal(new LocalMemoReviewStore(storage).read()["path/line/revision-1"]?.reviewCount, 1);
	assert.equal(reviews.read()["path/line/revision-2"], undefined);
	saved = null;
	assert.deepEqual(new LocalMemoReviewStore(storage).read(), {});
	assert.deepEqual(new LocalMemoReviewStore({ ...storage, loadLocalStorage: () => { throw new Error("unavailable"); } }).read(), {});
	const failing = new LocalMemoReviewStore({ ...storage, saveLocalStorage: () => { throw new Error("write failed"); } });
	assert.throws(() => failing.record("key", "2026-09-08T00:00:00Z"), /write failed/u);
	assert.equal(failing.read().key, undefined);
});
