import { TFolder } from "obsidian";
import { t } from "../i18n";
import type { App } from "obsidian";
import type { LegacyIndexSource } from "../types/legacyIndex";
import type { LegacyMigrationReport } from "../types/legacyMigration";
import type { TrashSnapshot } from "../types/trash";
import { PluginDataStore } from "./PluginDataStore";
import { buildPluginDataWithLegacyMigration, extractLegacyMigration, type LegacyMigrationCompletion } from "../utils/pluginData";
import { assertVaultPath, TrashSnapshotStore } from "./TrashSnapshotStore";

interface Options {
	pluginDataStore: PluginDataStore;
	// 当前 Trash 恢复数据根：用于写入副本、取消旧任务及清理路径保护。
	getDataRoot: () => string;
	// SettingsService 沿用正式插件设置 reader，保存并校验当前值后才允许完成。
	migrateSettings: () => Promise<void>;
	signal?: AbortSignal;
	yieldControl?: () => Promise<void>;
	runExclusive?: <T>(action: () => Promise<T>) => Promise<T>;
	onReportChanged?: () => Promise<void>;
}

export class LegacyTrashMigrationService {
	private report: LegacyMigrationReport = emptyReport();
	private queue: Promise<unknown> = Promise.resolve();
	constructor(private readonly app: App, private readonly source: LegacyIndexSource, private readonly options: Options) {}
	getReport(): LegacyMigrationReport { return structuredClone(this.report); }
	async waitForIdle(): Promise<void> { await this.queue; }
	// 普通启动只检查完成事实；缺失 completion 必须由迁移按钮显式重试。
	run(options: { explicit?: boolean } = {}): Promise<LegacyMigrationReport> {
		const operation = this.queue.then(() => options.explicit === true && this.options.runExclusive
			? this.options.runExclusive(() => this.runOnce(true)) : this.runOnce(options.explicit === true));
		this.queue = operation.catch(() => undefined);
		return operation.then(async (report) => {
			try { await this.options.onReportChanged?.(); }
			catch { /* 提示失败不改变已校验的迁移结果。 */ }
			return report;
		});
	}
	private async runOnce(explicit: boolean): Promise<LegacyMigrationReport> {
		try {
			const root = this.options.getDataRoot();
			const assertActive = () => {
				if (this.options.signal?.aborted || root !== this.options.getDataRoot()) throw new Error("Migration cancelled or data root changed.");
			};
			assertActive();
			let completion = extractLegacyMigration(await this.options.pluginDataStore.read());
			assertActive();
			if (completion !== null) return this.report = await this.cleanup(completion, assertActive);
			if (this.source.inspect().kind === "missing") return this.report = { ...emptyReport(), status: "not_applicable" };
			if (!explicit) return this.report = { ...emptyReport(), status: "attention", diagnostics: [{ code: "legacy_migration_explicit_retry", sourcePath: null, memoId: null, detail: t("migration.explicitRetry") }] };
			const loaded = await this.source.load({ cancellationSignal: this.options.signal, yieldControl: this.options.yieldControl });
			assertActive();
			if (loaded.kind === "missing") return this.report = { ...emptyReport(), status: "not_applicable" };
			if (loaded.kind === "attention") return this.report = { ...emptyReport(), status: "attention", diagnostics: loaded.diagnostics };
			const snapshot = loaded.snapshot;
			if (snapshot.diagnostics.length) return this.report = { ...emptyReport(), status: "attention", diagnostics: snapshot.diagnostics };
			const store = new TrashSnapshotStore(this.app, `${root}/trash`);
			for (const memo of snapshot.memos) {
				assertActive();
				if (memo.status !== "deleted") continue;
				if (memo.deletedPayload === null) throw new Error(`Legacy Trash payload missing: ${memo.memoId}`);
				const payload = memo.deletedPayload;
				const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify([snapshot.sourceId, memo.memoId])));
				const snapshotId = `legacy_${Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
				const target: TrashSnapshot = { snapshotId, deletedAt: payload.deletedAt, sourcePath: payload.sourcePath,
					logicalDate: payload.logicalDate, section: payload.section, rawBlock: payload.rawBlock };
				assertActive();
				if (await this.app.vault.adapter.exists(`${root}/trash/${snapshotId}.json`)) await store.assertUnchanged(target);
				else await store.save(target);
				assertActive();
				await this.options.yieldControl?.();
			}
			await this.options.migrateSettings();
			assertActive();
			// 迁移期间旧源若同步变化，不能把未读取的新数据标为完成。
			const latest = await this.source.load({ cancellationSignal: this.options.signal, yieldControl: this.options.yieldControl });
			assertActive();
			if (latest.kind !== "ready" || latest.snapshot.sourceId !== snapshot.sourceId
				|| latest.snapshot.sourceRevision !== snapshot.sourceRevision || latest.snapshot.diagnostics.length) throw new Error("Legacy source changed during migration; retry explicitly.");
			completion = { completed: true, legacySystemRoot: snapshot.legacySystemRoot, sourceRevision: snapshot.sourceRevision };
			await this.persistCompletion(completion);
			return this.report = await this.cleanup(completion, assertActive);
		} catch (error) {
			return this.report = { ...emptyReport(), status: "unavailable", diagnostics: [{ code: "legacy_trash_migration_failed", sourcePath: null, memoId: null, detail: String(error) }] };
		}
	}
	private async persistCompletion(completion: LegacyMigrationCompletion): Promise<void> {
		assertLegacySystemRoot(completion.legacySystemRoot);
		await this.options.pluginDataStore.mutate((savedData) => ({
			nextData: buildPluginDataWithLegacyMigration(savedData, completion), result: undefined,
		}));
	}

	private async cleanup(completion: LegacyMigrationCompletion, assertActive: () => void): Promise<LegacyMigrationReport> {
		const report: LegacyMigrationReport = { ...emptyReport(), status: "ready", sourceRevision: completion.sourceRevision };
		try {
			assertActive();
			const path = completion.legacySystemRoot;
			assertLegacySystemRoot(path);
			// 恢复副本或配置目录不得与待删除目录重叠。
			for (const protectedPath of [this.options.getDataRoot(), this.app.vault.configDir]) {
				if (protectedPath === path || protectedPath.startsWith(`${path}/`) || path.startsWith(`${protectedPath}/`)) throw new Error("Unsafe legacy cleanup overlap.");
			}
			const folder = this.app.vault.getAbstractFileByPath(path);
			if (folder === null && !await this.app.vault.adapter.exists(path)) return report;
			if (!(folder instanceof TFolder)) throw new Error("Legacy cleanup target is not an available folder.");
			assertActive();
			await this.app.vault.delete(folder, true);
			if (await this.app.vault.adapter.exists(path)) throw new Error("Legacy cleanup not confirmed.");
		} catch (error) {
			report.status = "attention";
			report.diagnostics = [{ code: "legacy_cleanup_failed", sourcePath: completion.legacySystemRoot, memoId: null, detail: String(error) }];
			report.cleanupCandidate = { legacySystemRoot: completion.legacySystemRoot, sourceRevision: completion.sourceRevision };
		}
		return report;
	}

}

function emptyReport(): LegacyMigrationReport {
	return { status: "idle", sourceRevision: null, diagnostics: [], cleanupCandidate: null };
}

function assertLegacySystemRoot(path: string): void {
	assertVaultPath(path);
	if (!path.endsWith("/_knomo-system") || path.split("/").slice(0, -1).some((part) => part.startsWith(".") || part === "_knomo-system")) throw new Error("Invalid legacy system root.");
}
