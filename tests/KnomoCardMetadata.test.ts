import test from "node:test";
import assert from "node:assert/strict";

import { createCatalogCapabilities, createResolvedMemoCapabilities } from "../src/services/MemoCapabilityModel";
import {
	getMemoActionClass,
	getMemoCardActions,
	getMemoCardShell,
	getMemoDeleteMode,
	getMemoDisplayContent,
	getMemoSourceReferenceMeta,
	getTrashActionClass,
	getTrashCardActions,
	getTrashActionState,
	getTrashMemoCardClass,
	isMemoCardMenuReady,
} from "../src/ui/KnomoCardMetadata";
import type { MemoViewItem } from "../src/types/memoView";

test("builds memo card shell metadata without daily-open card attributes", () => {
	assert.deepEqual(getMemoCardShell({
		memoId: "memo-1",
		includeActions: true,
		activeMenuMemoId: "memo-1",
	}), {
		className: "knomo-card has-card-actions is-menu-open",
		attrs: {
			"data-memo-id": "memo-1",
			"data-memo-render-key": "memo-1",
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
			"data-memo-render-key": "memo-2",
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
			"data-memo-render-key": "memo-3",
		},
	});

	assert.equal(getMemoCardShell({
		memoId: "memo-4",
		renderKey: "observation-4",
		includeActions: true,
		activeMenuMemoId: null,
	}).attrs["data-memo-render-key"], "observation-4");
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
	assert.deepEqual(getTrashActionState("purge", null, false), { disabled: true, busy: false });
	assert.deepEqual(getTrashCardActions("restore", true), [
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
	assert.equal(getTrashMemoCardClass("restore"), "knomo-card knomo-trash-card is-busy");
});

test("keeps the card menu available with Catalog capabilities", () => {
	const memo = makeMemo({});
	assert.equal(isMemoCardMenuReady(memo), true);
	assert.equal(isMemoCardMenuReady({
		...memo,
		catalog: {
			capabilities: makeCapabilities(),
		} as never,
	}), true);
});

test("builds memo source reference metadata", () => {
	assert.deepEqual(getMemoSourceReferenceMeta(makeMemo({ })), { type: "none" });
	assert.deepEqual(getMemoSourceReferenceMeta(makeMemo({ })), { type: "none" });
	assert.deepEqual(getMemoSourceReferenceMeta(makeMemo({ })), { type: "none" });
	assert.deepEqual(getMemoSourceReferenceMeta(makeMemo({
	})), { type: "none" });
	assert.deepEqual(getMemoSourceReferenceMeta(makeMemo({
		contentSnapshot: "引用 [[Daily/2026-06-01#^block-a|20260601-083000]]\n> 原文",
	})), {
		type: "markdown",
		text: "[[Daily/2026-06-01#^block-a|20260601-083000]]",
		sourcePath: "Daily/2026-06-02.md",
	});
});

test("hides the source block link from referenced card content", () => {
	assert.equal(getMemoDisplayContent(makeMemo({
		contentSnapshot: "引用 [[Daily/2026-06-01#^block-a|20260601-083000]]\n> 原文",
	})), "引用\n> 原文");
	assert.equal(getMemoDisplayContent(makeMemo({
		contentSnapshot: "普通链接 [[Daily/2026-06-01]]",
	})), "普通链接 [[Daily/2026-06-01]]");
});

function makeMemo(overrides: Partial<MemoViewItem> = {}): MemoViewItem {
	return {
		id: "memo-1",
		createdAt: "2026-06-02T00:00:00+08:00",
		updatedAt: "2026-06-02T00:00:00+08:00",
		contentSnapshot: "memo",
		contentHash: "hash",
		status: "active",
		tags: [],
		links: [],
		images: [],
		dailyRef: {
			path: "Daily/2026-06-02.md",
			heading: null,
			lineNumberHint: null,
		},
		...overrides,
	};
}

function makeCapabilities() {
	return {
		...createResolvedMemoCapabilities(),
		catalog: createCatalogCapabilities({
			kind: "complete",
			coveredFromDate: "2026-06-02",
			pendingFileCount: 0,
			coveredFileCount: 1,
			totalFileCount: 1,
		}),
	};
}
