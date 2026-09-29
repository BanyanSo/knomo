import test from "node:test";
import assert from "node:assert/strict";
import type { App, CachedMetadata, TFile as ObsidianTFile } from "obsidian";
import { ensureObsidianStub } from "./helpers/obsidianStub";
import { buildTagDisplayMap, buildTagDisplayMapCooperatively } from "../src/utils/tags";

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
		vault: { getMarkdownFiles: () => { scanCount++; return [...files.values()]; }, getAbstractFileByPath: (path: string) => files.get(path) ?? null, on },
		metadataCache: { getFileCache: (file: ObsidianTFile) => {
			if (cacheFailure) throw new Error("cache failure");
			return caches.get(file.path) ?? null;
		}, on },
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
	return { index, files, caches, callbacks, timers, step, until, ready, microtasks, change, TFolder,
		counts: () => ({ scanCount, notifications }), failCache: (value: boolean) => { cacheFailure = value; } };
}

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
	assert.equal((await f.ready()).status, "ready", "folder rename preserves snapshots while metadata catches up");
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
	const failed = assert.rejects(f.index.ensureReady(), /cache failure/);
	await f.step();
	await failed;
	assert.equal(f.index.getSnapshot().status, "idle");
	f.failCache(false);
	await f.ready();
	const file = [...f.files.values()][0];
	f.change(file, Array.from({ length: 300 }, (_, i) => `#New${i}`));
	const aggregationFailure = assert.rejects(f.index.ensureReady(async () => { throw new Error("yield failure"); }), /yield failure/);
	await f.step();
	await aggregationFailure;
	assert.equal(f.index.getSnapshot().revision, 1);
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
	assert.deepEqual(result, buildTagDisplayMap(sources));
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
