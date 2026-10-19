import assert from "node:assert/strict";
import test from "node:test";

import { translate } from "../src/i18n";

test("永久清理确认只说明 Knomo 内不可恢复", () => {
	assert.equal(
		translate("zh-CN", "confirm.purgeMemo"),
		"永久清理后，将无法再从 Knomo 恢复这条 Memo，确认继续吗？",
	);
	assert.equal(
		translate("en", "confirm.purgeMemo"),
		"After permanent deletion, you cannot restore this memo from Knomo. Continue?",
	);
});

test("清空文案说明不可恢复与 Daily 边界，失败不拼接技术错误", () => {
	assert.equal(translate("zh-CN", "trash.summary", { count: 101 }), "回收站共有 101 条Memos");
	assert.equal(translate("zh-CN", "trash.summaryOne", { count: 1 }), "回收站共有 1 条Memos");
	assert.equal(translate("en", "trash.summaryOne", { count: 1 }), "1 memo in Trash");
	assert.equal(translate("en", "trash.summary", { count: 101 }), "101 memos in Trash");
	assert.equal(translate("zh-CN", "confirm.clearTrash"), "回收站中的所有 Memos 将被永久删除，无法再通过 Knomo 恢复。日记中已有的内容不会受到影响。");
	assert.equal(translate("en", "confirm.clearTrash"), "All memos in Trash will be permanently deleted and can’t be restored in Knomo. Your daily notes won’t be affected.");
	assert.equal(translate("zh-CN", "notice.trashCleared"), "回收站已清空");
	assert.equal(translate("en", "notice.trashCleared"), "Trash emptied.");
	assert.equal(translate("zh-CN", "error.clearTrashFailed", { error: "private detail" }), "无法确认回收站是否已清空，请重新查看。");
	assert.equal(translate("en", "error.clearTrashFailed", { error: "private detail" }), "Couldn't confirm whether Trash was emptied. Please check again.");
});
