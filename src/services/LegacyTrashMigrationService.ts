import { TFile, TFolder, Vault } from "obsidian";
import type { App } from "obsidian";
import type { LegacyIndexSource } from "../types/legacyIndex";
import type { LegacyMigrationReport } from "../types/legacyMigration";
import type { TrashSnapshot } from "../types/trash";
import { PluginDataStore } from "./PluginDataStore";
import { classifyLegacyArtifactPath } from "./LegacyArtifactInventory";
import { sha256Text } from "./CanonicalJson";
import { buildPluginDataWithLegacyMigration, extractLegacyMigration, type LegacyMigrationCompletion } from "../utils/pluginData";
import { assertVaultPath, getTrashFilePath, TrashSnapshotStore } from "./TrashSnapshotStore";

interface Options {
	pluginDataStore: PluginDataStore;
	// 使用实际 Monthly 位置，完成事实与旧源定位不变。
	getTrashFolder: () => string;
	// 旧设置属于 best-effort，不阻塞已验证的回收站迁移。
	migrateSettings: () => Promise<void>;
	signal?: AbortSignal;
	yieldControl?: () => Promise<void>;
	runExclusive?: <T>(action: () => Promise<T>) => Promise<T>;
	onReportChanged?: () => Promise<void>;
	isReady?: () => boolean;
	scheduleRetry?: (action: () => void, delayMs: number) => () => void;
}

export class LegacyTrashMigrationService {
	private report: LegacyMigrationReport = emptyReport();
	private flight: Promise<LegacyMigrationReport> | null = null;
	private cancelRetry: (() => void) | null = null;
	private retryCount = 0;
	constructor(private readonly app: App, private readonly source: LegacyIndexSource, private readonly options: Options) {
		options.signal?.addEventListener("abort", () => { this.cancelRetry?.(); this.cancelRetry = null; }, { once: true });
	}
	getReport(): LegacyMigrationReport { return structuredClone(this.report); }
	async waitForIdle(): Promise<void> { await this.flight; }
	// 启动、有限延迟重试和手动恢复共用一个任务；不排队重复导入。
	run(): Promise<LegacyMigrationReport> {
		if (this.flight) return this.flight;
		this.cancelRetry?.(); this.cancelRetry = null;
		const operation = Promise.resolve().then(() => this.options.runExclusive
			? this.options.runExclusive(() => this.runOnce()) : this.runOnce()).catch((error: unknown) => {
			// 进入写入屏障前被其他维护任务阻挡时，保留旧源等待后续重试。
			return this.report = { ...emptyReport(), status: "pending", diagnostics: [{ code: "legacy_migration_busy", sourcePath: null, memoId: null, detail: String(error) }] };
		});
		this.flight = operation.then(async (report) => {
			try { await this.options.onReportChanged?.(); }
			catch { /* 提示失败不改变已校验的迁移结果。 */ }
			return report;
		}).finally(() => {
			this.flight = null;
			if (!this.options.signal?.aborted && this.options.scheduleRetry && this.retryCount < 2
				&& (this.report.status === "pending" || this.report.status === "recovery_required" || this.report.cleanupCandidate)) {
				const delay = [5000, 30000][this.retryCount++];
				this.cancelRetry = this.options.scheduleRetry(() => { this.cancelRetry = null; void this.run(); }, delay);
			}
		});
		return this.flight;
	}
	private async runOnce(): Promise<LegacyMigrationReport> {
		try {
			if (this.options.isReady?.() === false) throw new RetryableMigrationError("Migration configuration is not ready.");
			const root = this.options.getTrashFolder();
			const assertActive = () => {
				if (this.options.signal?.aborted || root !== this.options.getTrashFolder()) throw new RetryableMigrationError("Migration cancelled or Trash folder changed.");
			};
			assertActive();
			let completion = extractLegacyMigration(await this.options.pluginDataStore.read());
			assertActive();
			if (completion !== null) return this.report = await this.cleanup(completion, assertActive);
			if (this.source.inspect().kind === "missing") return this.report = { ...emptyReport(), status: "not_applicable" };
			const loaded = await this.source.load({ cancellationSignal: this.options.signal, yieldControl: this.options.yieldControl });
			assertActive();
			if (loaded.kind === "missing") return this.report = { ...emptyReport(), status: "not_applicable" };
			if (loaded.kind === "attention") return this.report = { ...emptyReport(), status: "recovery_required", diagnostics: loaded.diagnostics };
			const snapshot = loaded.snapshot;
			if (snapshot.diagnostics.length) return this.report = { ...emptyReport(), status: "recovery_required", diagnostics: snapshot.diagnostics };
			const store = new TrashSnapshotStore(this.app, root, assertActive);
			const targets: TrashSnapshot[] = [];
			for (const memo of snapshot.memos) {
				assertActive();
				if (memo.status !== "deleted") continue;
				if (memo.deletedPayload === null) throw new Error(`Legacy Trash payload missing: ${memo.memoId}`);
				const payload = memo.deletedPayload;
				const snapshotId = `legacy_${await sha256Text(JSON.stringify([snapshot.sourceId, memo.memoId]))}`;
				const target: TrashSnapshot = { snapshotId, deletedAt: payload.deletedAt, sourcePath: payload.sourcePath,
					logicalDate: payload.logicalDate, section: payload.section, rawBlock: payload.rawBlock };
				assertActive();
				targets.push(target);
				assertActive();
				await this.options.yieldControl?.();
			}
			await store.saveAll(targets);
			try { await this.options.migrateSettings(); }
			catch { /* 旧设置不可用时保留当前设置，不影响回收站完成事实。 */ }
			assertActive();
			// 迁移期间旧源若同步变化，不能把未读取的新数据标为完成。
			const latest = await this.source.load({ cancellationSignal: this.options.signal, yieldControl: this.options.yieldControl });
			assertActive();
			if (latest.kind !== "ready" || latest.snapshot.sourceId !== snapshot.sourceId
				|| latest.snapshot.sourceRevision !== snapshot.sourceRevision || latest.snapshot.diagnostics.length) throw new RetryableMigrationError("Legacy source changed during migration.");
			await store.assertContainsAll(targets);
			assertActive();
			completion = { completed: true, legacySystemRoot: snapshot.legacySystemRoot, sourceRevision: snapshot.sourceRevision };
			await this.persistCompletion(completion);
			return this.report = await this.cleanup(completion, assertActive);
		} catch (error) {
			return this.report = { ...emptyReport(), status: error instanceof RetryableMigrationError || this.options.signal?.aborted ? "pending" : "recovery_required", diagnostics: [{ code: "legacy_trash_migration_failed", sourcePath: null, memoId: null, detail: String(error) }] };
		}
	}
	private async persistCompletion(completion: LegacyMigrationCompletion): Promise<void> {
		assertLegacySystemRoot(completion.legacySystemRoot);
		await this.options.pluginDataStore.mutate((savedData) => ({
			nextData: buildPluginDataWithLegacyMigration(savedData, completion), result: undefined,
		}));
		const saved = extractLegacyMigration(await this.options.pluginDataStore.read());
		if (saved?.completed !== true || saved.legacySystemRoot !== completion.legacySystemRoot || saved.sourceRevision !== completion.sourceRevision) {
			throw new Error("Legacy completion write verification failed.");
		}
	}

	private async cleanup(completion: LegacyMigrationCompletion, assertActive: () => void): Promise<LegacyMigrationReport> {
		const report: LegacyMigrationReport = { ...emptyReport(), status: "ready", sourceRevision: completion.sourceRevision };
		try {
			assertActive();
			const path = completion.legacySystemRoot;
			assertLegacySystemRoot(path);
			// 恢复副本或配置目录不得与待删除目录重叠。
			for (const protectedPath of [getTrashFilePath(this.options.getTrashFolder()), this.app.vault.configDir]) {
				if (protectedPath === path || protectedPath.startsWith(`${path}/`) || path.startsWith(`${protectedPath}/`)) throw new Error("Unsafe legacy cleanup overlap.");
			}
			const folder = this.app.vault.getAbstractFileByPath(path);
			if (folder === null && !await this.app.vault.adapter.exists(path)) return report;
			if (!(folder instanceof TFolder)) throw new Error("Legacy cleanup target is not an available folder.");
			// 合法 Monthly 备份沿用旧版分类；未知文件不属于清理授权。
			Vault.recurseChildren(folder, (child) => {
				if (child instanceof TFile && classifyLegacyArtifactPath(path, child.path) === null) throw new LegacyCleanupUnknownFileError(child.path);
			});
			assertActive();
			await this.app.fileManager.trashFile(folder);
			if (await this.app.vault.adapter.exists(path)) throw new Error("Legacy cleanup not confirmed.");
		} catch (error) {
			report.diagnostics = [{ code: error instanceof LegacyCleanupUnknownFileError ? "legacy_cleanup_unknown_file" : "legacy_cleanup_failed",
				sourcePath: error instanceof LegacyCleanupUnknownFileError ? error.path : completion.legacySystemRoot, memoId: null, detail: String(error) }];
			report.cleanupCandidate = { legacySystemRoot: completion.legacySystemRoot, sourceRevision: completion.sourceRevision };
		}
		return report;
	}

}

class RetryableMigrationError extends Error {}

class LegacyCleanupUnknownFileError extends Error {
	constructor(readonly path: string) { super(`Unrecognized file in legacy cleanup: ${path}`); }
}

function emptyReport(): LegacyMigrationReport {
	return { status: "idle", sourceRevision: null, diagnostics: [], cleanupCandidate: null };
}

function assertLegacySystemRoot(path: string): void {
	assertVaultPath(path);
	if (!path.endsWith("/_knomo-system") || path.split("/").slice(0, -1).some((part) => part.startsWith(".") || part === "_knomo-system")) throw new Error("Invalid legacy system root.");
}
