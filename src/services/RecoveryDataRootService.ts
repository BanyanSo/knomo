import { TFile } from "obsidian";
import type { App } from "obsidian";
import { getCatalogDataRootPath, normalizeVaultPath } from "../utils/path";
import { ensureFolder } from "../utils/vault";
import { assertVaultPath, TrashSnapshotStore } from "./TrashSnapshotStore";

// 数据根只承担恢复副本；不枚举或复制开发期协议文件。
export class RecoveryDataRootService {
	constructor(private readonly app: App, private readonly getLocation: () => KnomoDataRootLocation,
		private readonly commit: (root: string) => Promise<void>,
		private readonly exclusive: <T>(action: () => Promise<T>) => Promise<T>) {}
	async plan(value: string) {
		const location = this.getLocation();
		const newDataRoot = normalizeVaultPath(value);
		assertVaultPath(newDataRoot);
		const oldDataRoot = location.knomoDataRoot;
		if (oldDataRoot !== newDataRoot && (newDataRoot.startsWith(`${oldDataRoot}/`) || oldDataRoot.startsWith(`${newDataRoot}/`))) throw new Error("Data roots must be separate.");
		return { action: !location.knomoDataRootConfigured ? "initialize" as const : oldDataRoot === newDataRoot ? "unchanged" as const : "migrate" as const, oldDataRoot, newDataRoot };
	}
	async migrate(value: string): Promise<void> {
		await this.exclusive(async () => {
			const plan = await this.plan(value);
			const targetRoot = getCatalogDataRootPath(plan.newDataRoot);
			if (plan.action === "migrate") {
				const sourceRoot = getCatalogDataRootPath(plan.oldDataRoot);
				const source = new TrashSnapshotStore(this.app, `${sourceRoot}/trash`);
				const target = new TrashSnapshotStore(this.app, `${targetRoot}/trash`);
				const snapshots = await source.query();
				if (snapshots.errors.length) throw new Error("Cannot relocate damaged Trash snapshots.");
				for (const snapshot of snapshots.items) {
					const path = `${targetRoot}/trash/${snapshot.snapshotId}.json`;
					if (this.app.vault.getAbstractFileByPath(path) instanceof TFile || await this.app.vault.adapter.exists(path)) await target.assertUnchanged(snapshot);
					else await target.save(snapshot);
				}
			}
			await ensureFolder(this.app, targetRoot);
			await this.commit(plan.newDataRoot);
		});
	}
}

export interface KnomoDataRootLocation { knomoDataRoot: string; knomoDataRootConfigured: boolean; }
