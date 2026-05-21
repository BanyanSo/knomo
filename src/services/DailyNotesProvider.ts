import { normalizePath } from "obsidian";
import type { App } from "obsidian";

import type { DailyNotesConfig } from "./DailyNoteService";

interface InternalPluginManager {
	getPluginById?(id: string): unknown;
	plugins?: Record<string, unknown> | Map<string, unknown>;
	enabledPlugins?: Set<string> | string[];
}

type AppWithInternalPlugins = App & {
	internalPlugins?: InternalPluginManager;
};

type RuntimeConfigResult =
	| { type: "config"; config: DailyNotesConfig }
	| { type: "disabled" }
	| { type: "unavailable" };

const DAILY_NOTES_PLUGIN_ID = "daily-notes";
const DEFAULT_DAILY_NOTES_FORMAT = "YYYY-MM-DD";
// 职责：只读取日记核心插件配置，不猜测用户的日记路径。
export class DailyNotesProvider {
	private cachedConfig: DailyNotesConfig | null = null;

	constructor(private readonly app: App) {}

	getConfig(): DailyNotesConfig | null {
		const runtimeConfig = this.readRuntimeConfig();
		if (runtimeConfig.type === "config") {
			this.cachedConfig = runtimeConfig.config;
			return runtimeConfig.config;
		}
		if (runtimeConfig.type === "disabled") {
			this.cachedConfig = null;
			return null;
		}
		return this.cachedConfig;
	}

	async loadConfig(): Promise<DailyNotesConfig | null> {
		const runtimeConfig = this.readRuntimeConfig();
		if (runtimeConfig.type === "config") {
			this.cachedConfig = runtimeConfig.config;
			return runtimeConfig.config;
		}
		if (runtimeConfig.type === "disabled") {
			this.cachedConfig = null;
			return null;
		}

		const fileConfig = await this.readConfigFile();
		this.cachedConfig = fileConfig;
		return fileConfig;
	}

	private readRuntimeConfig(): RuntimeConfigResult {
		const internalPlugins = (this.app as AppWithInternalPlugins).internalPlugins;
		const pluginRecord = asRecord(readDailyNotesPlugin(internalPlugins));
		const pluginState = getDailyNotesPluginState(internalPlugins, pluginRecord);
		// Obsidian 核心插件 id 不随界面语言本地化；中文界面里的“日记”仍是 daily-notes。
		if (pluginState === "disabled") {
			return { type: "disabled" };
		}

		const options = getDailyNotesOptions(pluginRecord);
		if (pluginState === "enabled") {
			const config = parseDailyNotesConfig(options ?? {}, DEFAULT_DAILY_NOTES_FORMAT);
			return { type: "config", config: config ?? getDefaultDailyNotesConfig() };
		}

		const config = parseDailyNotesConfig(options, DEFAULT_DAILY_NOTES_FORMAT);
		return config === null ? { type: "unavailable" } : { type: "config", config };
	}

	private async readConfigFile(): Promise<DailyNotesConfig | null> {
		const path = normalizePath(`${this.app.vault.configDir}/${DAILY_NOTES_PLUGIN_ID}.json`);
		try {
			const data = await this.app.vault.adapter.read(path);
			return parseDailyNotesConfig(JSON.parse(data) as unknown, DEFAULT_DAILY_NOTES_FORMAT);
		} catch {
			return null;
		}
	}
}

type DailyNotesPluginState = "enabled" | "disabled" | "unknown";

function readDailyNotesPlugin(internalPlugins: InternalPluginManager | undefined): unknown {
	const fromGetter = internalPlugins?.getPluginById?.(DAILY_NOTES_PLUGIN_ID);
	if (fromGetter !== undefined && fromGetter !== null) {
		return fromGetter;
	}

	const plugins = internalPlugins?.plugins;
	if (plugins instanceof Map) {
		return plugins.get(DAILY_NOTES_PLUGIN_ID) ?? null;
	}

	return asRecord(plugins)?.[DAILY_NOTES_PLUGIN_ID] ?? null;
}

function getDailyNotesPluginState(
	internalPlugins: InternalPluginManager | undefined,
	pluginRecord: Record<string, unknown> | null,
): DailyNotesPluginState {
	const enabled = pluginRecord?.enabled;
	if (enabled === false) {
		return "disabled";
	}
	if (enabled === true || asRecord(pluginRecord?.instance) !== null) {
		return "enabled";
	}

	const enabledPlugins = internalPlugins?.enabledPlugins;
	if (enabledPlugins instanceof Set) {
		return enabledPlugins.has(DAILY_NOTES_PLUGIN_ID) ? "enabled" : "disabled";
	}
	if (Array.isArray(enabledPlugins)) {
		return enabledPlugins.includes(DAILY_NOTES_PLUGIN_ID) ? "enabled" : "disabled";
	}

	return "unknown";
}

function getDailyNotesOptions(pluginRecord: Record<string, unknown> | null): Record<string, unknown> | null {
	const instance = asRecord(pluginRecord?.instance);
	return (
		asRecord(instance?.options) ??
		asRecord(pluginRecord?.options) ??
		asRecord(instance?.settings) ??
		asRecord(pluginRecord?.settings)
	);
}

function getDefaultDailyNotesConfig(): DailyNotesConfig {
	return {
		folder: null,
		format: DEFAULT_DAILY_NOTES_FORMAT,
	};
}

function parseDailyNotesConfig(value: unknown, fallbackFormat: string | null): DailyNotesConfig | null {
	const record = asRecord(value);
	if (record === null) {
		return null;
	}

	const rawFormat = stringOrNull(record.format);
	const format = rawFormat?.trim() || fallbackFormat;
	if (format === null || format.trim().length === 0) {
		return null;
	}

	return {
		folder: normalizeFolder(stringOrNull(record.folder)),
		format: format.trim(),
	};
}

function normalizeFolder(value: string | null): string | null {
	const folder = value?.trim() ?? "";
	return folder.length === 0 ? null : normalizePath(folder);
}

function stringOrNull(value: unknown): string | null {
	return typeof value === "string" ? value : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
	return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
