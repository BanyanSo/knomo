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
