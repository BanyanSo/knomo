import assert from "node:assert/strict";
import test from "node:test";

import { getIdentityLedgerRootPath } from "../src/services/IdentityLedgerProtocol";
import { getKnomoSharedConfigRootPath } from "../src/services/KnomoSharedConfigProtocol";
import { getCatalogDataRootPath, getLegacySystemRootPath } from "../src/utils/path";

test("Knomo 内部数据使用稳定的无版本目录，旧 Index 根保持显式只读", () => {
	const root = getCatalogDataRootPath("/Memos//Archive/");
	assert.equal(root, "Memos/Archive/_knomo-data");
	assert.equal(getLegacySystemRootPath("/Memos//Archive/"), "Memos/Archive/_knomo-system");
	assert.equal(getIdentityLedgerRootPath("/Memos//Archive/"), `${root}/identity`);
	assert.equal(getKnomoSharedConfigRootPath("/Memos//Archive/"), `${root}/config`);
});
