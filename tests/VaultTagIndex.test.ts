import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import type { App, CachedMetadata, TFile as ObsidianTFile } from "obsidian";
import { ensureObsidianStub } from "./helpers/obsidianStub";
import { buildTagDisplayMapCooperatively } from "../src/utils/tags";

async function fixture(count = 2) {
	await ensureObsidianStub();
	const { TFile, TFolder } = await import("obsidian");
	const { VaultTagIndex } = await import("../src/services/VaultTagIndex");
	const files = new Map<string, ObsidianTFile>();
	const caches = new Map<string, CachedMetadata>();
	const callbacks = new Map<string, (...args: unknown[]) => void>();
	const timers = new Map<number, () => void>();
	let timerId = 0;
	let scanCount = 0;
	let cacheFailure = false;
	let ruleFailure = false;
	let matcherFailure = false;
	let rules: string[] | null = [];
	let matcherRules: string[] = [];
	let matches = 0;
	for (let i = 0; i < count; i++) {
		const file = new TFile();
		Object.assign(file, { path: `folder/${i}.md`, extension: "md", stat: { mtime: i } });
		files.set(file.path, file);
		caches.set(file.path, { allTags: [`#Tag${i}/Child`] } as unknown as CachedMetadata);
	}
	const on = (name: string, callback: (...args: unknown[]) => void) => { callbacks.set(name, callback); return {}; };
	const app = {
		workspace: { containerEl: { win: {
			setTimeout: (callback: () => void) => { timers.set(++timerId, callback); return timerId; },
			clearTimeout: (id: number) => timers.delete(id),
		} } },
		vault: { getConfig: () => { if (ruleFailure) throw new Error("rule read failure"); return rules; }, offref() {}, getMarkdownFiles: () => { scanCount++; return [...files.values()]; }, getAbstractFileByPath: (path: string) => files.get(path) ?? null, on },
		metadataCache: { getFileCache: (file: ObsidianTFile) => {
			if (cacheFailure) throw new Error("cache failure");
			return caches.get(file.path) ?? null;
		}, updateUserIgnoreFilters: () => { matcherRules = [...rules ?? []]; },
		isUserIgnored: (path: string) => { if (matcherFailure) throw new Error("matcher failure"); matches++; return matcherRules.some(rule => path.startsWith(rule)); }, on },
	} as unknown as App;
	const index = new VaultTagIndex(app);
	index.load();
	let notifications = 0;
	index.subscribe(() => notifications++);
	const microtasks = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
	const step = async () => {
		const entry = timers.entries().next().value;
		if (entry) { timers.delete(entry[0]); entry[1](); }
		await microtasks();
	};
	const until = async (predicate: () => boolean) => {
		for (let i = 0; i < 10000 && !predicate(); i++) await step();
		assert.ok(predicate(), "controlled scheduler reached expected state");
	};
	const ready = async () => {
		let settled = false;
		const promise = index.ensureReady();
		void promise.then(() => { settled = true; }, () => { settled = true; });
		await until(() => settled);
		return promise;
	};
	const change = (file: ObsidianTFile, tags: string[]) => {
		const cache = { allTags: tags } as unknown as CachedMetadata;
		caches.set(file.path, cache);
		callbacks.get("changed")!(file, "", cache);
	};
	return { app, index, files, caches, callbacks, timers, step, until, ready, microtasks, change, TFolder,
		win: app.workspace.containerEl.win,
		counts: () => ({ scanCount, notifications }), failCache: (value: boolean) => { cacheFailure = value; },
		matches: () => matches,
		failRules: (value: boolean) => { ruleFailure = value; callbacks.get("config-changed")!("userIgnoreFilters"); },
		failMatcher: (value: boolean) => { matcherFailure = value; },
		setRules: (value: string[] | null, event = true) => { rules = value; if (event) callbacks.get("config-changed")!("userIgnoreFilters"); } };
}

test("Unreadable exclusions retain candidates and can recover without rescanning", async () => {
	const f = await fixture(1);
	await f.ready();
	f.failRules(true);
	assert.deepEqual(f.index.getSnapshot().suggestions, ["Tag0/Child"]);
	assert.deepEqual((await f.ready()).suggestions, ["Tag0/Child"]);
	f.failRules(false);
	assert.deepEqual((await f.ready()).suggestions, ["Tag0/Child"]);
	assert.equal(f.counts().scanCount, 1);
	f.index.unload();
});

test("A failed host matcher retains eligibility while updating content and sidebar facts", async () => {
	const f = await fixture(1);
	f.setRules(["elsewhere/"]);
	await f.ready();
	f.failMatcher(true);
	f.change([...f.files.values()][0], ["#New"]);
	const fallback = await f.ready();
	assert.deepEqual(fallback.suggestions, ["New"]);
	assert.equal(fallback.displayByKey.get("new"), "New");
	f.failMatcher(false);
	f.setRules(["elsewhere/", "unused/"]);
	assert.deepEqual((await f.ready()).suggestions, ["New"]);
	assert.equal(f.counts().scanCount, 1);
	f.index.unload();
});

test("Cold exclusion failures provide real tags while valid empty history stays empty", async () => {
	const cold = await fixture(2);
	cold.failRules(true);
	const first = await cold.ready();
	assert.equal(first.exclusionState, "degraded");
	assert.equal(first.suggestions.length, 2);
	cold.index.unload();
	const unsupported = await fixture(1);
	unsupported.setRules(["folder/"]);
	Object.assign(unsupported.app.metadataCache, { isUserIgnored: undefined });
	assert.deepEqual((await unsupported.ready()).suggestions, ["Tag0/Child"]);
	unsupported.index.unload();
	const empty = await fixture(1);
	empty.setRules(["folder/"]);
	assert.deepEqual((await empty.ready()).suggestions, []);
	empty.failRules(true);
	assert.deepEqual((await empty.ready()).suggestions, []);
	empty.index.unload();
});

test("Non-Error configuration failures settle once instead of invalidating every batch", async () => {
	const f = await fixture(1);
	Object.assign(f.app.vault, { getConfig: () => { throw "configuration offline"; } });
	assert.equal((await f.ready()).exclusionState, "degraded");
	const published = f.counts().notifications;
	await f.ready(); await f.ready();
	assert.equal(f.counts().notifications, published);
	f.index.unload();
});

test("Per-path matcher failure preserves history while other paths and deletions update", async () => {
	const f = await fixture(2);
	const [a, b] = [...f.files.values()];
	f.setRules([a.path]); await f.ready();
	Object.assign(f.app.metadataCache, { isUserIgnored: (path: string) => {
		if (path === a.path) throw new Error("one path unavailable");
		return true;
	} });
	f.change(a, ["#Excluded"]); f.change(b, ["#Removed"]);
	const result = await f.ready();
	assert.deepEqual(result.suggestions, []);
	assert.equal(result.exclusionState, "degraded");
	assert.equal(result.displayByKey.has("removed"), true);
	f.failRules(true);
	f.callbacks.get("deleted")!(b); f.files.delete(b.path);
	assert.equal((await f.ready()).displayByKey.has("removed"), false);
	f.index.unload();
});

test("Visible sessions recover matching with unchanged rules and bound repeated retries", async t => {
	let now = 10000;
	t.mock.method(Date, "now", () => now);
	const f = await fixture(1);
	f.setRules(["elsewhere/"]); await f.ready();
	f.failMatcher(true); f.change([...f.files.values()][0], ["#New"]);
	assert.equal((await f.ready()).exclusionState, "degraded");
	const dom = new JSDOM("", { pretendToBeVisual: true });
	Object.assign(dom.window, { setTimeout: f.win.setTimeout, clearTimeout: f.win.clearTimeout });
	const stop = f.index.watchSuggestions(() => {}, dom.window.document);
	try {
		const revision = f.index.getSnapshot().revision;
		for (let i = 0; i < 8; i++) await f.step();
		assert.equal(f.index.getSnapshot().revision, revision);
		now += 1000;
		await f.until(() => f.index.getSnapshot().revision > revision);
		const failedRevision = f.index.getSnapshot().revision;
		f.failMatcher(false); now += 2000;
		await f.until(() => f.index.getSnapshot().exclusionState === "current");
		assert.equal(f.index.getSnapshot().revision, failedRevision + 1);
		assert.deepEqual(f.index.getSnapshot().suggestions, ["New"]);
		assert.equal(f.counts().scanCount, 1);
	} finally { stop(); f.index.unload(); dom.window.close(); }
});

test("Metadata absence retains content and identical recovery clears partial state", async () => {
	const f = await fixture(2);
	const [a, b] = [...f.files.values()];
	await f.ready();
	const cache = f.caches.get(a.path)!;
	f.caches.delete(a.path);
	// 明确的单文件改名可以沿用内容，但新路径资格须重新判断。
	const old = a.path; a.path = "renamed.md";
	f.files.delete(old); f.files.set(a.path, a);
	f.callbacks.get("rename")!(a, old);
	const partial = await f.ready();
	assert.equal(partial.status, "partial");
	assert.equal(partial.suggestions.length, 2);
	f.caches.set(a.path, cache); f.callbacks.get("resolve")!(a);
	const complete = await f.ready();
	assert.equal(complete.status, "ready");
	assert.equal(complete.suggestions, partial.suggestions);
	f.failRules(true); f.change(a, []);
	f.callbacks.get("deleted")!(b); f.files.delete(b.path);
	assert.deepEqual((await f.ready()).suggestions, []);
	f.index.unload();
});

test("A metadata read exception affects only that file and does not abort recovery of others", async () => {
	const f = await fixture(2);
	const [a, b] = [...f.files.values()];
	f.caches.clear(); await f.ready();
	f.caches.set(b.path, { allTags: ["#Recovered"] } as unknown as CachedMetadata);
	Object.assign(f.app.metadataCache, { getFileCache: (file: ObsidianTFile) => {
		if (file === a) throw new Error("unreadable file");
		return f.caches.get(file.path) ?? null;
	} });
	f.callbacks.get("resolved")!();
	const result = await f.ready();
	assert.equal(result.status, "partial");
	assert.deepEqual(result.suggestions, ["Recovered"]);
	f.index.unload();
});

test("Renames discard old eligibility and deletion/recreation never inherits old content", async () => {
	const f = await fixture(1);
	const [file] = [...f.files.values()];
	f.setRules(["folder/"]); await f.ready();
	f.failRules(true);
	const old = file.path; file.path = "moved.md";
	f.files.delete(old); f.files.set(file.path, file); f.caches.delete(old);
	f.callbacks.get("rename")!(file, old);
	assert.deepEqual((await f.ready()).suggestions, ["Tag0/Child"]);
	f.callbacks.get("deleted")!(file); f.files.delete(file.path);
	assert.deepEqual((await f.ready()).suggestions, []);
	const { TFile } = await import("obsidian");
	const replacement = Object.assign(new TFile(), { path: file.path, extension: "md", stat: { mtime: 99 } });
	f.files.set(file.path, replacement);
	f.change(replacement, ["#Replacement"]);
	assert.deepEqual((await f.ready()).suggestions, ["Replacement"]);
	f.index.unload();
});

test("Visible candidate sessions detect silent rule changes and release polling on hide, close and unload", async () => {
	const f = await fixture(1);
	await f.ready();
	const dom = new JSDOM("", { pretendToBeVisual: true });
	const { window: win } = dom;
	Object.assign(win, { setTimeout: f.win.setTimeout, clearTimeout: f.win.clearTimeout });
	let notifications = 0;
	const stop = f.index.watchSuggestions(() => notifications++, win.document);
	const stopOther = f.index.watchSuggestions(() => {}, win.document);
	try {
		assert.equal(f.timers.size, 2);
		f.setRules(["folder/"], false);
		await f.until(() => notifications > 0);
		assert.deepEqual(f.index.getSnapshot().suggestions, []);
		Object.defineProperty(win.document, "hidden", { configurable: true, value: true });
		win.document.dispatchEvent(new win.Event("visibilitychange"));
		assert.equal(f.timers.size, 0, "隐藏时停止检查");
		f.setRules([], false);
		Object.defineProperty(win.document, "hidden", { configurable: true, value: false });
		win.document.dispatchEvent(new win.Event("visibilitychange"));
		await f.until(() => notifications > 1);
		assert.deepEqual(f.index.getSnapshot().suggestions, ["Tag0/Child"]);
		assert.equal(f.counts().scanCount, 1);
		stop(); stop();
		assert.equal(f.timers.size, 1, "关闭一个会话不影响另一个");
		f.index.unload();
		assert.equal(f.timers.size, 0);
		win.dispatchEvent(new win.Event("focus"));
		assert.equal(f.timers.size, 0, "卸载后不能重新检查");
	} finally { stop(); stopOther(); f.index.unload(); win.close(); }
});

test("Excluded files with missing metadata stay excluded when caches become available", async () => {
	const f = await fixture(2);
	const [a, b] = [...f.files.values()];
	f.setRules([b.path]); f.caches.delete(b.path);
	const partial = await f.ready();
	assert.equal(partial.status, "partial");
	assert.deepEqual(partial.suggestions, ["Tag0/Child"]);
	f.caches.set(b.path, { allTags: ["#ExcludedFrontmatter"] } as unknown as CachedMetadata);
	f.callbacks.get("resolve")!(b);
	const complete = await f.ready();
	assert.equal(complete.status, "ready");
	assert.equal(complete.suggestions, partial.suggestions);
	assert.equal(complete.displayByKey.has("excludedfrontmatter"), true);
	f.setRules(null);
	assert.deepEqual((await f.ready()).suggestions, ["ExcludedFrontmatter", "Tag0/Child"]);
	f.index.unload();
});

test("Tag candidates exclude file sources and casing without filtering sidebar display data", async () => {
	const f = await fixture(3);
	const [a, b, c] = [...f.files.values()];
	f.change(a, ["#PROJECT", "#OnlyExcluded"]);
	f.change(b, ["#PROJECT"]);
	f.change(c, ["#Project"]);
	f.setRules([a.path, b.path]);
	const snapshot = await f.ready();
	assert.deepEqual(snapshot.suggestions, ["Project"]);
	assert.equal(snapshot.displayByKey.get("project"), "PROJECT");
	assert.equal(snapshot.displayByKey.has("onlyexcluded"), true);
	f.change(a, ["#PROJECT", "#AnotherExcluded"]);
	const next = await f.ready();
	assert.equal(next.suggestions, snapshot.suggestions, "候选未变时复用结果");
	f.change(c, []);
	assert.deepEqual((await f.ready()).suggestions, []);
	f.setRules([]);
	assert.deepEqual((await f.ready()).suggestions, ["AnotherExcluded", "PROJECT"]);
	assert.equal(f.counts().scanCount, 1, "规则变化不重新扫描或读取正文");
	const matches = f.matches();
	const notifications = f.counts().notifications;
	await f.ready(); await f.ready();
	assert.equal(f.matches(), matches);
	assert.equal(f.counts().notifications, notifications);
	f.index.unload();
});

test("Exclusions invalidate an in-flight batch before it can publish or resolve a waiter", async () => {
	const f = await fixture(600);
	await f.ready();
	const initial = f.counts().notifications;
	f.setRules(["folder/0.md"]);
	let done = false;
	const pending = f.index.ensureReady().then(value => { done = true; return value; });
	await f.step();
	f.setRules(["folder/"]);
	await f.until(() => done);
	assert.deepEqual((await pending).suggestions, []);
	assert.equal(f.counts().notifications, initial + 1, "旧规则批次不能发布");
	f.setRules([], false);
	assert.equal((await f.ready()).suggestions.length, 600, "会话开始即检查未发事件的规则变化");
	f.index.unload();
});

test("File and folder moves recompute eligibility while retaining snapshots for sidebar", async () => {
	const f = await fixture(1);
	const [file] = [...f.files.values()];
	f.setRules(["excluded/"]);
	await f.ready();
	const move = async (next: string) => {
		const old = file.path;
		file.path = next;
		f.files.delete(old); f.files.set(next, file);
		f.caches.set(next, f.caches.get(old)!); f.caches.delete(old);
		f.callbacks.get("rename")!(file, old);
		return f.ready();
	};
	assert.deepEqual((await move("excluded/file.md")).suggestions, []);
	assert.deepEqual((await move("excluded-other/file.md")).suggestions, ["Tag0/Child"]);
	const folder = new f.TFolder();
	Object.assign(folder, { path: "excluded", children: [file] });
	file.path = "excluded/file.md";
	f.caches.clear();
	f.callbacks.get("rename")!(folder, "excluded-other");
	const excluded = await f.ready();
	assert.deepEqual(excluded.suggestions, []);
	assert.equal(excluded.displayByKey.get("tag0/child"), "Tag0/Child");
	folder.path = "restored"; file.path = "restored/file.md";
	f.callbacks.get("rename")!(folder, "excluded");
	assert.deepEqual((await f.ready()).suggestions, ["Tag0/Child"]);
	f.index.unload();
});

test("Vault tag index registers idle events without scanning and batches deferred atomic publication", async () => {
	const f = await fixture();
	const file = [...f.files.values()][0];
	f.change(file, ["#Project"]);
	assert.equal(f.timers.size, 0);
	assert.equal(f.counts().scanCount, 0);
	const old = await f.ready();
	f.change(file, ["#NewTag"]);
	f.change(file, ["#LastTag"]);
	assert.equal(f.index.getSnapshot().displayByKey, old.displayByKey);
	let done = false;
	const pending = f.index.ensureReady().then(snapshot => { done = true; return snapshot; });
	const second = f.index.ensureReady();
	await f.microtasks();
	assert.equal(done, false);
	assert.equal(f.timers.size, 1);
	await f.until(() => done);
	assert.equal(await pending, await second);
	assert.equal(f.index.getSnapshot().displayByKey.has("lasttag"), true);
	assert.equal(old.displayByKey.has("lasttag"), false);
	assert.deepEqual(f.counts(), { scanCount: 1, notifications: 2 });
	f.change(file, ["#LastTag"]);
	assert.equal(f.timers.size, 0);
	f.index.unload();
});

test("Vault tag index publishes stable generations during continuous updates without starving earlier waiters", async () => {
	const f = await fixture(300);
	await f.ready();
	const file = [...f.files.values()][0];
	for (let batch = 0; batch < 3; batch++) {
		f.change(file, [`#Batch${batch}`]);
		let done = false;
		const first = f.index.ensureReady().then(value => { done = true; return value; });
		await f.step();
		assert.equal(done, false);
		f.change(file, [`#Later${batch}`]);
		let laterDone = false;
		const later = f.index.ensureReady().then(value => { laterDone = true; return value; });
		await f.until(() => done);
		const published = await first;
		assert.equal(published.status, "building");
		assert.equal(published.displayByKey.has(`batch${batch}`), true);
		assert.equal(published.displayByKey.has(`later${batch}`), false);
		assert.equal(laterDone, false);
		await f.until(() => laterDone);
		assert.equal((await later).displayByKey.has(`later${batch}`), true);
	}
	assert.deepEqual(f.counts(), { scanCount: 1, notifications: 7 });
	f.index.unload();
});

test("Vault tag index default scan yields and preserves changes and deletion during initial scan", async () => {
	const f = await fixture(600);
	const files = [...f.files.values()];
	let done = false;
	const result = f.index.ensureReady().then(value => { done = true; return value; });
	await f.step();
	assert.equal(done, false);
	assert.equal(f.timers.size, 1, "default yield uses the owning window timer");
	f.change(files[599], ["#Newest"]);
	f.callbacks.get("deleted")!(files[598]);
	f.files.delete(files[598].path);
	await f.until(() => done);
	const snapshot = await result;
	assert.equal(snapshot.displayByKey.has("newest"), true);
	assert.equal(snapshot.displayByKey.has("tag598"), false);
	f.index.unload();
});

for (const started of [false, true]) test(`Vault tag index yields to interaction and resumes one shared build: started=${started}`, async () => {
	const f = await fixture(600);
	let done = false;
	const pending = f.index.ensureReady().then(snapshot => { done = true; return snapshot; });
	if (started) await f.step();
	const index = f.index as unknown as { pauseForInteraction(): () => void };
	const resume = index.pauseForInteraction();
	const resumeOther = index.pauseForInteraction();
	const second = f.index.ensureReady();
	for (let i = 0; i < 10; i++) await f.step();
	assert.equal(done, false, "输入关键期不能继续完成构建");
	assert.equal(f.counts().scanCount, started ? 1 : 0);
	resume(); resume();
	for (let i = 0; i < 10; i++) await f.step();
	assert.equal(done, false, "另一视图仍在交互时不恢复");
	resumeOther();
	await f.until(() => done);
	assert.equal(await pending, await second);
	assert.equal(f.counts().scanCount, 1, "恢复不能重新扫描全库");
	f.index.unload();
});

test("Vault tag index unload settles a build paused between slices", async () => {
	const f = await fixture(600);
	const rejected = assert.rejects(f.index.ensureReady(), /unloaded/);
	await f.step();
	const resume = (f.index as unknown as { pauseForInteraction(): () => void }).pauseForInteraction();
	await f.step();
	f.index.unload();
	await rejected;
	resume();
	await f.microtasks();
	assert.equal(f.timers.size, 0);
	assert.equal(f.counts().notifications, 0);
});

test("Vault tag index retains partial caches, rename/delete semantics and mtime display selection", async () => {
	const f = await fixture();
	const [a, b] = [...f.files.values()];
	f.caches.delete(b.path);
	assert.equal((await f.ready()).status, "partial");
	f.change(a, ["#Project/Sub"]);
	f.caches.set(b.path, { allTags: ["#project/Sub"] } as unknown as CachedMetadata);
	f.callbacks.get("resolved")!();
	assert.equal((await f.ready()).displayByKey.get("project"), "project");
	a.stat.mtime = 20;
	f.change(a, ["#Project/Sub"]);
	assert.equal((await f.ready()).displayByKey.get("project"), "Project");
	const folder = new f.TFolder();
	Object.assign(folder, { path: "renamed", children: [a, b] });
	for (const file of [a, b]) {
		const old = file.path;
		file.path = old.replace("folder/", "renamed/");
		f.files.delete(old); f.files.set(file.path, file);
		f.caches.set(file.path, f.caches.get(old)!); f.caches.delete(old);
	}
	f.caches.delete(a.path);
	f.caches.delete(b.path);
	f.callbacks.get("rename")!(folder, "folder");
	assert.equal((await f.ready()).status, "partial", "folder rename preserves snapshots and tracks missing metadata");
	f.callbacks.get("deleted")!(a);
	assert.equal((await f.ready()).displayByKey.get("project"), "project");
	const old = b.path;
	b.path = "last.md";
	f.caches.set(b.path, { allTags: ["#Final"] } as unknown as CachedMetadata);
	f.callbacks.get("rename")!(b, old);
	assert.deepEqual((await f.ready()).suggestions, ["Final"]);
	f.index.unload();
});

test("Vault tag index rejects failed builds and retries without stale ready completion", async () => {
	const f = await fixture();
	f.failCache(true);
	assert.equal((await f.ready()).status, "partial");
	f.failCache(false);
	f.callbacks.get("resolved")!();
	await f.ready();
	const file = [...f.files.values()][0];
	f.change(file, Array.from({ length: 300 }, (_, i) => `#New${i}`));
	const aggregationFailure = assert.rejects(f.index.ensureReady(async () => { throw new Error("yield failure"); }), /yield failure/);
	await f.step();
	await aggregationFailure;
	assert.equal(f.index.getSnapshot().revision, 2);
	let done = false;
	const retry = f.index.ensureReady().then(value => { done = true; return value; });
	await f.until(() => done);
	assert.equal((await retry).displayByKey.has("new299"), true);
	f.index.unload();
});

for (const duringBuild of [false, true]) test(`Vault tag index unload rejects waiters and cancels ${duringBuild ? "active yield" : "scheduled batch"}`, async () => {
	const f = await fixture(600);
	const rejected = assert.rejects(f.index.ensureReady(), /unloaded/);
	if (duringBuild) await f.step();
	f.index.unload();
	await rejected;
	await f.microtasks();
	assert.equal(f.timers.size, 0);
	assert.equal(f.counts().notifications, 0);
	assert.equal(f.index.getSnapshot().status, "idle");
	await assert.rejects(f.index.ensureReady(), /unloaded/);
});

test("Cooperative tag display aggregation matches frequency, mtime, parent and stable order rules", async () => {
	const sources = Array.from({ length: 1000 }, (_, order) => ({
		tag: ["#Project/Sub", "#project/sub", "#PROJECT/Other", "#alpha", "#ALPHA"][order % 5],
		modifiedTime: order % 17, order,
	}));
	let yields = 0;
	const result = await buildTagDisplayMapCooperatively(sources, { yieldControl: async () => { yields++; } });
	assert.deepEqual([...result], [["project", "Project"], ["project/sub", "Project/Sub"],
		["project/other", "PROJECT/Other"], ["alpha", "alpha"]]);
	assert.ok(yields > 0);
});

for (const size of [100, 1000]) test(`Vault tag index coalesces ${size} metadata events into one publication`, async () => {
	const f = await fixture(size);
	await f.ready();
	const before = f.counts();
	for (const file of f.files.values()) f.change(file, [`#Updated/${file.stat.mtime}`]);
	assert.equal(f.timers.size, 1);
	const result = await f.ready();
	assert.equal(result.suggestions.length, size);
	assert.equal(f.counts().notifications - before.notifications, 1);
	assert.equal(f.counts().scanCount, 1);
	f.index.unload();
});
