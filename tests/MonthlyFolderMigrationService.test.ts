import assert from "node:assert/strict";
import test from "node:test";
import type { Plugin, TFile } from "obsidian";
import { ensureObsidianStub } from "./helpers/obsidianStub";

const OLD = "Old/knomo-trash.json";
const NEW = "New/knomo-trash.json";
const item = (snapshotId = "s1") => ({ snapshotId, deletedAt: "2026-09-09T12:00:00Z", sourcePath: "Daily/2026-09-09.md",
	logicalDate: "2026-09-09", section: null, rawBlock: "- 12:34 same" });
const collection = (items = [item()]) => JSON.stringify({ kind: "knomo-trash", items });

async function fixture(files: Record<string, string> = { [OLD]: collection() }) {
	await ensureObsidianStub();
	const { InMemoryVault } = await import("./helpers/InMemoryVault");
	const { SettingsService, DEFAULT_KNOMO_SETTINGS } = await import("../src/services/SettingsService");
	const { PluginDataStore } = await import("../src/services/PluginDataStore");
	const vault = new InMemoryVault(files);
	Object.assign(vault.app, { fileManager: { trashFile: async (file: TFile) => vault.remove(file.path) } });
	let data: unknown = { settings: { ...DEFAULT_KNOMO_SETTINGS, monthlyMemoFolder: "Old", excludeMonthlyMemosFromObsidian: false } };
	let failSave = false;
	let active = true;
	const plugin = { app: vault.app, loadData: async () => structuredClone(data), saveData: async (next: unknown) => {
		if (failSave) throw new Error("settings save failed"); data = structuredClone(next);
	} } as unknown as Plugin;
	const service = new SettingsService(plugin, new PluginDataStore(plugin), {
		runExclusive: (action) => action(), assertActive: () => { if (!active) throw new Error("cancelled"); },
	});
	await service.loadSettings();
	return { service, plugin, vault, failSave: () => { failSave = true; }, cancel: () => { active = false; },
		setFolderData: (folder: string) => { data = { settings: { ...DEFAULT_KNOMO_SETTINGS, monthlyMemoFolder: folder, excludeMonthlyMemosFromObsidian: false } }; },
		externalSettings: () => { data = { settings: { ...DEFAULT_KNOMO_SETTINGS, monthlyMemoFolder: "External" } }; },
		data: () => data };
}

test("Monthly 切换复制/合并完整集合，保存设置后才清理旧文件，不读取开发目录或 marker", async () => {
	const marker = "Old/_knomo-data/legacy-index-completion.json";
	const development = "Old/_knomo-data/trash/s1.json";
	const f = await fixture({ [OLD]: collection(), [NEW]: collection([item("s2")]), [marker]: "ignored", [development]: "ignored", "Old/Memos.md": "monthly", "Daily.md": "daily" });
	const read = f.vault.app.vault.read.bind(f.vault.app.vault);
	f.vault.app.vault.read = async (file) => { assert.notEqual(file.path, marker); assert.notEqual(file.path, development); return read(file); };
	const remove = f.vault.app.fileManager.trashFile;
	f.vault.app.fileManager.trashFile = async (file) => {
		assert.equal(f.service.getSettings().monthlyMemoFolder, "New");
		assert.equal((f.data() as { settings: { monthlyMemoFolder: string } }).settings.monthlyMemoFolder, "New");
		return remove(file);
	};
	assert.equal((await f.service.migrateMonthlyMemoFolder("New")).trashError, undefined);
	assert.deepEqual(JSON.parse(f.vault.read(NEW)!).items.map((i: { snapshotId: string }) => i.snapshotId).sort(), ["s1", "s2"]);
	assert.equal(f.vault.read(OLD), null);
	assert.equal(f.vault.read(marker), "ignored");
	assert.equal(f.vault.read(development), "ignored");
	assert.equal(f.vault.read("Old/Memos.md"), "monthly");
	assert.equal(f.vault.read("Daily.md"), "daily");
});

test("目标不存在时创建，已有同 ID 同内容仅保留一份，无源不预建 Trash", async () => {
	for (const files of [{ [OLD]: collection() }, { [OLD]: collection(), [NEW]: collection() }, {}] as Record<string, string>[]) {
		const f = await fixture(files);
		assert.equal((await f.service.migrateMonthlyMemoFolder("New")).trashError, undefined);
		assert.equal(f.vault.read(OLD), null);
		assert.equal(f.vault.read(NEW), Object.keys(files).length ? collection() : null);
	}
});

test("损坏、非 Knomo 文件和 ID 冲突保留文件，合法新设置仍生效并报告搬迁失败", async (context) => {
	for (const [name, files] of Object.entries({ source: { [OLD]: "broken" }, target: { [OLD]: collection(), [NEW]: "broken" },
		ownership: { [OLD]: collection(), [NEW]: '{"kind":"other","items":[]}' },
		conflict: { [OLD]: collection(), [NEW]: collection([{ ...item(), rawBlock: "different" }]) } })) {
		await context.test(name, async () => {
			const f = await fixture(files as Record<string, string>);
			const result = await f.service.migrateMonthlyMemoFolder("New");
			assert.ok(result.trashError);
			assert.equal(f.service.getSettings().monthlyMemoFolder, "New");
			for (const [path, text] of Object.entries(files)) assert.equal(f.vault.read(path), text);
		});
	}
});

test("目标写后抛错、验证失败、源变化、旧文件清理失败保留旧数据且不回滚设置", async (context) => {
	for (const failure of ["write-after", "verify", "source-change", "cleanup", "target-late"] as const) {
		await context.test(failure, async () => {
			const f = await fixture();
			const create = f.vault.app.vault.create.bind(f.vault.app.vault);
			f.vault.app.vault.create = async (path, text) => {
				const result = await create(path, text);
				if (path === NEW) {
					if (failure === "write-after") throw new Error("uncertain");
					if (failure === "source-change") f.vault.replace(OLD, collection([item("external")]));
				}
				return result;
			};
			const read = f.vault.app.vault.read.bind(f.vault.app.vault);
			f.vault.app.vault.read = async (file) => { if (file.path === NEW && failure === "verify") throw new Error("read failed"); return read(file); };
			if (failure === "cleanup") f.vault.app.fileManager.trashFile = async () => { throw new Error("cleanup failed"); };
			const save = f.plugin.saveData.bind(f.plugin);
			f.plugin.saveData = async (data) => { await save(data); if (failure === "target-late") f.vault.replace(NEW, collection([])); };
			assert.ok((await f.service.migrateMonthlyMemoFolder("New")).trashError);
			assert.equal(f.service.getSettings().monthlyMemoFolder, "New");
			assert.notEqual(f.vault.read(OLD), null);
		});
	}
});

test("设置保存失败、外部配置改变或卸载不清理旧文件；已复制目标不回滚", async (context) => {
	for (const failure of ["save", "external", "cancel"] as const) {
		await context.test(failure, async () => {
			const f = await fixture();
			const create = f.vault.app.vault.create.bind(f.vault.app.vault);
			f.vault.app.vault.create = async (path, text) => {
				const result = await create(path, text);
				if (path === NEW) { if (failure === "save") f.failSave(); else if (failure === "external") f.externalSettings(); else f.cancel(); }
				return result;
			};
			await assert.rejects(f.service.migrateMonthlyMemoFolder("New"));
			assert.equal(f.vault.read(OLD), collection());
			assert.equal(f.vault.read(NEW), collection());
		});
	}
});

test("Monthly 实际搬迁保留同一会话 Restore cleanupOnly，重试不会再次追加", async () => {
	const f = await fixture({ [OLD]: collection(), "Daily/2026-09-09.md": "" });
	Object.assign(f.vault.app, { workspace: { getActiveViewOfType: () => null, containerEl: { win: { setTimeout } } } });
	const { TrashSnapshotStore } = await import("../src/services/TrashSnapshotStore");
	const { IndependentTrashService } = await import("../src/services/IndependentTrashService");
	const store = new TrashSnapshotStore(f.vault.app, () => f.service.getSettings().monthlyMemoFolder);
	const trash = new IndependentTrashService(f.vault.app, store, {
		getLogicalDateForPath: async () => "2026-09-09",
		getOriginalDailyFile: async () => f.vault.app.vault.getAbstractFileByPath("Daily/2026-09-09.md") as TFile,
		getDailyFileForDate: async () => { throw new Error("unexpected target"); },
		updateCatalogPartition: async () => undefined, refreshCatalogPaths: async () => undefined,
	});
	const process = f.vault.app.vault.process.bind(f.vault.app.vault);
	f.vault.app.vault.process = async (file, update) => { if (file.path === OLD) throw new Error("cleanup failed"); return process(file, update); };
	assert.equal((await trash.restore("s1")).state, "restored_cleanup_pending");
	f.vault.app.vault.process = process;
	const restored = f.vault.read("Daily/2026-09-09.md");
	assert.equal((await f.service.migrateMonthlyMemoFolder("New")).trashError, undefined);
	assert.equal((await trash.restore("s1")).state, "restored");
	assert.equal(f.vault.read("Daily/2026-09-09.md"), restored);
	assert.equal((await store.query()).items.length, 0);
});

test("公开设置保存和 patch 入口也搬迁 Trash，外部读取只切换位置不搬迁", async () => {
	for (const action of ["save", "patch", "external"] as const) {
		const f = await fixture();
		if (action === "save") await f.service.saveSettings({ ...f.service.getSettings(), monthlyMemoFolder: "New" });
		else if (action === "patch") await f.service.updateSettings({ monthlyMemoFolder: "New", dailyHeading: "## Updated" });
		else { f.externalSettings(); await f.service.loadSettings(); }
		assert.equal(f.vault.read(OLD), action === "external" ? collection() : null);
		assert.equal(f.vault.read(NEW), action === "external" ? null : collection());
		if (action === "patch") assert.equal(f.service.getSettings().dailyHeading, "## Updated");
	}
});

test("目标目录占位、源不可读及源在设置保存期间变化均保留旧源并报告", async (context) => {
	for (const failure of ["directory", "source-read", "source-late", "save-after", "verify-settings"] as const) {
		await context.test(failure, async () => {
			const f = await fixture();
			if (failure === "directory") await f.vault.app.vault.createFolder(NEW);
			const read = f.vault.app.vault.read.bind(f.vault.app.vault);
			if (failure === "source-read") f.vault.app.vault.read = async (file) => { if (file.path === OLD) throw new Error("source unavailable"); return read(file); };
			const save = f.plugin.saveData.bind(f.plugin);
			f.plugin.saveData = async (data) => {
				await save(data);
				if (failure === "source-late") f.vault.replace(OLD, collection([item("late")]));
				if (failure === "save-after") throw new Error("settings uncertain");
				if (failure === "verify-settings") f.plugin.loadData = async () => { throw new Error("settings unreadable"); };
			};
			if (failure === "save-after" || failure === "verify-settings") await assert.rejects(f.service.migrateMonthlyMemoFolder("New"));
			else { assert.ok((await f.service.migrateMonthlyMemoFolder("New")).trashError); assert.equal(f.service.getSettings().monthlyMemoFolder, "New"); }
			assert.notEqual(f.vault.read(OLD), null);
		});
	}
});

test("异常旧位置不阻止切换合法设置，配置目录下的源文件绝不清理", async () => {
	for (const folder of ["../Invalid", ".obsidian/plugins/knomo"]) {
		const f = await fixture({ ".obsidian/plugins/knomo/knomo-trash.json": collection() });
		f.setFolderData(folder);
		await f.service.loadSettings();
		assert.ok((await f.service.migrateMonthlyMemoFolder("New")).trashError);
		assert.equal(f.service.getSettings().monthlyMemoFolder, "New");
		assert.equal(f.vault.read(".obsidian/plugins/knomo/knomo-trash.json"), collection());
	}
});

test("源配置在复制期间变更或并发请求排队后变更，不继续旧路径操作", async () => {
	const f = await fixture();
	const create = f.vault.app.vault.create.bind(f.vault.app.vault);
	f.vault.app.vault.create = async (path, text) => {
		const result = await create(path, text);
		if (path === NEW) { f.externalSettings(); await f.service.loadSettings(); }
		return result;
	};
	await assert.rejects(f.service.migrateMonthlyMemoFolder("New"), /changed/u);
	assert.equal(f.service.getSettings().monthlyMemoFolder, "External");
	assert.equal(f.vault.read(OLD), collection());
	const g = await fixture();
	const results = await Promise.allSettled([g.service.migrateMonthlyMemoFolder("New"), g.service.migrateMonthlyMemoFolder("Third")]);
	assert.equal(results[0]!.status, "fulfilled");
	assert.equal(results[1]!.status, "rejected");
	assert.equal(g.service.getSettings().monthlyMemoFolder, "New");
	assert.equal(g.vault.read("Third/knomo-trash.json"), null);
});
