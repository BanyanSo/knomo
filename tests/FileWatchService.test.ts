import test from "node:test";
import assert from "node:assert/strict";
import { setImmediate as waitImmediate } from "node:timers/promises";
import { ensureObsidianStub } from "./helpers/obsidianStub";

test("FileWatchService delegates sync errors to the injected callback", async () => {
	await ensureObsidianStub();
	const { TFile } = await import("obsidian");
	const { FileWatchService } = await import("../src/services/FileWatchService");
	const file = Object.assign(new TFile(), {
		path: "Daily/2026-06-02.md",
		extension: "md",
	});
	const syncError = new Error("manual sync failed");
	const handlersByEvent = new Map<string, (...args: unknown[]) => void>();
	const timerHandlers: Array<() => void> = [];
	let receivedPath: string | null = null;
	let receivedError: unknown = null;
	const app = {
		vault: {
			on: (eventName: string, handler: (...args: unknown[]) => void) => {
				handlersByEvent.set(eventName, handler);
				return {};
			},
			cachedRead: async () => "changed content",
		},
		workspace: {
			containerEl: {
				win: {
					setTimeout: (handler: () => void) => {
						timerHandlers.push(handler);
						return 1;
					},
					clearTimeout: () => undefined,
				},
			},
		},
	};
	const service = new FileWatchService(
		app as never,
		{
			consumeByReason: () => null,
			consumeByExpectedHash: () => null,
			cleanup: () => undefined,
		} as never,
		{
			isPotentialDailyFile: () => true,
			getSyncDebounceMs: () => 0,
			syncExternalDailyFile: async () => {
				throw syncError;
			},
		} as never,
		undefined,
		(path, error) => {
			receivedPath = path;
			receivedError = error;
		},
	);

	service.start({
		registerEvent: () => undefined,
		register: () => undefined,
	} as never);

	assert.deepEqual([...handlersByEvent.keys()], ["modify", "create", "rename", "delete"]);
	const triggerModify = handlersByEvent.get("modify");
	assert.notEqual(triggerModify, undefined);
	if (triggerModify === undefined) {
		throw new Error("modify handler was not registered.");
	}
	triggerModify(file);
	const triggerTimer = timerHandlers[0];
	assert.notEqual(triggerTimer, undefined);
	if (triggerTimer === undefined) {
		throw new Error("sync timer was not queued.");
	}
	triggerTimer();
	await waitImmediate();

	assert.equal(receivedPath, file.path);
	assert.equal(receivedError, syncError);
});

test("FileWatchService refreshes views when a memo-index or Time buoy index file changes", async () => {
	await ensureObsidianStub();
	const { TFile } = await import("obsidian");
	const { FileWatchService } = await import("../src/services/FileWatchService");
	const file = Object.assign(new TFile(), {
		path: "Memos/_knomo-system/indexes/memo-index-2026-06.json",
		extension: "json",
	});
	const timeBuoyFile = Object.assign(new TFile(), {
		path: "Memos/_knomo-system/indexes/time-buoy/time-buoy-2026-07 conflict.json",
		extension: "json",
	});
	const handlersByEvent = new Map<string, (...args: unknown[]) => void>();
	const timerHandlers: Array<() => void> = [];
	let refreshCount = 0;
	let dailySyncCalled = false;
	const app = {
		vault: {
			on: (eventName: string, handler: (...args: unknown[]) => void) => {
				handlersByEvent.set(eventName, handler);
				return {};
			},
		},
		workspace: {
			containerEl: {
				win: {
					setTimeout: (handler: () => void) => {
						timerHandlers.push(handler);
						return 1;
					},
					clearTimeout: () => undefined,
				},
			},
		},
	};
	const service = new FileWatchService(
		app as never,
		{
			consumeByReason: () => null,
			consumeByExpectedHash: () => null,
			cleanup: () => undefined,
		} as never,
		{
			isPotentialDailyFile: () => false,
			isMemoIndexFile: (path: string) => path === file.path,
			isTimeBuoyIndexFile: (path: string) => path === timeBuoyFile.path,
			getSyncDebounceMs: () => 0,
			syncExternalDailyFile: async () => {
				dailySyncCalled = true;
				return false;
			},
		} as never,
		() => {
			refreshCount += 1;
		},
	);

	service.start({
		registerEvent: () => undefined,
		register: () => undefined,
	} as never);

	const triggerCreate = handlersByEvent.get("create");
	assert.notEqual(triggerCreate, undefined);
	if (triggerCreate === undefined) {
		throw new Error("create handler was not registered.");
	}
	triggerCreate(file);
	const triggerTimer = timerHandlers[0];
	assert.notEqual(triggerTimer, undefined);
	if (triggerTimer === undefined) {
		throw new Error("refresh timer was not queued.");
	}
	triggerTimer();
	await waitImmediate();

	assert.equal(refreshCount, 1);
	assert.equal(dailySyncCalled, false);

	triggerCreate(timeBuoyFile);
	const timeBuoyTimer = timerHandlers[1];
	assert.notEqual(timeBuoyTimer, undefined);
	timeBuoyTimer?.();
	await waitImmediate();
	assert.equal(refreshCount, 2);
});

test("FileWatchService ignores memo-index and Time buoy index changes caused by Knomo writes", async () => {
	await ensureObsidianStub();
	const { TFile } = await import("obsidian");
	const { FileWatchService } = await import("../src/services/FileWatchService");
	const file = Object.assign(new TFile(), {
		path: "Memos/_knomo-system/indexes/memo-index-2026-06.json",
		extension: "json",
	});
	const timeBuoyFile = Object.assign(new TFile(), {
		path: "Memos/_knomo-system/indexes/time-buoy/time-buoy-2026-07.json",
		extension: "json",
	});
	const handlersByEvent = new Map<string, (...args: unknown[]) => void>();
	const timerHandlers: Array<() => void> = [];
	let refreshCount = 0;
	const app = {
		vault: {
			on: (eventName: string, handler: (...args: unknown[]) => void) => {
				handlersByEvent.set(eventName, handler);
				return {};
			},
		},
		workspace: {
			containerEl: {
				win: {
					setTimeout: (handler: () => void) => {
						timerHandlers.push(handler);
						return 1;
					},
					clearTimeout: () => undefined,
				},
			},
		},
	};
	const service = new FileWatchService(
		app as never,
		{
			consumeByReason: (_path: string, reason: string) => (
				reason === "index" || reason === "time_buoy_index" ? { opId: `op-${reason}` } : null
			),
			consumeByExpectedHash: () => null,
			cleanup: () => undefined,
		} as never,
		{
			isPotentialDailyFile: () => false,
			isMemoIndexFile: (path: string) => path === file.path,
			isTimeBuoyIndexFile: (path: string) => path === timeBuoyFile.path,
			getSyncDebounceMs: () => 0,
		} as never,
		() => {
			refreshCount += 1;
		},
	);

	service.start({
		registerEvent: () => undefined,
		register: () => undefined,
	} as never);
	handlersByEvent.get("modify")?.(file);
	timerHandlers[0]?.();
	await waitImmediate();

	assert.equal(refreshCount, 0);

	handlersByEvent.get("modify")?.(timeBuoyFile);
	timerHandlers[1]?.();
	await waitImmediate();
	assert.equal(refreshCount, 0);
});

test("FileWatchService scans recent daily notes when a memo-index file is deleted", async () => {
	await ensureObsidianStub();
	const { TFile } = await import("obsidian");
	const { FileWatchService } = await import("../src/services/FileWatchService");
	const file = Object.assign(new TFile(), {
		path: "Memos/_knomo-system/indexes/memo-index-2026-06.json",
		extension: "json",
	});
	const handlersByEvent = new Map<string, (...args: unknown[]) => void>();
	const timerHandlers: Array<() => void> = [];
	let refreshCount = 0;
	let scanArgs: [number, string] | null = null;
	const service = new FileWatchService(
		{
			vault: {
				on: (eventName: string, handler: (...args: unknown[]) => void) => {
					handlersByEvent.set(eventName, handler);
					return {};
				},
			},
			workspace: {
				containerEl: {
					win: {
						setTimeout: (handler: () => void) => {
							timerHandlers.push(handler);
							return 1;
						},
						clearTimeout: () => undefined,
					},
				},
			},
		} as never,
		{
			cleanup: () => undefined,
		} as never,
		{
			isPotentialDailyFile: () => false,
			isMemoIndexFile: (path: string) => path === file.path,
			isMonthlyArchiveFile: () => false,
			getSyncDebounceMs: () => 0,
			scanRecentDailyMemos: async (days: number, source: string) => {
				scanArgs = [days, source];
				return { scannedFiles: 1, created: 1, updated: 0, deleted: 0, skipped: 0, failed: 0, errors: [] };
			},
		} as never,
		() => {
			refreshCount += 1;
		},
		undefined,
		{ memoIndexRecoveryScanDays: 7 },
	);

	service.start({
		registerEvent: () => undefined,
		register: () => undefined,
	} as never);
	handlersByEvent.get("delete")?.(file);
	timerHandlers[0]?.();
	await waitImmediate();

	assert.deepEqual(scanArgs, [7, "file_watch"]);
	assert.equal(refreshCount, 1);
});

test("FileWatchService scans once when a memo-index file is moved away", async () => {
	await ensureObsidianStub();
	const { TFile } = await import("obsidian");
	const { FileWatchService } = await import("../src/services/FileWatchService");
	const oldPath = "Memos/_knomo-system/indexes/memo-index-2026-06.json";
	const movedFile = Object.assign(new TFile(), {
		path: "Memos/_knomo-system/indexes/memo-index-2026-06 conflict.json",
		extension: "json",
	});
	const handlersByEvent = new Map<string, (...args: unknown[]) => void>();
	const timers: Array<{ handler: () => void; cancelled: boolean }> = [];
	let scanCount = 0;
	let refreshCount = 0;
	const service = new FileWatchService(
		{
			vault: {
				on: (eventName: string, handler: (...args: unknown[]) => void) => {
					handlersByEvent.set(eventName, handler);
					return {};
				},
			},
			workspace: {
				containerEl: {
					win: {
						setTimeout: (handler: () => void) => {
							timers.push({ handler, cancelled: false });
							return timers.length;
						},
						clearTimeout: (id: number) => {
							const timer = timers[id - 1];
							if (timer !== undefined) timer.cancelled = true;
						},
					},
				},
			},
		} as never,
		{
			cleanup: () => undefined,
		} as never,
		{
			isPotentialDailyFile: () => false,
			isMemoIndexFile: (path: string) => path === oldPath,
			isMonthlyArchiveFile: () => false,
			getSyncDebounceMs: () => 0,
			scanRecentDailyMemos: async () => {
				scanCount += 1;
				return { scannedFiles: 1, created: 0, updated: 1, deleted: 0, skipped: 0, failed: 0, errors: [] };
			},
		} as never,
		() => {
			refreshCount += 1;
		},
	);

	service.start({
		registerEvent: () => undefined,
		register: () => undefined,
	} as never);
	handlersByEvent.get("rename")?.(movedFile, oldPath);
	handlersByEvent.get("rename")?.(movedFile, oldPath);
	for (const timer of timers) {
		if (!timer.cancelled) timer.handler();
	}
	await waitImmediate();

	assert.equal(scanCount, 1);
	assert.equal(refreshCount, 1);
});

test("FileWatchService ignores deleted sync-conflict memo-index copies", async () => {
	await ensureObsidianStub();
	const { TFile } = await import("obsidian");
	const { FileWatchService } = await import("../src/services/FileWatchService");
	const file = Object.assign(new TFile(), {
		path: "Memos/_knomo-system/indexes/memo-index-2026-06 conflict.json",
		extension: "json",
	});
	const handlersByEvent = new Map<string, (...args: unknown[]) => void>();
	let scanCalled = false;
	const service = new FileWatchService(
		{
			vault: {
				on: (eventName: string, handler: (...args: unknown[]) => void) => {
					handlersByEvent.set(eventName, handler);
					return {};
				},
			},
			workspace: {
				containerEl: {
					win: {
						setTimeout: () => 1,
						clearTimeout: () => undefined,
					},
				},
			},
		} as never,
		{
			cleanup: () => undefined,
		} as never,
		{
			isPotentialDailyFile: () => false,
			isMemoIndexFile: () => false,
			isMonthlyArchiveFile: () => false,
			getSyncDebounceMs: () => 0,
			scanRecentDailyMemos: async () => {
				scanCalled = true;
				return { scannedFiles: 0, created: 0, updated: 0, deleted: 0, skipped: 0, failed: 0, errors: [] };
			},
		} as never,
	);

	service.start({
		registerEvent: () => undefined,
		register: () => undefined,
	} as never);
	handlersByEvent.get("delete")?.(file);
	await waitImmediate();

	assert.equal(scanCalled, false);
});

test("FileWatchService syncs daily note renames with the old path", async () => {
	await ensureObsidianStub();
	const { TFile } = await import("obsidian");
	const { FileWatchService } = await import("../src/services/FileWatchService");
	const file = Object.assign(new TFile(), {
		path: "Daily/2026-06-02.md",
		extension: "md",
	});
	const oldPath = "Daily/2026-06-01.md";
	const handlersByEvent = new Map<string, (...args: unknown[]) => void>();
	const timerHandlers: Array<() => void> = [];
	let syncedPaths: [string, string] | null = null;
	let refreshCount = 0;
	const app = {
		vault: {
			on: (eventName: string, handler: (...args: unknown[]) => void) => {
				handlersByEvent.set(eventName, handler);
				return {};
			},
			cachedRead: async () => "desktop changed content",
		},
		workspace: {
			containerEl: {
				win: {
					setTimeout: (handler: () => void) => {
						timerHandlers.push(handler);
						return 1;
					},
					clearTimeout: () => undefined,
				},
			},
		},
	};
	const service = new FileWatchService(
		app as never,
		{
			consumeByExpectedHash: () => null,
			cleanup: () => undefined,
		} as never,
		{
			isMonthlyArchiveFile: () => false,
			isPotentialDailyFile: (path: string) => path === file.path || path === oldPath,
			isMemoIndexFile: () => false,
			getSyncDebounceMs: () => 0,
			syncRenamedDailyFile: async (changedFile: { path: string }, previousPath: string) => {
				syncedPaths = [changedFile.path, previousPath];
				return true;
			},
		} as never,
		() => {
			refreshCount += 1;
		},
	);

	service.start({
		registerEvent: () => undefined,
		register: () => undefined,
	} as never);

	const triggerRename = handlersByEvent.get("rename");
	assert.notEqual(triggerRename, undefined);
	if (triggerRename === undefined) {
		throw new Error("rename handler was not registered.");
	}
	triggerRename(file, oldPath);
	const triggerTimer = timerHandlers[0];
	assert.notEqual(triggerTimer, undefined);
	if (triggerTimer === undefined) {
		throw new Error("sync timer was not queued.");
	}
	triggerTimer();
	await waitImmediate();

	assert.deepEqual(syncedPaths, [file.path, oldPath]);
	assert.equal(refreshCount, 1);
});

test("FileWatchService syncs deleted daily notes", async () => {
	await ensureObsidianStub();
	const { TFile } = await import("obsidian");
	const { FileWatchService } = await import("../src/services/FileWatchService");
	const file = Object.assign(new TFile(), {
		path: "Daily/2026-06-02.md",
		extension: "md",
	});
	const handlersByEvent = new Map<string, (...args: unknown[]) => void>();
	const timerHandlers: Array<() => void> = [];
	let deletedPath = "";
	const app = {
		vault: {
			on: (eventName: string, handler: (...args: unknown[]) => void) => {
				handlersByEvent.set(eventName, handler);
				return {};
			},
		},
		workspace: {
			containerEl: {
				win: {
					setTimeout: (handler: () => void) => {
						timerHandlers.push(handler);
						return 1;
					},
					clearTimeout: () => undefined,
				},
			},
		},
	};
	const service = new FileWatchService(
		app as never,
		{
			cleanup: () => undefined,
		} as never,
		{
			isPotentialDailyFile: (path: string) => path === file.path,
			getSyncDebounceMs: () => 0,
			syncDeletedDailyFile: async (path: string) => {
				deletedPath = path;
				return true;
			},
		} as never,
	);

	service.start({
		registerEvent: () => undefined,
		register: () => undefined,
	} as never);

	handlersByEvent.get("delete")?.(file);
	timerHandlers[0]?.();
	await waitImmediate();

	assert.equal(deletedPath, file.path);
});

test("FileWatchService rebuilds a deleted monthly archive after debounce", async () => {
	await ensureObsidianStub();
	const { TFile } = await import("obsidian");
	const { FileWatchService } = await import("../src/services/FileWatchService");
	const file = Object.assign(new TFile(), {
		path: "Memos/Memos-2026-06.md",
		extension: "md",
	});
	const handlersByEvent = new Map<string, (...args: unknown[]) => void>();
	const timerHandlers: Array<() => void> = [];
	let rebuiltPath = "";
	let refreshCount = 0;
	const service = new FileWatchService(
		{
			vault: {
				on: (eventName: string, handler: (...args: unknown[]) => void) => {
					handlersByEvent.set(eventName, handler);
					return {};
				},
			},
			workspace: {
				containerEl: {
					win: {
						setTimeout: (handler: () => void) => {
							timerHandlers.push(handler);
							return 1;
						},
						clearTimeout: () => undefined,
					},
				},
			},
		} as never,
		{
			consumeByReason: () => null,
			cleanup: () => undefined,
		} as never,
		{
			isPotentialDailyFile: () => false,
			isMonthlyArchiveFile: (path: string) => path === file.path,
			getSyncDebounceMs: () => 0,
			recoverDeletedMonthlyArchive: async (path: string) => {
				rebuiltPath = path;
				return true;
			},
		} as never,
		() => {
			refreshCount += 1;
		},
	);

	service.start({
		registerEvent: () => undefined,
		register: () => undefined,
	} as never);
	handlersByEvent.get("delete")?.(file);
	assert.equal(rebuiltPath, "");
	timerHandlers[0]?.();
	await waitImmediate();

	assert.equal(rebuiltPath, file.path);
	assert.equal(refreshCount, 1);
});

test("FileWatchService ignores monthly archive deletes caused by Knomo rollback", async () => {
	await ensureObsidianStub();
	const { TFile } = await import("obsidian");
	const { FileWatchService } = await import("../src/services/FileWatchService");
	const file = Object.assign(new TFile(), {
		path: "Memos/Memos-2026-06.md",
		extension: "md",
	});
	const handlersByEvent = new Map<string, (...args: unknown[]) => void>();
	let rebuildCalled = false;
	const service = new FileWatchService(
		{
			vault: {
				on: (eventName: string, handler: (...args: unknown[]) => void) => {
					handlersByEvent.set(eventName, handler);
					return {};
				},
			},
			workspace: {
				containerEl: {
					win: {
						setTimeout: () => 1,
						clearTimeout: () => undefined,
					},
				},
			},
		} as never,
		{
			consumeByReason: (_path: string, reason: string) => reason === "archive_delete" ? { opId: "rollback" } : null,
			cleanup: () => undefined,
		} as never,
		{
			isPotentialDailyFile: () => false,
			isMonthlyArchiveFile: () => true,
			getSyncDebounceMs: () => 0,
			recoverDeletedMonthlyArchive: async () => {
				rebuildCalled = true;
				return true;
			},
		} as never,
	);

	service.start({
		registerEvent: () => undefined,
		register: () => undefined,
	} as never);
	handlersByEvent.get("delete")?.(file);
	await waitImmediate();

	assert.equal(rebuildCalled, false);
});

test("FileWatchService rebuilds the expected archive once after a user rename", async () => {
	const oldPath = "Memos/Memos-2026-06";
	const harness = await createMonthlyRenameHarness([oldPath]);
	const file = harness.createFile("Memos/June archive", "");

	harness.triggerRename(file, oldPath);
	harness.triggerRename(file, oldPath);
	await harness.runTimers();

	assert.deepEqual(harness.recoveredPaths, [oldPath]);
	assert.equal(harness.refreshCount(), 1);
	assert.equal(harness.errors.length, 0);
});

test("FileWatchService ignores monthly archive moves marked by internal migration", async () => {
	const oldPath = "Memos/Memos-2026-06.md";
	const newPath = "Archive/Memos/Memos-2026-06.md";
	const harness = await createMonthlyRenameHarness([oldPath], newPath);

	harness.triggerRename(harness.createFile(newPath), oldPath);
	await harness.runTimers();

	assert.deepEqual(harness.recoveredPaths, []);
	assert.equal(harness.timerCount(), 0);
});

test("FileWatchService does not consume an archive move marker for another destination", async () => {
	const oldPath = "Memos/Memos-2026-06.md";
	const harness = await createMonthlyRenameHarness([oldPath], "Archive/Memos/Memos-2026-06.md");

	harness.triggerRename(harness.createFile("User/June.md"), oldPath);
	await harness.runTimers();

	assert.deepEqual(harness.recoveredPaths, [oldPath]);
});

test("FileWatchService restores the old period and reports a conflicting monthly rename target", async () => {
	const oldPath = "Memos/Memos-2026-06.md";
	const newPath = "Memos/Memos-2026-07.md";
	const harness = await createMonthlyRenameHarness([oldPath, newPath]);

	harness.triggerRename(harness.createFile(newPath), oldPath);
	await harness.runTimers();

	assert.deepEqual(harness.recoveredPaths, [oldPath]);
	assert.equal(harness.refreshCount(), 1);
	assert.equal(harness.errors.length, 1);
	assert.match(String(harness.errors[0]), /Target path has conflicts/);
});

test("FileWatchService runs queued file tasks serially", async () => {
	await ensureObsidianStub();
	const { TFile } = await import("obsidian");
	const { FileWatchService } = await import("../src/services/FileWatchService");
	const firstFile = Object.assign(new TFile(), {
		path: "Daily/2026-06-02.md",
		extension: "md",
	});
	const secondFile = Object.assign(new TFile(), {
		path: "Daily/2026-06-03.md",
		extension: "md",
	});
	const handlersByEvent = new Map<string, (...args: unknown[]) => void>();
	const timerHandlers: Array<() => void> = [];
	const deferredSyncs: Array<Deferred<boolean>> = [];
	const syncedPaths: string[] = [];
	let activeSyncs = 0;
	let maxActiveSyncs = 0;
	const app = {
		vault: {
			on: (eventName: string, handler: (...args: unknown[]) => void) => {
				handlersByEvent.set(eventName, handler);
				return {};
			},
			cachedRead: async (file: { path: string }) => `${file.path} changed content`,
		},
		workspace: {
			containerEl: {
				win: {
					setTimeout: (handler: () => void) => {
						timerHandlers.push(handler);
						return timerHandlers.length;
					},
					clearTimeout: () => undefined,
				},
			},
		},
	};
	const service = new FileWatchService(
		app as never,
		{
			consumeByExpectedHash: () => null,
			cleanup: () => undefined,
		} as never,
		{
			isPotentialDailyFile: () => true,
			isMemoIndexFile: () => false,
			getSyncDebounceMs: () => 0,
			syncExternalDailyFile: async (file: { path: string }) => {
				activeSyncs += 1;
				maxActiveSyncs = Math.max(maxActiveSyncs, activeSyncs);
				syncedPaths.push(file.path);
				const deferred = createDeferred<boolean>();
				deferredSyncs.push(deferred);
				const changed = await deferred.promise;
				activeSyncs -= 1;
				return changed;
			},
		} as never,
	);

	service.start({
		registerEvent: () => undefined,
		register: () => undefined,
	} as never);

	const triggerModify = handlersByEvent.get("modify");
	assert.notEqual(triggerModify, undefined);
	if (triggerModify === undefined) {
		throw new Error("modify handler was not registered.");
	}
	triggerModify(firstFile);
	triggerModify(secondFile);
	timerHandlers[0]?.();
	timerHandlers[1]?.();
	await waitImmediate();

	assert.deepEqual(syncedPaths, [firstFile.path]);
	assert.equal(maxActiveSyncs, 1);

	deferredSyncs[0]?.resolve(true);
	await waitImmediate();
	await waitImmediate();

	assert.deepEqual(syncedPaths, [firstFile.path, secondFile.path]);
	assert.equal(maxActiveSyncs, 1);
	deferredSyncs[1]?.resolve(true);
});

test("FileWatchService coalesces pending file tasks by path", async () => {
	await ensureObsidianStub();
	const { TFile } = await import("obsidian");
	const { FileWatchService } = await import("../src/services/FileWatchService");
	const firstFile = Object.assign(new TFile(), {
		path: "Daily/2026-06-02.md",
		extension: "md",
		label: "first",
	});
	const queuedFile = Object.assign(new TFile(), {
		path: "Daily/2026-06-03.md",
		extension: "md",
		label: "queued",
	});
	const latestFile = Object.assign(new TFile(), {
		path: queuedFile.path,
		extension: "md",
		label: "latest",
	});
	const handlersByEvent = new Map<string, (...args: unknown[]) => void>();
	const timerHandlers: Array<() => void> = [];
	const deferredSyncs: Array<Deferred<boolean>> = [];
	const syncedLabels: string[] = [];
	const app = {
		vault: {
			on: (eventName: string, handler: (...args: unknown[]) => void) => {
				handlersByEvent.set(eventName, handler);
				return {};
			},
			cachedRead: async (file: { path: string }) => `${file.path} changed content`,
		},
		workspace: {
			containerEl: {
				win: {
					setTimeout: (handler: () => void) => {
						timerHandlers.push(handler);
						return timerHandlers.length;
					},
					clearTimeout: () => undefined,
				},
			},
		},
	};
	const service = new FileWatchService(
		app as never,
		{
			consumeByExpectedHash: () => null,
			cleanup: () => undefined,
		} as never,
		{
			isPotentialDailyFile: () => true,
			isMemoIndexFile: () => false,
			getSyncDebounceMs: () => 0,
			syncExternalDailyFile: async (file: { label: string }) => {
				syncedLabels.push(file.label);
				const deferred = createDeferred<boolean>();
				deferredSyncs.push(deferred);
				return deferred.promise;
			},
		} as never,
	);

	service.start({
		registerEvent: () => undefined,
		register: () => undefined,
	} as never);

	const triggerModify = handlersByEvent.get("modify");
	assert.notEqual(triggerModify, undefined);
	if (triggerModify === undefined) {
		throw new Error("modify handler was not registered.");
	}
	triggerModify(firstFile);
	timerHandlers[0]?.();
	await waitImmediate();
	assert.deepEqual(syncedLabels, ["first"]);

	triggerModify(queuedFile);
	timerHandlers[1]?.();
	triggerModify(latestFile);
	timerHandlers[2]?.();
	await waitImmediate();
	assert.deepEqual(syncedLabels, ["first"]);

	deferredSyncs[0]?.resolve(true);
	await waitImmediate();
	await waitImmediate();
	assert.deepEqual(syncedLabels, ["first", "latest"]);
	assert.equal(deferredSyncs.length, 2);

	deferredSyncs[1]?.resolve(true);
	await waitImmediate();
	await waitImmediate();
	assert.deepEqual(syncedLabels, ["first", "latest"]);
	assert.equal(deferredSyncs.length, 2);
});

interface Deferred<T> {
	promise: Promise<T>;
	resolve: (value: T) => void;
}

async function createMonthlyRenameHarness(expectedPaths: string[], internalMoveTarget: string | null = null) {
	await ensureObsidianStub();
	const { TFile } = await import("obsidian");
	const { FileWatchService } = await import("../src/services/FileWatchService");
	const handlersByEvent = new Map<string, (...args: unknown[]) => void>();
	const timers: Array<{ id: number; handler: () => void; cancelled: boolean }> = [];
	const recoveredPaths: string[] = [];
	const errors: unknown[] = [];
	let refreshes = 0;
	const service = new FileWatchService(
		{
			vault: {
				on: (eventName: string, handler: (...args: unknown[]) => void) => {
					handlersByEvent.set(eventName, handler);
					return {};
				},
			},
			workspace: {
				containerEl: {
					win: {
						setTimeout: (handler: () => void) => {
							const id = timers.length + 1;
							timers.push({ id, handler, cancelled: false });
							return id;
						},
						clearTimeout: (id: number) => {
							const timer = timers.find((item) => item.id === id);
							if (timer !== undefined) timer.cancelled = true;
						},
					},
				},
			},
		} as never,
		{
			consumeByReason: (_path: string, reason: string, targetPath?: string) => (
				internalMoveTarget !== null && reason === "archive_move" && targetPath === internalMoveTarget
					? { opId: "internal-move" }
					: null
			),
			cleanup: () => undefined,
		} as never,
		{
			isMonthlyArchiveFile: (path: string) => expectedPaths.includes(path),
			isMemoIndexFile: () => false,
			isPotentialDailyFile: () => false,
			getSyncDebounceMs: () => 0,
			recoverDeletedMonthlyArchive: async (path: string) => {
				recoveredPaths.push(path);
				return true;
			},
		} as never,
		() => {
			refreshes += 1;
		},
		(_path, error) => {
			errors.push(error);
		},
	);
	service.start({
		registerEvent: () => undefined,
		register: () => undefined,
	} as never);

	return {
		createFile: (path: string, extension = "md") => Object.assign(new TFile(), { path, extension }),
		triggerRename: (file: InstanceType<typeof TFile>, oldPath: string) => {
			handlersByEvent.get("rename")?.(file, oldPath);
		},
		runTimers: async () => {
			for (const timer of timers) {
				if (!timer.cancelled) timer.handler();
			}
			await waitImmediate();
			await waitImmediate();
		},
		timerCount: () => timers.filter((timer) => !timer.cancelled).length,
		refreshCount: () => refreshes,
		recoveredPaths,
		errors,
	};
}

function createDeferred<T>(): Deferred<T> {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((promiseResolve) => {
		resolve = promiseResolve;
	});
	return { promise, resolve };
}
