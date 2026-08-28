import { normalizePath } from "obsidian";

import type { CatalogInventoryEntry } from "../types/catalog";
import type { DailyNotesConfig } from "./DailyNoteService";

// 职责：共享按月份分组的 Daily 文件清单，避免每个 Monthly 都重新遍历 Vault。
export class DailyInventoryIndex {
	private readonly byPath = new Map<string, CatalogInventoryEntry>();
	private readonly pathsByPeriod = new Map<string, Set<string>>();
	private scopeKey: string | null = null;

	replace(entries: readonly CatalogInventoryEntry[], scopeKey: string): void {
		this.byPath.clear();
		this.pathsByPeriod.clear();
		for (const entry of entries) this.upsertEntry(entry);
		this.scopeKey = scopeKey;
	}

	upsert(entry: CatalogInventoryEntry): void {
		this.remove(entry.sourcePath);
		this.upsertEntry(entry);
	}

	remove(sourcePath: string): CatalogInventoryEntry | null {
		const normalizedPath = normalizePath(sourcePath);
		const existing = this.byPath.get(normalizedPath);
		if (existing === undefined) return null;
		this.byPath.delete(normalizedPath);
		const period = existing.logicalDate.slice(0, 7);
		const paths = this.pathsByPeriod.get(period);
		paths?.delete(normalizedPath);
		if (paths?.size === 0) this.pathsByPeriod.delete(period);
		return existing;
	}

	get(sourcePath: string): CatalogInventoryEntry | null {
		return this.byPath.get(normalizePath(sourcePath)) ?? null;
	}

	listPeriod(period: string): CatalogInventoryEntry[] {
		return [...(this.pathsByPeriod.get(period) ?? [])]
			.flatMap((path) => {
				const entry = this.byPath.get(path);
				return entry === undefined ? [] : [{ ...entry }];
			})
			.sort((left, right) => left.sourcePath.localeCompare(right.sourcePath));
	}

	listPeriods(): string[] {
		return [...this.pathsByPeriod.keys()].sort();
	}

	hasPeriod(period: string): boolean {
		return (this.pathsByPeriod.get(period)?.size ?? 0) > 0;
	}

	hasScope(scopeKey: string): boolean {
		return this.scopeKey === scopeKey;
	}

	private upsertEntry(entry: CatalogInventoryEntry): void {
		const normalizedEntry = { ...entry, sourcePath: normalizePath(entry.sourcePath) };
		this.byPath.set(normalizedEntry.sourcePath, normalizedEntry);
		const period = normalizedEntry.logicalDate.slice(0, 7);
		const paths = this.pathsByPeriod.get(period) ?? new Set<string>();
		paths.add(normalizedEntry.sourcePath);
		this.pathsByPeriod.set(period, paths);
	}
}

export function buildDailyInventoryScopeKey(config: DailyNotesConfig): string {
	return JSON.stringify({
		folder: normalizePath(config.folder ?? ""),
		format: config.format,
	});
}
