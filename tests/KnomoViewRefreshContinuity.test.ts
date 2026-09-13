import assert from "node:assert/strict";
import test from "node:test";
import { ensureObsidianStub } from "./helpers/obsidianStub";

test("列表查询等待置顶数据后才返回，拒绝混合不同 Catalog revision", async () => {
	await ensureObsidianStub();
	const { KnomoView } = await import("../src/ui/KnomoView");
	const view = Object.create(KnomoView.prototype);
	let release!: () => void;
	let revision = 2;
	const rendering: boolean[] = [];
	Object.assign(view, {
		buildCatalogActiveQuery: () => ({}), isDefaultListState: () => false,
		queryCatalogFeature: async () => ({ items: [], catalogRevision: 2, nextCursor: null }),
		shouldShowTodayTimeBuoys: () => true,
		timeBuoyViewController: {
			loadTodayOnly: (render: boolean) => { rendering.push(render); return new Promise<void>(resolve => { release = resolve; }); },
			getSnapshot: () => ({ todayValid: true, todayRevision: revision }),
		},
	});
	let returned = false;
	const first = view.loadCatalogMemos(false).then(() => { returned = true; });
	await Promise.resolve(); await Promise.resolve();
	assert.equal(returned, false);
	assert.deepEqual(rendering, [false]);
	release(); await first;
	assert.equal(returned, true);
	revision = 3;
	const stale = view.loadCatalogMemos(false);
	await Promise.resolve(); await Promise.resolve();
	release();
	await assert.rejects(stale, /Catalog changed/);
});

test("引用事件增量刷新且原位排队正文与来源引用，不清空卡片容器", async () => {
	await ensureObsidianStub();
	const { KnomoView } = await import("../src/ui/KnomoView");
	const view = Object.create(KnomoView.prototype);
	const content = {}, meta = {};
	const card = { getAttribute: () => "memo", querySelector: (selector: string) => selector === ".knomo-card-content" ? content : meta };
	const cards = [card];
	const container = { querySelectorAll: () => cards };
	const queued: unknown[][] = [];
	const memo = { id: "memo", contentSnapshot: "text [[Daily#^block]]", dailyRef: { path: "Daily.md" } };
	Object.assign(view, {
		refresh: async (force?: boolean) => { assert.equal(force, undefined); },
		trashViewClosed: false, cardFlowEl: container,
		cardFlowCoordinator: { generation: 3 }, mobileSearchController: { results: null, renderGeneration: 1 },
		findMemoById: () => memo, getMemoCardPreview: () => ({ text: "text" }),
		memoMarkdownRenderer: {
			queueMemoMarkdown: (...args: unknown[]) => queued.push(args),
			queueSourceReferenceMarkdown: (...args: unknown[]) => queued.push(args),
		},
	});
	await view.refreshReferences();
	assert.equal(view.cardFlowEl, container);
	assert.equal(cards[0], card);
	assert.equal(queued.length, 2);
	assert.equal(queued[0][1], content);
	assert.equal(queued[1][0], meta);
	view.trashViewClosed = true;
	await view.refreshReferences();
	assert.equal(queued.length, 2);
});
