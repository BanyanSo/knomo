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
	const modifyHandlers: Array<(file: unknown) => void> = [];
	const timerHandlers: Array<() => void> = [];
	let receivedPath: string | null = null;
	let receivedError: unknown = null;
	const app = {
		vault: {
			on: (eventName: string, handler: (file: unknown) => void) => {
				assert.equal(eventName, "modify");
				modifyHandlers.push(handler);
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

	const triggerModify = modifyHandlers[0];
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
