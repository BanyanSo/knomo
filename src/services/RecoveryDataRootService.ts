import type { App } from "obsidian";
import { getCatalogDataRootPath, normalizeVaultPath } from "../utils/path";
import { ensureFolder } from "../utils/vault";
import { assertVaultPath, TrashSnapshotStore } from "./TrashSnapshotStore";

// 数据根只承担恢复副本；不枚举或复制开发期协议文件。
export class RecoveryDataRootService {
	constructor(private readonly app: App, private readonly getLocation: () => KnomoDataRootLocation & { monthlyMemoFolder: string },
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
			if (this.getLocation().monthlyMemoFolder !== plan.newDataRoot) {
				const sourceFolder = this.getLocation().monthlyMemoFolder;
				const assertActive = () => { if (this.getLocation().monthlyMemoFolder !== sourceFolder) throw new Error("Trash folder changed during relocation."); };
				const source = new TrashSnapshotStore(this.app, sourceFolder, assertActive);
				const target = new TrashSnapshotStore(this.app, plan.newDataRoot, assertActive);
				const snapshots = await source.query();
				if (snapshots.errors.length) throw new Error("Cannot relocate damaged Trash snapshots.");
				await target.saveAll(snapshots.items);
			}
			await ensureFolder(this.app, targetRoot);
			await this.commit(plan.newDataRoot);
		});
	}
}

export interface KnomoDataRootLocation { knomoDataRoot: string; knomoDataRootConfigured: boolean; }
