import assert from "node:assert/strict";
import test from "node:test";

import { ensureObsidianStub } from "./helpers/obsidianStub";

test("Trash 来自 Monthly 文件夹，正式旧 Index 根定位保持不变", async () => {
	await ensureObsidianStub();
	const { getLegacySystemRootPath } = await import("../src/utils/path");
	const { getTrashFilePath } = await import("../src/services/TrashSnapshotStore");
	assert.equal(getTrashFilePath("Memos/Archive"), "Memos/Archive/knomo-trash.json");
	assert.equal(getLegacySystemRootPath("/Memos//Archive/"), "Memos/Archive/_knomo-system");
});
