import assert from "node:assert/strict";
import test from "node:test";
import { LocalComposerDraftStore, disposeLocalComposerDraftStores, emptyComposerDraft, type LocalComposerDraft } from "../src/ui/LocalComposerDraftStore";
import type { MemoViewItem } from "../src/types/memoView";

function storage() {
	const data = new Map<string, unknown>();
	return { data, loadLocalStorage: (key: string) => data.get(key) ?? null,
		saveLocalStorage: (key: string, value: unknown) => { data.set(key, JSON.parse(JSON.stringify(value))); } };
}

function draft(content: string): LocalComposerDraft {
	return { ...emptyComposerDraft(), active: { ...emptyComposerDraft().active, content, anchor: content.length, head: 0, scrollTop: 24 } };
}

function reloadDraftModule(): typeof import("../src/ui/LocalComposerDraftStore") {
	const path = require.resolve("../src/ui/LocalComposerDraftStore");
	const cached = require.cache[path];
	delete require.cache[path];
	try { return require(path); }
	finally { require.cache[path] = cached; }
}

test("跨模块重载后旧提交不能覆盖新实例持久化的版本", () => {
	for (const callback of ["committed", "acknowledge"] as const) {
		const disk = storage();
		const old = new LocalComposerDraftStore(disk, () => undefined);
		old.update(draft("submitted")); const token = old.beginSubmission(); old.close();
		const current = new (reloadDraftModule().LocalComposerDraftStore)(disk, assert.fail);
		current.update(draft("new input after reload"));
		const before = JSON.stringify([...disk.data]);
		if (callback === "committed") old.committed(token, true);
		else old.acknowledgePending();
		old.finishSubmission();
		assert.equal(JSON.stringify([...disk.data]), before, callback);
		current.close();
	}
});

test("插件卸载撤销打开及已关闭未决实例的权限，并保留待核对提交", () => {
	for (const closed of [false, true]) {
		const disk = storage();
		const old = new LocalComposerDraftStore(disk, assert.fail);
		old.update(editingDraft()); const token = old.beginSubmission();
		if (closed) old.close();
		disposeLocalComposerDraftStores(disk);
		const current = new LocalComposerDraftStore(disk, assert.fail);
		assert.deepEqual(current.pending, editingDraft());
		const before = JSON.stringify([...disk.data]);
		old.committed(token, true); old.acknowledgePending(); old.update(draft("stale input"));
		old.finishSubmission(); old.close();
		assert.equal(JSON.stringify([...disk.data]), before);
		const other = new LocalComposerDraftStore(disk, assert.fail);
		assert.equal(other.draft.active.content, "", "旧回调不能释放新实例认领");
		current.update({ ...editingDraft(), active: draft("new input").active });
		const newToken = current.beginSubmission();
		current.committed(newToken, true); current.finishSubmission();
		assert.equal(current.draft.active.content, "new text");
		current.close(); other.close();
	}
});

function editingDraft(): LocalComposerDraft {
	const result = draft("edited text");
	result.editingMemo = { id: "old-key", contentSnapshot: "original", dailyRef: { path: "Daily/a.md" }, catalog: {
		observationHandle: { sourcePath: "Daily/a.md", sourceRevision: "original-revision", rawBlockHash: "hash", startLine: 1, endLine: 2 },
	} } as MemoViewItem;
	result.suspendedCreate = { ...draft("new text").active, referenceText: "[[source]]", markdownText: "> quote" };
	return result;
}

test("关闭重开与应用重启保留正文、引用、反向选区、滚动和完成图片", () => {
	const disk = storage();
	const initial = draft("![[image.png]]");
	initial.active.imageLinks = [{ from: 0, to: initial.active.content.length, link: initial.active.content, path: "image.png", sourcePath: "Daily/a.md" }];
	initial.active.referenceText = "[[ref]]"; initial.active.markdownText = "> ref";
	const first = new LocalComposerDraftStore(disk, assert.fail);
	first.update(initial); first.close();
	const reopened = new LocalComposerDraftStore(disk, assert.fail);
	assert.deepEqual(reopened.draft, initial);
	// 新 App 对象模拟进程重启：不依赖上一进程的内存认领。
	const restarted = new LocalComposerDraftStore({ ...disk }, assert.fail);
	assert.deepEqual(restarted.draft, initial);
	reopened.close(); restarted.close();
});

test("同 Vault 多视图独占草稿，另一个 Vault 不可见；交错保存不覆盖", () => {
	const disk = storage();
	const one = new LocalComposerDraftStore(disk, assert.fail);
	one.update(draft("one"));
	const two = new LocalComposerDraftStore(disk, assert.fail);
	assert.equal(two.draft.active.content, ""); two.update(draft("two"));
	one.update(draft("one changed"));
	const otherVault = new LocalComposerDraftStore(storage(), assert.fail);
	assert.equal(otherVault.draft.active.content, "");
	one.close();
	const reopened = new LocalComposerDraftStore(disk, assert.fail);
	assert.equal(reopened.draft.active.content, "one changed");
	two.close();
	const reopenedTwo = new LocalComposerDraftStore(disk, assert.fail);
	assert.equal(reopenedTwo.draft.active.content, "two");
	reopened.close(); reopenedTwo.close(); otherVault.close();
});

test("编辑和暂存的新建草稿同时恢复，原 observation 不换取新句柄", () => {
	const disk = storage();
	const store = new LocalComposerDraftStore(disk, assert.fail);
	const saved = editingDraft(); store.update(saved); store.close();
	const restored = new LocalComposerDraftStore(disk, assert.fail);
	assert.deepEqual(restored.draft, saved);
	const token = restored.beginSubmission();
	restored.committed(token, true); restored.finishSubmission(); restored.close();
	const afterSave = new LocalComposerDraftStore(disk, assert.fail);
	assert.deepEqual(afterSave.draft.active, saved.suspendedCreate);
	assert.equal(afterSave.draft.editingMemo, null); afterSave.close();
});

test("onClose 和组件卸载重复清理不能释放新视图已经取得的认领", () => {
	const disk = storage(); const first = new LocalComposerDraftStore(disk, assert.fail);
	first.update(draft("owned draft")); first.close();
	const second = new LocalComposerDraftStore(disk, assert.fail);
	assert.equal(second.draft.active.content, "owned draft");
	first.close(); first.finishSubmission();
	const third = new LocalComposerDraftStore(disk, assert.fail);
	assert.equal(third.draft.active.content, ""); second.close(); third.close();
});

test("落盘确认仅清理对应版本，不能清理后来输入或同文新会话", () => {
	for (const later of ["new input", "submitted"]) {
		const disk = storage(); const store = new LocalComposerDraftStore(disk, assert.fail);
		store.update(draft("submitted")); const token = store.beginSubmission();
		store.update(draft("intermediate")); store.update(draft(later));
		store.committed(token, true); store.finishSubmission(); store.close();
		const restored = new LocalComposerDraftStore(disk, assert.fail);
		assert.equal(restored.draft.active.content, later);
		assert.equal(restored.pending, null); restored.close();
	}
	const disk = storage(); const store = new LocalComposerDraftStore(disk, assert.fail);
	store.update(draft("same")); const token = store.beginSubmission();
	store.committed(token, false); store.finishSubmission(); store.close();
	const restored = new LocalComposerDraftStore(disk, assert.fail);
	assert.equal(restored.draft.active.content, "same"); restored.close();
});

test("关闭时未决提交独占实例，成功后只清理已提交内容", () => {
	const disk = storage(); const store = new LocalComposerDraftStore(disk, assert.fail);
	store.update(draft("submitting")); const token = store.beginSubmission(); store.close();
	const another = new LocalComposerDraftStore(disk, assert.fail);
	assert.equal(another.draft.active.content, ""); another.update(draft("new view"));
	store.committed(token, true); store.finishSubmission(); another.close();
	const restored = new LocalComposerDraftStore(disk, assert.fail);
	assert.equal(restored.draft.active.content, "new view"); restored.close();
});

test("失败或强制退出保留待核对提交和之后的新输入，不自动重试", () => {
	const disk = storage(); const store = new LocalComposerDraftStore(disk, assert.fail);
	store.update(editingDraft()); store.beginSubmission();
	store.update(draft("later input")); store.finishSubmission(); store.close();
	const restored = new LocalComposerDraftStore({ ...disk }, assert.fail);
	assert.deepEqual(restored.pending, editingDraft());
	assert.equal(restored.draft.active.content, "later input");
	restored.acknowledgePending(); assert.equal(restored.pending, null);
	assert.equal(restored.draft.active.content, "later input"); restored.close();
});

test("存储不可用、配额耗尽及静默写入失败均提示，不阻断内存草稿和提交", () => {
	for (const mode of ["unavailable", "quota", "silent"] as const) {
		let errors = 0;
		const disk = mode === "unavailable" ? {} : { loadLocalStorage: () => null, saveLocalStorage: () => {
			if (mode === "quota") throw new Error("quota exceeded");
		} };
		const store = new LocalComposerDraftStore(disk as unknown as ReturnType<typeof storage>, () => errors++);
		store.update(draft("retained")); const token = store.beginSubmission();
		assert.equal(errors, 1);
		assert.equal(store.draft.active.content, "retained");
		store.committed(token, true); store.finishSubmission(); store.close();
	}
});

test("损坏存储不静默覆盖为默认值；读回对象不能修改内部记录", () => {
	const disk = storage(); disk.data.set("knomo.composerDrafts", { schema: 99, entries: ["valuable old data"] });
	const before = JSON.stringify([...disk.data]); let errors = 0;
	const store = new LocalComposerDraftStore(disk, () => errors++);
	store.update(draft("new draft")); assert.equal(errors, 1);
	assert.equal(JSON.stringify([...disk.data]), before);
	store.draft.active.content = "external mutation";
	assert.equal(store.draft.active.content, "new draft"); store.close();
});
