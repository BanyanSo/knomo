import type { App } from "obsidian";

import { getSystemFolderPath } from "../utils/path";

interface VaultConfigAccess {
	getConfig?: (key: string) => unknown;
	setConfig?: (key: string, value: unknown) => Promise<void> | void;
	config?: Record<string, unknown>;
}

const EXCLUDE_RULES_CONFIG_KEY = "userIgnoreFilters";

export class ObsidianExcludeService {
	constructor(private readonly app: App) {}

	getExcludeRules(): string[] {
		const value = this.getConfigValue();
		return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
	}

	async setExcludeRules(rules: string[]): Promise<void> {
		const uniqueRules = [...new Set(rules)];
		const vault = this.getVaultConfigAccess();
		if (typeof vault.setConfig !== "function") {
			throw new Error("This Obsidian environment does not support automatic exclude rule updates.");
		}
		await vault.setConfig(EXCLUDE_RULES_CONFIG_KEY, uniqueRules);
	}

	hasRule(rule: string): boolean {
		return this.getExcludeRules().includes(rule);
	}

	async ensureRule(rule: string): Promise<{ addedByKnomo: boolean }> {
		const rules = this.getExcludeRules();
		if (rules.includes(rule)) {
			return { addedByKnomo: false };
		}
		await this.setExcludeRules([...rules, rule]);
		return { addedByKnomo: true };
	}

	async removeRule(rule: string): Promise<void> {
		const rules = this.getExcludeRules();
		if (!rules.includes(rule)) {
			return;
		}
		await this.setExcludeRules(rules.filter((item) => item !== rule));
	}

	private getConfigValue(): unknown {
		const vault = this.getVaultConfigAccess();
		if (typeof vault.getConfig === "function") {
			return vault.getConfig(EXCLUDE_RULES_CONFIG_KEY);
		}
		return vault.config?.[EXCLUDE_RULES_CONFIG_KEY];
	}

	private getVaultConfigAccess(): VaultConfigAccess {
		return this.app.vault as unknown as VaultConfigAccess;
	}
}

export function buildMonthlyFolderExcludeRule(monthlyMemoFolder: string): string | null {
	return buildFolderExcludeRule(monthlyMemoFolder);
}

export function buildSystemFolderExcludeRule(monthlyMemoFolder: string): string {
	return `${getSystemFolderPath(monthlyMemoFolder)}/`;
}

function buildFolderExcludeRule(folderPath: string): string | null {
	const folder = folderPath
		.trim()
		.replace(/\\/g, "/")
		.replace(/\/+/g, "/")
		.replace(/^\/+|\/+$/g, "");
	return folder.length === 0 ? null : `${folder}/`;
}
