import assert from "node:assert/strict";
import test from "node:test";
import { createCardMemo } from "./helpers/memoCardFixture";

test("卡片 fixture 的默认对象独立，显式覆盖保持浅覆盖和 undefined", () => {
	const first = createCardMemo(), second = createCardMemo();
	first.tags.push("changed");
	first.links.push({ target: "Changed", displayText: null, syntax: "wiki_link" });
	first.images.push({ path: "changed.png", altText: "", syntax: "obsidian_embed" });
	first.dailyRef.path = "Changed.md";
	assert.deepEqual(second.tags, []);
	assert.deepEqual(second.links, []);
	assert.deepEqual(second.images, []);
	assert.equal(second.dailyRef.path, "Daily/2026-06-02.md");
	const tags = ["explicit"], dailyRef = { path: "Custom.md", heading: null, lineNumberHint: null };
	const overridden = createCardMemo({ tags, dailyRef, createdAt: undefined });
	assert.strictEqual(overridden.tags, tags);
	assert.strictEqual(overridden.dailyRef, dailyRef);
	assert.equal(overridden.createdAt, undefined);
});
