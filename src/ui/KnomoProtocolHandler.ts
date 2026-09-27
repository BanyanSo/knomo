import type { ObsidianProtocolHandler } from "obsidian";
import { isKnomoQuickCommand, type KnomoQuickCommandController } from "./KnomoQuickCommands";

interface KnomoProtocolOptions {
	onLayoutReady(callback: () => void): void;
	isActive(): boolean;
	openView(): Promise<void>;
	quickCommands: Pick<KnomoQuickCommandController<unknown>, "execute" | "cancel">;
	onError(error: unknown): void;
}

/** Vault 路由及参数解码由 Obsidian 完成；这里只接受已路由到本实例的命令。 */
export function createKnomoProtocolHandler(options: KnomoProtocolOptions): ObsidianProtocolHandler {
	let revision = 0;
	return (params) => {
		const command = params.command;
		if (command !== "open-view" && !isKnomoQuickCommand(command)) return;
		if (!options.isActive()) return;
		const request = ++revision;
		// 冷启动等待布局恢复，避免与宿主恢复的 Knomo 标签页重复创建。
		options.onLayoutReady(() => {
			if (!options.isActive() || request !== revision) return;
			if (command === "open-view") {
				options.quickCommands.cancel();
				void options.openView().catch(error => options.onError(error));
			} else {
				void options.quickCommands.execute(command).catch(error => options.onError(error));
			}
		});
	};
}
