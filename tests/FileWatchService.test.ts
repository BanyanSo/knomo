import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { setImmediate as waitImmediate } from "node:timers/promises";

test("FileWatchService delegates sync errors to the injected callback", async () => {
	await ensureObsidianStub();
	const { TFile } = await import("obsidian");
	const { FileWatchService } = await import("../src/services/FileWatchService");
	const file = Object.assign(new TFile(), {
		path: "Daily/2026-06-02.md",
		extension: "md",
	});
	const syncError = new Error("manual sync failed");
	const handlersByEvent = new Map<string, (file: unknown) => void>();
	const timerHandlers: Array<() => void> = [];
	let receivedPath: string | null = null;
	let receivedError: unknown = null;
	const app = {
		vault: {
			on: (eventName: string, handler: (file: unknown) => void) => {
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

	assert.deepEqual([...handlersByEvent.keys()], ["modify", "create", "rename"]);
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

test("FileWatchService refreshes views when a memo-index file changes", async () => {
	await ensureObsidianStub();
	const { TFile } = await import("obsidian");
	const { FileWatchService } = await import("../src/services/FileWatchService");
	const file = Object.assign(new TFile(), {
		path: "Memos/_knomo-system/indexes/memo-index-2026-06.json",
		extension: "json",
	});
	const handlersByEvent = new Map<string, (file: unknown) => void>();
	const timerHandlers: Array<() => void> = [];
	let refreshCount = 0;
	let dailySyncCalled = false;
	const app = {
		vault: {
			on: (eventName: string, handler: (file: unknown) => void) => {
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
			consumeByExpectedHash: () => null,
			cleanup: () => undefined,
		} as never,
		{
			isPotentialDailyFile: () => false,
			isMemoIndexFile: (path: string) => path === file.path,
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
});

test("FileWatchService scans daily notes delivered through rename events", async () => {
	await ensureObsidianStub();
	const { TFile } = await import("obsidian");
	const { FileWatchService } = await import("../src/services/FileWatchService");
	const file = Object.assign(new TFile(), {
		path: "Daily/2026-06-02.md",
		extension: "md",
	});
	const handlersByEvent = new Map<string, (file: unknown) => void>();
	const timerHandlers: Array<() => void> = [];
	let syncedPath = "";
	let refreshCount = 0;
	const app = {
		vault: {
			on: (eventName: string, handler: (file: unknown) => void) => {
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
			isPotentialDailyFile: (path: string) => path === file.path,
			isMemoIndexFile: () => false,
			getSyncDebounceMs: () => 0,
			syncExternalDailyFile: async (changedFile: { path: string }) => {
				syncedPath = changedFile.path;
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
	triggerRename(file);
	const triggerTimer = timerHandlers[0];
	assert.notEqual(triggerTimer, undefined);
	if (triggerTimer === undefined) {
		throw new Error("sync timer was not queued.");
	}
	triggerTimer();
	await waitImmediate();

	assert.equal(syncedPath, file.path);
	assert.equal(refreshCount, 1);
});

async function ensureObsidianStub(): Promise<void> {
	const stubPath = resolve(__dirname, "../node_modules/obsidian/index.js");
	await mkdir(dirname(stubPath), { recursive: true });
	await writeFile(
		stubPath,
		[
			"class TFile {}",
			"class TFolder { constructor() { this.children = []; } }",
			"const Vault = { recurseChildren() {} };",
			"const normalizePath = (value) => value.replace(/\\\\/g, '/').replace(/\\/+/g, '/').replace(/^\\//, '').replace(/\\/$/, '');",
			"function setIcon(el, icon) { if (el && typeof el.setAttr === 'function') el.setAttr('data-icon', icon); return el; }",
			"function addIcon() {}",
			"let languageValue = 'en';",
			"function getLanguage() { return languageValue; }",
			"getLanguage.set = (value) => { languageValue = value; };",
			"let localeValue = 'en';",
			"const moment = (date = new Date()) => ({ format: () => date.toISOString().slice(0, 10) });",
			"moment.locale = (value) => { if (typeof value === 'string') localeValue = value; return localeValue; };",
			"module.exports = { TFile, TFolder, Vault, normalizePath, setIcon, addIcon, getLanguage, moment };",
		].join("\n"),
	);
}
