import assert from "node:assert/strict";
import test from "node:test";

import { filterVaultFolderPaths } from "../src/ui/KnomoFolderSuggest";

test("Vault 文件夹筛选忽略大小写并支持多段路径查询", () => {
	const paths = ["Projects/Knomo Data", "Archive/Knomo", "Daily", "Projects/Other"];
	assert.deepEqual(filterVaultFolderPaths(paths, "pro knomo"), ["Projects/Knomo Data"]);
	assert.deepEqual(filterVaultFolderPaths(paths, "ARCHIVE\\kno"), ["Archive/Knomo"]);
});

test("空查询返回排序后的已有文件夹，同时仍允许输入新路径", () => {
	assert.deepEqual(filterVaultFolderPaths(["Zeta", "Alpha"], ""), ["Alpha", "Zeta"]);
	assert.deepEqual(filterVaultFolderPaths(["Existing"], "Brand New"), []);
});
