import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { TFile } from "obsidian";
import type { App } from "obsidian";

import { CatalogV2DailyWriteGateway } from "../src/services/CatalogV2DailyWriteGateway";
import { DiaryMemoParser } from "../src/services/DiaryMemoParser";
import {
	MarkdownMutationService,
	MarkdownMutationStaleError,
	type MarkdownCatalogCommitInput,
} from "../src/services/MarkdownMutationService";
import type { MemoObservation, ObservationHandle } from "../src/types/catalog";

const HEADINGS = ["## Memos"] as const;

test("V3-OP-002/004/005 与 V3-FAIL-002/004：正文 mutation 不依赖 bootstrap、identity 或本机 IDB", async (context) => {
	for (const scenario of [
		"no-bootstrap",
		"identity-syncing",
		"identity-ambiguous",
		"state-idb-deleted",
		"transaction-idb-deleted",
		"catalog-idb-degraded",
	] as const) {
		await context.test(scenario, async () => {
			const fixture = createFixture({ catalogDegraded: scenario === "catalog-idb-degraded" });
			const created = await fixture.service.create({ content: "created\n- [ ] task" });
			assert.equal(created.status, "committed_identity_pending");
			assert.equal(created.catalogUpdatePending, scenario === "catalog-idb-degraded");

			const createdObservation = await fixture.getOnlyObservation("2026-08-22");
			const edited = await fixture.service.edit({
				observation: toHandle(createdObservation),
				content: "edited\n- [ ] task",
			});
			assert.equal(edited.status, "committed_identity_pending");

			const taskObservation = await fixture.getOnlyObservation("2026-08-22");
			const toggled = await fixture.service.toggleTask({
				observation: toHandle(taskObservation),
				taskIndex: 0,
				checked: true,
			});
			assert.equal(toggled.observation?.content, "edited\n- [x] task");

			const copySource = await fixture.getOnlyObservation("2026-08-22");
			const copied = await fixture.service.copy({
				observation: toHandle(copySource),
				targetLogicalDate: "2026-08-23",
			});
			assert.equal(copied.status, "committed_identity_pending");
			assert.equal((await fixture.getOnlyObservation("2026-08-23")).content, copySource.content);
			assert.doesNotMatch(fixture.vault.readText(fixture.getPath("2026-08-22")), /<!--|memoId|knomo-id/u);
		});
	}
});

test("V3-ORDER-006/V3-PURITY-001：同一分钟相同正文创建两条 observation，Daily 不含内部身份字符", async () => {
	const fixture = createFixture();

	await fixture.service.create({ content: "same" });
	await fixture.service.create({ content: "same" });

	const parsed = await fixture.parse("2026-08-22");
	assert.equal(parsed.length, 2);
	assert.equal(parsed[0]?.content, "same");
	assert.equal(parsed[1]?.content, "same");
	assert.notEqual(parsed[0]?.startLine, parsed[1]?.startLine);
	assert.equal(
		fixture.vault.readText(fixture.getPath("2026-08-22")),
		"## Memos\n- 09:00 same\n- 09:00 same\n",
	);
});

test("用户配置 top 时新 memo 插入标题下方，bottom 仍追加到分组末尾", async () => {
	const path = "Daily/2026-08-22.md";
	const initial = "## Memos\n- 08:00 existing\n\n\n## Notes\ntext\n";
	const top = createFixture({ initialFiles: { [path]: initial }, insertPosition: "top" });
	await top.service.create({ content: "new" });
	assert.equal(
		top.vault.readText(path),
		"## Memos\n- 09:00 new\n- 08:00 existing\n\n\n## Notes\ntext\n",
	);

	const bottom = createFixture({ initialFiles: { [path]: initial }, insertPosition: "bottom" });
	await bottom.service.create({ content: "new" });
	assert.equal(
		bottom.vault.readText(path),
		"## Memos\n- 08:00 existing\n- 09:00 new\n\n\n## Notes\ntext\n",
	);
});

test("V3-LAYER-004：stale ObservationHandle 拒绝写入并刷新 Catalog，不按旧行号猜测", async () => {
	const fixture = createFixture({
		initialFiles: { "Daily/2026-08-22.md": "## Memos\n- 08:00 first\n- 08:01 second\n" },
	});
	const stale = (await fixture.parse("2026-08-22"))[0];
	assert.ok(stale !== undefined);
	fixture.vault.writeText(fixture.getPath("2026-08-22"), "## Memos\n- 07:59 concurrent\n- 08:00 first\n- 08:01 second\n");
	const concurrentBytes = fixture.vault.readText(fixture.getPath("2026-08-22"));

	await assert.rejects(() => fixture.service.edit({
		observation: toHandle(stale),
		content: "must not be written",
	}), MarkdownMutationStaleError);

	assert.equal(fixture.vault.readText(fixture.getPath("2026-08-22")), concurrentBytes);
	assert.deepEqual(fixture.refreshedPaths, [[fixture.getPath("2026-08-22")]]);
});

test("V3-OP-005：copy 保留 multiline、列表、任务和代码块结构，但不复制显式 block ID", async (context) => {
	for (const [name, content] of [
		["multiline", "first\nsecond"],
		["list", "- first\n- second"],
		["task", "- [ ] first\n  continuation"],
		["code", "```ts\nconst x = 1;\n```"],
	] as const) {
		await context.test(name, async () => {
			const fixture = createFixture();
			await fixture.service.create({ content });
			const source = await fixture.getOnlyObservation("2026-08-22");

			await fixture.service.copy({
				observation: toHandle(source),
				targetLogicalDate: "2026-08-23",
			});

			assert.equal((await fixture.getOnlyObservation("2026-08-23")).content, content);
		});
	}

	const fixture = createFixture({
		initialFiles: { "Daily/2026-08-22.md": "## Memos\n- 08:00 referenced ^userref\n" },
	});
	const source = await fixture.getOnlyObservation("2026-08-22");
	await fixture.service.copy({ observation: toHandle(source), targetLogicalDate: "2026-08-23" });
	const copied = await fixture.getOnlyObservation("2026-08-23");
	assert.equal(copied.content, "referenced");
	assert.equal(copied.existingBlockId, null);
});

test("V3-OP-006：move 来源删除失败时精确回滚目标，不留下无恢复记录的重复正文", async () => {
	const sourcePath = "Daily/2026-08-22.md";
	const targetPath = "Daily/2026-08-23.md";
	const fixture = createFixture({
		initialFiles: {
			[sourcePath]: "## Memos\n- 08:00 move me\n",
			[targetPath]: "## Memos\n",
		},
	});
	const source = await fixture.getOnlyObservation("2026-08-22");
	fixture.vault.failNextProcess(sourcePath);

	await assert.rejects(() => fixture.service.move({
		observation: toHandle(source),
		targetLogicalDate: "2026-08-23",
	}), /process failed/u);

	assert.match(fixture.vault.readText(sourcePath), /move me/u);
	assert.doesNotMatch(fixture.vault.readText(targetPath), /move me/u);
});

test("V3-OP-006：move 回滚目标遇到并发修改时保留两份正文并明确报告 content pending", async () => {
	const sourcePath = "Daily/2026-08-22.md";
	const targetPath = "Daily/2026-08-23.md";
	const fixture = createFixture({
		initialFiles: {
			[sourcePath]: "## Memos\n- 08:00 move me\n",
			[targetPath]: "## Memos\n",
		},
	});
	const source = await fixture.getOnlyObservation("2026-08-22");
	fixture.vault.failNextProcess(sourcePath, () => {
		fixture.vault.writeText(targetPath, `${fixture.vault.readText(targetPath)}- 08:01 concurrent\n`);
	});

	const result = await fixture.service.move({
		observation: toHandle(source),
		targetLogicalDate: "2026-08-23",
	});

	assert.equal(result.status, "committed_content_pending");
	assert.equal(result.catalogUpdatePending, true);
	assert.match(fixture.vault.readText(sourcePath), /move me/u);
	assert.match(fixture.vault.readText(targetPath), /move me/u);
	assert.match(fixture.vault.readText(targetPath), /concurrent/u);
});

test("V3-OP-007/012：remove 删除当前 block；显式 reference 只写用户请求的 block ID", async () => {
	const fixture = createFixture({
		initialFiles: { "Daily/2026-08-22.md": "## Memos\n- 08:00 referenced\n" },
	});
	const source = await fixture.getOnlyObservation("2026-08-22");

	const referenced = await fixture.service.createBlockReference({
		observation: toHandle(source),
		sourcePath: "Notes/source.md",
	});
	assert.equal(referenced.blockId, "aaaaaa");
	assert.equal(fixture.vault.readText(fixture.getPath("2026-08-22")), "## Memos\n- 08:00 referenced ^aaaaaa\n");

	assert.ok(referenced.observation !== null);
	await fixture.service.remove({ observation: toHandle(referenced.observation) });
	assert.equal(fixture.vault.readText(fixture.getPath("2026-08-22")), "## Memos\n");
});

test("P1 第 7 步：可恢复删除先只读捕获精确 block，restore 原样写回且不含身份字符", async () => {
	const sourcePath = "Daily/2026-08-22.md";
	const original = "## Memos\n- 08:00 first line\n  continuation\n";
	const fixture = createFixture({ initialFiles: { [sourcePath]: original } });
	const observation = await fixture.getOnlyObservation("2026-08-22");

	const captured = await fixture.service.captureObservation({ observation: toHandle(observation) });

	assert.equal(captured.rawBlock, "- 08:00 first line\n  continuation");
	assert.equal(fixture.vault.readText(sourcePath), original);
	await fixture.service.remove({ observation: toHandle(observation) });
	await fixture.service.restore({
		targetLogicalDate: observation.logicalDate,
		rawBlock: captured.rawBlock,
		section: observation.section,
	});
	assert.equal(fixture.vault.readText(sourcePath), original);
	assert.doesNotMatch(fixture.vault.readText(sourcePath), /<!--|memoId|knomo-id/u);
});

interface FixtureOptions {
	catalogDegraded?: boolean;
	initialFiles?: Readonly<Record<string, string>>;
	insertPosition?: "top" | "bottom";
}

function createFixture(options: FixtureOptions = {}) {
	const vault = new MemoryVault(options.initialFiles ?? {
		"Daily/2026-08-22.md": "## Memos\n",
		"Daily/2026-08-23.md": "## Memos\n",
	});
	const app = {
		workspace: { getActiveViewOfType: () => null },
		vault,
	} as unknown as App;
	const parser = new DiaryMemoParser(async (bytes) => createHash("sha256").update(bytes).digest("hex"));
	const committedPartitions: MarkdownCatalogCommitInput[] = [];
	const refreshedPaths: string[][] = [];
	const service = new MarkdownMutationService(app, {
		getHeadings: () => HEADINGS,
		getDailyFileForDate: async (logicalDate) => vault.ensureFile(`Daily/${logicalDate}.md`, "## Memos\n"),
		getLogicalDateForPath: async (sourcePath) => sourcePath.match(/(\d{4}-\d{2}-\d{2})\.md$/u)?.[1]
			?? Promise.reject(new Error(`Not a Daily path: ${sourcePath}`)),
		getMemoTimeFormat: () => "HH:mm",
		getInsertPosition: () => options.insertPosition ?? "bottom",
		updateCatalogPartition: async (input) => {
			committedPartitions.push(input);
			if (options.catalogDegraded) throw new Error("Catalog storage is degraded.");
		},
		refreshCatalogPaths: async (paths) => { refreshedPaths.push([...paths]); },
		now: () => new Date(2026, 7, 22, 9, 0, 0),
		random: () => 0,
	}, new CatalogV2DailyWriteGateway(app, parser));

	const getPath = (logicalDate: string) => `Daily/${logicalDate}.md`;
	const parse = async (logicalDate: string): Promise<MemoObservation[]> => {
		const path = getPath(logicalDate);
		return (await parser.parse({
			sourcePath: path,
			logicalDate,
			headings: HEADINGS,
			bytes: Buffer.from(vault.readText(path), "utf8"),
		})).observations;
	};
	return {
		service,
		vault,
		committedPartitions,
		refreshedPaths,
		getPath,
		parse,
		getOnlyObservation: async (logicalDate: string) => {
			const observations = await parse(logicalDate);
			assert.equal(observations.length, 1);
			return observations[0] as MemoObservation;
		},
	};
}

function toHandle(observation: MemoObservation): ObservationHandle {
	return {
		sourcePath: observation.sourcePath,
		sourceRevision: observation.sourceRevision,
		startLine: observation.startLine,
		endLine: observation.endLine,
		rawBlockHash: observation.rawBlockHash,
	};
}

class MemoryVault {
	private readonly files = new Map<string, TFile>();
	private readonly contents = new Map<string, string>();
	private readonly failingProcessPaths = new Map<string, (() => void) | null>();

	constructor(initialFiles: Readonly<Record<string, string>>) {
		for (const [path, content] of Object.entries(initialFiles)) this.ensureFile(path, content);
	}

	getFiles(): TFile[] {
		return [...this.files.values()];
	}

	getAbstractFileByPath(path: string): TFile | null {
		return this.files.get(path) ?? null;
	}

	async cachedRead(file: TFile): Promise<string> {
		return this.readText(file.path);
	}

	async process(file: TFile, update: (content: string) => string): Promise<string> {
		if (this.failingProcessPaths.has(file.path)) {
			const onFailure = this.failingProcessPaths.get(file.path);
			this.failingProcessPaths.delete(file.path);
			onFailure?.();
			throw new Error(`process failed: ${file.path}`);
		}
		const next = update(this.readText(file.path));
		this.writeText(file.path, next);
		return next;
	}

	ensureFile(path: string, content: string): TFile {
		const existing = this.files.get(path);
		if (existing !== undefined) return existing;
		const file = Object.assign(new TFile(), {
			path,
			name: path.split("/").pop() ?? "",
			basename: (path.split("/").pop() ?? "").replace(/\.md$/u, ""),
			extension: "md",
			stat: { ctime: 1, mtime: 1, size: Buffer.byteLength(content) },
		});
		this.files.set(path, file);
		this.contents.set(path, content);
		return file;
	}

	readText(path: string): string {
		const content = this.contents.get(path);
		if (content === undefined) throw new Error(`Missing file: ${path}`);
		return content;
	}

	writeText(path: string, content: string): void {
		const file = this.files.get(path);
		if (file === undefined) throw new Error(`Missing file: ${path}`);
		this.contents.set(path, content);
		file.stat = { ...file.stat, mtime: file.stat.mtime + 1, size: Buffer.byteLength(content) };
	}

	failNextProcess(path: string, onFailure: (() => void) | null = null): void {
		this.failingProcessPaths.set(path, onFailure);
	}
}
