import test from "node:test";
import assert from "node:assert/strict";

import {
	getMemoActionClass,
	getMemoCardActions,
	getMemoCardShell,
	getMemoSourceReferenceMeta,
	getMemoWarningText,
	getTrashActionClass,
	getTrashCardActions,
	getTrashActionState,
	getTrashMemoCardClass,
	getTrashMemoWarningText,
} from "../src/ui/KnomoCardMetadata";
import type { MemoRecord } from "../src/types/memo";
import { recoverMemoReferenceMetadata } from "../src/utils/references";

test("builds memo card shell metadata without daily-open card attributes", () => {
	assert.deepEqual(getMemoCardShell({
		memoId: "memo-1",
		includeActions: true,
		activeMenuMemoId: "memo-1",
	}), {
		className: "knomo-card is-menu-open",
		attrs: {
			"data-memo-id": "memo-1",
		},
	});

	assert.deepEqual(getMemoCardShell({
		memoId: "memo-2",
		includeActions: false,
		activeMenuMemoId: "memo-2",
	}), {
		className: "knomo-card",
		attrs: {
			"data-memo-id": "memo-2",
		},
	});
});

test("builds card action and trash action metadata", () => {
	assert.equal(getMemoActionClass("edit"), "knomo-card-action");
	assert.equal(getMemoActionClass("delete"), "knomo-card-action is-danger");
	assert.deepEqual(getMemoCardActions(), [
		{ action: "edit", className: "knomo-card-action" },
		{ action: "reference", className: "knomo-card-action" },
		{ action: "open-daily", className: "knomo-card-action" },
		{ action: "copy-text", className: "knomo-card-action" },
		{ action: "copy-link", className: "knomo-card-action" },
		{ action: "delete", className: "knomo-card-action is-danger" },
	]);
	assert.equal(getTrashActionClass("restore"), "knomo-inline-button");
	assert.equal(getTrashActionClass("purge"), "knomo-inline-button is-danger");
	assert.deepEqual(getTrashActionState("restore", null), { disabled: false, busy: false });
	assert.deepEqual(getTrashActionState("restore", "restore"), { disabled: true, busy: true });
	assert.deepEqual(getTrashActionState("purge", "restore"), { disabled: true, busy: false });
	assert.deepEqual(getTrashCardActions("restore"), [
		{
			action: "restore",
			className: "knomo-inline-button",
			state: { disabled: true, busy: true },
		},
		{
			action: "purge",
			className: "knomo-inline-button is-danger",
			state: { disabled: true, busy: false },
		},
	]);
	assert.equal(getTrashMemoCardClass(null), "knomo-card knomo-trash-card");
	assert.equal(getTrashMemoCardClass("purge"), "knomo-card knomo-trash-card is-busy");
});

test("builds memo source reference metadata", () => {
	const deletedMemoIds = new Set<string>();
	assert.deepEqual(getMemoSourceReferenceMeta(makeMemo({ sourceMemoId: null }), deletedMemoIds), { type: "none" });
	assert.deepEqual(getMemoSourceReferenceMeta(makeMemo({ sourceMemoId: "source-1" }), new Set(["source-1"])), { type: "none" });
	assert.deepEqual(getMemoSourceReferenceMeta(makeMemo({ sourceMemoId: "source-1" }), deletedMemoIds), {
		type: "plain",
		sourceMemoId: "source-1",
	});
	assert.deepEqual(getMemoSourceReferenceMeta(makeMemo({
		sourceMemoId: "source-1",
		references: [{ memoId: "source-1", referenceText: "[[Daily/2026-06-02#^abc]]" }],
	}), deletedMemoIds), {
		type: "markdown",
		text: "[[Daily/2026-06-02#^abc|source-1]]",
		sourcePath: "Daily/2026-06-02.md",
	});
});

test("builds source metadata after recovering a historical reference", () => {
	const source = makeMemo({
		id: "2026060208000000",
		dailyRef: {
			...makeMemo().dailyRef,
			lastKnownBlock: "- 08:00 source ^abc123",
		},
	});
	const child = makeMemo({
		id: "2026060209000001",
		contentSnapshot: "child [[Daily/2026-06-02#^abc123|20260602-080000-00]]",
	});
	const recovered = recoverMemoReferenceMetadata([source, child], (linkPath) => `${linkPath}.md`)[1];

	assert.deepEqual(getMemoSourceReferenceMeta(recovered, new Set()), {
		type: "markdown",
		text: "[[Daily/2026-06-02#^abc123|20260602-080000-00]]",
		sourcePath: "Daily/2026-06-02.md",
	});
});

test("builds memo and trash warning metadata", () => {
	assert.equal(getMemoWarningText(makeMemo()), null);
	assert.equal(getMemoWarningText(makeMemo({ syncStatus: "pending_monthly" })), "pending_monthly");
	assert.equal(getMemoWarningText(makeMemo({
		syncStatus: "monthly_failed",
		issue: makeIssue("Monthly failed"),
	})), "Monthly failed");
	assert.equal(getMemoWarningText(makeMemo({ issue: makeIssue("Block missing") })), "Block missing");
	assert.equal(getTrashMemoWarningText(makeMemo()), null);
	assert.equal(getTrashMemoWarningText(makeMemo({ issue: makeIssue("Delete failed") })), "Delete failed");
});

function makeMemo(overrides: Partial<MemoRecord> = {}): MemoRecord {
	return {
		id: "memo-1",
		createdAt: "2026-06-02T00:00:00+08:00",
		updatedAt: "2026-06-02T00:00:00+08:00",
		contentSnapshot: "memo",
		contentHash: "hash",
		status: "active",
		syncStatus: "synced",
		source: "plugin_input",
		version: 1,
		tags: [],
		links: [],
		images: [],
		references: [],
		sourceMemoId: null,
		issue: null,
		lastMarkdownSyncAt: null,
		lastMarkdownSyncSource: null,
		dailyRef: {
			path: "Daily/2026-06-02.md",
			heading: null,
			lastKnownBlock: "",
			lastKnownHash: "",
			lineNumberHint: null,
			lastSyncedAt: null,
		},
		monthlyRef: {
			path: "Knomo/2026-06.md",
			dateHeading: "2026-06-02",
			lastKnownBlock: "",
			lastKnownHash: "",
			lineNumberHint: null,
			lastSyncedAt: null,
		},
		...overrides,
	};
}

function makeIssue(message: string): MemoRecord["issue"] {
	return {
		type: "monthly_sync_failed",
		detectedAt: "2026-06-02T00:00:00+08:00",
		message,
	};
}
