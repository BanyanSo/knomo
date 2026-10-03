import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { TFile } from "obsidian";
import type { App } from "obsidian";

import { DailyNoteService } from "../src/services/DailyNoteService";
import { DailyMemoWriteGateway } from "../src/services/DailyMemoWriteGateway";
import { DiaryMemoParser } from "../src/services/DiaryMemoParser";
import {
	MarkdownMutationService,
	MarkdownMutationStaleError,
	UnsafeDailyInsertError,
	type MarkdownCatalogCommitInput,
} from "../src/services/MarkdownMutationService";
import type { MemoObservation, ObservationHandle } from "../src/types/catalog";
import { MemoCommandService } from "../src/services/MemoCommandService";
import { MemoCatalogService } from "../src/services/MemoCatalogService";
import { InMemoryMemoCatalogStore } from "../src/services/MemoCatalogStore";
import { composerMarkdownFixtures } from "./fixtures/composerMarkdown";
import { formatServiceError } from "../src/utils/serviceText";

const HEADINGS = ["## Memos"] as const;

test("Composer Markdown fixtures preserve semantic source through Daily create, parse and edit", async () => {
	for (const content of [...composerMarkdownFixtures.map(f => f.text.replace(/\r\n/g, "\n")), "first  \nsecond\\\nthird"]) {
		const fixture = createFixture();
		await fixture.service.create({ content });
		const saved = await fixture.getOnlyObservation("2026-08-22");
		assert.equal(saved.content, content);
		await fixture.service.edit({ observation: toHandle(saved), content: content + "\nchanged" });
		assert.equal((await fixture.getOnlyObservation("2026-08-22")).content, content + "\nchanged");
	}
});

test("缺失日记先应用模板再追加 Memo，指定日期创建也保留模板", async () => {
	const fixture = createFixture({ template: "Templates/Daily", initialFiles: {
		"Templates/Daily.md": "---\ndate: {{date}}\n---\n# {{title}}\n\n## Memos\n\n## Review\nkeep\n",
	} });
	await fixture.service.create({ content: "first" });
	await fixture.service.create({ content: "second" });
	await fixture.service.create({ content: "third", targetLogicalDate: "2026-08-23" });
	for (const day of ["2026-08-22", "2026-08-23"]) {
		const text = fixture.vault.readText(fixture.getPath(day));
		assert.ok(text.startsWith(`---\ndate: ${day}\n---\n# ${day}\n`));
		assert.ok(text.endsWith("## Review\nkeep\n"));
		assert.equal(text.split("## Memos").length - 1, 1);
		assert.equal((await fixture.parse(day)).length, day === "2026-08-22" ? 2 : 1);
	}
});

test("正文 mutation 不依赖 bootstrap、identity 或本机 IDB", async (context) => {
	for (const scenario of [
		"no-bootstrap-identity-or-idb-dependencies",
		"catalog-idb-degraded",
	] as const) {
		await context.test(scenario, async () => {
			const fixture = createFixture({ catalogDegraded: scenario === "catalog-idb-degraded" });
			const created = await fixture.service.create({ content: "created\n- [ ] task" });
			assert.equal(created.status, "committed");
			assert.equal(created.catalogUpdatePending, scenario === "catalog-idb-degraded");

			const createdObservation = await fixture.getOnlyObservation("2026-08-22");
			const edited = await fixture.service.edit({
				observation: toHandle(createdObservation),
				content: "edited\n- [ ] task",
			});
			assert.equal(edited.status, "committed");

			const taskObservation = await fixture.getOnlyObservation("2026-08-22");
			const toggled = await fixture.service.toggleTask({
				observation: toHandle(taskObservation),
				taskIndex: 0,
				checked: true,
			});
			assert.equal(toggled.observation?.content, "edited\n- [x] task");

			assert.doesNotMatch(fixture.vault.readText(fixture.getPath("2026-08-22")), /<!--|memoId|knomo-id/u);
		});
	}
});

test("Things 混合代码、HTML 与引用任务只修改对应 marker，旧句柄拒绝写入", async () => {
	const fixture = createFixture();
	const content = "intro\n\n<!--\n- [ ] fake\n-->\n\n> - [ ] quoted\n\n```md\n- [ ] example\n```\n\n- [X] last";
	await fixture.service.create({ content });
	const observation = await fixture.getOnlyObservation("2026-08-22");
	assert.equal(observation.tasks.length, 2);
	const result = await fixture.service.toggleTask({ observation: toHandle(observation), taskIndex: 0, checked: true });
	assert.equal(result.observation?.content, content.replace("> - [ ] quoted", "> - [x] quoted"));
	await assert.rejects(fixture.service.toggleTask({ observation: toHandle(observation), taskIndex: 1, checked: false }));
});

test("任务修改保留其他任务、缩进、正文格式与代码围栏，越界索引拒绝写入", async () => {
	for (const [content, taskIndex, expected] of [
		["- [ ] first\n- [ ] second\n- [x] third", 1, "- [ ] first\n- [x] second\n- [x] third"],
		["intro\n  1) [ ] keep **format** #tag", 0, "intro\n  1) [x] keep **format** #tag"],
		["```markdown\n- [ ] code\n```\n- [ ] real", 0, "```markdown\n- [ ] code\n```\n- [x] real"],
	] as const) {
		const fixture = createFixture();
		await fixture.service.create({ content });
		const observation = await fixture.getOnlyObservation("2026-08-22");
		const result = await fixture.service.toggleTask({ observation: toHandle(observation), taskIndex, checked: true });
		assert.equal(result.observation?.content, expected);
		const current = await fixture.getOnlyObservation("2026-08-22");
		const before = fixture.vault.readText(fixture.getPath("2026-08-22"));
		await assert.rejects(fixture.service.toggleTask({ observation: toHandle(current), taskIndex: current.tasks.length, checked: true }));
		assert.equal(fixture.vault.readText(fixture.getPath("2026-08-22")), before);
	}
});

test("任务列表起始的 memo 按原始 Daily 行切换 checkbox，不失败也不跳行", async () => {
	const fixture = createFixture();
	await fixture.service.create({ content: "- [ ] first\n- [ ] second" });

	const firstObservation = await fixture.getOnlyObservation("2026-08-22");
	const firstResult = await fixture.service.toggleTask({
		observation: toHandle(firstObservation),
		taskIndex: 0,
		checked: true,
	});
	assert.equal(firstResult.observation?.content, "- [x] first\n- [ ] second");
	assert.equal(
		fixture.vault.readText(fixture.getPath("2026-08-22")),
		"## Memos\n- 09:00\n\t- [x] first\n\t- [ ] second\n",
	);

	const secondObservation = await fixture.getOnlyObservation("2026-08-22");
	const secondResult = await fixture.service.toggleTask({
		observation: toHandle(secondObservation),
		taskIndex: 1,
		checked: true,
	});
	assert.equal(secondResult.observation?.content, "- [x] first\n- [x] second");
	assert.equal(
		fixture.vault.readText(fixture.getPath("2026-08-22")),
		"## Memos\n- 09:00\n\t- [x] first\n\t- [x] second\n",
	);
});

test("Daily committed 回调先于 Catalog 更新完成", async () => {
	const catalogGate = createDeferred<void>();
	const catalogStarted = createDeferred<void>();
	const dailyCommitted = createDeferred<void>();
	const fixture = createFixture({
		updateCatalogPartition: async () => {
			catalogStarted.resolve(undefined);
			await catalogGate.promise;
		},
	});

	const saving = fixture.service.create({
		content: "created",
		onDailyCommitted: () => dailyCommitted.resolve(undefined),
	});
	await dailyCommitted.promise;

	assert.equal(fixture.vault.readText(fixture.getPath("2026-08-22")), "## Memos\n- 09:00 created\n");
	assert.equal(fixture.committedPartitions.length, 0);
	await catalogStarted.promise;
	assert.equal(fixture.committedPartitions.length, 1);
	catalogGate.resolve(undefined);
	assert.equal((await saving).catalogUpdatePending, false);
});

test("同一 Daily 的后续 Catalog 分区按提交顺序串行", async () => {
	const firstCatalogGate = createDeferred<void>();
	const firstCommitted = createDeferred<void>();
	const secondCommitted = createDeferred<void>();
	let catalogCalls = 0;
	const fixture = createFixture({
		updateCatalogPartition: async () => {
			catalogCalls += 1;
			if (catalogCalls === 1) await firstCatalogGate.promise;
		},
	});

	const first = fixture.service.create({
		content: "first",
		onDailyCommitted: () => firstCommitted.resolve(undefined),
	});
	await firstCommitted.promise;
	const second = fixture.service.create({
		content: "second",
		onDailyCommitted: () => secondCommitted.resolve(undefined),
	});
	await secondCommitted.promise;

	assert.equal(catalogCalls, 1);
	assert.equal(
		fixture.vault.readText(fixture.getPath("2026-08-22")),
		"## Memos\n- 09:00 first\n- 09:00 second\n",
	);
	firstCatalogGate.resolve(undefined);
	await Promise.all([first, second]);
	assert.equal(catalogCalls, 2);
	assert.equal(fixture.committedPartitions[0]?.parsed.observations.length, 1);
	assert.equal(fixture.committedPartitions[1]?.parsed.observations.length, 2);
});

test("同一分钟相同正文创建两条 observation，Daily 不含内部身份字符", async () => {
	const fixture = createFixture();

	await fixture.service.create({ content: "same" });
	await fixture.service.create({ content: "same" });

	const parsed = await fixture.parse("2026-08-22");
	assert.equal(parsed.length, 2);
	assert.equal(parsed[0]?.content, "same");
	assert.equal(parsed[1]?.content, "same");
	assert.notEqual(parsed[0]?.startLine, parsed[1]?.startLine);
	assert.equal(
		fixture.committedPartitions[1]?.insertedObservation?.startLine,
		parsed[1]?.startLine,
	);
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

test("stale ObservationHandle 拒绝写入并刷新 Catalog，不按旧行号猜测", async () => {
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

test("P8 同文旧句柄遇到前插、删除、换行、外部编辑和同步替换均 fail closed", async (context) => {
	const original = "## Memos\n- 08:00 same duplicate\n- 08:00 same duplicate\n";
	const revisions = {
		insert: original.replace("## Memos\n", "## Memos\n- 07:59 inserted\n"),
		delete: "## Memos\n- 08:00 same duplicate\n",
		lineEnding: original.replace(/\n/gu, "\r\n"),
		external: original.replace("same duplicate", "external changed"),
		sync: "## Memos\n- 08:00 replaced occurrence\n- 08:00 same duplicate\n",
	};
	for (const [name, content] of Object.entries(revisions)) {
		await context.test(name, async () => {
			const path = "Daily/2026-08-22.md";
			const fixture = createFixture({ initialFiles: { [path]: original } });
			const handles = (await fixture.parse("2026-08-22")).map(toHandle);
			fixture.vault.writeText(path, content);
			for (const observation of handles) {
				await assert.rejects(() => fixture.service.edit({ observation, content: "wrong target" }), MarkdownMutationStaleError);
				await assert.rejects(() => fixture.service.createBlockReference({ observation, sourcePath: "Notes/source.md" }), MarkdownMutationStaleError);
			}
			assert.equal(fixture.vault.readText(path), content);
		});
	}
});

test("显式 reference 只写用户请求的 block ID，重复请求复用已有引用", async () => {
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
	const repeated = await fixture.service.createBlockReference({ observation: toHandle(referenced.observation), sourcePath: "Notes/source.md" });
	assert.equal(repeated.blockId, referenced.blockId);
	assert.equal(fixture.vault.readText(fixture.getPath("2026-08-22")), "## Memos\n- 08:00 referenced ^aaaaaa\n");
});

test("切换新建时间格式不改写已有 Memo 的精度：编辑、任务、引用", async (context) => {
	for (const time of ["10:30", "10:30:00", "10:30:27"]) {
		await context.test(time, async () => {
			let format: "HH:mm" | "HH:mm:ss" = "HH:mm";
			const fixture = createFixture({
				initialFiles: { "Daily/2026-08-22.md": `## Memos\n- ${time} original\n` },
				getMemoTimeFormat: () => format,
			});
			format = "HH:mm:ss";
			const source = await fixture.getOnlyObservation("2026-08-22");
			await fixture.service.edit({ observation: source, content: "edited\n- [ ] task" });
			await fixture.service.toggleTask({ observation: await fixture.getOnlyObservation("2026-08-22"), taskIndex: 0, checked: true });
			await fixture.service.createBlockReference({ observation: await fixture.getOnlyObservation("2026-08-22"), sourcePath: "Notes/source.md" });
			assert.equal((await fixture.getOnlyObservation("2026-08-22")).time, time);
			await fixture.service.create({ content: "new" });
			assert.deepEqual((await fixture.parse("2026-08-22")).map(item => item.time), [time, "09:00:00"]);
		});
	}
});

test("末尾缩进空行属于原 memo，连续创建不转移正文或解析失败", async (context) => {
	for (const eol of ["\n", "\r\n"]) {
		for (const indent of ["\t", "    "]) {
			await context.test(JSON.stringify({ eol, indent }), async () => {
				const path = "Daily/2026-08-22.md";
				const initial = ["## Memos", "- 20:14:06 第一奥", indent, ""].join(eol);
				const fixture = createFixture({ initialFiles: { [path]: initial } });
				const original = await fixture.getOnlyObservation("2026-08-22");
				await fixture.service.create({ content: "second" });
				await fixture.service.create({ content: "third\n" });
				await fixture.service.create({ content: "fourth" });
				const parsed = await fixture.parse("2026-08-22");
				assert.deepEqual(parsed.map((item) => item.content), [original.content, "second", "third\n", "fourth"]);
				assert.equal(parsed[0]?.rawBlockHash, original.rawBlockHash);
				assert.ok(fixture.vault.readText(path).startsWith(initial));
			});
		}
	}
});

test("插入遵循 Parser 的 Memo 区间，内部标题和围栏不改变外层边界", async (context) => {
	for (const eol of ["\n", "\r\n"]) for (const indent of ["  ", "\t"]) {
		for (const insertPosition of ["top", "bottom"] as const) for (const activeEditor of [false, true]) {
			await context.test(JSON.stringify({ eol, indent, insertPosition, activeEditor }), async () => {
				const path = "Daily/2026-08-22.md";
				const initial = ["---", "title: Daily", "---", "## Memos", "- 08:00 ```js",
					indent + "code", indent + "```", indent + "## Fake", "- 08:01 second",
					indent + "## Other", "## Other", "```md", "# Example", "```", "- 08:02 outside", ""].join(eol);
				const fixture = createFixture({ initialFiles: { [path]: initial }, insertPosition, activeEditor });
				const before = await fixture.parse("2026-08-22");
				const result = await fixture.service.create({ content: "new" });
				const after = await fixture.parse("2026-08-22");
				assert.equal(result.observation?.section, "## Memos");
				assert.equal(after.length, before.length + 1);
				assert.deepEqual(after.filter(item => item.content !== "new").map(item => item.rawBlockHash), before.map(item => item.rawBlockHash));
				const expected = initial.replace(insertPosition === "top" ? "## Memos" + eol : "## Other" + eol + "```md",
					insertPosition === "top" ? "## Memos" + eol + "- 09:00 new" + eol : "- 09:00 new" + eol + "## Other" + eol + "```md");
				assert.equal(fixture.vault.readText(path), expected);
				assert.equal(fixture.committedPartitions.length, 1);
				assert.equal(fixture.writeCalls.editor, activeEditor ? 1 : 0);
				assert.equal(fixture.writeCalls.process, activeEditor ? 0 : 1);
			});
		}
	}
});

test("不安全插入及数量校验失败不提交 Daily 或后续状态", async (context) => {
	for (const activeEditor of [false, true]) for (const eol of ["\n", "\r\n"]) {
		for (const scenario of [
			{ initial: ["---", "title: unfinished"], content: "new", position: "top" },
			{ initial: ["## Memos", "```md", "unfinished"], content: "new", position: "bottom" },
			{ initial: ["```md", "unfinished"], content: "new", position: "top" },
			{ initial: ["## Memos"], content: " ^only-id", position: "bottom" },
		] as const) {
			await context.test(JSON.stringify({ activeEditor, eol, scenario }), async () => {
				const path = "Daily/2026-08-22.md";
				const initial = scenario.initial.join(eol) + eol;
				const fixture = createFixture({ initialFiles: { [path]: initial }, activeEditor, insertPosition: scenario.position });
				let committed = false;
				await assert.rejects(fixture.service.create({ content: scenario.content, onDailyCommitted: () => { committed = true; } }), (error: unknown) => {
					assert.ok(error instanceof UnsafeDailyInsertError);
					assert.equal(error.diagnostics.sourcePath, path);
					assert.equal(error.diagnostics.beforeCount, 0);
					assert.doesNotMatch(formatServiceError(error), /observation|only-id|unfinished/u);
					assert.match(formatServiceError(error), /Daily was not modified/u);
					if (scenario.content === " ^only-id") {
						assert.equal(error.diagnostics.afterCount, 0);
						assert.equal(error.diagnostics.reason, "Create must add exactly one parsed memo observation.");
					}
					return true;
				});
				assert.deepEqual(Buffer.from(fixture.vault.readText(path)), Buffer.from(initial));
				assert.equal(fixture.writeCalls.process, 0);
				assert.equal(fixture.writeCalls.editor, 0);
				assert.equal(committed, false);
				assert.deepEqual(fixture.committedPartitions, []);
				assert.deepEqual(fixture.refreshedPaths, []);
			});
		}
	}
});

test("未闭合外层围栏之前仍可安全顶部插入", async () => {
	const fixture = createFixture({ initialFiles: { "Daily/2026-08-22.md": "## Memos\n```md\nunfinished\n" }, insertPosition: "top" });
	await fixture.service.create({ content: "new" });
	assert.equal(fixture.vault.readText("Daily/2026-08-22.md"), "## Memos\n- 09:00 new\n```md\nunfinished\n");
});

test("Memo 内伪标题不能截断底部插入区域", async () => {
	for (const indent of ["  ", "\t"]) {
		const initial = `## Memos\n- 08:00 old\n${indent}## Other\n- 08:01 second\n## Other\ntext\n`;
		const fixture = createFixture({ initialFiles: { "Daily/2026-08-22.md": initial } });
		await fixture.service.create({ content: "new" });
		assert.equal(fixture.vault.readText("Daily/2026-08-22.md"), initial.replace("- 08:01 second\n", "- 08:01 second\n- 09:00 new\n"));
	}
});

test("结构失败时两阶段保存均拒绝，不报告部分提交", async () => {
	const fixture = createFixture({ initialFiles: { "Daily/2026-08-22.md": "## Memos\n```\n" } });
	const command = new MemoCommandService(fixture.app, new MemoCatalogService(new InMemoryMemoCatalogStore()), {
		refreshCatalogPaths: async () => { throw new Error("Must not refresh"); },
		refreshLocalCatalog: async () => { throw new Error("Must not refresh"); },
		rebuildLocalCatalog: async () => { throw new Error("Must not rebuild"); },
		getMemoTimeFormat: () => "HH:mm",
		now: () => new Date(2026, 7, 22, 9, 0),
	}, fixture.service);
	const operation = command.startCreate("new");
	await assert.rejects(operation.dailyCommitted, UnsafeDailyInsertError);
	await assert.rejects(operation.settled, UnsafeDailyInsertError);
	assert.deepEqual(fixture.writeCalls, { process: 0, editor: 0 });
	assert.deepEqual(fixture.committedPartitions, []);
});

test("无标题和新建标题仍使用 Parser 区间并保留 frontmatter", async () => {
	for (const heading of [null, "## New"]) for (const insertPosition of ["top", "bottom"] as const) {
		const initial = "---\ntitle: daily\n---\n- 08:00 old\n  ## New\n  ```\n## Other\ntext\n";
		const fixture = createFixture({ initialFiles: { "Daily/2026-08-22.md": initial }, heading, insertPosition });
		const created = await fixture.service.create({ content: "new" });
		assert.equal(created.observation?.section, heading);
		assert.ok(fixture.vault.readText("Daily/2026-08-22.md").startsWith("---\ntitle: daily\n---\n"));
		assert.equal((await fixture.parse("2026-08-22")).length, 2);
	}
});

test("新建目标变化通过真实命令链路拒绝保存，Composer 保留草稿且不更新 Catalog", async (context) => {
	const { KnomoView } = await import("../src/ui/KnomoView");
	for (const activeEditor of [false, true]) for (const stage of ["commit", "process"] as const) {
		if (activeEditor && stage === "process") continue;
		for (const change of ["rename", "outside-daily", "replacement", "configuration", "logical-date"] as const) {
			await context.test(JSON.stringify({ activeEditor, stage, change }), async () => {
				let changed = false;
				const changeTarget = (file: TFile) => {
					changed = true;
					if (change === "replacement") fixture.vault.replaceFile(file);
					if (change === "rename") fixture.vault.rename(file, "Daily/2026-08-24.md");
					if (change === "outside-daily") fixture.vault.rename(file, "Notes/2026-08-22.md");
				};
				const fixture = createFixture({
					activeEditor,
					initialFiles: {},
					beforeCommit: stage === "commit" ? changeTarget : undefined,
					beforeProcess: stage === "process" ? changeTarget : undefined,
					getLogicalDateForPath: () => {
						if (changed && change === "configuration") throw new Error("Daily configuration unavailable");
						return changed && change === "logical-date" ? "2026-08-23" : "2026-08-22";
					},
				});
				const catalog = new MemoCatalogService(new InMemoryMemoCatalogStore());
				await catalog.open();
				const command = new MemoCommandService(fixture.app, catalog, {
					refreshCatalogPaths: async () => undefined,
					refreshLocalCatalog: async () => { throw new Error("Must not refresh"); },
					rebuildLocalCatalog: async () => { throw new Error("Must not rebuild"); },
					getMemoTimeFormat: () => "HH:mm", now: () => new Date(2026, 7, 22, 9, 0),
				}, fixture.service);
				const errors: string[] = [];
				const input = { value: "unfinished memo", disabled: false, composer: {
					composing: false, setSaving: (_saving: boolean) => undefined,
					capture: () => ({ valid: () => true, sameSession: () => true }),
				} };
				const view = Object.assign(Object.create(KnomoView.prototype) as { saveInput: () => Promise<void> }, {
					getDailyNotesStatus: () => ({ enabled: true }), isComposerCreationAvailable: () => true,
					inputEl: input, isSaving: false, editingMemo: null,
					quoteReferenceText: null, quoteMarkdownText: null, currentLayout: "desktop",
					draftContent: input.value, composerOpen: true,
					closeTimeBuoyPicker: () => undefined, updateSendButtonState: () => undefined,
					syncRootState: () => undefined,
					updateStatus: (message: string, error: boolean) => { if (error) errors.push(message); },
					clearComposerContext: () => { throw new Error("Must retain context"); },
					memoCommandService: command,
				});
				await view.saveInput();
				assert.equal(changed, true);
				assert.equal(errors.length, 1);
				assert.equal(input.value, "unfinished memo");
				assert.equal(view.draftContent, input.value);
				assert.equal(view.composerOpen, true);
				assert.equal(view.isSaving, false);
				assert.deepEqual(fixture.committedPartitions, []);
				assert.deepEqual(fixture.cleanupCalls, []);
				assert.equal(fixture.writeCalls.editor, 0);
				for (const file of fixture.vault.getFiles()) assert.equal(fixture.vault.readText(file.path), "## Memos\n");
				assert.deepEqual(fixture.refreshedPaths, [["Daily/2026-08-22.md"]]);
			});
		}
	}
});

interface FixtureOptions {
	delayEditorDiskWrite?: boolean;
	beforeCommit?: (file: TFile) => void;
	beforeProcess?: (file: TFile) => void;
	getLogicalDateForPath?: (path: string) => string;
	heading?: string | null;
	activeEditor?: boolean;
	template?: string;
	catalogDegraded?: boolean;
	initialFiles?: Readonly<Record<string, string>>;
	insertPosition?: "top" | "bottom";
	getMemoTimeFormat?: () => "HH:mm" | "HH:mm:ss";
	updateCatalogPartition?: (input: MarkdownCatalogCommitInput) => Promise<void>;
}

function createFixture(options: FixtureOptions = {}) {
	const vault = new MemoryVault(options.initialFiles ?? {
		"Daily/2026-08-22.md": "## Memos\n",
		"Daily/2026-08-23.md": "## Memos\n",
	});
	const activePath = "Daily/2026-08-22.md";
	const writeCalls = { process: 0, editor: 0 };
	const process = vault.process.bind(vault);
	vault.process = async (file, update) => { writeCalls.process += 1; options.beforeProcess?.(file); return process(file, update); };
	let editorContent: string | null = null;
	const editor = {
		getValue: () => editorContent ?? vault.readText(activePath),
		offsetToPos: (offset: number) => ({ line: 0, ch: offset }),
		transaction: (input: { changes: Array<{ text: string }> }) => {
			writeCalls.editor += 1;
			if (options.delayEditorDiskWrite) editorContent = input.changes[0]!.text;
			else vault.writeText(activePath, input.changes[0]!.text);
		},
	};
	const app = {
		workspace: { getActiveViewOfType: () => options.activeEditor ? { file: vault.getAbstractFileByPath(activePath), editor } : null, containerEl: { win: { setTimeout } } },
		vault,
	} as unknown as App;
	const parser = new DiaryMemoParser(async (bytes) => createHash("sha256").update(bytes).digest("hex"));
	const gateway = new DailyMemoWriteGateway(app, parser);
	const commit = gateway.commit.bind(gateway);
	gateway.commit = (prepared) => { options.beforeCommit?.(prepared.file); return commit(prepared); };
	const committedPartitions: MarkdownCatalogCommitInput[] = [];
	const cleanupCalls: string[] = [];
	const refreshedPaths: string[][] = [];
	const service = new MarkdownMutationService(app, {
		getWriteHeading: () => options.heading === undefined ? HEADINGS[0] : options.heading,
		getDailyFileForDate: async (logicalDate) => options.template === undefined
			? vault.ensureFile(`Daily/${logicalDate}.md`, "## Memos\n")
			: new DailyNoteService(app).getOrCreateDailyNoteForDateWithConfig(new Date(`${logicalDate}T00:00:00`), {
				folder: "Daily", format: "YYYY-MM-DD", template: options.template,
			}),
		getLogicalDateForPath: options.getLogicalDateForPath ?? ((sourcePath) => {
			const date = sourcePath.match(/^Daily\/(\d{4}-\d{2}-\d{2})\.md$/u)?.[1];
			if (!date) throw new Error(`Not a Daily path: ${sourcePath}`);
			return date;
		}),
		getMemoTimeFormat: options.getMemoTimeFormat ?? (() => "HH:mm"),
		getInsertPosition: () => options.insertPosition ?? "bottom",
		updateCatalogPartition: async (input) => {
			committedPartitions.push(input);
			await options.updateCatalogPartition?.(input);
			if (options.catalogDegraded) throw new Error("Catalog storage is degraded.");
		},
		refreshCatalogPaths: async (paths) => { refreshedPaths.push([...paths]); },
		removeEmptyCreatedDailyFile: async (file) => { cleanupCalls.push(file.path); },
		now: () => new Date(2026, 7, 22, 9, 0, 0),
		random: () => 0,
	}, gateway);

	const getPath = (logicalDate: string) => `Daily/${logicalDate}.md`;
	const parse = async (logicalDate: string): Promise<MemoObservation[]> => {
		const path = getPath(logicalDate);
		return (await parser.parse({
			sourcePath: path,
			logicalDate,
			bytes: Buffer.from(vault.readText(path), "utf8"),
		})).observations;
	};
	return {
		cleanupCalls,
		writeCalls,
		app,
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

	constructor(initialFiles: Readonly<Record<string, string>>) {
		for (const [path, content] of Object.entries(initialFiles)) this.ensureFile(path, content);
	}

	getFiles(): TFile[] {
		return [...this.files.values()];
	}

	rename(file: TFile, path: string): void {
		const content = this.readText(file.path);
		this.contents.delete(file.path);
		this.files.delete(file.path);
		file.path = path;
		this.files.set(path, file);
		this.contents.set(path, content);
	}

	replaceFile(file: TFile): void {
		const content = this.readText(file.path);
		this.files.delete(file.path);
		this.ensureFile(file.path, content);
	}

	getAbstractFileByPath(path: string): TFile | null {
		return this.files.get(path) ?? null;
	}

	async createFolder(): Promise<void> {}

	async create(path: string, content: string): Promise<TFile> {
		if (this.files.has(path)) throw new Error("Already exists");
		return this.ensureFile(path, content);
	}

	async read(file: TFile): Promise<string> {
		return this.readText(file.path);
	}

	async cachedRead(file: TFile): Promise<string> {
		return this.readText(file.path);
	}

	async process(file: TFile, update: (content: string) => string): Promise<string> {
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

}

function createDeferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
	let resolvePromise: (value: T) => void = () => undefined;
	const promise = new Promise<T>((resolve) => {
		resolvePromise = resolve;
	});
	return { promise, resolve: resolvePromise };
}

test("image source is checked against the actual Daily at prepare and commit without changing body on failure", async () => {
	for (const activeEditor of [false, true]) for (const edit of [false, true]) {
		const fixture = createFixture({ activeEditor });
		await fixture.service.create({ content: "original" });
		const observation = await fixture.getOnlyObservation("2026-08-22");
		const original = fixture.vault.readText(observation.sourcePath);
		let checks = 0;
		const validateImageSource = (path: string) => {
			assert.equal(path, observation.sourcePath);
			if (++checks === 2) throw new Error("attachment changed while preparing Daily");
		};
		const saving = edit
			? fixture.service.edit({ observation: toHandle(observation), content: "![[image.png]]", validateImageSource })
			: fixture.service.create({ content: "![[image.png]]", validateImageSource });
		await assert.rejects(saving, /attachment changed/);
		assert.equal(checks, 2);
		assert.equal(fixture.vault.readText(observation.sourcePath), original);
	}
});

test("MemoCommand passes image validation to the actual creation date and preserves original edit handle", async () => {
	const fixture = createFixture();
	const store = new InMemoryMemoCatalogStore();
	const catalog = new MemoCatalogService(store);
	await catalog.open();
	const command = new MemoCommandService(fixture.app, catalog, {
		refreshCatalogPaths: async () => undefined,
		refreshLocalCatalog: async () => { throw new Error("Must not refresh"); },
		rebuildLocalCatalog: async () => { throw new Error("Must not rebuild"); },
		getMemoTimeFormat: () => "HH:mm", now: () => new Date(2026, 7, 23, 0, 0),
	}, fixture.service);
	const seen: string[] = [];
	const operation = command.startCreate("![[image.png]]", path => { seen.push(path); throw new Error("bad image source"); });
	await assert.rejects(operation.dailyCommitted, /bad image source/);
	await assert.rejects(operation.settled, /bad image source/);
	assert.deepEqual(seen, ["Daily/2026-08-23.md"]);
	assert.equal((await fixture.parse("2026-08-23")).length, 0);
	await fixture.service.create({ content: "original" });
	const observation = await fixture.getOnlyObservation("2026-08-22");
	const handle = toHandle(observation);
	const editing = command.startEdit({ observationHandle: handle } as import("../src/types/catalogView").CatalogMemoItem, "changed", path => {
		assert.equal(path, handle.sourcePath);
		throw new Error("invalid image in edit");
	});
	await assert.rejects(editing.dailyCommitted, /invalid image in edit/);
	await assert.rejects(editing.settled, /invalid image in edit/);
	assert.equal((await fixture.getOnlyObservation("2026-08-22")).content, "original");
});


test("编辑器事务仅更新内存或磁盘读取失败时，不授权清理持久草稿", async () => {
	for (const readFailure of [false, true]) {
		const fixture = createFixture({ activeEditor: true, delayEditorDiskWrite: true });
		if (readFailure) fixture.vault.read = async () => { throw new Error("disk unavailable"); };
		const confirmations: Array<boolean | undefined> = [];
		const result = await fixture.service.create({ content: "submitted once", onDailyCommitted: confirmed => confirmations.push(confirmed) });
		assert.equal(result.status, "committed");
		assert.deepEqual(confirmations, [false]);
		assert.equal(fixture.vault.readText("Daily/2026-08-22.md"), "## Memos\n");
		assert.equal(fixture.writeCalls.editor, 1);
		assert.equal(fixture.writeCalls.process, 0);
	}
});

test("已读回编辑器落盘内容或 Vault.process 成功才确认草稿可清理", async () => {
	for (const activeEditor of [false, true]) {
		const fixture = createFixture({ activeEditor });
		const confirmations: Array<boolean | undefined> = [];
		await fixture.service.create({ content: "durable", onDailyCommitted: confirmed => confirmations.push(confirmed) });
		assert.deepEqual(confirmations, [true]);
		assert.match(fixture.vault.readText("Daily/2026-08-22.md"), /durable/);
	}
});
