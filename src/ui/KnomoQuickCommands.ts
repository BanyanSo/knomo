import { t, type TranslationKey } from "../i18n";
import type { Command } from "obsidian";

const QUICK_COMMANDS = [
	["new-memo", "command.newMemo"],
	["random-revisit", "nav.random"],
	["shuffle-day", "nav.shuffleDay"],
	["time-buoy", "nav.timeBuoy"],
	["record-stats", "nav.recordStats"],
	["on-this-day", "filter.anniversary"],
] as const satisfies ReadonlyArray<readonly [string, TranslationKey]>;

export type KnomoQuickCommand = typeof QUICK_COMMANDS[number][0];

export function createKnomoQuickCommands(execute: (command: KnomoQuickCommand) => Promise<void>): Command[] {
	return QUICK_COMMANDS.map(([id, key]) => ({ id, name: t(key), callback: () => execute(id) }));
}

export interface QuickCommandView {
	waitForQuickCommands(): Promise<boolean>;
	executeQuickCommand(command: KnomoQuickCommand): void;
}

interface QuickCommandOptions<Leaf> {
	getLeaves(): Leaf[];
	getActiveLeaf(): Leaf | null;
	createLeaf(): Leaf;
	openLeaf(leaf: Leaf): Promise<void>;
	loadLeaf(leaf: Leaf): Promise<void>;
	revealLeaf(leaf: Leaf): Promise<void>;
	focusLeaf(leaf: Leaf): void;
	getView(leaf: Leaf): QuickCommandView | null;
	isTimeBuoyEnabled(): boolean;
	showNotice(message: string): void;
}

/** 仅保留一次打开任务和最后一个入口意图，不保存视图或命令历史。 */
export class KnomoQuickCommandController<Leaf> {
	private revision = 0;
	private disposed = false;
	private target: Leaf | null = null;
	private opening: { leaf: Leaf; ready: Promise<void> } | null = null;

	constructor(private readonly options: QuickCommandOptions<Leaf>) {}

	cancel(): void {
		this.revision += 1;
		this.target = null;
	}

	activeLeafChanged(leaf: Leaf | null): void {
		if (this.target !== null && leaf !== this.target) this.cancel();
	}

	dispose(): void {
		this.disposed = true;
		this.cancel();
	}

	async execute(command: KnomoQuickCommand): Promise<void> {
		this.cancel();
		if (this.disposed || !this.checkEnabled(command)) return;
		const revision = this.revision;
		const current = () => !this.disposed && revision === this.revision;
		try {
			const leaves = this.options.getLeaves();
			const active = this.options.getActiveLeaf();
			const opening = this.opening;
			const leaf = opening?.leaf ?? (active !== null && leaves.includes(active) ? active : leaves[0]) ?? this.options.createLeaf();
			this.target = leaf;
			if (opening !== null) {
				await opening.ready;
			} else if (!leaves.includes(leaf)) {
				// 先发布任务，再启动宿主调用，避免同步事件重入创建第二个标签页。
				const task = { leaf, ready: Promise.resolve().then(async () => {
					if (!this.disposed && this.target === leaf) await this.options.openLeaf(leaf);
				}) };
				this.opening = task;
				try { await task.ready; }
				finally { if (this.opening === task) this.opening = null; }
			}
			if (!current() || !this.options.getLeaves().includes(leaf) || !this.checkEnabled(command)) return;
			// 先加载休眠视图，等待期间用户切页时可以取消，避免迟到的 reveal 抢焦点。
			await this.options.loadLeaf(leaf);
			if (!current() || !this.options.getLeaves().includes(leaf)) return;
			const view = this.options.getView(leaf);
			if (view === null || !await view.waitForQuickCommands()) {
				if (current() && this.options.getLeaves().includes(leaf)) throw new Error("Knomo view did not initialize.");
				return;
			}
			if (!current() || !this.options.getLeaves().includes(leaf)
				|| this.options.getView(leaf) !== view || !this.checkEnabled(command)) return;
			await this.options.revealLeaf(leaf);
			if (!current() || !this.options.getLeaves().includes(leaf)
				|| this.options.getView(leaf) !== view || !this.checkEnabled(command)) return;
			this.options.focusLeaf(leaf);
			if (!current() || this.options.getActiveLeaf() !== leaf) return;
			view.executeQuickCommand(command);
		} catch (error) {
			if (current()) this.options.showNotice(t("command.openFailed", { error: String(error) }));
		} finally {
			if (current()) this.target = null;
		}
	}

	private checkEnabled(command: KnomoQuickCommand): boolean {
		if (command !== "time-buoy" || this.options.isTimeBuoyEnabled()) return true;
		this.options.showNotice(t("command.timeBuoyDisabled"));
		return false;
	}
}
