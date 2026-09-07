import { TFile, TFolder } from "obsidian";
import type { App } from "obsidian";
import type { TrashQueryResult, TrashSnapshot } from "../types/trash";

export class TrashSnapshotStore {
	constructor(private readonly app: App, private readonly root = "_knomo-data/trash") {
		assertVaultPath(root);
	}

	async save(snapshot: TrashSnapshot): Promise<void> {
		validateSnapshot(snapshot, snapshot.snapshotId);
		const path = this.path(snapshot.snapshotId);
		const parts = this.root.split("/");
		for (let index = 1; index <= parts.length; index++) {
			const folder = parts.slice(0, index).join("/");
			if (this.app.vault.getAbstractFileByPath(folder) === null) {
				try { await this.app.vault.createFolder(folder); }
				catch (error) { if (!(this.app.vault.getAbstractFileByPath(folder) instanceof TFolder)) throw error; }
			}
			if (!(this.app.vault.getAbstractFileByPath(folder) instanceof TFolder)) throw new Error(`Trash folder unavailable: ${folder}`);
		}
		// 只创建，绝不覆盖同 ID 的已有或损坏副本。
		await this.app.vault.create(path, JSON.stringify(snapshot));
		await this.assertUnchanged(snapshot);
	}

	async read(snapshotId: string): Promise<TrashSnapshot> {
		const file = this.app.vault.getAbstractFileByPath(this.path(snapshotId));
		if (!(file instanceof TFile)) throw new Error(`Trash snapshot unavailable: ${snapshotId}`);
		const value: unknown = JSON.parse(await this.app.vault.read(file));
		validateSnapshot(value, snapshotId);
		return value;
	}

	async assertUnchanged(snapshot: TrashSnapshot): Promise<void> {
		const current = await this.read(snapshot.snapshotId);
		if (!sameSnapshot(current, snapshot)) throw new Error(`Trash snapshot changed: ${snapshot.snapshotId}`);
	}

	async remove(snapshot: TrashSnapshot, allowMissing = false): Promise<void> {
		if (allowMissing && this.app.vault.getAbstractFileByPath(this.path(snapshot.snapshotId)) === null
			&& !await this.app.vault.adapter.exists(this.path(snapshot.snapshotId))) return;
		await this.assertUnchanged(snapshot);
		const path = this.path(snapshot.snapshotId);
		const file = this.app.vault.getAbstractFileByPath(path);
		if (!(file instanceof TFile)) throw new Error(`Trash snapshot unavailable: ${snapshot.snapshotId}`);
		await this.app.vault.delete(file);
		if (await this.app.vault.adapter.exists(path)) throw new Error(`Trash snapshot cleanup not confirmed: ${snapshot.snapshotId}`);
	}

	async query(): Promise<TrashQueryResult> {
		const result: TrashQueryResult = { items: [], errors: [] };
		for (const file of this.app.vault.getFiles()) {
			if (!file.path.startsWith(`${this.root}/`) || file.path.slice(this.root.length + 1).includes("/") || !file.path.endsWith(".json")) continue;
			const snapshotId = file.name.slice(0, -5);
			try { result.items.push(await this.read(snapshotId)); }
			catch (error) { result.errors.push({ snapshotId, message: String(error) }); }
		}
		result.items.sort((a, b) => b.deletedAt.localeCompare(a.deletedAt) || a.snapshotId.localeCompare(b.snapshotId));
		return result;
	}

	private path(snapshotId: string): string {
		if (!/^[a-zA-Z0-9_-]{1,128}$/u.test(snapshotId)) throw new Error("Invalid Trash snapshot ID.");
		return `${this.root}/${snapshotId}.json`;
	}
}

export function assertVaultPath(path: string): void {
	if (!path || /[\\:\u0000-\u001f]/u.test(path) || path.split("/").some((part) => !part || part === "." || part === "..")) {
		throw new Error("Invalid Vault path.");
	}
}

function validateSnapshot(value: unknown, snapshotId: string): asserts value is TrashSnapshot {
	if (value === null || typeof value !== "object") throw new Error("Invalid Trash snapshot.");
	const item = value as Partial<TrashSnapshot>;
	if (item.snapshotId !== snapshotId || typeof item.deletedAt !== "string" || !Number.isFinite(Date.parse(item.deletedAt))
		|| typeof item.sourcePath !== "string" || !item.sourcePath.endsWith(".md")
		|| typeof item.logicalDate !== "string" || !/^\d{4}-\d{2}-\d{2}$/u.test(item.logicalDate)
		|| new Date(`${item.logicalDate}T00:00:00Z`).toISOString().slice(0, 10) !== item.logicalDate
		|| !(item.section === null || typeof item.section === "string" && /^#{1,6} [^\r\n]+$/u.test(item.section))
		|| typeof item.rawBlock !== "string" || item.rawBlock.length === 0) throw new Error("Invalid Trash snapshot.");
	assertVaultPath(item.sourcePath);
}

function sameSnapshot(a: TrashSnapshot, b: TrashSnapshot): boolean {
	return a.snapshotId === b.snapshotId && a.deletedAt === b.deletedAt && a.sourcePath === b.sourcePath
		&& a.logicalDate === b.logicalDate && a.section === b.section && a.rawBlock === b.rawBlock;
}
