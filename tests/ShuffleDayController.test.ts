import test from "node:test";
import assert from "node:assert/strict";

import type { ShuffleDayService } from "../src/services/ShuffleDayService";
import type { MemoRecord } from "../src/types/memo";
import { buildShuffleDayStats } from "../src/utils/shuffleDay";
import { ensureObsidianStub } from "./helpers/obsidianStub";

test("refreshes shuffle day through the service and renders loading transitions", async () => {
	const { ShuffleDayController } = await loadController();
	const memo = makeMemo("memo-1", "2026-05-01T09:00:00");
	let ensureCalls = 0;
	let renderCalls = 0;
	const controller = new ShuffleDayController({
		ensureAllMemosLoaded: async () => {
			ensureCalls += 1;
		},
		getMemos: () => [memo],
		service: makeService(async () => ({
			status: "ready",
			selectedDate: "2026-05-01",
			memos: [memo],
			stats: buildShuffleDayStats([memo]),
			historyEntry: { date: "2026-05-01", shownAt: "2026-07-02T10:00:00" },
			nextHistory: [{ date: "2026-05-01", shownAt: "2026-07-02T10:00:00" }],
		})),
		isShuffleDayActive: () => true,
		showNotice: () => {},
		requestRender: () => {
			renderCalls += 1;
		},
	});

	await controller.refresh();

	assert.equal(ensureCalls, 1);
	assert.equal(renderCalls, 2);
	assert.equal(controller.getSnapshot().status, "ready");
	assert.equal(controller.getSnapshot().selectedDate, "2026-05-01");
	assert.deepEqual(controller.getSnapshot().memos.map((item) => item.id), ["memo-1"]);
});

test("updates only memos from the selected shuffle day", async () => {
	const { ShuffleDayController } = await loadController();
	const first = makeMemo("first", "2026-05-01T09:00:00");
	const second = makeMemo("second", "2026-05-01T10:00:00");
	const today = makeMemo("today", "2026-07-02T09:00:00");
	const controller = new ShuffleDayController({
		ensureAllMemosLoaded: async () => {},
		getMemos: () => [first, second],
		service: makeService(async () => ({
			status: "ready",
			selectedDate: "2026-05-01",
			memos: [second, first],
			stats: buildShuffleDayStats([first, second]),
			historyEntry: { date: "2026-05-01", shownAt: "2026-07-02T10:00:00" },
			nextHistory: [{ date: "2026-05-01", shownAt: "2026-07-02T10:00:00" }],
		})),
		isShuffleDayActive: () => false,
		showNotice: () => {},
		requestRender: () => {},
	});
	await controller.refresh();

	controller.applyMemoMutation({ type: "create", memo: today });
	assert.deepEqual(controller.getSnapshot().memos.map((memo) => memo.id), ["first", "second"]);

	const updatedFirst = { ...first, contentSnapshot: "updated" };
	controller.applyMemoMutation({ type: "update", previousMemo: first, memo: updatedFirst });
	assert.equal(controller.getSnapshot().memos[0].contentSnapshot, "updated");

	controller.applyMemoMutation({ type: "delete", previousMemo: updatedFirst, memo: updatedFirst });
	controller.applyMemoMutation({ type: "delete", previousMemo: second, memo: second });
	assert.equal(controller.getSnapshot().status, "empty-day-cleared");
	assert.deepEqual(controller.getSnapshot().memos, []);

	const restored = makeMemo("restored", "2026-05-01T08:00:00");
	controller.applyMemoMutation({ type: "create", memo: restored });
	assert.equal(controller.getSnapshot().status, "ready");
	assert.deepEqual(controller.getSnapshot().memos.map((memo) => memo.id), ["restored"]);
});

async function loadController(): Promise<typeof import("../src/ui/ShuffleDayController")> {
	await ensureObsidianStub();
	return import("../src/ui/ShuffleDayController");
}

function makeService(selectShuffleDay: ShuffleDayService["selectShuffleDay"]): ShuffleDayService {
	return { selectShuffleDay } as ShuffleDayService;
}

function makeMemo(id: string, createdAt: string): MemoRecord {
	return {
		id,
		createdAt,
		updatedAt: createdAt,
		contentSnapshot: id,
		contentHash: `hash-${id}`,
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
			path: `Daily/${createdAt.slice(0, 10)}.md`,
			heading: "## Memos",
			lastKnownBlock: id,
			lastKnownHash: `daily-${id}`,
			lineNumberHint: 1,
			lastSyncedAt: null,
		},
		monthlyRef: {
			path: "Memos/Memos-2026-05.md",
			dateHeading: createdAt.slice(0, 10),
			lastKnownBlock: id,
			lastKnownHash: `monthly-${id}`,
			lineNumberHint: 1,
			lastSyncedAt: null,
		},
	};
}
