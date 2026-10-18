import assert from "node:assert/strict";
import test from "node:test";
import { sha256Bytes, sha256Text } from "../src/utils/sha256";
import { canonicalJson as monthlyJson } from "../src/services/CanonicalJson";
import { canonicalJson as legacyJson } from "../src/utils/canonicalJson";

const EMPTY_DIGEST = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
const UNICODE_DIGEST = "980dbb99782196a90dd8d093974da8b0528ba1979eb224cc51a3a21361a76d4b";
const SUBVIEW_DIGEST = "c09e13ff1c2593e3e53f4b08d2cb1b811655d1a9bb53e6ad3bae36a57d4f7ae4";

test("SHA-256 固定字节覆盖空输入、Unicode 和非零 offset 子视图", async () => {
	assert.equal(await sha256Bytes(new Uint8Array()), EMPTY_DIGEST);
	assert.equal(await sha256Bytes(new TextEncoder().encode("Knomo 备忘 🌱\r\n")), UNICODE_DIGEST);
	assert.equal(await sha256Bytes(Uint8Array.from([255, 0, 128, 1, 254]).subarray(1, 4)), SUBVIEW_DIGEST);
	assert.equal(await sha256Text(""), EMPTY_DIGEST);
	assert.equal(await sha256Text("Knomo 备忘 🌱\r\n"), UNICODE_DIGEST);
});

test("SHA-256 在等待 digest 前复制输入，调用后修改原数组不改变摘要", async t => {
	const digest = crypto.subtle.digest.bind(crypto.subtle);
	let received: ArrayBuffer | undefined;
	t.mock.method(crypto.subtle, "digest", (algorithm: AlgorithmIdentifier, input: BufferSource) => {
		received = input as ArrayBuffer;
		return Promise.resolve().then(() => digest(algorithm, input));
	});
	const source = Uint8Array.from([255, 0, 128, 1, 254]);
	const pending = sha256Bytes(source.subarray(1, 4));
	source.fill(7);
	assert.notStrictEqual(received, source.buffer);
	assert.deepEqual([...new Uint8Array(received!)], [0, 128, 1]);
	assert.equal(await pending, SUBVIEW_DIGEST);
});

test("SHA-256 调用时获取 Web Crypto，不可用以 Promise 拒绝报告，恢复后可再次调用", async () => {
	const descriptor = Object.getOwnPropertyDescriptor(globalThis, "crypto")!;
	try {
		Object.defineProperty(globalThis, "crypto", { configurable: true, value: undefined });
		for (const call of [() => sha256Bytes(new Uint8Array()), () => sha256Text("")]) {
			let pending!: Promise<string>;
			assert.doesNotThrow(() => { pending = call(); });
			await assert.rejects(pending, { message: "Web Crypto SHA-256 is unavailable." });
		}
	} finally {
		Object.defineProperty(globalThis, "crypto", descriptor);
	}
	assert.equal(await sha256Bytes(new Uint8Array()), EMPTY_DIGEST);
});

test("SHA-256 原样传播 Web Crypto digest 的拒绝", async t => {
	const failure = new Error("digest rejected");
	t.mock.method(crypto.subtle, "digest", () => Promise.reject(failure));
	await assert.rejects(sha256Bytes(new Uint8Array()), error => error === failure);
	await assert.rejects(sha256Text("text"), error => error === failure);
});

test("两套 canonical JSON 保持补充平面键的历史排序及固定摘要", async () => {
	const value = { "\u{10000}": { z: true, a: "备忘" }, "\uE000": [1, "🌱"] };
	assert.equal(monthlyJson(value), '{"\uE000":[1,"🌱"],"\u{10000}":{"a":"备忘","z":true}}');
	assert.equal(legacyJson(value), '{"\u{10000}":{"a":"备忘","z":true},"\uE000":[1,"🌱"]}');
	assert.equal(await sha256Text(monthlyJson(value)), "87f40526efc69549740d203ac0736ce94715e0d3b265b6c769eb478ae0a7e757");
	assert.equal(await sha256Text(legacyJson(value)), "72637bbb8bb92414f305c963cb27e745953d253fd01015ae2eb4df42ce65f79d");
});
