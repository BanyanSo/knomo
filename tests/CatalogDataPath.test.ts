import assert from "node:assert/strict";
import test from "node:test";

import { ensureObsidianStub } from "./helpers/obsidianStub";

test("Trash 来自 Monthly 文件夹", async () => {
	await ensureObsidianStub();
	const { getTrashFilePath } = await import("../src/services/TrashSnapshotStore");
	assert.equal(getTrashFilePath("Memos/Archive"), "Memos/Archive/knomo-trash.json");
});
