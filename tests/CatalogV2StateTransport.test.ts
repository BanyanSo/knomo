import test from "node:test";
import assert from "node:assert/strict";
import { TFile, TFolder } from "obsidian";
import type { App, TAbstractFile } from "obsidian";

import { CatalogV2StateTransport, isStateSegmentPath } from "../src/services/CatalogV2StateTransport";
import { parseStateSegment } from "../src/services/CatalogV2Protocol";
import type { StateOperation } from "../src/types/catalogV2";

test("state transport inventories only canonical segments and explicit sync conflicts", () => {
	const root = "Memos/_knomo-data/state/devices";
	const writer = "w_00000000000000000000000000000001";
	assert.equal(isStateSegmentPath(root, `${root}/${writer}/segment-000001.jsonl`), true);
	assert.equal(isStateSegmentPath(root, `${root}/${writer}/segment-000001 conflict.jsonl`), true);
	assert.equal(isStateSegmentPath(root, `${root}/${writer}/segment-000001 copy.jsonl`), false);
	assert.equal(isStateSegmentPath(root, `${root}/${writer}/nested/segment-000001.jsonl`), false);
	assert.equal(isStateSegmentPath(root, `${root}/w_invalid/segment-000001.jsonl`), false);
});

test("state transport appends canonical JSONL to the current writer segment", async () => {
	const files = new Map<string, TAbstractFile>();
	const contents = new Map<string, string>();
	const vault = {
		getAbstractFileByPath: (path: string) => files.get(path) ?? null,
		createFolder: async (path: string) => {
			const folder = Object.assign(new TFolder(), { path, name: path.split("/").pop() ?? "", children: [] });
			files.set(path, folder);
			addToParent(files, path, folder);
		},
		create: async (path: string, content: string) => {
			const name = path.split("/").pop() ?? "";
			const file = Object.assign(new TFile(), {
				path,
				name,
				basename: name.replace(/\.[^.]+$/, ""),
				extension: name.split(".").pop() ?? "",
				stat: { ctime: 1, mtime: 1, size: new TextEncoder().encode(content).byteLength },
			});
			files.set(path, file);
			contents.set(path, content);
			addToParent(files, path, file);
			return file;
		},
		cachedRead: async (file: TFile) => contents.get(file.path) ?? "",
		process: async (file: TFile, update: (content: string) => string) => {
			const content = update(contents.get(file.path) ?? "");
			contents.set(file.path, content);
			file.stat = { ...file.stat, mtime: file.stat.mtime + 1, size: new TextEncoder().encode(content).byteLength };
			return content;
		},
		readBinary: async (file: TFile) => new TextEncoder().encode(contents.get(file.path) ?? "").buffer,
	} as unknown as App["vault"];
	const app = { vault } as App;
	const transport = new CatalogV2StateTransport(app, "Memos/_knomo-data");
	const first = makeReviewOperation(1);
	const second = makeReviewOperation(2);
	const firstRef = await transport.append(first);
	const secondRef = await transport.append(second);
	assert.equal(firstRef.path, secondRef.path);
	const parsed = await parseStateSegment(firstRef.path, contents.get(firstRef.path) ?? "");
	assert.deepEqual(parsed.operations.map((item) => item.operation.opId), [first.opId, second.opId]);
});

test("state transport treats an exact retried operation as idempotent", async () => {
	const files = new Map<string, TAbstractFile>();
	const contents = new Map<string, string>();
	const vault = createMemoryVault(files, contents);
	const app = { vault } as App;
	const transport = new CatalogV2StateTransport(app, "Memos/_knomo-data");
	const operation = makeReviewOperation(1);

	const first = await transport.append(operation);
	const retried = await transport.append(operation);

	assert.deepEqual(retried, first);
	assert.equal((contents.get(first.path) ?? "").split("\n").filter(Boolean).length, 1);
	assert.equal(await transport.getLastSequence(operation.writerId), 1);
});

function addToParent(files: Map<string, TAbstractFile>, path: string, child: TAbstractFile): void {
	const separator = path.lastIndexOf("/");
	if (separator < 0) return;
	const parent = files.get(path.slice(0, separator));
	if (parent instanceof TFolder) parent.children.push(child);
}

function makeReviewOperation(sequence: number): StateOperation {
	return {
		schemaVersion: 1,
		writerId: "w_00000000000000000000000000000001",
		sequence,
		opId: `o_${sequence.toString(16).padStart(32, "0")}`,
		memoId: "memo-1",
		occurredAt: "2026-08-09T00:00:00.000Z",
		type: "review.record",
		baseEvidence: null,
		payload: { reviewedAt: "2026-08-09T00:00:00.000Z" },
	};
}

function createMemoryVault(
	files: Map<string, TAbstractFile>,
	contents: Map<string, string>,
): App["vault"] {
	return {
		getAbstractFileByPath: (path: string) => files.get(path) ?? null,
		createFolder: async (path: string) => {
			const folder = Object.assign(new TFolder(), { path, name: path.split("/").pop() ?? "", children: [] });
			files.set(path, folder);
			addToParent(files, path, folder);
		},
		create: async (path: string, content: string) => {
			const name = path.split("/").pop() ?? "";
			const file = Object.assign(new TFile(), {
				path,
				name,
				basename: name.replace(/\.[^.]+$/, ""),
				extension: name.split(".").pop() ?? "",
				stat: { ctime: 1, mtime: 1, size: new TextEncoder().encode(content).byteLength },
			});
			files.set(path, file);
			contents.set(path, content);
			addToParent(files, path, file);
			return file;
		},
		cachedRead: async (file: TFile) => contents.get(file.path) ?? "",
		process: async (file: TFile, update: (content: string) => string) => {
			const content = update(contents.get(file.path) ?? "");
			contents.set(file.path, content);
			file.stat = { ...file.stat, mtime: file.stat.mtime + 1, size: new TextEncoder().encode(content).byteLength };
			return content;
		},
		readBinary: async (file: TFile) => new TextEncoder().encode(contents.get(file.path) ?? "").buffer,
	} as unknown as App["vault"];
}
