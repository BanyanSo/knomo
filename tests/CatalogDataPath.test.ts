import assert from "node:assert/strict";
import test from "node:test";

import { ensureObsidianStub } from "./helpers/obsidianStub";

test("Knomo 内部数据使用稳定的无版本目录，旧 Index 根保持显式只读", async () => {
	await ensureObsidianStub();
	const { getCatalogDataRootPath, getLegacySystemRootPath } = await import("../src/utils/path");
	const root = getCatalogDataRootPath("/Memos//Archive/");
	assert.equal(root, "Memos/Archive/_knomo-data");
	assert.equal(getLegacySystemRootPath("/Memos//Archive/"), "Memos/Archive/_knomo-system");
});
