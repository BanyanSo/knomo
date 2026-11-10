import test from "node:test";
import assert from "node:assert/strict";
import type { App } from "obsidian";

import {
	buildMonthlyFolderExcludeRule,
	ObsidianExcludeService,
} from "../src/services/ObsidianExcludeService";

test("builds monthly folder exclude rules from vault paths", () => {
	assert.equal(buildMonthlyFolderExcludeRule("Knomo/Monthly"), "Knomo/Monthly/");
	assert.equal(buildMonthlyFolderExcludeRule("/Knomo//Monthly/"), "Knomo/Monthly/");
	assert.equal(buildMonthlyFolderExcludeRule("Knomo\\Monthly"), "Knomo/Monthly/");
	assert.equal(buildMonthlyFolderExcludeRule("   "), null);
});

test("ensures and removes Obsidian exclude rules without duplicates", async () => {
	const app = createAppWithExcludeRules(["Existing/"]);
	const service = new ObsidianExcludeService(app);

	assert.deepEqual(await service.ensureRule("Existing/"), { addedByKnomo: false });
	assert.deepEqual(await service.ensureRule("Memos/"), { addedByKnomo: true });
	assert.deepEqual(service.getExcludeRules(), ["Existing/", "Memos/"]);

	await service.removeRule("Memos/");
	assert.deepEqual(service.getExcludeRules(), ["Existing/"]);
});

test("candidate policy distinguishes known empty host defaults from unreadable or invalid rules", () => {
	for (const value of [null, []]) {
		const service = new ObsidianExcludeService({ vault: { getConfig: () => value } } as never);
		assert.equal(service.readTagCandidatePolicy().isIgnored("any.md"), false);
	}
	for (const value of [undefined, {}, "folder/", ["ok/", 1]]) {
		const service = new ObsidianExcludeService({ vault: { getConfig: () => value } } as never);
		assert.throws(() => service.readTagCandidatePolicy(), /could not be read/);
	}
	assert.throws(() => new ObsidianExcludeService({ vault: { getConfig() { throw new Error("I/O"); } } } as never).readTagCandidatePolicy(), /I\/O/);
});

test("candidate policy refreshes the host matcher and delegates paths without interpreting its rules", () => {
	let rules = ["archive/", "/pattern/"];
	let active: string[] = [];
	let calls = 0;
	const metadataCache = {
		updateUserIgnoreFilters() { active = [...rules]; },
		isUserIgnored(path: string) { assert.equal(this, metadataCache); calls++; return active.includes(path); },
	};
	const app = { vault: { getConfig: () => rules }, metadataCache } as never;
	const service = new ObsidianExcludeService(app);
	const first = service.readTagCandidatePolicy();
	assert.equal(first.isIgnored("archive/"), true);
	assert.equal(first.isIgnored("archive-other/"), false);
	assert.equal(first.isIgnored("/pattern/"), true);
	assert.equal(calls, 3);
	rules = ["other/"];
	const second = service.readTagCandidatePolicy();
	assert.notEqual(first.fingerprint, second.fingerprint);
	assert.equal(second.isIgnored("archive/"), false);
	assert.equal(second.isIgnored("other/"), true);
});

test("candidate policy reports missing, throwing and invalid host matchers instead of returning all files", () => {
	for (const metadataCache of [{}, { isUserIgnored: () => true }]) {
		const service = new ObsidianExcludeService({ vault: { getConfig: () => ["excluded/"] }, metadataCache } as never);
		assert.throws(() => service.readTagCandidatePolicy(), /does not provide/);
	}
	const service = new ObsidianExcludeService({ vault: { getConfig: () => ["excluded/"] }, metadataCache: {
		updateUserIgnoreFilters() {}, isUserIgnored: () => undefined,
	} } as never);
	assert.throws(() => service.readTagCandidatePolicy().isIgnored("a.md"), /invalid result/);
});

test("exclusion changes notify subscribers across service instances and detach cleanly", async () => {
	const app = createAppWithExcludeRules([]);
	let callback!: (key: string) => void;
	let detached = false;
	Object.assign(app.vault, { on: (_: string, listener: typeof callback) => { callback = listener; return {}; }, offref: () => { detached = true; } });
	const service = new ObsidianExcludeService(app);
	let notifications = 0;
	const stop = service.subscribe(() => notifications++);
	callback("unrelated"); assert.equal(notifications, 0);
	callback("userIgnoreFilters"); assert.equal(notifications, 1);
	await new ObsidianExcludeService(app).ensureRule("Monthly/");
	assert.equal(notifications, 2);
	stop(); assert.equal(detached, true);
	await service.removeRule("Monthly/");
	assert.equal(notifications, 2);
});

function createAppWithExcludeRules(initialRules: string[]): App {
	const config: Record<string, unknown> = {
		userIgnoreFilters: [...initialRules],
	};
	return {
		vault: {
			getConfig: (key: string) => config[key],
			setConfig: (key: string, value: unknown) => {
				config[key] = value;
			},
		},
	} as unknown as App;
}
