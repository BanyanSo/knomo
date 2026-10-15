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
			getAbstractFileByPath: () => file,
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
			getAbstractFileByPath: () => file,
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
		vault: { getAbstractFileByPath: () => file, cachedRead: async () => "", process: async () => "" },
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

test("Daily 写入网关为大文件解析传入协作式 runtime", async () => {
	const file = makeFile("Daily/2026-08-09.md");
	const content = Array.from({ length: 600 }, (_, index) => `- 09:00 memo ${index}`).join("\n");
	let yieldCount = 0;
	const app = {
		workspace: { getActiveViewOfType: () => null },
		vault: {
			getAbstractFileByPath: () => file,
			cachedRead: async () => content,
			process: async () => content,
		},
	} as unknown as App;
	const gateway = new DailyMemoWriteGateway(
		app,
		new DiaryMemoParser(async (bytes) => createHash("sha256").update(bytes).digest("hex")),
		{
			sliceBudgetMs: 60_000,
			maxLinesPerSlice: 32,
			yieldControl: async () => { yieldCount += 1; },
		},
	);

	await gateway.prepare({
		file,
		logicalDate: "2026-08-09",
		expectedRevision: null,
		update: (current) => current,
	});

	assert.ok(yieldCount > 0);
});

test("目标在准备、提交前或 process 回调前变化时拒绝写入，即使正文完全相同", async (context) => {
	for (const mode of ["active_editor", "vault_process"] as const) {
		for (const stage of ["prepare", "commit", "process"] as const) {
			if (mode === "active_editor" && stage === "process") continue;
			for (const change of ["rename", "outside-daily", "replacement"] as const) {
				await context.test(`${mode}/${stage}/${change}`, async () => {
					const path = "Daily/2026-08-09.md";
					const file = makeFile(path);
					let currentFile = file;
					let disk = "## Memos\n";
					const editor = new MemoryEditor(disk);
					const changeTarget = () => {
						if (change === "replacement") currentFile = makeFile(path);
						else file.path = change === "rename" ? "Daily/2026-08-10.md" : "Notes/2026-08-09.md";
					};
					let changed = false;
					const app = {
						workspace: { getActiveViewOfType: () => mode === "active_editor" ? { file, editor } : null },
						vault: {
							getAbstractFileByPath: (lookup: string) => lookup === currentFile.path ? currentFile : null,
							cachedRead: async () => disk,
							process: async (_file: TFile, update: (content: string) => string) => {
								if (stage === "process") changeTarget();
								disk = update(disk);
								return disk;
							},
						},
					} as unknown as App;
					const gateway = makeGateway(app);
					await assert.rejects(async () => {
						const prepared = await gateway.prepare({
							file, logicalDate: "2026-08-09", expectedRevision: null,
							update: (content) => {
								if (stage === "prepare" && !changed) { changed = true; changeTarget(); }
								return `${content}- 09:00 new memo\n`;
							},
						});
						if (stage === "commit") changeTarget();
						await gateway.commit(prepared);
					}, StaleDailyWriteError);
					assert.equal(disk, "## Memos\n");
					assert.equal(editor.getValue(), disk);
					assert.equal(editor.transactionCount, 0);
				});
			}
		}
	}
});

test("runtime 取消阻止编辑器、process 与解析后续提交，已提交正文仍返回成功", async (context) => {
	for (const stage of ["editor", "disk-read", "process", "parse-yield", "committed"] as const) {
		await context.test(stage, async () => {
			const cancellation = new AbortController();
			const file = makeFile("Daily/2026-08-09.md");
			const before = "- 09:00 before\n".repeat(100);
			let disk = before;
			const editor = new MemoryEditor(before);
			const active = stage === "editor" || stage === "disk-read";
			let preparedDone = false;
			let yieldCount = 0;
			const app = {
				workspace: { getActiveViewOfType: () => active ? { file, editor } : null },
				vault: {
					getAbstractFileByPath: () => file, cachedRead: async () => disk,
					read: async () => { if (preparedDone) cancellation.abort(); return disk; },
					process: async (_file: TFile, update: (value: string) => string) => {
						if (stage === "process") cancellation.abort();
						disk = update(disk);
						if (stage === "committed") cancellation.abort();
						return disk;
					},
				},
			} as unknown as App;
			const gateway = new DailyMemoWriteGateway(app, new DiaryMemoParser(), {
				cancellationSignal: cancellation.signal, maxLinesPerSlice: 10,
				yieldControl: async () => { yieldCount++; if (stage === "parse-yield") cancellation.abort(); },
			});
			const save = async () => {
				const prepared = await gateway.prepare({ file, logicalDate: "2026-08-09", expectedRevision: null,
					requireDiskMatch: stage === "disk-read", update: value => value.replace("before", "after") });
				preparedDone = true;
				if (stage === "editor") cancellation.abort();
				return gateway.commit(prepared);
			};
			if (stage === "committed") {
				assert.equal((await save()).mode, "vault_process");
				assert.equal(disk, before.replace("before", "after"));
			} else {
				await assert.rejects(save, /cancel/iu);
				assert.equal(disk, before);
				assert.equal(editor.getValue(), before);
				assert.equal(editor.transactionCount, 0);
				if (stage === "parse-yield") assert.equal(yieldCount, 1);
			}
		});
	}
});

function makeGateway(app: App): DailyMemoWriteGateway {
	return new DailyMemoWriteGateway(app, new DiaryMemoParser(async (bytes) => (
		createHash("sha256").update(bytes).digest("hex")
	)), { yieldControl: () => new Promise<void>((resolve) => setTimeout(resolve, 0)) });
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
