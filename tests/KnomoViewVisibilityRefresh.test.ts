import assert from "node:assert/strict";
import test from "node:test";
import { ensureObsidianStub } from "./helpers/obsidianStub";
import { KnomoViewStateController } from "../src/ui/KnomoViewStateController";
import { KnomoCardFlowCoordinator } from "../src/ui/KnomoCardFlowCoordinator";

async function harness() {
	await ensureObsidianStub();
	const { KnomoView } = await import("../src/ui/KnomoView");
	const view = Object.create(KnomoView.prototype);
	let shown = true;
	const doc = { visibilityState: "visible" };
	const queries: boolean[] = [];
	const referenceScans: string[] = [];
	const markdownPauses: Array<[boolean, boolean]> = [];
	const imagePauses: boolean[] = [];
	Object.assign(view, {
		presentationVisibilityReady: true,
		presentationHidden: false,
		presentationVisibilityRevision: 0,
		mobileBackgroundPaused: false,
		containerEl: { isShown: () => shown, doc },
		viewStateController: new KnomoViewStateController(),
		cardFlowCoordinator: new KnomoCardFlowCoordinator(),
		settingsService: { getSettings: () => ({ timeBuoyEnabled: false }) },
		renderedTimeBuoyEnabled: false,
		reconcileConfirmedCatalog: async () => {},
		refreshRandomReunionBatch: async () => {},
		waitForAllMemosLoading: async () => {},
		reloadMemos: async (_loadAll: boolean, force: boolean) => { queries.push(force); return true; },
		cardFlowEl: { querySelectorAll: () => { referenceScans.push("card-flow"); return []; } },
		mobileSearchController: { isOpen: false, cancelPendingRequest: () => {}, suspendLoadingFeedback: () => {} },
		cancelCatalogDesktopQuery: () => {},
		cancelCatalogDesktopCount: () => {},
		clearLoadingIndicators: () => {},
		pauseMobileCardBatchContinuation: () => {},
		memoMarkdownRenderer: { setPaused: (main: boolean, relations: boolean) => markdownPauses.push([main, relations]) },
		cardImageLoadQueue: { setPaused: (paused: boolean) => imagePauses.push(paused) },
	});
	return { view, queries, referenceScans, show: (value: boolean) => { shown = value; }, doc, markdownPauses, imagePauses };
}

test("隐藏标签合并刷新，后台文档继续暂停，恢复后仅查询一次并保留强制要求", async () => {
	const { view, queries, referenceScans, show, doc } = await harness();
	show(false);
	await view.refresh(true);
	await view.refresh(false);
	await view.refreshReferences(["a.md"]);
	await view.refreshReferences(["b.md"]);
	assert.deepEqual(queries, []);
	assert.deepEqual(referenceScans, []);
	show(true);
	doc.visibilityState = "hidden";
	await view.refresh();
	assert.deepEqual(queries, []);
	doc.visibilityState = "visible";
	await view.flushPresentationRefresh();
	assert.deepEqual(queries, [true]);
	assert.deepEqual(referenceScans, ["card-flow"]);
});

test("补刷中到达的新需求进入下一批，失败保留强制需求供下次重试", async () => {
	const { view, show } = await harness();
	let release!: (loaded: boolean) => void;
	const forces: boolean[] = [];
	view.reloadMemos = async (_loadAll: boolean, force: boolean) => {
		forces.push(force);
		if (forces.length === 1) return new Promise<boolean>(resolve => { release = resolve; });
		return forces.length !== 3;
	};
	show(false);
	await view.refresh();
	show(true);
	const first = view.flushPresentationRefresh();
	await new Promise(resolve => setImmediate(resolve));
	const trailing = view.refresh(true);
	release(true);
	await Promise.all([first, trailing]);
	assert.deepEqual(forces, [false, true]);
	await view.refresh(true);
	assert.deepEqual(forces, [false, true, true], "失败后不会循环重试");
	await view.refresh();
	assert.deepEqual(forces, [false, true, true, true], "后续普通请求保留未完成的强制要求");
});

test("补刷期间再次隐藏或关闭时不开始后续展示，关闭丢弃积压", async () => {
	const { view, show, queries, referenceScans } = await harness();
	let release!: () => void;
	view.waitForAllMemosLoading = () => new Promise<void>(resolve => { release = resolve; });
	const first = view.refresh(true);
	await new Promise(resolve => setImmediate(resolve));
	show(false);
	await view.refreshReferences();
	release();
	await first;
	assert.deepEqual(queries, []);
	assert.deepEqual(referenceScans, []);
	view.trashViewClosed = true;
	show(true);
	await view.flushPresentationRefresh();
	assert.deepEqual(queries, []);
	assert.deepEqual(referenceScans, []);
});

test("分栏按各自可见性刷新，返回时 Composer 仍暂停普通队列", async () => {
	const hidden = await harness();
	const visible = await harness();
	hidden.show(false);
	hidden.view.syncPresentationVisibility();
	await Promise.all([hidden.view.refresh(), visible.view.refresh()]);
	assert.deepEqual(visible.queries, [false]);
	assert.deepEqual(hidden.queries, []);
	assert.deepEqual(hidden.markdownPauses, [[true, true]]);
	assert.deepEqual(hidden.imagePauses, [true]);

	hidden.view.mobileBackgroundPaused = true;
	hidden.show(true);
	hidden.view.syncPresentationVisibility();
	await hidden.view.flushPresentationRefresh();
	assert.deepEqual(hidden.queries, [false]);
	assert.deepEqual(hidden.markdownPauses, [[true, true], [true, false]]);
	assert.deepEqual(hidden.imagePauses, [true, true]);
});

test("隐藏时附件缓存立即失效，过多路径折叠为一次全量展示更新", async () => {
	const { view, show } = await harness();
	const invalidations: string[][] = [];
	const renders: Array<readonly string[] | undefined> = [];
	const invalidate = (paths: string[]) => { invalidations.push(paths); };
	Object.assign(view, {
		cardImageCache: { invalidateResourcePaths: invalidate },
		imageResourceCache: { invalidateImagePaths: invalidate },
		renderChangedAttachmentImages: (paths?: readonly string[]) => { renders.push(paths); },
	});
	view.cardImageLoadQueue.invalidateResourcePaths = invalidate;
	view.mobileSearchController.invalidateImagePaths = invalidate;
	show(false);
	const paths = Array.from({ length: 200 }, (_, index) => `Images/${index}.png`);
	view.handleAttachmentFilesChanged(paths);
	assert.deepEqual(invalidations, [paths, paths, paths, paths]);
	assert.deepEqual(renders, []);
	show(true);
	await view.flushPresentationRefresh();
	assert.deepEqual(renders, [undefined]);
});
