import assert from "node:assert/strict";
import test from "node:test";
import { createHash, randomUUID } from "node:crypto";
import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import type { TFile } from "obsidian";
import type { FavoriteCollection, FavoriteItem } from "../src/types/favorite";
import { ensureObsidianStub } from "./helpers/obsidianStub";

const DAILY = "Daily/2026-11-18.md";
const FILE = "Monthly/knomo-favorite.json";
const DATE = "2026-11-18";
const BODY = "## Memos\n- 09:30:27 identical #work\n- 09:30:27 identical #work\n";
const anchoredBody = "## Memos\n- 10:00 first #work ^first\n- 11:00 second #home ^second\n";
const item = (blockId = "first", sourcePath = DAILY): FavoriteItem => ({
	favoriteId: randomUUID(), sourcePath, blockId, memoTime: "10:00", starredAt: "2026-11-18T00:00:00.000Z",
});
const collection = (items: FavoriteItem[]): FavoriteCollection => ({ kind: "knomo-favorite", version: 1, collectionId: randomUUID(), items });

function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>(done => { resolve = done; });
	return { promise, resolve };
}

async function fixture(initial: Record<string, string> = { [DAILY]: BODY }) {
	await ensureObsidianStub();
	const { InMemoryVault } = await import("./helpers/InMemoryVault");
	const { FavoriteStore } = await import("../src/services/FavoriteStore");
	const { FavoriteService } = await import("../src/services/FavoriteService");
	const { DailyAnchorSourceUnlocatedError } = await import("../src/services/DailyMemoAnchor");
	const { DiaryMemoParser } = await import("../src/services/DiaryMemoParser");
	const { MarkdownMutationService } = await import("../src/services/MarkdownMutationService");
	const { DailyMemoWriteGateway } = await import("../src/services/DailyMemoWriteGateway");
	const vault = new InMemoryVault(initial);
	const app = vault.app;
	let folder = "Monthly", loaded = true, hint: unknown;
	let dailyPrefix = "Daily/";
	Object.assign(app, { workspace: { getActiveViewOfType: () => null, containerEl: { win: { setTimeout } } },
		loadLocalStorage: () => hint, saveLocalStorage: (_key: string, value: unknown) => { hint = value; },
		fileManager: { trashFile: async (file: TFile) => { vault.remove(file.path); store.fileChanged(file.path); } } });
	const store = new FavoriteStore(app, () => folder, () => loaded);
	const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
	const parser = new DiaryMemoParser(async bytes => hash(bytes));
	const getDate = (path: string) => path.startsWith(dailyPrefix) && /\d{4}-\d{2}-\d{2}\.md$/u.test(path) ? path.slice(-13, -3) : null;
	const readSource = async (path = DAILY) => {
		const logicalDate = getDate(path), body = vault.read(path);
		if (!logicalDate || body === null) throw new DailyAnchorSourceUnlocatedError();
		return { path, logicalDate, ...await parser.parse({ sourcePath: path, logicalDate, bytes: Buffer.from(body) }) };
	};
	const index = async () => undefined;
	const gateway = new DailyMemoWriteGateway(app, parser);
	const mutation = new MarkdownMutationService(app, {
		getLogicalDateForPath: path => getDate(path)!, getDailyFileForDate: async () => app.vault.getAbstractFileByPath(DAILY) as TFile,
		getWriteHeading: () => "## Memos", getMemoTimeFormat: () => "HH:mm", updateCatalogPartition: index, refreshCatalogPaths: index,
		onDailyConfirmed: result => service.confirmed(result),
	}, gateway);
	const service = new FavoriteService(store, {
		getDate, getFileIdentity: path => app.vault.getAbstractFileByPath(path),
		readSource, isSourceCurrent: async source => {
			const body = vault.read(source.path);
			return body !== null && source.logicalDate === getDate(source.path) && hash(Buffer.from(body)) === source.sourceRevision;
		},
		createBlockReference: observation => mutation.createBlockReference({ sourcePath: observation.sourcePath, observation }),
	});
	const create = app.vault.create.bind(app.vault), process = app.vault.process.bind(app.vault);
	app.vault.create = async (path, text) => {
		const file = await create(path, text);
		store.fileChanged(path);
		return file;
	};
	app.vault.process = async (file, update) => {
		const text = await process(file, update);
		if (file.path.endsWith(".json")) store.fileChanged(file.path);
		return text;
	};
	await store.retry();
	return { app, vault, store, service, parser, gateway, readSource, getDate, index,
		favorites: (path = FILE) => JSON.parse(vault.read(path)!) as FavoriteCollection,
		setLoaded: (value: boolean) => { loaded = value; },
		setFolder: (value: string) => { folder = value; store.configurationChanged(); },
		setDailyPrefix: (value: string) => { dailyPrefix = value; service.configurationChanged(); },
		drain: () => store.retry(),
	};
}

async function renameDaily(f: Awaited<ReturnType<typeof fixture>>, target: string): Promise<void> {
	const original = f.app.vault.getAbstractFileByPath(DAILY)!;
	const body = f.vault.read(DAILY)!;
	f.vault.remove(DAILY);
	await f.app.vault.create(target, body);
	original.path = target;
	const lookup = f.app.vault.getAbstractFileByPath.bind(f.app.vault);
	f.app.vault.getAbstractFileByPath = path => path === target && lookup(path) ? original : lookup(path);
	f.service.sourceChanged(DAILY, "rename", target);
}

test("same-text Memos get independent native anchors, stale handles never acquire a new target", async () => {
	const f = await fixture();
	const first = (await f.readSource()).observations[0]!;
	const second = (await f.readSource()).observations[1]!;
	assert.equal(f.vault.read(FILE), null);
	const star = f.service.star(first);
	assert.equal(f.service.cardState(first).disabled, true);
	await assert.rejects(f.service.star(first));
	await star;
	await assert.rejects(f.service.star(second), /stale/u);
	const [a, b] = (await f.readSource()).observations;
	await f.service.star(b!);
	const current = (await f.readSource()).observations;
	assert.notEqual(current[0]!.existingBlockId, current[1]!.existingBlockId);
	assert.deepEqual(current.map(memo => [memo.time, memo.content]), [[a!.time, a!.content], [b!.time, b!.content]]);
	assert.equal(f.favorites().items.length, 2);
	const bytes = f.vault.read(DAILY);
	const firstId = f.service.cardState(current[0]!).favoriteId!;
	await f.service.star(current[0]!);
	assert.equal(f.service.cardState(current[0]!).favoriteId, firstId);
	assert.equal(f.vault.read(DAILY), bytes);
	await f.service.unstar(current[0]!, firstId);
	await f.service.star(current[0]!);
	await assert.rejects(f.service.unstar(current[0]!, firstId), /selection/u);
	for (const memo of current) {
		await f.service.resolve(memo.sourcePath);
		await f.service.unstar(memo, f.service.cardState(memo).favoriteId!);
	}
	assert.deepEqual(f.favorites().items, []);
	assert.equal(f.vault.read(DAILY), bytes);
});

test("invalid, duplicate, hidden and known missing collections suspend commands and preserve files", async () => {
	const valid = collection([item()]);
	for (const text of ["broken", JSON.stringify({ ...valid, version: 2 }),
		JSON.stringify({ ...valid, items: [item(), item()] }),
		JSON.stringify({ ...valid, items: [{ ...item(), memoTime: "24:00" }] }),
		JSON.stringify({ ...valid, items: [{ ...item(), sourcePath: "../Daily.md" }] }),
		JSON.stringify({ ...valid, items: [{ ...item(), extra: true }] }),
	]) {
		const f = await fixture({ [DAILY]: BODY, [FILE]: text });
		assert.equal(f.store.getState().status, "error");
		await assert.rejects(f.service.star((await f.readSource()).observations[0]!));
		assert.equal(f.vault.read(DAILY), BODY);
		assert.equal(f.vault.read(FILE), text);
	}
	const text = JSON.stringify(valid);
	const f = await fixture({ [DAILY]: anchoredBody, [FILE]: text, "Other/knomo-favorite.json": text });
	assert.equal(f.store.getState().status, "conflict");
	f.vault.remove(FILE); f.store.fileChanged(FILE);
	await f.drain();
	assert.equal(f.store.getState().status, "ready");
	f.vault.remove("Other/knomo-favorite.json"); f.store.fileChanged("Other/knomo-favorite.json");
	await f.drain();
	assert.equal(f.store.getState().status, "conflict");
	const hidden = await fixture();
	hidden.app.vault.adapter.exists = async path => path === FILE;
	await hidden.drain();
	assert.equal(hidden.store.getState().status, "error");
});

test("reserved folders do not join live file discovery", async () => {
	const text = JSON.stringify(collection([item()]));
	const f = await fixture({ [FILE]: text });
	for (const folder of [".trash", ".obsidian", "Monthly/_knomo-system"]) {
		await f.app.vault.create(folder + "/knomo-favorite.json", text);
		assert.equal(f.store.getState().status, "ready");
	}
	await f.drain();
	assert.equal(f.store.getState().status, "ready");
});

test("same-name folders only block configured or previously verified Favorites paths", async () => {
	const text = JSON.stringify(collection([item()]));
	const f = await fixture({ [FILE]: text });
	const folder = "Archive/knomo-favorite.json";
	await f.app.vault.createFolder(folder);
	f.store.fileChanged(folder);
	assert.equal(f.store.getState().status, "ready");
	await f.drain();
	assert.equal(f.store.getState().status, "ready");
	assert.equal(f.service.persistedCount, 1);
	const occupied = await fixture();
	await occupied.app.vault.createFolder(FILE);
	occupied.store.fileChanged(FILE);
	await occupied.drain();
	assert.equal(occupied.store.getState().status, "error");
	f.vault.remove(FILE);
	await f.app.vault.createFolder(FILE);
	f.setFolder("Next");
	f.store.fileChanged(FILE);
	await f.drain();
	assert.equal(f.store.getState().status, "error");
});

test("latest valid collection is mutated atomically and a write-then-throw is reported as unconfirmed", async () => {
	const f = await fixture({ [DAILY]: anchoredBody, [FILE]: JSON.stringify(collection([item()])) });
	const next = f.favorites(), original = next.items[0]!;
	const other = item("external", "Daily/2026-11-17.md");
	const process = f.app.vault.process.bind(f.app.vault);
	f.app.vault.process = async (file, update) => {
		f.vault.replace(FILE, JSON.stringify({ ...next, items: [original, other] }));
		await process(file, update);
		throw new Error("after writing");
	};
	const second = (await f.readSource()).observations[1]!;
	await assert.rejects(f.service.star(second), /after writing/u);
	assert.deepEqual(f.favorites().items.map(record => record.blockId), ["first", "external", "second"]);
	assert.equal(f.vault.read(DAILY), anchoredBody);
	await f.service.resolve(DAILY);
	assert.ok(f.service.cardState(second).favoriteId);
});

test("failed first JSON creation preserves the Daily anchor and retry reuses it", async () => {
	const f = await fixture();
	const create = f.app.vault.create.bind(f.app.vault);
	f.app.vault.create = async () => { throw new Error("JSON unavailable"); };
	await assert.rejects(f.service.star((await f.readSource()).observations[0]!), /JSON unavailable/u);
	const selected = (await f.readSource()).observations[0]!;
	assert.ok(selected.existingBlockId);
	assert.equal(f.vault.read(FILE), null);
	f.app.vault.create = create;
	await f.service.star(selected);
	assert.equal(f.favorites().items[0]?.blockId, selected.existingBlockId);
});

test("first creation verifies the Daily again after preparing the destination folder", async () => {
	const f = await fixture();
	const create = f.app.vault.createFolder.bind(f.app.vault);
	f.app.vault.createFolder = async path => {
		const folder = await create(path);
		f.vault.replace(DAILY, f.vault.read(DAILY)!.replace("identical", "concurrent update"));
		return folder;
	};
	await assert.rejects(f.service.star((await f.readSource()).observations[0]!), /Daily source changed/u);
	assert.equal(f.vault.read(FILE), null);
	assert.match(f.vault.read(DAILY)!, /concurrent update #work \^[a-z0-9]+/u);
});

test("relocation preserves source until configuration is saved, with same-directory retry and conflict recovery", async () => {
	const text = JSON.stringify(collection([item()]));
	const target = "Next/knomo-favorite.json";
	const f = await fixture({ [FILE]: text });
	const result = await f.store.relocate("Next", async () => {
		assert.equal(f.vault.read(FILE), text);
		assert.equal(f.vault.read(target), text);
		f.setFolder("Next");
	});
	assert.equal(result.favoriteError, undefined);
	assert.equal(f.vault.read(FILE), null);
	assert.equal(f.vault.read(target), text);
	const failed = await fixture({ [FILE]: text });
	await assert.rejects(failed.store.relocate("Next", async () => { throw new Error("settings not saved"); }));
	assert.equal(failed.vault.read(FILE), text);
	assert.equal(failed.vault.read(target), text);
	assert.equal(failed.store.getState().status, "conflict");
	failed.vault.remove(target);
	failed.store.fileChanged(target);
	failed.setFolder("Next");
	assert.equal((await failed.store.relocate("Next", async () => undefined)).favoriteError, undefined);
	assert.equal(failed.vault.read(FILE), null);
	assert.equal(failed.vault.read(target), text);
});

test("relocation stops cleanup on source edits and destination occupancy while settings can save", async () => {
	const text = JSON.stringify(collection([item()]));
	const target = "Next/knomo-favorite.json";
	const f = await fixture({ [FILE]: text });
	let settingsSaved = false;
	const result = await f.store.relocate("Next", async () => {
		f.vault.replace(FILE, text + " ");
		f.store.fileChanged(FILE);
		f.setFolder("Next");
		settingsSaved = true;
	});
	assert.equal(settingsSaved, true);
	assert.ok(result.favoriteError);
	assert.equal(f.vault.read(FILE), text + " ");
	assert.equal(f.vault.read(target), text);
	const occupied = await fixture({ [FILE]: text, [target]: "unrelated" });
	assert.ok((await occupied.store.relocate("Next", async () => occupied.setFolder("Next"))).favoriteError);
	assert.equal(occupied.vault.read(FILE), text);
	assert.equal(occupied.vault.read(target), "unrelated");
});

test("file and Daily can arrive in either order and a duplicate anchor revokes only the active binding", async () => {
	const text = JSON.stringify(collection([item()]));
	for (const dailyFirst of [false, true]) {
		const f = await fixture(dailyFirst ? { [DAILY]: anchoredBody } : { [FILE]: text });
		assert.equal(f.service.persistedCount, dailyFirst ? 0 : 1);
		if (!dailyFirst) assert.equal((await f.service.resolve(DAILY)).status, "missing");
		await f.app.vault.create(dailyFirst ? FILE : DAILY, dailyFirst ? text : anchoredBody);
		f.service.sourceChanged(DAILY, "change");
		await f.drain();
		await f.service.resolve(DAILY);
		assert.ok(f.service.cardState((await f.readSource()).observations[0]!).favoriteId);
		f.vault.replace(DAILY, anchoredBody + "- 12:00 duplicate ^first\n");
		f.service.sourceChanged(DAILY, "change");
		await f.service.resolve(DAILY);
		assert.equal(f.service.cardState((await f.readSource()).observations[0]!).favoriteId, undefined);
		assert.equal(f.vault.read(FILE), text);
	}
});

test("an explicit Daily rename follows the same file and blocks an old-path recreation", async () => {
	const f = await fixture({ [DAILY]: anchoredBody, [FILE]: JSON.stringify(collection([item()])) });
	await f.service.resolve(DAILY);
	const original = f.favorites().items[0]!;
	const originalFile = f.app.vault.getAbstractFileByPath(DAILY)!;
	const destination = "Daily/2026-11-17.md";
	await f.app.vault.create(destination, anchoredBody.replace("10:00", "10:00:17"));
	const lookup = f.app.vault.getAbstractFileByPath.bind(f.app.vault);
	originalFile.path = destination;
	f.app.vault.getAbstractFileByPath = path => path === destination ? originalFile : lookup(path);
	f.service.sourceChanged(DAILY, "rename", destination);
	await f.service.resolve(destination);
	await f.drain();
	assert.deepEqual(f.favorites().items, [{ ...original, sourcePath: destination, memoTime: "10:00:17" }]);
	assert.equal(f.service.cardState((await f.readSource()).observations[0]!).favoriteId, undefined);
	await f.service.resolve(destination);
	assert.equal(f.service.cardState((await f.readSource(destination)).observations[0]!).favoriteId, original.favoriteId);
});

test("a known rename into a location occupied by another favorite leaves both relations unbound", async () => {
	const target = "Daily/2026-11-17.md";
	const old = item("first", target);
	const saved = collection([item(), old]);
	const f = await fixture({ [DAILY]: anchoredBody, [target]: anchoredBody.replace("first #work", "other #work"), [FILE]: JSON.stringify(saved) });
	await f.service.resolve(target);
	f.vault.remove(target);
	f.service.sourceChanged(target, "delete");
	await renameDaily(f, target);
	await f.service.resolve(target);
	await f.drain();

	const moved = (await f.readSource(target)).observations[0]!;
	assert.deepEqual(f.service.cardState(moved), { disabled: true, favoriteId: undefined });
	await assert.rejects(f.service.unstar(moved, old.favoriteId));
	await assert.rejects(f.service.star(moved));
	assert.deepEqual(f.favorites(), saved);
});

test("queued rename repair cannot persist against a byte-identical replacement file", async () => {
	const target = "Daily/2026-11-17.md";
	const saved = collection([item()]);
	const f = await fixture({ [DAILY]: anchoredBody, [FILE]: JSON.stringify(saved) });
	const held = deferred(), entered = deferred();
	const blocker = f.store.run(async () => { entered.resolve(); await held.promise; });
	await entered.promise;
	try {
		await renameDaily(f, target);
		await f.service.resolve(target);
		// 文件系统会给重建后的目标分配另一个 TFile，即使磁盘内容相同。
		const lookup = f.app.vault.getAbstractFileByPath.bind(f.app.vault);
		f.vault.remove(target);
		f.service.sourceChanged(target, "delete");
		const replacement = await f.app.vault.create(target, anchoredBody);
		f.app.vault.getAbstractFileByPath = path => path === target ? replacement : lookup(path);
		f.service.sourceChanged(target, "change");
	} finally {
		held.resolve();
		await blocker;
	}
	await f.drain();
	assert.deepEqual(f.favorites(), saved);
});

test("a matching Trash delete and restore transfer a favorite to the new Daily while an old snapshot cannot", async () => {
	const { IndependentTrashService } = await importTrash();
	for (const scenario of ["confirmed", "historical", "reloading", "cancelled-during-reload"] as const) {
		const f = await fixture({ [DAILY]: anchoredBody, [FILE]: JSON.stringify(collection([item()])) });
		const original = f.favorites().items[0]!;
		const { TrashSnapshotStore } = await import("../src/services/TrashSnapshotStore");
		const snapshots = new TrashSnapshotStore(f.app, "Monthly");
		let restoration = false;
		const destination = "NewDaily/" + DATE + ".md";
		const trash = new IndependentTrashService(f.app, snapshots, {
			getLogicalDateForPath: async () => DATE,
			getOriginalDailyFile: async () => null,
			getDailyFileForDate: async () => f.app.vault.create(destination, "## Memos\n"),
			updateCatalogPartition: f.index, refreshCatalogPaths: f.index,
			onDailyConfirmed: (result, target, anchors, snapshotId, restored) => {
				if (snapshotId && (scenario !== "historical" || restoration)) f.service.trashConfirmed(snapshotId, result, target, anchors, restored);
			},
		}, f.gateway);
		const held = deferred(), entered = deferred();
		const blocker = f.store.run(async () => { entered.resolve(); await held.promise; });
		await entered.promise;
		const reloading = scenario === "reloading" || scenario === "cancelled-during-reload";
		if (reloading) {
			f.store.fileChanged(FILE);
			assert.equal(f.service.status, "loading");
		}
		const replacement = scenario === "cancelled-during-reload" ? { ...original, favoriteId: randomUUID() } : original;
		let deleted;
		try {
			deleted = await trash.delete((await f.readSource()).observations[0]!);
			if (replacement !== original) f.vault.replace(FILE, JSON.stringify({ ...f.favorites(), items: [replacement] }));
		} finally {
			held.resolve();
			await blocker;
		}
		await f.drain();
		f.setDailyPrefix("NewDaily/");
		restoration = true;
		const result = await trash.restore(await snapshots.read(deleted.snapshotId));
		assert.equal(result.state, "restored");
		await f.service.resolve(destination);
		await f.drain();
		const follows = scenario === "confirmed" || scenario === "reloading";
		assert.equal(f.favorites().items[0]!.sourcePath, follows ? destination : DAILY, scenario);
		assert.equal(f.favorites().items[0]!.favoriteId, replacement.favoriteId);
		assert.equal(f.favorites().items[0]!.starredAt, original.starredAt);
	}
});

async function importTrash() {
	await ensureObsidianStub();
	return import("../src/services/IndependentTrashService");
}

test("Favorites query keeps same-revision candidates, combines search and tags, and pages over the Catalog lookup bound", async () => {
	const latest = "Daily/2026-11-19.md";
	const latestItems = Array.from({ length: 165 }, (_, i) => item("b" + i, latest));
	const older = item();
	const body = "## Memos\n" + latestItems.map(record => "- 10:00 first #work ^" + record.blockId + "\n").join("")
		+ "- 12:00 first #work ^unstarred\n";
	const f = await fixture({ [DAILY]: anchoredBody, [latest]: body, [FILE]: JSON.stringify(collection([...latestItems, older])) });
	const { IndexedDbMemoCatalogStore } = await import("../src/services/IndexedDbMemoCatalogStore");
	const { MemoCatalogService } = await import("../src/services/MemoCatalogService");
	const { CatalogReadService } = await import("../src/services/CatalogReadService");
	const { queryFavorites } = await import("../src/services/FavoriteQuery");
	const catalog = new MemoCatalogService(new IndexedDbMemoCatalogStore("favorites", { factory: new IDBFactory(), keyRange: IDBKeyRange }));
	const read = new CatalogReadService({ catalog });
	for (const path of [DAILY, latest]) {
		const source = await f.readSource(path);
		await catalog.replaceFile({ ...source, blockAnchors: { ...source.blockAnchors }, inventory: {
			sourcePath: path, logicalDate: source.logicalDate, mtime: 1, size: f.vault.read(path)!.length,
		}, parserVersion: 1, settingsFingerprint: "test", auditedAt: 1 });
	}
	const query = { text: "first", tags: ["work"], fromDate: DATE, limit: 25 };
	let page = await queryFavorites(read, f.service, query);
	const handles: string[] = [];
	for (;;) {
		assert.equal(page.invalidated, false);
		handles.push(...page.items.map(memo => memo.observation.observationKey));
		if (!page.nextCursor) break;
		page = await queryFavorites(read, f.service, { ...query, cursor: page.nextCursor });
	}
	assert.equal(handles.length, 166);
	assert.equal(new Set(handles).size, 166);
	assert.ok(handles[0]?.startsWith(latest));
	assert.ok(handles[165]?.startsWith(DAILY));
	assert.equal(page.favoriteProgress.matched, 166);
	const filteredOut = await queryFavorites(read, f.service, { ...query, tags: ["home"] });
	assert.equal(filteredOut.items.length, 0);
	f.vault.replace(DAILY, anchoredBody.replace("first", "changed"));
	f.service.sourceChanged(DAILY, "change");
	const stale = await queryFavorites(read, f.service, { ...query, toDate: DATE });
	assert.equal(stale.items.length, 0);
	assert.equal(stale.favoriteProgress.waiting, 1);
	catalog.close();
});
