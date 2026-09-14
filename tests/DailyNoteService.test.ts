import assert from "node:assert/strict";
import test from "node:test";
import type { App } from "obsidian";
import { ensureObsidianStub } from "./helpers/obsidianStub";

async function fixture() {
	await ensureObsidianStub();
	const { TFile } = await import("obsidian");
	const { DailyNoteService } = await import("../src/services/DailyNoteService");
	const files = new Map<string, InstanceType<typeof TFile>>();
	const contents = new Map<string, string>();
	const put = (path: string, text: string) => {
		const file = Object.assign(new TFile(), { path, basename: path.split("/").pop()!.replace(/\.md$/, ""), extension: "md" });
		files.set(path, file);
		contents.set(path, text);
		return file;
	};
	const vault = {
		getAbstractFileByPath: (path: string) => files.get(path) ?? null,
		createFolder: async () => undefined,
		read: async (file: InstanceType<typeof TFile>) => contents.get(file.path)!,
		create: async (path: string, text: string) => {
			if (files.has(path)) throw new Error("Already exists");
			return put(path, text);
		},
	};
	const config = { folder: "Daily", format: "YYYY-MM-DD", template: "Templates/Daily" };
	const service = new DailyNoteService({ vault } as unknown as App, {
		getConfig: () => config, loadConfig: async () => config,
	});
	return { service, vault, put, contents, config };
}

test("实际配置入口创建日记时应用模板，已有文件不重复套用", async () => {
	const f = await fixture();
	f.put("Templates/Daily.md", "---\ndate: {{date}}\n---\n# {{title}}\n{{date:YYYY/MM/DD}}\n## Memos\n\n## Review\n");
	const date = new Date(2026, 4, 14);
	const file = await f.service.getOrCreateDailyNoteForDateWithConfig(date, f.config);
	assert.equal(f.contents.get(file.path), "---\ndate: 2026-05-14\n---\n# 2026-05-14\n2026/05/14\n## Memos\n\n## Review\n");
	f.contents.set(file.path, "existing memo");
	assert.equal(await f.service.getOrCreateDailyNoteForDate(date), file);
	assert.equal(f.contents.get(file.path), "existing memo");
});

test("模板缺失或读取失败不创建空日记；未配置模板仍可创建", async () => {
	const f = await fixture();
	const date = new Date(2026, 4, 14);
	await assert.rejects(f.service.getOrCreateDailyNoteForDateWithConfig(date, f.config), /template/i);
	assert.equal(f.contents.has("Daily/2026-05-14.md"), false);
	f.put("Templates/Daily.md", "template");
	f.vault.read = async () => { throw new Error("Template I/O failed"); };
	await assert.rejects(f.service.getOrCreateDailyNoteForDate(date), /Template I\/O failed/);
	assert.equal(f.contents.has("Daily/2026-05-14.md"), false);
	const file = await f.service.getOrCreateDailyNoteForDateWithConfig(date, { folder: "Daily", format: "YYYY-MM-DD" });
	assert.equal(f.contents.get(file.path), "");
});

test("读取模板期间并发创建的日记不被覆盖", async () => {
	const f = await fixture();
	f.put("Templates/Daily.md", "template");
	f.vault.read = async () => {
		f.put("Daily/2026-05-14.md", "concurrent memo");
		return "template";
	};
	const file = await f.service.getOrCreateDailyNoteForDateWithConfig(new Date(2026, 4, 14), f.config);
	assert.equal(f.contents.get(file.path), "concurrent memo");
});

test("核心日记配置从运行时和配置文件保留模板路径", async () => {
	await ensureObsidianStub();
	const { DailyNotesProvider } = await import("../src/services/DailyNotesProvider");
	for (const runtime of [true, false]) {
		const options = { folder: "Daily", template: " Templates\\Daily.md " };
		const provider = new DailyNotesProvider({
			internalPlugins: { getPluginById: () => runtime ? { enabled: true, instance: { options } } : undefined },
			vault: { configDir: ".obsidian", adapter: { read: async () => JSON.stringify(options) } },
		} as unknown as App);
		assert.equal((await provider.loadConfig() as { template?: string })?.template, "Templates/Daily.md");
	}
});

test("模板标题使用文件名，自定义日期时间格式正确，未知语法保持原文", async () => {
	const f = await fixture();
	f.put("Templates/Daily.md", "{{title}}|{{date:YYYY/MM/DD}}|{{time}}|{{time:HH:mm:ss}}|{{unknown}}|<% custom %>");
	const before = new Date();
	const file = await f.service.getOrCreateDailyNoteForDateWithConfig(new Date(2026, 4, 14), {
		...f.config, format: "YYYY/MM/DD",
	});
	const after = new Date();
	const text = f.contents.get(file.path)!;
	assert.match(text, /^14\|2026\/05\/14\|\d{2}:\d{2}\|\d{2}:\d{2}:\d{2}\|{{unknown}}\|<% custom %>$/);
	const time = text.split("|")[3];
	const formatTime = (date: Date) => [date.getHours(), date.getMinutes(), date.getSeconds()].map(value => String(value).padStart(2, "0")).join(":");
	assert.ok(time === formatTime(before) || time === formatTime(after));
});
