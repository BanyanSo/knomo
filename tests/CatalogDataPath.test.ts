import assert from "node:assert/strict";
import test from "node:test";

import {
	getCatalogDataRootPath,
	getCatalogDeletedPayloadPath,
	getCatalogDeletedRootPath,
	getCatalogDevicePath,
	getCatalogDevicesRootPath,
	getCatalogMigrationTempPath,
	getCatalogSnapshotsRootPath,
	getCatalogStateCheckpointPath,
	getCatalogStateCheckpointsRootPath,
	getCatalogStateRootPath,
	getCatalogStateSegmentPath,
	getCatalogTempRootPath,
	getCatalogUpgradeCheckpointPath,
	getCatalogUpgradeCheckpointsRootPath,
	getCatalogUpgradeIssuePath,
	getCatalogUpgradeIssuesRootPath,
	getCatalogUpgradePackagePath,
	getCatalogUpgradePackagesRootPath,
	getCatalogUpgradeRootPath,
	getLegacySystemRootPath,
} from "../src/utils/path";

test("catalog paths use the flat _knomo-data layout and legacy root stays explicit", () => {
	const root = getCatalogDataRootPath("/Memos//Archive/");
	assert.equal(root, "Memos/Archive/_knomo-data");
	assert.equal(getLegacySystemRootPath("/Memos//Archive/"), "Memos/Archive/_knomo-system");
	assert.equal(getCatalogStateRootPath(root), `${root}/state`);
	assert.equal(getCatalogDevicesRootPath(root), `${root}/state/devices`);
	assert.equal(getCatalogDevicePath(root, "w_1"), `${root}/state/devices/w_1`);
	assert.equal(getCatalogStateSegmentPath(root, "w_1", 1), `${root}/state/devices/w_1/segment-000001.jsonl`);
	assert.equal(getCatalogSnapshotsRootPath(root), `${root}/state/snapshots`);
	assert.equal(getCatalogStateCheckpointsRootPath(root), `${root}/state/checkpoints`);
	assert.equal(getCatalogStateCheckpointPath(root, "digest", "w_1"), `${root}/state/checkpoints/commit-digest-w_1.json`);
	assert.equal(getCatalogDeletedRootPath(root), `${root}/state/deleted`);
	assert.equal(getCatalogDeletedPayloadPath(root, "memo", "op"), `${root}/state/deleted/memo/op.json`);
	assert.equal(getCatalogUpgradeRootPath(root), `${root}/upgrade`);
	assert.equal(getCatalogUpgradePackagesRootPath(root), `${root}/upgrade/packages`);
	assert.equal(getCatalogUpgradePackagePath(root, "memo_index", "digest"), `${root}/upgrade/packages/memo_index-digest.json`);
	assert.equal(getCatalogUpgradeCheckpointsRootPath(root), `${root}/upgrade/checkpoints`);
	assert.equal(getCatalogUpgradeCheckpointPath(root, "digest", "w_1"), `${root}/upgrade/checkpoints/commit-digest-w_1.json`);
	assert.equal(getCatalogUpgradeIssuesRootPath(root), `${root}/upgrade/issues`);
	assert.equal(getCatalogUpgradeIssuePath(root, "memo_index", "digest"), `${root}/upgrade/issues/memo_index-digest.json`);
	assert.equal(getCatalogTempRootPath(root), `${root}/temp`);
	assert.equal(getCatalogMigrationTempPath(root, "run"), `${root}/temp/migration-run`);
	assert.equal(root.includes("/v2/"), false);
});
