import { TFile } from "obsidian";
import type { App } from "obsidian";
import type { LegacyIndexSource } from "../types/legacyIndex";
import type { LegacyMigrationReport } from "../types/legacyMigration";
import type { TrashSnapshot } from "../types/trash";
import { ensureFolder } from "../utils/vault";
import { assertVaultPath, TrashSnapshotStore } from "./TrashSnapshotStore";

export const LEGACY_COMPLETION_FILE = "legacy-index-completion.json";
interface Completion { sourceId: string; sourceRevision: string; legacySystemRoot: string; }

// 完成事实独立存放；不检查目标 snapshot，也不依赖本地缓存或旧共享协议。
export class LegacyMigrationMarkerStore {
	constructor(private readonly app: App, readonly root: string) { assertVaultPath(root); }
	async read(): Promise<Completion | null> {
		const path = `${this.root}/${LEGACY_COMPLETION_FILE}`;
		const file = this.app.vault.getAbstractFileByPath(path);
		if (file === null && !await this.app.vault.adapter.exists(path)) return null;
		if (!(file instanceof TFile)) throw new Error("Migration marker unavailable.");
		const value: unknown = JSON.parse(await this.app.vault.read(file));
		if (value === null || typeof value !== "object") throw new Error("Invalid migration marker.");
		const item = value as Partial<Completion>;
		if (typeof item.sourceId !== "string" || !item.sourceId.startsWith("legacy-index:")
			|| typeof item.sourceRevision !== "string" || !/^[a-f0-9]{64}$/u.test(item.sourceRevision)
			|| typeof item.legacySystemRoot !== "string") throw new Error("Invalid migration marker.");
		assertVaultPath(item.legacySystemRoot);
		if (!item.legacySystemRoot.endsWith("/_knomo-system")
			|| item.sourceId !== `legacy-index:${item.legacySystemRoot.slice(0, -"/_knomo-system".length)}`) throw new Error("Invalid migration source.");
		return item as Completion;
	}
	async save(completion: Completion): Promise<void> {
		const existing = await this.read();
		if (existing === null) {
			await ensureFolder(this.app, this.root);
			await this.app.vault.create(`${this.root}/${LEGACY_COMPLETION_FILE}`, JSON.stringify(completion));
		}
		const verified = await this.read();
		if (JSON.stringify(verified) !== JSON.stringify(completion)) throw new Error("Migration marker conflicts or failed verification.");
	}
}

interface Options {
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
	// 普通启动只检查完成事实；缺失 marker 必须由迁移按钮显式重试。
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
			const marker = new LegacyMigrationMarkerStore(this.app, root);
			const completion = await marker.read();
			assertActive();
			if (completion !== null) return this.report = { ...emptyReport(), status: "ready", sourceRevision: completion.sourceRevision };
			if (this.source.inspect().kind === "missing") return this.report = { ...emptyReport(), status: "not_applicable" };
			if (!explicit) return this.report = { ...emptyReport(), status: "attention", diagnostics: [{ code: "legacy_migration_explicit_retry", sourcePath: null, memoId: null, detail: "旧 Index 尚未确认迁移，请显式迁移或重试。" }] };
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
			await marker.save({ sourceId: snapshot.sourceId, sourceRevision: snapshot.sourceRevision, legacySystemRoot: snapshot.legacySystemRoot });
			assertActive();
			return this.report = { ...emptyReport(), status: "ready", sourceRevision: snapshot.sourceRevision,
				cleanupCandidate: { legacySystemRoot: snapshot.legacySystemRoot, sourceRevision: snapshot.sourceRevision } };
		} catch (error) {
			return this.report = { ...emptyReport(), status: "unavailable", diagnostics: [{ code: "legacy_trash_migration_failed", sourcePath: null, memoId: null, detail: String(error) }] };
		}
	}
}

function emptyReport(): LegacyMigrationReport {
	return { status: "idle", sourceRevision: null, diagnostics: [], cleanupCandidate: null };
}
