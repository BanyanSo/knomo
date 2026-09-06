import { normalizePath, TFile, TFolder } from "obsidian";
import type { App } from "obsidian";

import type { IdentityLedgerSnapshot } from "../types/identityLedger";
import { isRecord } from "../utils/object";
import { normalizeVaultPath } from "../utils/path";
import { ensureFolder } from "../utils/vault";
import {
	canonicalIdentityLedgerJson,
	isIdentityLedgerWriterId,
	sha256IdentityLedgerText,
} from "./IdentityLedgerProtocol";

const RECEIPT_RELATIVE_ROOT = "_knomo-data/receipts";

export interface IdentityReceiptStoreOptions {
	getRootPath: () => string | null;
	getWriterId: () => Promise<string>;
	getKnownIdentityEventIds: () => readonly string[];
	getIdentitySnapshot?: () => IdentityLedgerSnapshot;
	legacyReceiptStore?: { getMeta<T>(key: string): Promise<T | null> };
}

interface SharedIdentityReceipt {
	eventId: string;
	writerId: string;
	key: "historicalIdentityBootstrap" | "legacyMigrationCompletion";
	value: Record<string, unknown>;
}

// 职责：把低频授权与完成事实保存为普通不可变共享记录；IndexedDB 只可缓存，不能成为事实来源。
export class IdentityReceiptStore {
	constructor(private readonly app: App, private readonly options: IdentityReceiptStoreOptions) {}

	async getMeta<T>(key: string): Promise<T | null> {
		const values = await this.getMetaValues<T>(key);
		return values[values.length - 1] ?? null;
	}

	async getMetaValues<T>(key: string): Promise<T[]> {
		if (key !== "historicalIdentityBootstrap" && key !== "legacyMigrationCompletion") return [];
		const receipts = (await this.loadReceipts()).filter((receipt) => receipt.key === key);
		if (key === "legacyMigrationCompletion") {
			const values = receipts.filter((receipt) => this.dependenciesAvailable(receipt.value)).map((receipt) => receipt.value as T);
			return values.length > 0 ? values : this.promoteLegacyReceipt<T>(key);
		}
		const completed = receipts.filter((receipt) => receipt.value.state === "completed"
			&& this.dependenciesAvailable(receipt.value));
		if (completed.length > 0) return completed.map((receipt) => receipt.value as T);
		const configuredRoot = this.options.getRootPath();
		const rootPath = configuredRoot === null ? null : normalizeVaultPath(configuredRoot);
		const authorized = receipts.filter((receipt) => receipt.value.state === "pending"
			&& receipt.value.reason === "initial_import" && receipt.value.authorizationRoot === rootPath)
			.map((receipt) => receipt.value as T);
		return authorized.length > 0 ? authorized : this.promoteLegacyReceipt<T>(key);
	}

	async setMeta(key: string, value: unknown): Promise<void> {
		if ((key !== "historicalIdentityBootstrap" && key !== "legacyMigrationCompletion") || !isRecord(value)) {
			throw new Error("Unsupported shared Identity receipt.");
		}
		const rootPath = this.requireRootPath();
		const writerId = await this.options.getWriterId();
		if (!isIdentityLedgerWriterId(writerId)) throw new Error("Invalid Identity receipt writerId.");
		const sharedValue = this.withIdentityDependencies(value);
		const semantic = canonicalIdentityLedgerJson({ key, value: sharedValue, writerId });
		const semanticDigest = await sha256IdentityLedgerText(semantic);
		const receipt: SharedIdentityReceipt = { eventId: `e_${semanticDigest.slice(0, 32)}`, writerId, key, value: sharedValue };
		const content = `${canonicalIdentityLedgerJson(receipt)}\n`;
		const digest = await sha256IdentityLedgerText(content);
		const directory = normalizePath(`${rootPath}/${RECEIPT_RELATIVE_ROOT}/writers/${writerId}/records`);
		const path = normalizePath(`${directory}/receipt-${receipt.eventId}-${digest}.json`);
		await ensureFolder(this.app, directory);
		await this.writeImmutable(path, content);
	}

	// 不可变记录不删除；调用者按 sourceId/sourceRevision 选择适用的完成事实。
	deleteMeta(_key: string): Promise<void> {
		return Promise.resolve();
	}

	private withIdentityDependencies(value: Record<string, unknown>): Record<string, unknown> {
		if (value.state === "completed" || Array.isArray(value.importedMemoIds)) {
			const provided = Array.isArray(value.requiredIdentityEventIds)
				? value.requiredIdentityEventIds.filter((eventId): eventId is string => typeof eventId === "string")
				: this.options.getKnownIdentityEventIds();
			return { ...value, requiredIdentityEventIds: [...new Set(provided)].sort() };
		}
		return { ...value };
	}

	private dependenciesAvailable(value: Record<string, unknown>): boolean {
		if (!Array.isArray(value.requiredIdentityEventIds)
			|| value.requiredIdentityEventIds.some((eventId) => typeof eventId !== "string")) return false;
		const available = new Set(this.options.getKnownIdentityEventIds());
		return value.requiredIdentityEventIds.every((eventId) => available.has(eventId));
	}

	private async promoteLegacyReceipt<T>(key: SharedIdentityReceipt["key"]): Promise<T[]> {
		const value = await this.options.legacyReceiptStore?.getMeta<unknown>(key) ?? null;
		if (!isRecord(value) || !this.legacyReceiptIsSupported(key, value)) return [];
		await this.setMeta(key, value);
		return this.getMetaValues<T>(key);
	}

	private legacyReceiptIsSupported(key: SharedIdentityReceipt["key"], value: Record<string, unknown>): boolean {
		if (key === "historicalIdentityBootstrap") {
			if (value.state === "pending") {
				const configuredRoot = this.options.getRootPath();
				return value.reason === "initial_import" && configuredRoot !== null
					&& value.authorizationRoot === normalizeVaultPath(configuredRoot);
			}
			if (value.state !== "completed") return false;
			const snapshot = this.options.getIdentitySnapshot?.();
			return snapshot !== undefined && snapshot.quarantinedEventIds.length === 0
				&& Object.values(snapshot.memos).every((memo) => !memo.conflicted);
		}
		if (!Array.isArray(value.importedMemoIds)) return false;
		const snapshot = this.options.getIdentitySnapshot?.();
		return snapshot !== undefined && value.importedMemoIds.every((memoId) => typeof memoId === "string"
			&& snapshot.memos[memoId]?.conflicted === false);
	}

	private async loadReceipts(): Promise<SharedIdentityReceipt[]> {
		const configuredRoot = this.options.getRootPath();
		if (configuredRoot === null) return [];
		const rootPath = normalizeVaultPath(configuredRoot);
		const root = this.app.vault.getAbstractFileByPath(normalizePath(`${rootPath}/${RECEIPT_RELATIVE_ROOT}`));
		if (root === null) return [];
		if (!(root instanceof TFolder)) throw new Error("Identity receipt root is not a folder.");
		const receipts = new Map<string, SharedIdentityReceipt | null>();
		for (const file of listFiles(root).sort((left, right) => left.path.localeCompare(right.path))) {
			try {
				const receipt = await parseReceipt(rootPath, file.path, await this.app.vault.cachedRead(file));
				const existing = receipts.get(receipt.eventId);
				if (existing === undefined) {
					receipts.set(receipt.eventId, receipt);
				} else if (existing !== null && canonicalIdentityLedgerJson(existing) !== canonicalIdentityLedgerJson(receipt)) {
					receipts.set(receipt.eventId, null);
				}
			} catch {
				// 单个损坏或未完整同步的记录不授权初始化，也不遮蔽其余已验证事实。
			}
		}
		return [...receipts.values()].filter((receipt): receipt is SharedIdentityReceipt => receipt !== null)
			.sort((left, right) => left.eventId.localeCompare(right.eventId));
	}

	private requireRootPath(): string {
		const rootPath = this.options.getRootPath();
		if (rootPath === null) throw new Error("Identity receipt root is not configured.");
		return normalizeVaultPath(rootPath);
	}

	private async writeImmutable(path: string, content: string): Promise<void> {
		const existing = this.app.vault.getAbstractFileByPath(path);
		if (existing instanceof TFile) {
			if (await this.app.vault.cachedRead(existing) === content) return;
			throw new Error(`Identity receipt path collision: ${path}`);
		}
		if (existing !== null) throw new Error(`Identity receipt path is not a file: ${path}`);
		try {
			await this.app.vault.create(path, content);
		} catch (error) {
			const raced = this.app.vault.getAbstractFileByPath(path);
			if (raced instanceof TFile && await this.app.vault.cachedRead(raced) === content) return;
			throw error;
		}
		const written = this.app.vault.getAbstractFileByPath(path);
		if (!(written instanceof TFile) || await this.app.vault.cachedRead(written) !== content) {
			throw new Error("Identity receipt was not durably verified.");
		}
	}
}

async function parseReceipt(rootPath: string, path: string, content: string): Promise<SharedIdentityReceipt> {
	const prefix = normalizePath(`${rootPath}/${RECEIPT_RELATIVE_ROOT}/writers`);
	const normalizedPath = normalizePath(path);
	const relative = normalizedPath.startsWith(`${prefix}/`) ? normalizedPath.slice(prefix.length + 1).split("/") : [];
	const match = /^receipt-(e_[a-f0-9]{32})-([a-f0-9]{64})\.json$/u.exec(relative[2] ?? "");
	if (relative.length !== 3 || relative[1] !== "records" || !isIdentityLedgerWriterId(relative[0]) || match === null
		|| !content.endsWith("\n") || await sha256IdentityLedgerText(content) !== match[2]) {
		throw new Error("Invalid Identity receipt.");
	}
	const value = JSON.parse(content.slice(0, -1)) as unknown;
	assertReceipt(value);
	if (value.writerId !== relative[0] || value.eventId !== match[1]
		|| `${canonicalIdentityLedgerJson(value)}\n` !== content) throw new Error("Invalid Identity receipt content.");
	return value;
}

function assertReceipt(value: unknown): asserts value is SharedIdentityReceipt {
	if (!isRecord(value) || Object.keys(value).sort().join(",") !== "eventId,key,value,writerId"
		|| !/^e_[a-f0-9]{32}$/u.test(typeof value.eventId === "string" ? value.eventId : "")
		|| !isIdentityLedgerWriterId(value.writerId)
		|| (value.key !== "historicalIdentityBootstrap" && value.key !== "legacyMigrationCompletion") || !isRecord(value.value)) {
		throw new Error("Invalid Identity receipt record.");
	}
}

function listFiles(folder: TFolder): TFile[] {
	return folder.children.flatMap((child) => child instanceof TFile ? [child] : child instanceof TFolder ? listFiles(child) : []);
}
