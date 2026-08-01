import test from "node:test";
import assert from "node:assert/strict";

import type { App, CachedMetadata, TFile as ObsidianTFile } from "obsidian";
import { ensureObsidianStub } from "./helpers/obsidianStub";

test("Vault tag index scans once and applies metadata changes incrementally", async () => {
	await ensureObsidianStub();
	const { TFile } = await import("obsidian");
	const { VaultTagIndex } = await import("../src/services/VaultTagIndex");
	const first = new TFile();
	const second = new TFile();
	Object.assign(first, { path: "A.md", name: "A.md", extension: "md", basename: "A" });
	Object.assign(second, { path: "B.md", name: "B.md", extension: "md", basename: "B" });
	first.stat.mtime = 1;
	second.stat.mtime = 2;
	const files = new Map<string, ObsidianTFile>([[first.path, first], [second.path, second]]);
	const caches = new Map<string, CachedMetadata>([
		[first.path, { allTags: ["#Project"] } as unknown as CachedMetadata],
		[second.path, { allTags: ["#project/Sub"] } as unknown as CachedMetadata],
	]);
	const callbacks = new Map<string, (...args: unknown[]) => void>();
	let scanCount = 0;
	const app = {
		vault: {
			getMarkdownFiles: () => {
				scanCount += 1;
				return [...files.values()];
			},
			getAbstractFileByPath: (path: string) => files.get(path) ?? null,
			on: () => ({}),
		},
		metadataCache: {
			getFileCache: (file: ObsidianTFile) => caches.get(file.path) ?? null,
			on: (name: string, callback: (...args: unknown[]) => void) => {
				callbacks.set(name, callback);
				return {};
			},
		},
	} as unknown as App;
	const index = new VaultTagIndex(app);
	index.load();

	const initial = await index.ensureReady();
	await index.ensureReady();
	assert.equal(scanCount, 1);
	assert.equal(initial.status, "ready");
	assert.equal(initial.displayByKey.get("project"), "project");
	assert.equal(initial.displayByKey.get("project/sub"), "project/Sub");

	callbacks.get("changed")?.(first, "", { allTags: ["#NewTag"] } as unknown as CachedMetadata);
	const changed = index.getSnapshot();
	assert.equal(changed.displayByKey.has("newtag"), true);
	assert.equal(changed.displayByKey.has("project/sub"), true);
	assert.equal(scanCount, 1);
});
