import assert from "node:assert/strict";
import test from "node:test";
import { IndependentTrashController } from "../src/ui/IndependentTrashController";
import type { TrashSnapshot } from "../src/types/trash";

test("Trash UI 按 snapshotId 独立操作同文副本，并保留恢复成功但清理失败提示", async () => {
	const base = { deletedAt: "2026-09-08T00:00:00Z", sourcePath: "Daily/2026-09-08.md", logicalDate: "2026-09-08",
		section: "## Memos", rawBlock: "- 10:30 same memo" };
	let items: TrashSnapshot[] = [{ ...base, snapshotId: "one" }, { ...base, snapshotId: "two" }];
	const calls: string[] = [];
	const controller = new IndependentTrashController({
		query: async () => ({ items, errors: [{ snapshotId: "bad", message: "damaged" }] }),
		restore: async (snapshotId) => { calls.push(snapshotId); return { snapshotId, state: "restored_cleanup_pending",
			observation: null, catalogUpdatePending: false, message: "正文已恢复，恢复副本未清理" }; },
		purge: async (snapshotId) => { items = items.filter((item) => item.snapshotId !== snapshotId); },
	});
	await controller.refresh();
	await controller.run("two", "restore");
	assert.deepEqual(calls, ["two"]);
	assert.equal(controller.getSnapshot().items.length, 2);
	assert.match(controller.getSnapshot().messages.get("two")!, /恢复副本未清理/u);
	await controller.run("one", "purge");
	assert.deepEqual(controller.getSnapshot().items.map((item) => item.snapshotId), ["two"]);
	assert.equal(controller.getSnapshot().errors.length, 1);
	assert.equal(controller.getSnapshot().busySnapshotIds.size, 0);
});
