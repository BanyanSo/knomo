import type { App, Events } from "obsidian";

import { KnomoError } from "../types/serviceError";

interface VaultConfigAccess {
	getConfig?: (key: string) => unknown;
	setConfig?: (key: string, value: unknown) => Promise<void> | void;
	config?: Record<string, unknown>;
}

const EXCLUDE_RULES_CONFIG_KEY = "userIgnoreFilters";

interface ExcludeMatcherAccess {
	updateUserIgnoreFilters?: () => void;
	isUserIgnored?: (path: string) => boolean;
}

export interface TagCandidatePolicy {
	fingerprint: string;
	isIgnored: (path: string) => boolean;
}

const excludeListeners = new WeakMap<App, Set<() => void>>();

export class ObsidianExcludeService {
	constructor(private readonly app: App) {}

	getExcludeRules(): string[] {
		const value = this.getConfigValue();
		return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
	}

	// 内部宿主能力集中在此边界；未知配置不能被当成空规则。
	readTagCandidatePolicy(): TagCandidatePolicy {
		const value = this.getConfigValue();
		if (value !== null && (!Array.isArray(value) || !value.every(item => typeof item === "string"))) {
			throw new Error("Obsidian tag exclusions could not be read.");
		}
		const rules: string[] = value ?? [];
		const fingerprint = JSON.stringify(rules);
		if (rules.length === 0) return { fingerprint, isIgnored: () => false };
		const matcher = this.app.metadataCache as ExcludeMatcherAccess;
		if (typeof matcher.updateUserIgnoreFilters !== "function" || typeof matcher.isUserIgnored !== "function") {
			throw new Error("This Obsidian version does not provide the tag exclusion matcher.");
		}
		// setConfig 与监听回调的先后顺序不构成匹配缓存已更新的保证。
		matcher.updateUserIgnoreFilters();
		return { fingerprint, isIgnored: path => {
			const ignored = matcher.isUserIgnored!(path);
			if (typeof ignored !== "boolean") throw new Error("Obsidian tag exclusion matcher returned an invalid result.");
			return ignored;
		} };
	}

	subscribe(listener: () => void): () => void {
		let listeners = excludeListeners.get(this.app);
		if (!listeners) excludeListeners.set(this.app, listeners = new Set());
		listeners.add(listener);
		const vault = this.app.vault as Events;
		const ref = vault.on("config-changed", (key: unknown) => {
			if (key === EXCLUDE_RULES_CONFIG_KEY) listener();
		});
		return () => { listeners.delete(listener); vault.offref(ref); };
	}

	async setExcludeRules(rules: string[]): Promise<void> {
		const uniqueRules = [...new Set(rules)];
		const vault = this.getVaultConfigAccess();
		if (typeof vault.setConfig !== "function") {
			throw new KnomoError("auto_exclude_unsupported");
		}
		await vault.setConfig(EXCLUDE_RULES_CONFIG_KEY, uniqueRules);
		for (const listener of excludeListeners.get(this.app) ?? []) listener();
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

function buildFolderExcludeRule(folderPath: string): string | null {
	const folder = folderPath
		.trim()
		.replace(/\\/g, "/")
		.replace(/\/+/g, "/")
		.replace(/^\/+|\/+$/g, "");
	return folder.length === 0 ? null : `${folder}/`;
}
