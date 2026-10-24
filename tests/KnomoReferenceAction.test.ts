import test from "node:test";
import assert from "node:assert/strict";
import type { CatalogMemoItem } from "../src/types/catalogView";
import type { MemoReferenceResult } from "../src/services/MemoCommandService";
import type { MemoViewItem } from "../src/types/memoView";
import { createReferenceMemo } from "./helpers/referenceMemo";
import { ensureObsidianStub } from "./helpers/obsidianStub";

test("引用和复制失败沿用原错误原因，过期句柄不进入后续操作", async () => {
	for (const action of ["reference", "copy-link"] as const) {
		const fixture = await createFixture(async () => { throw new Error("The selected memo changed; refresh and select it again."); });
		await fixture.view.handleMemoAction(action, fixture.memo);
		assert.deepEqual(fixture.references, []);
		assert.deepEqual(fixture.copies, []);
		assert.equal(fixture.notices.length, 1);
		assert.match(fixture.notices[0], /^The selected [Mm]emo changed; refresh and select it again\.$/);
	}
});

test("复制失败仅提示实际原因，不误报成功，保留原句柄与已准备链接", async () => {
	let selected: CatalogMemoItem | undefined;
	const fixture = await createFixture(async item => { selected = item; return { text: "[[Daily/2026-10-16#^own|2026-10-16 09:00]]", localRefreshPending: true }; });
	fixture.view.copyText = async text => { fixture.copies.push(text); throw new Error("Clipboard denied"); };
	await fixture.view.handleMemoAction("copy-link", fixture.memo);
	assert.strictEqual(selected, fixture.memo.catalog);
	assert.strictEqual(selected?.observationHandle, fixture.memo.catalog?.observationHandle);
	assert.deepEqual(fixture.copies, ["[[Daily/2026-10-16#^own|2026-10-16 09:00]]"]);
	assert.deepEqual(fixture.notices, ["Clipboard denied"]);
});

test("复制仅显示原成功提示，引用静默完成，后台刷新状态不改变交互", async () => {
	for (const localRefreshPending of [false, true]) {
		const fixture = await createFixture(async () => ({ text: "[[Daily/2026-10-16#^own|custom alias]]", localRefreshPending }));
		await fixture.view.handleMemoAction("copy-link", fixture.memo);
		assert.deepEqual(fixture.copies, ["[[Daily/2026-10-16#^own|custom alias]]"]);
		assert.deepEqual(fixture.notices, ["Link copied"]);
		fixture.notices.length = 0;
		await fixture.view.handleMemoAction("reference", fixture.memo);
		assert.deepEqual(fixture.references, ["[[Daily/2026-10-16#^own|custom alias]]"]);
		assert.deepEqual(fixture.notices, []);
	}
});

test("剪贴板等待期间关闭View，不回填成功或失败提示", async () => {
	for (const outcome of ["success", "failure"] as const) {
		const fixture = await createFixture(async () => ({ text: "[[own]]", localRefreshPending: true }));
		let resolve!: () => void, reject!: (error: Error) => void;
		fixture.view.copyText = text => {
			fixture.copies.push(text);
			return new Promise<void>((done, fail) => { resolve = done; reject = fail; });
		};
		const pending = fixture.view.handleMemoAction("copy-link", fixture.memo);
		await new Promise<void>(done => setImmediate(done));
		assert.deepEqual(fixture.copies, ["[[own]]"]);
		fixture.view.trashViewClosed = true;
		if (outcome === "success") resolve();
		else reject(new Error("Clipboard denied"));
		await pending;
		assert.deepEqual(fixture.notices, []);
	}
});

test("引用或复制等待期间切换会话及关闭View，不追加引用、复制或回填提示", async () => {
	for (const action of ["reference", "copy-link"] as const) {
		let resolve!: (result: MemoReferenceResult) => void;
		const fixture = await createFixture(() => new Promise(done => { resolve = done; }));
		const pending = fixture.view.handleMemoAction(action, fixture.memo);
		await Promise.resolve();
		if (action === "reference") fixture.switchSession();
		else fixture.view.trashViewClosed = true;
		resolve({ text: "[[late]]", localRefreshPending: true });
		await pending;
		assert.deepEqual(fixture.references, []);
		assert.deepEqual(fixture.copies, []);
		assert.deepEqual(fixture.notices, []);
	}
});

async function createFixture(prepare: (memo: CatalogMemoItem) => Promise<MemoReferenceResult>) {
	await ensureObsidianStub();
	const [{ KnomoView }, { Notice }] = await Promise.all([import("../src/ui/KnomoView"), import("obsidian")]);
	const notices = (Notice as unknown as { messages: string[] }).messages;
	notices.length = 0;
	const references: string[] = [], copies: string[] = [];
	let currentSession = true;
	const input = Object.assign(new EventTarget(), { value: "comment", setSelectionRange: () => {}, composer: {
		composing: false, capture: () => ({ sameSession: () => currentSession }), invalidateContext: () => {},
	} });
	const view = Object.assign(Object.create(KnomoView.prototype), {
		inputEl: input, currentLayout: "desktop-wide", mobileSearchController: { isOpen: false },
		trashViewClosed: false, isSaving: false, editingMemo: null, composerOpen: true, composerIsComposing: false,
		closeCardMenu: () => {}, syncCardMenuState: () => {}, syncUiChrome: () => {},
		memoCommandService: { createReferenceText: prepare }, copyText: async (text: string) => { copies.push(text); },
		startReferenceMemo: (_memo: MemoViewItem, text: string) => { references.push(text); },
	}) as ReferenceView;
	return { view, memo: createReferenceMemo(), notices, references, copies, switchSession: () => { currentSession = false; } };
}

interface ReferenceView {
	trashViewClosed: boolean;
	copyText(text: string): Promise<void>;
	handleMemoAction(action: "reference" | "copy-link", memo: MemoViewItem): Promise<void>;
}
