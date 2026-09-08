import { TFile } from "obsidian";
import { t } from "../i18n";
import type { App } from "obsidian";
import type { MemoObservation, ObservationHandle } from "../types/catalog";
import type { TrashSnapshot, TrashWriteResult } from "../types/trash";
import { DailyMemoWriteGateway, type PreparedDailyWrite } from "./DailyMemoWriteGateway";
import { findObservation, findAppendedObservation, getRawBlock, replaceObservation, insertRawBlock, hasBlockId,
	type MarkdownCatalogCommitInput } from "./MarkdownMutationService";
import { TrashSnapshotStore, assertVaultPath } from "./TrashSnapshotStore";

export interface IndependentTrashOptions {
	assertActive?: () => void;
	getLogicalDateForPath: (path: string) => Promise<string>;
	// 返回 null 表示原路径已不适用；配置不可读必须抛错，不能猜测。
	getOriginalDailyFile: (path: string, date: string) => Promise<TFile | null>;
	getDailyFileForDate: (date: string) => Promise<TFile>;
	updateCatalogPartition: (input: MarkdownCatalogCommitInput) => Promise<void>;
	refreshCatalogPaths: (paths: readonly string[]) => Promise<void>;
	now?: () => Date;
	newSnapshotId?: () => string;
}

export class TrashDailyWriteError extends Error {
	constructor(readonly snapshotId: string, readonly dailyState: "before" | "after" | "changed" | "unreadable", reason: unknown) {
		super(`Trash Daily write not confirmed; snapshot retained (${snapshotId}, ${dailyState}): ${String(reason)}`);
		this.name = "TrashDailyWriteError";
	}
}

// 队列与清理重试仅存在于当前会话，不建立持久事务历史。
export class IndependentTrashService {
	private queue: Promise<unknown> = Promise.resolve();
	private readonly cleanupOnly = new Map<string, { snapshot: TrashSnapshot; prepared: PreparedDailyWrite; observation: MemoObservation; confirmed?: boolean; catalogUpdatePending?: boolean }>();

	constructor(private readonly app: App, readonly store: TrashSnapshotStore, private readonly options: IndependentTrashOptions,
		private readonly gateway = new DailyMemoWriteGateway(app)) {}

	query() { return this.store.query(); }

	delete(handle: ObservationHandle): Promise<TrashWriteResult> {
		const original = { ...handle };
		return this.serial(async () => {
			assertVaultPath(original.sourcePath);
			const file = this.app.vault.getAbstractFileByPath(original.sourcePath);
			if (!(file instanceof TFile)) throw new Error("Daily file unavailable.");
			const logicalDate = await this.options.getLogicalDateForPath(file.path);
			const prepared = await this.gateway.prepare({ file, logicalDate, expectedRevision: original.sourceRevision, requireDiskMatch: true,
				update: (content, parsed) => replaceObservation(content, findObservation(parsed, original, file.path), "", true) });
			const observation = findObservation(prepared.before, original, file.path);
			const snapshot: TrashSnapshot = { snapshotId: this.options.newSnapshotId?.() ?? randomSnapshotId(),
				deletedAt: (this.options.now?.() ?? new Date()).toISOString(), sourcePath: original.sourcePath,
				logicalDate, section: observation.section, rawBlock: getRawBlock(prepared.beforeContent, observation) };
			this.options.assertActive?.();
			await this.store.save(snapshot);
			await this.commit(prepared, snapshot);
			return { snapshotId: snapshot.snapshotId, state: "deleted", observation: null,
				catalogUpdatePending: await this.updateCatalog(prepared) };
		});
	}

	restore(snapshotId: string): Promise<TrashWriteResult> {
		return this.serial(async () => {
			const pending = this.cleanupOnly.get(snapshotId);
			if (pending !== undefined) return this.finishRestore(pending.snapshot, pending.prepared, pending.observation);
			const snapshot = await this.store.read(snapshotId);
			const original = await this.options.getOriginalDailyFile(snapshot.sourcePath, snapshot.logicalDate);
			if (original !== null && original.path !== snapshot.sourcePath) throw new Error("Restore cannot follow a historical file move.");
			const file = original ?? await this.options.getDailyFileForDate(snapshot.logicalDate);
			assertVaultPath(file.path);
			if (!(file instanceof TFile) || !file.path.endsWith(".md")) throw new Error("Restore Daily target unavailable.");
			const prepared = await this.gateway.prepare({ file, logicalDate: snapshot.logicalDate, expectedRevision: null, requireDiskMatch: true,
				update: (content) => {
					// 包括 Memo 外部锚点；不能制造同文件 blockId 冲突。
					const ids = snapshot.rawBlock.match(/\^[A-Za-z0-9_-]+(?=\s|$)/gu) ?? [];
					if (ids.some((id) => hasBlockId(content, id.slice(1)))) throw new Error("Restore block ID already exists in target Daily.");
					return insertRawBlock(content, snapshot.rawBlock, snapshot.section, "bottom");
				} });
			const observation = findAppendedObservation(prepared, snapshot.rawBlock, snapshot.section, "bottom");
			await this.store.assertUnchanged(snapshot);
			// 一旦可能写入，后续按钮只核对落盘并清理，不能再次追加。
			this.cleanupOnly.set(snapshotId, { snapshot, prepared, observation });
			try { await this.commit(prepared, snapshot); }
			catch (error) {
				if (error instanceof TrashDailyWriteError && error.dailyState === "before" && prepared.mode === "vault_process") this.cleanupOnly.delete(snapshotId);
				throw error;
			}
			return this.finishRestore(snapshot, prepared, observation);
		});
	}

	purge(snapshotId: string): Promise<void> {
		return this.serial(async () => {
			const snapshot = await this.store.read(snapshotId);
			this.options.assertActive?.();
			await this.store.remove(snapshot);
			this.cleanupOnly.delete(snapshotId);
		});
	}

	private async finishRestore(snapshot: TrashSnapshot, prepared: PreparedDailyWrite, observation: MemoObservation): Promise<TrashWriteResult> {
		const pending = this.cleanupOnly.get(snapshot.snapshotId)!;
		if (!pending.confirmed) {
			const state = await this.readDailyState(prepared);
			if (state !== "after") throw new TrashDailyWriteError(snapshot.snapshotId, state, "Restored content is not confirmed on disk; cleanup only.");
			pending.catalogUpdatePending = await this.updateCatalog(prepared, observation);
			pending.confirmed = true;
		}
		const catalogUpdatePending = pending.catalogUpdatePending ?? false;
		try {
			this.options.assertActive?.();
			await this.store.remove(snapshot, true);
			this.cleanupOnly.delete(snapshot.snapshotId);
			return { snapshotId: snapshot.snapshotId, state: "restored", observation, catalogUpdatePending };
		} catch (error) {
			return { snapshotId: snapshot.snapshotId, state: "restored_cleanup_pending", observation, catalogUpdatePending,
				message: t("trash.restoredCleanupError", { error: String(error) }) };
		}
	}

	private async commit(prepared: PreparedDailyWrite, snapshot: TrashSnapshot): Promise<void> {
		try {
			await this.store.assertUnchanged(snapshot);
			this.options.assertActive?.();
			if (prepared.file.path !== (prepared.before.observations[0]?.sourcePath ?? prepared.after.observations[0]?.sourcePath)) {
				throw new Error("Daily target path changed.");
			}
			await this.gateway.commit(prepared);
		} catch (error) { throw new TrashDailyWriteError(snapshot.snapshotId, await this.readDailyState(prepared), error); }
		const state = await this.readDailyState(prepared);
		if (state !== "after") throw new TrashDailyWriteError(snapshot.snapshotId, state, "Disk write is not confirmed.");
	}

	private async readDailyState(prepared: PreparedDailyWrite): Promise<TrashDailyWriteError["dailyState"]> {
		try {
			const content = await this.app.vault.read(prepared.file);
			return content === prepared.afterContent ? "after" : content === prepared.beforeContent ? "before" : "changed";
		} catch { return "unreadable"; }
	}

	private async updateCatalog(prepared: PreparedDailyWrite, observation?: MemoObservation): Promise<boolean> {
		try {
			this.options.assertActive?.();
			await this.options.updateCatalogPartition({ file: prepared.file, logicalDate: prepared.logicalDate,
				content: prepared.afterContent, parsed: prepared.after, insertedObservation: observation });
			return false;
		} catch {
			await this.options.refreshCatalogPaths([prepared.file.path]).catch(() => undefined);
			return true;
		}
	}

	private serial<T>(action: () => Promise<T>): Promise<T> {
		const pending = this.queue.catch(() => undefined).then(() => { this.options.assertActive?.(); return action(); });
		this.queue = pending;
		return pending;
	}
}

function randomSnapshotId(): string {
	const bytes = new Uint8Array(16);
	crypto.getRandomValues(bytes);
	return `s_${Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("")}`;
}
