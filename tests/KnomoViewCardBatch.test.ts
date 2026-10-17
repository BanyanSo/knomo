import test from "node:test";
import assert from "node:assert/strict";
import type { MemoViewItem } from "../src/types/memoView";
import { KnomoCardFlowCoordinator } from "../src/ui/KnomoCardFlowCoordinator";
import { KnomoViewStateController } from "../src/ui/KnomoViewStateController";
import { ensureObsidianStub } from "./helpers/obsidianStub";

test("Shuffle Day 使用有限首批，同一天续批保持顺序且不重新选择日期", async () => {
	await ensureObsidianStub();
	const [{ KnomoView }, { Platform }] = await Promise.all([import("../src/ui/KnomoView"), import("obsidian")]);
	const previous = Platform.isMobile;
	try {
		for (const mobile of [false, true]) {
			Platform.isMobile = mobile;
			const fixture = createFixture(KnomoView);
			const memos = makeMemos(120);
			const firstCount = fixture.view.getInitialCardBatchSize();
			assert.equal(firstCount, mobile ? 25 : 50);
			fixture.view.startCardFeed(memos, "memo", 1);
			assert.ok(fixture.rendered.length > 0 && fixture.rendered.length < firstCount);
			fixture.flushFrames();
			assert.equal(fixture.rendered.length, firstCount);
			assert.equal(fixture.coordinator.remainingCount, 120 - firstCount);
			while (fixture.coordinator.hasMoreItems) {
				fixture.view.renderNextCardBatch(1);
				fixture.flushFrames();
			}
			assert.deepEqual(fixture.rendered, memos.map(memo => memo.id));
			assert.equal(fixture.exhausted(), 1);
		}
	} finally { Platform.isMobile = previous; }
});

test("桌面 Composer 打开时仍调度并完成卡片分片，移动输入保留暂停与恢复", async () => {
	await ensureObsidianStub();
	const [{ KnomoView }, { Platform }] = await Promise.all([import("../src/ui/KnomoView"), import("obsidian")]);
	const previous = Platform.isMobile;
	try {
		Platform.isMobile = false;
		const desktop = createFixture(KnomoView);
		desktop.view.composerOpen = true;
		desktop.view.startCardFeed(makeMemos(70), "memo", 1);
		assert.equal(desktop.frames.size, 1);
		desktop.view.pauseMobileCardBatchContinuation();
		assert.equal(desktop.frames.size, 1, "桌面编辑不能暂停建卡 continuation");
		desktop.flushFrames();
		assert.equal(desktop.rendered.length, 50);
		desktop.view.renderNextCardBatch(1);
		desktop.flushFrames();
		assert.equal(desktop.rendered.length, 70);
		Platform.isMobile = true;
		const mobile = createFixture(KnomoView);
		mobile.view.composerOpen = true;
		mobile.view.startCardFeed(makeMemos(70), "memo", 1);
		assert.equal(mobile.frames.size, 0);
		assert.ok(mobile.rendered.length > 0 && mobile.rendered.length < 25);
		mobile.view.resumeMobileCardBatchContinuation();
		assert.equal(mobile.frames.size, 0);
		mobile.view.composerOpen = false;
		mobile.view.resumeMobileCardBatchContinuation();
		assert.equal(mobile.frames.size, 1);
		mobile.flushFrames();
		assert.equal(mobile.rendered.length, 25);
	} finally { Platform.isMobile = previous; }
});

function createFixture(View: typeof import("../src/ui/KnomoView").KnomoView) {
	const frames = new Map<number, FrameRequestCallback>();
	let frameId = 0, exhausted = 0;
	const win = {
		requestAnimationFrame: (callback: FrameRequestCallback) => { frames.set(++frameId, callback); return frameId; },
		cancelAnimationFrame: (id: number) => { frames.delete(id); },
	};
	const coordinator = new KnomoCardFlowCoordinator({ sentinel: { isObserving: false, render: () => {}, remove: () => {} } });
	coordinator.generation = 1;
	const rendered: string[] = [];
	const view = Object.assign(Object.create(View.prototype), {
		viewStateController: Object.assign(new KnomoViewStateController(), { activeNav: "shuffleDay" }),
		cardFlowCoordinator: coordinator, containerEl: { win }, cardFlowEl: {}, composerOpen: false,
		prepareRecentTimeFlow: () => {}, renderMemoCard: (memo: MemoViewItem) => rendered.push(memo.id),
		renderHistoryLoadMore: () => { exhausted++; },
		shuffleDayController: { refresh: () => assert.fail("续批不得重新抽取日期"), reloadSelectedDate: () => assert.fail("续批不得重读日期") },
	}) as BatchView;
	return { view, coordinator, frames, rendered, exhausted: () => exhausted, flushFrames: () => {
		let iterations = 0;
		while (frames.size > 0) {
			assert.ok(iterations++ < 100, "continuation 应有界完成");
			const callbacks = [...frames.values()]; frames.clear();
			for (const callback of callbacks) callback(0);
		}
	} };
}

function makeMemos(count: number): MemoViewItem[] {
	return Array.from({ length: count }, (_, index) => ({
		id: `day-${index}`, createdAt: "2026-10-16T09:00", updatedAt: "2026-10-16T09:00", contentSnapshot: `memo ${index}`,
		contentHash: `${index}`, status: "active", tags: [], links: [], images: [],
		dailyRef: { path: "Daily/2026-10-16.md", heading: null, lineNumberHint: index },
	}));
}

interface BatchView {
	composerOpen: boolean;
	getInitialCardBatchSize(): number;
	startCardFeed(memos: MemoViewItem[], mode: "memo", generation: number): void;
	renderNextCardBatch(generation: number): void;
	pauseMobileCardBatchContinuation(): void;
	resumeMobileCardBatchContinuation(): void;
}
