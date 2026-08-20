import test from "node:test";
import assert from "node:assert/strict";

import {
	getMemoActionClass,
	getMemoCardActions,
	getMemoCardShell,
	getMemoSourceReferenceMeta,
	getTrashActionClass,
	getTrashCardActions,
	getTrashActionState,
	getTrashMemoCardClass,
} from "../src/ui/KnomoCardMetadata";
import type { MemoRecord } from "./helpers/memoViewFixture";

test("builds memo card shell metadata without daily-open card attributes", () => {
	assert.deepEqual(getMemoCardShell({
		memoId: "memo-1",
		includeActions: true,
		activeMenuMemoId: "memo-1",
	}), {
		className: "knomo-card has-card-actions is-menu-open",
		attrs: {
			"data-memo-id": "memo-1",
		},
	});

	assert.deepEqual(getMemoCardShell({
		memoId: "memo-2",
		includeActions: true,
		activeMenuMemoId: null,
	}), {
		className: "knomo-card has-card-actions",
		attrs: {
			"data-memo-id": "memo-2",
		},
	});

	assert.deepEqual(getMemoCardShell({
		memoId: "memo-3",
		includeActions: false,
		activeMenuMemoId: "memo-3",
	}), {
		className: "knomo-card",
		attrs: {
			"data-memo-id": "memo-3",
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

test("filters identity actions while keeping ordinary reading actions", () => {
	const memo = makeMemo({});
	assert.deepEqual(getMemoCardActions(memo), getMemoCardActions());
	assert.deepEqual(getMemoCardActions({
		...memo,
		catalogV2: {
			capabilities: {
				view: true,
				copy: true,
				openDaily: true,
				openLinks: true,
				openImages: true,
				copyAsNew: "blocked_ambiguous",
				edit: "blocked_ambiguous",
				toggleTask: "blocked_ambiguous",
				delete: "blocked_ambiguous",
				createReference: "blocked_ambiguous",
				recordReview: "blocked_ambiguous",
			},
		} as never,
	}), [
		{ action: "open-daily", className: "knomo-card-action" },
		{ action: "copy-text", className: "knomo-card-action" },
	]);
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
