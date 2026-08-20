import assert from "node:assert/strict";
import test from "node:test";
import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import { TFile, TFolder } from "obsidian";
import type { App, TAbstractFile } from "obsidian";

import { CatalogV2StateCompactionService } from "../src/services/CatalogV2StateCompactionService";
import {
	buildStateCompactionCommit,
	buildStateSnapshot,
	canonicalJson,
} from "../src/services/CatalogV2Protocol";
import { CatalogV2StateReducer } from "../src/services/CatalogV2StateReducer";
import { CatalogV2StateTransport } from "../src/services/CatalogV2StateTransport";
import { IndexedDbCatalogV2StateStore } from "../src/services/IndexedDbCatalogV2StateStore";
import type { StateOperation } from "../src/types/catalogV2";
import { ensureFolder } from "../src/utils/vault";

const SYSTEM_ROOT = "Memos/_knomo-data";
const WRITER_ID = "w_11111111111111111111111111111111";

test("phase zero disables shared state compaction and segment retirement", async () => {
	const fixture = createMemoryApp();
	await seedSegments(fixture.app, [makeReviewOperation(1), makeReviewOperation(2)]);
	const store = new IndexedDbCatalogV2StateStore("state-compaction", {
		factory: new IDBFactory(),
		keyRange: IDBKeyRange,
	});
	await store.open();
	const service = new CatalogV2StateCompactionService(fixture.app, SYSTEM_ROOT, store, {
		sealedSegmentThreshold: 1,
		quietWindowMs: 0,
		now: () => 1_000,
	});

	assert.deepEqual(await service.maintain(), { createdSnapshots: 0, retiredSegments: 0 });
	assert.deepEqual(await service.maintain(), { createdSnapshots: 0, retiredSegments: 0 });
	assert.deepEqual(fixture.trashed, []);
	assert.notEqual(fixture.app.vault.getAbstractFileByPath(`${SYSTEM_ROOT}/state/devices/${WRITER_ID}/segment-000001.jsonl`), null);
	const transport = new CatalogV2StateTransport(fixture.app, SYSTEM_ROOT);
	const inputSet = await transport.prepareInputSet();
	const inputs = await transport.readInputSet(inputSet, [], true);
	const recovered = await new CatalogV2StateReducer().reduce(inputs.flatMap((segment) => segment.operations));
	assert.equal(recovered.memos["memo-1"]?.reviewCount, 2);
	store.close();
});

test("commit and segment deletion arriving before the snapshot degrade only the missing state range", async () => {
	const fixture = createMemoryApp();
	await seedSegments(fixture.app, [makeReviewOperation(1), makeReviewOperation(2)]);
	const transport = new CatalogV2StateTransport(fixture.app, SYSTEM_ROOT);
	const firstSegment = (await transport.readSegments([], true))[0];
	assert.notEqual(firstSegment, undefined);
	if (firstSegment === undefined) return;
	const snapshot = await buildStateSnapshot({
		sourceWriterId: WRITER_ID,
		coveredSegments: [{ path: firstSegment.path, sha256: firstSegment.sha256, byteLength: firstSegment.byteLength }],
		operations: firstSegment.operations.map((item) => item.operation),
	});
	const commit = await buildStateCompactionCommit({
		snapshot: { path: snapshot.path, sha256: snapshot.digest, byteLength: snapshot.bytes.byteLength },
		snapshotValue: snapshot.snapshot,
		committingWriterId: WRITER_ID,
		committedAt: "2026-08-09T00:00:00.000Z",
	});
	await ensureFolder(fixture.app, `${SYSTEM_ROOT}/state/checkpoints`);
	await fixture.app.vault.create(`${SYSTEM_ROOT}/${commit.path}`, new TextDecoder().decode(commit.bytes));
	const coveredFile = fixture.app.vault.getAbstractFileByPath(firstSegment.path);
	assert.ok(coveredFile instanceof TFile);
	await fixture.app.fileManager.trashFile(coveredFile as TFile);

	const invalid: string[] = [];
	const incompleteSet = await transport.prepareInputSet((path) => invalid.push(path));
	const incomplete = await transport.readInputSet(incompleteSet, [], true);
	const degraded = await new CatalogV2StateReducer().reduce(incomplete.flatMap((segment) => segment.operations));
	assert.equal(invalid.length, 1);
	assert.deepEqual(degraded.awaitingWriterIds, [WRITER_ID]);
	assert.equal(degraded.memos["memo-1"]?.reviewCount, 1);

	await ensureFolder(fixture.app, `${SYSTEM_ROOT}/state/snapshots/${WRITER_ID}`);
	await fixture.app.vault.create(`${SYSTEM_ROOT}/${snapshot.path}`, new TextDecoder().decode(snapshot.bytes));
	const completeSet = await transport.prepareInputSet();
	const complete = await transport.readInputSet(completeSet, [], true);
	const recovered = await new CatalogV2StateReducer().reduce(complete.flatMap((segment) => segment.operations));
	assert.deepEqual(recovered.awaitingWriterIds, []);
	assert.equal(recovered.memos["memo-1"]?.reviewCount, 2);
});

function createMemoryApp(): { app: App; trashed: string[] } {
	const files = new Map<string, TAbstractFile>();
	const contents = new Map<string, string>();
	const trashed: string[] = [];
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
				basename: name.replace(/\.[^.]+$/u, ""),
				extension: name.split(".").pop() ?? "",
				stat: { ctime: 1, mtime: 1, size: new TextEncoder().encode(content).byteLength },
			});
			files.set(path, file);
			contents.set(path, content);
			addToParent(files, path, file);
			return file;
		},
		readBinary: async (file: TFile) => {
			const bytes = new TextEncoder().encode(contents.get(file.path) ?? "");
			return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
		},
		cachedRead: async (file: TFile) => contents.get(file.path) ?? "",
	} as unknown as App["vault"];
	const app = {
		vault,
		fileManager: {
			trashFile: async (file: TFile) => {
				trashed.push(file.path);
				files.delete(file.path);
				contents.delete(file.path);
				removeFromParent(files, file.path, file);
			},
		},
	} as unknown as App;
	return { app, trashed };
}

async function seedSegments(app: App, operations: readonly StateOperation[]): Promise<void> {
	const writerFolder = `${SYSTEM_ROOT}/state/devices/${WRITER_ID}`;
	await ensureFolder(app, writerFolder);
	for (const operation of operations) {
		const path = `${writerFolder}/segment-${String(operation.sequence).padStart(6, "0")}.jsonl`;
		await app.vault.create(path, `${canonicalJson(operation)}\n`);
	}
}

function makeReviewOperation(sequence: number): StateOperation {
	return {
		schemaVersion: 1,
		writerId: WRITER_ID,
		sequence,
		opId: `o_${sequence.toString(16).padStart(32, "0")}`,
		memoId: "memo-1",
		occurredAt: "2026-08-09T00:00:00.000Z",
		type: "review.record",
		baseEvidence: null,
		payload: { reviewedAt: `2026-08-09T00:00:0${sequence}.000Z` },
	};
}

function addToParent(files: Map<string, TAbstractFile>, path: string, child: TAbstractFile): void {
	const separator = path.lastIndexOf("/");
	if (separator < 0) return;
	const parent = files.get(path.slice(0, separator));
	if (parent instanceof TFolder) parent.children.push(child);
}

function removeFromParent(files: Map<string, TAbstractFile>, path: string, child: TAbstractFile): void {
	const separator = path.lastIndexOf("/");
	if (separator < 0) return;
	const parent = files.get(path.slice(0, separator));
	if (!(parent instanceof TFolder)) return;
	parent.children = parent.children.filter((entry) => entry !== child);
}
