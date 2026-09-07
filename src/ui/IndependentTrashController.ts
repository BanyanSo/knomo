import type { TrashQueryResult, TrashWriteResult } from "../types/trash";

interface TrashActions {
	query(): Promise<TrashQueryResult>;
	restore(snapshotId: string): Promise<TrashWriteResult>;
	purge(snapshotId: string): Promise<void>;
}

// 独立 Trash 的 UI 状态，不复用 memoId/deletedMemoIds；P6 再装配到生产视图。
export class IndependentTrashController {
	private state: TrashQueryResult = { items: [], errors: [] };
	private readonly busy = new Set<string>();
	private readonly messages = new Map<string, string>();
	private revision = 0;

	constructor(private readonly actions: TrashActions) {}

	getSnapshot() {
		return { ...this.state, busySnapshotIds: new Set(this.busy), messages: new Map(this.messages) };
	}

	async refresh(): Promise<void> {
		const revision = ++this.revision;
		const state = await this.actions.query();
		if (revision === this.revision) this.state = state;
	}

	async run(snapshotId: string, action: "restore" | "purge"): Promise<void> {
		if (this.busy.has(snapshotId)) return;
		this.busy.add(snapshotId);
		this.revision++;
		try {
			if (action === "restore") {
				const result = await this.actions.restore(snapshotId);
				this.messages.set(snapshotId, result.message ?? "正文已恢复");
			} else {
				await this.actions.purge(snapshotId);
				this.messages.delete(snapshotId);
			}
			await this.refresh();
		} catch (error) {
			this.messages.set(snapshotId, String(error));
			throw error;
		} finally { this.busy.delete(snapshotId); }
	}
}
