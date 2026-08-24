import { normalizePath, TFolder } from "obsidian";
import type { App } from "obsidian";

import type { KnomoSharedConfigStatus } from "../types/knomoConfig";
import { getCatalogDataRootPath } from "../utils/path";
import type { KnomoDataRootLocation } from "./KnomoDataRootMigrationService";

interface StartupSharedConfigService {
	reloadConfiguredRoot(): Promise<void>;
	getStatus(): KnomoSharedConfigStatus;
	publishLocalConfig(): Promise<void>;
}

export interface KnomoStartupBootstrapOptions {
	getLocation: () => KnomoDataRootLocation;
	initializeDataRoot: (dataRoot: string) => Promise<void>;
	sharedConfig: StartupSharedConfigService;
}

/** 启用插件时补齐默认数据根与共享配置；已有共享配置只读取，不覆盖。 */
export class KnomoStartupBootstrapService {
	constructor(
		private readonly app: App,
		private readonly options: KnomoStartupBootstrapOptions,
	) {}

	async initialize(): Promise<void> {
		let location = this.options.getLocation();
		if (!location.knomoDataRootConfigured) {
			await this.options.initializeDataRoot(location.knomoDataRoot);
			location = this.options.getLocation();
			if (!location.knomoDataRootConfigured) {
				throw new Error("Knomo Data Root initialization did not persist its location.");
			}
		}

		await this.ensureFolder(getCatalogDataRootPath(location.knomoDataRoot));
		await this.options.sharedConfig.reloadConfiguredRoot();
		if (this.options.sharedConfig.getStatus() === "missing") {
			await this.options.sharedConfig.publishLocalConfig();
		}
	}

	private async ensureFolder(path: string): Promise<void> {
		const segments = normalizePath(path).split("/").filter(Boolean);
		let current = "";
		for (const segment of segments) {
			current = current.length === 0 ? segment : `${current}/${segment}`;
			const existing = this.app.vault.getAbstractFileByPath(current);
			if (existing instanceof TFolder) continue;
			if (existing !== null) throw new Error(`Knomo data path is not a folder: ${current}`);
			try {
				await this.app.vault.createFolder(current);
			} catch (error) {
				if (!(this.app.vault.getAbstractFileByPath(current) instanceof TFolder)) throw error;
			}
		}
	}
}
