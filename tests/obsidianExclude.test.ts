import test from "node:test";
import assert from "node:assert/strict";
import type { App } from "obsidian";

import {
	buildMonthlyFolderExcludeRule,
	buildSystemFolderExcludeRule,
	ObsidianExcludeService,
} from "../src/services/ObsidianExcludeService";

test("builds monthly folder exclude rules from vault paths", () => {
	assert.equal(buildMonthlyFolderExcludeRule("Knomo/Monthly"), "Knomo/Monthly/");
	assert.equal(buildMonthlyFolderExcludeRule("/Knomo//Monthly/"), "Knomo/Monthly/");
	assert.equal(buildMonthlyFolderExcludeRule("Knomo\\Monthly"), "Knomo/Monthly/");
	assert.equal(buildMonthlyFolderExcludeRule("   "), null);
});

test("builds system folder exclude rules under the monthly folder", () => {
	assert.equal(buildSystemFolderExcludeRule("Knomo"), "Knomo/_knomo-system/");
	assert.equal(buildSystemFolderExcludeRule("/Archive//Memos/"), "Archive/Memos/_knomo-system/");
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
