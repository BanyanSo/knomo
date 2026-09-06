import { normalizePath } from "obsidian";

import type { CatalogStoreLifecycle } from "../types/catalog";
import { isRecord } from "../utils/object";

export const SHARED_IDENTITY_REPLICA_CACHE_META_KEY = "sharedReplicaCache.identity";
export const SHARED_CONFIG_REPLICA_CACHE_META_KEY = "sharedReplicaCache.config";
export const SHARED_REPLICA_CACHE_META_KEYS = [
	SHARED_IDENTITY_REPLICA_CACHE_META_KEY,
	SHARED_CONFIG_REPLICA_CACHE_META_KEY,
] as const;

export type SharedReplicaDomain = "identity" | "config";

export interface SharedReplicaCacheStore {
	getLifecycle(): CatalogStoreLifecycle;
	getMeta<T>(key: string): Promise<T | null>;
	setMeta<T>(key: string, value: T): Promise<void>;
}

interface SharedReplicaCacheEntry {
	rootPath: string;
	value: unknown[];
}

interface SharedReplicaCacheState {
	entries: SharedReplicaCacheEntry[];
}

export class SharedReplicaCache {
	private writeQueue: Promise<void> = Promise.resolve();

	constructor(private readonly store: SharedReplicaCacheStore) {}

	isDurable(): boolean {
		const lifecycle = this.store.getLifecycle();
		return lifecycle.persistent && lifecycle.writable;
	}

	async load(domain: SharedReplicaDomain, rootPath: string): Promise<unknown[] | null> {
		this.assertDurable();
		const state = await this.readState(domain);
		const entry = state.entries.find((candidate) => candidate.rootPath === normalizePath(rootPath));
		return entry === undefined ? null : clonePayload(entry.value);
	}

	save(domain: SharedReplicaDomain, rootPath: string, value: readonly unknown[]): Promise<void> {
		const normalizedRoot = normalizePath(rootPath);
		const payload = clonePayload(value);
		const operation = this.writeQueue.then(async () => {
			this.assertDurable();
			const state = await this.readState(domain);
			const entry = state.entries.find((candidate) => candidate.rootPath === normalizedRoot);
			if (entry === undefined) {
				state.entries.push({ rootPath: normalizedRoot, value: payload });
				state.entries.sort((left, right) => left.rootPath.localeCompare(right.rootPath));
			} else {
				entry.value = payload;
			}
			await this.store.setMeta(getMetaKey(domain), state);
		});
		this.writeQueue = operation.catch(() => undefined);
		return operation;
	}

	private async readState(domain: SharedReplicaDomain): Promise<SharedReplicaCacheState> {
		const value = await this.store.getMeta<unknown>(getMetaKey(domain));
		if (value === null) return { entries: [] };
		if (!isRecord(value) || !hasExactKeys(value, ["entries"]) || !Array.isArray(value.entries)) {
			throw new Error("Shared replica cache is invalid.");
		}
		const entries: SharedReplicaCacheEntry[] = [];
		const seenRoots = new Set<string>();
		for (const candidate of value.entries) {
			if (!isRecord(candidate)) throw new Error("Shared replica cache entry is invalid.");
			if (!hasExactKeys(candidate, ["rootPath", "value"])
				|| typeof candidate.rootPath !== "string"
				|| normalizePath(candidate.rootPath) !== candidate.rootPath
				|| candidate.rootPath.length === 0
				|| candidate.rootPath.startsWith("/")
				|| candidate.rootPath.includes("\\")
				|| candidate.rootPath.split("/").includes("..")
				|| !Array.isArray(candidate.value)
				|| seenRoots.has(candidate.rootPath)) {
				throw new Error("Shared replica cache entry is invalid.");
			}
			seenRoots.add(candidate.rootPath);
			entries.push({ rootPath: candidate.rootPath, value: clonePayload(candidate.value) });
		}
		return { entries };
	}

	private assertDurable(): void {
		if (!this.isDurable()) throw new Error("Shared replica cache is not durably available.");
	}
}

function getMetaKey(domain: SharedReplicaDomain): string {
	return domain === "identity" ? SHARED_IDENTITY_REPLICA_CACHE_META_KEY : SHARED_CONFIG_REPLICA_CACHE_META_KEY;
}

function clonePayload(value: readonly unknown[]): unknown[] {
	return JSON.parse(JSON.stringify(value)) as unknown[];
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
	const keys = Object.keys(value).sort();
	return keys.length === expected.length
		&& [...expected].sort().every((key, index) => keys[index] === key);
}
