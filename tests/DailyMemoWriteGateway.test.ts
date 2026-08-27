import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { TFile } from "obsidian";
import type { App, Editor, EditorPosition, EditorTransaction, MarkdownView } from "obsidian";

import { DailyMemoWriteGateway, StaleDailyWriteError } from "../src/services/DailyMemoWriteGateway";
import { DiaryMemoParser } from "../src/services/DiaryMemoParser";

test("active Daily writes through one editor transaction", async () => {
	const file = makeFile("Daily/2026-08-09.md");
	const editor = new MemoryEditor("## Memos\n- 09:00 before\n");
	let processCalls = 0;
	const view = { file, editor } as unknown as MarkdownView;
	const app = {
		workspace: { getActiveViewOfType: () => view },
		vault: {
			cachedRead: async () => "stale vault bytes",
			process: async () => {
				processCalls += 1;
				return "";
			},
		},
	} as unknown as App;
	const gateway = makeGateway(app);

	const prepared = await gateway.prepare({
		file,
		logicalDate: "2026-08-09",
		expectedRevision: null,
		update: (content) => content.replace("before", "after"),
	});
	const result = await gateway.commit(prepared);

	assert.equal(result.mode, "active_editor");
	assert.equal(editor.getValue(), "## Memos\n- 09:00 after\n");
	assert.equal(editor.transactionCount, 1);
	assert.equal(processCalls, 0);
	assert.equal(result.after.observations[0]?.content, "after");
});

test("background Daily writes through Vault.process with a compare-and-swap guard", async () => {
	const file = makeFile("Daily/2026-08-09.md");
	let content = "## Memos\n- 09:00 before\n";
	let processCalls = 0;
	let updateCalls = 0;
	const app = {
		workspace: { getActiveViewOfType: () => null },
		vault: {
			cachedRead: async () => content,
			process: async (_file: TFile, update: (current: string) => string) => {
				processCalls += 1;
				content = update(content);
				return content;
			},
		},
	} as unknown as App;
	const gateway = makeGateway(app);
	const prepared = await gateway.prepare({
		file,
		logicalDate: "2026-08-09",
		expectedRevision: null,
		update: (current) => {
			updateCalls += 1;
			return current.replace("before", "after");
		},
	});
	const result = await gateway.commit(prepared);

	assert.equal(result.mode, "vault_process");
	assert.equal(processCalls, 1);
	assert.equal(updateCalls, 2);
	assert.equal(content, "## Memos\n- 09:00 after\n");
});

test("expected revision and late editor changes reject stale Daily writes", async () => {
	const file = makeFile("Daily/2026-08-09.md");
	const editor = new MemoryEditor("## Memos\n- 09:00 before\n");
	const view = { file, editor } as unknown as MarkdownView;
	const app = {
		workspace: { getActiveViewOfType: () => view },
		vault: { cachedRead: async () => "", process: async () => "" },
	} as unknown as App;
	const gateway = makeGateway(app);

	await assert.rejects(() => gateway.prepare({
		file,
		logicalDate: "2026-08-09",
		expectedRevision: "0".repeat(64),
		update: (content) => content,
	}), StaleDailyWriteError);

	const prepared = await gateway.prepare({
		file,
		logicalDate: "2026-08-09",
		expectedRevision: null,
		update: (content) => content.replace("before", "after"),
	});
	editor.setValue("## Memos\n- 09:00 concurrent\n");
	await assert.rejects(() => gateway.commit(prepared), StaleDailyWriteError);
	assert.equal(editor.transactionCount, 0);
});

function makeGateway(app: App): DailyMemoWriteGateway {
	return new DailyMemoWriteGateway(app, new DiaryMemoParser(async (bytes) => (
		createHash("sha256").update(bytes).digest("hex")
	)));
}

function makeFile(path: string): TFile {
	return Object.assign(new TFile(), {
		path,
		name: path.split("/").pop() ?? "",
		stat: { ctime: 1, mtime: 1, size: 0 },
	});
}

class MemoryEditor {
	transactionCount = 0;

	constructor(private value: string) {}

	getValue(): string {
		return this.value;
	}

	setValue(value: string): void {
		this.value = value;
	}

	offsetToPos(offset: number): EditorPosition {
		const prefix = this.value.slice(0, offset);
		const lines = prefix.split("\n");
		return { line: lines.length - 1, ch: lines[lines.length - 1]?.length ?? 0 };
	}

	transaction(transaction: EditorTransaction): void {
		const change = transaction.changes?.[0];
		assert.ok(change !== undefined);
		assert.deepEqual(change.from, { line: 0, ch: 0 });
		assert.deepEqual(change.to, this.offsetToPos(this.value.length));
		this.value = change.text;
		this.transactionCount += 1;
	}
}

void (MemoryEditor satisfies new (value: string) => Pick<Editor, "getValue" | "offsetToPos" | "transaction">);
