import { normalizePath, TFile, TFolder } from "obsidian";
import type { App } from "obsidian";

import type {
	CatalogV2LegacyCleanupClass,
	CatalogV2LegacyRetiredReceipt,
	CatalogV2LegacyV2Receipt,
	LegacyArtifactReceipt,
	MigrationCommit,
} from "../types/catalogV2";
import { sha256Bytes } from "./CatalogV2Protocol";
import { classifyLegacyArtifactPath } from "./LegacyArtifactInventory";

export interface CatalogV2LegacyCleanupResult {
	retired: CatalogV2LegacyRetiredReceipt[];
	failedPaths: string[];
	skippedPaths: string[];
	rootRetired: boolean;
}

export class CatalogV2LegacyCleanupService {
	constructor(
		private readonly app: App,
		private readonly legacySystemRoot: string,
		private readonly now: () => Date = () => new Date(),
	) {}

	async retireFiles(input: {
		commit: MigrationCommit | null;
		receipts: readonly LegacyArtifactReceipt[];
		legacyV2Receipts: readonly CatalogV2LegacyV2Receipt[];
		allowPendingCreate: boolean;
	}): Promise<CatalogV2LegacyCleanupResult> {
		const result = createCleanupResult();
		for (const receipt of [...input.receipts].sort((left, right) => left.path.localeCompare(right.path))) {
			try {
				const cleanupClass = classifyCleanupClass(this.legacySystemRoot, receipt.path);
				if (cleanupClass === null || receipt.disposition !== "imported" || receipt.requiredArtifact === null
					|| (cleanupClass === "legacy_pending_create" && !input.allowPendingCreate)
					|| input.commit === null || !commitCoversReceipt(input.commit, receipt)) {
					result.skippedPaths.push(receipt.path);
					continue;
				}
				if (!await this.trashVerifiedFile(receipt.path, receipt.sha256, receipt.byteLength)) {
					result.skippedPaths.push(receipt.path);
					continue;
				}
				result.retired.push(this.createReceipt(receipt.path, receipt.sha256, cleanupClass));
			} catch {
				result.failedPaths.push(receipt.path);
			}
		}
		for (const receipt of [...input.legacyV2Receipts].sort((left, right) => left.sourcePath.localeCompare(right.sourcePath))) {
			try {
				if (!await this.verifyTarget(receipt)
					|| !await this.trashVerifiedFile(receipt.sourcePath, receipt.sourceSha256, receipt.sourceByteLength)) {
					result.skippedPaths.push(receipt.sourcePath);
					continue;
				}
				result.retired.push(this.createReceipt(receipt.sourcePath, receipt.sourceSha256, "legacy_v2_artifact"));
			} catch {
				result.failedPaths.push(receipt.sourcePath);
			}
		}
		return normalizeResult(result);
	}

	async retireEmptyDirectories(input: { allowSystemRoot: boolean }): Promise<CatalogV2LegacyCleanupResult> {
		const result = createCleanupResult();
		const paths = this.getAllowedDirectoryPaths();
		for (const path of paths) {
			try {
				const folder = this.app.vault.getAbstractFileByPath(path);
				if (!(folder instanceof TFolder)) continue;
				if (folder.children.length !== 0) {
					result.skippedPaths.push(path);
					continue;
				}
				await this.app.fileManager.trashFile(folder);
				result.retired.push(this.createReceipt(path, null, "legacy_empty_directory"));
			} catch {
				result.failedPaths.push(path);
			}
		}
		const rootPath = normalizePath(this.legacySystemRoot);
		const root = this.app.vault.getAbstractFileByPath(rootPath);
		if (input.allowSystemRoot && root instanceof TFolder) {
			if (root.children.length === 0) {
				try {
					await this.app.fileManager.trashFile(root);
					result.retired.push(this.createReceipt(rootPath, null, "legacy_empty_system_root"));
					result.rootRetired = true;
				} catch {
					result.failedPaths.push(rootPath);
				}
			} else {
				result.skippedPaths.push(rootPath);
			}
		}
		return normalizeResult(result);
	}

	private async trashVerifiedFile(path: string, sha256: string, byteLength: number): Promise<boolean> {
		const normalizedPath = normalizePath(path);
		if (!normalizedPath.startsWith(`${normalizePath(this.legacySystemRoot).replace(/\/$/u, "")}/`)) return false;
		const file = this.app.vault.getAbstractFileByPath(normalizedPath);
		if (!(file instanceof TFile)) return false;
		const bytes = new Uint8Array(await this.app.vault.readBinary(file));
		if (bytes.byteLength !== byteLength || await sha256Bytes(bytes) !== sha256) return false;
		await this.app.fileManager.trashFile(file);
		return true;
	}

	private async verifyTarget(receipt: CatalogV2LegacyV2Receipt): Promise<boolean> {
		const file = this.app.vault.getAbstractFileByPath(normalizePath(receipt.target.path));
		if (!(file instanceof TFile)) return false;
		const bytes = new Uint8Array(await this.app.vault.readBinary(file));
		return bytes.byteLength === receipt.target.byteLength && await sha256Bytes(bytes) === receipt.target.sha256;
	}

	private getAllowedDirectoryPaths(): string[] {
		const root = normalizePath(this.legacySystemRoot).replace(/\/$/u, "");
		const relativePaths = [
			"indexes/time-buoy",
			"v2/state/writers",
			"v2/state/snapshots",
			"v2/state/compactions",
			"v2/state/deleted",
			"v2/state",
			"v2/migrations/imports",
			"v2/migrations/commits",
			"v2/migrations/quarantine",
			"v2/migrations",
			"v2/tmp",
			"v2",
			"indexes",
		];
		const dynamicPaths = this.listAllowedDynamicDirectories(root);
		return [...new Set([...relativePaths.map((path) => normalizePath(`${root}/${path}`)), ...dynamicPaths])]
			.sort((left, right) => pathDepth(right) - pathDepth(left) || left.localeCompare(right));
	}

	private listAllowedDynamicDirectories(root: string): string[] {
		const values: string[] = [];
		for (const relativeRoot of ["v2/state/writers", "v2/state/snapshots", "v2/state/deleted"]) {
			const folder = this.app.vault.getAbstractFileByPath(normalizePath(`${root}/${relativeRoot}`));
			if (!(folder instanceof TFolder)) continue;
			for (const child of folder.children) {
				if (!(child instanceof TFolder)) continue;
				if (relativeRoot.endsWith("deleted") || /^w_[a-f0-9]{32}$/u.test(child.name)) values.push(child.path);
			}
		}
		return values;
	}

	private createReceipt(
		path: string,
		sha256: string | null,
		cleanupClass: CatalogV2LegacyCleanupClass,
	): CatalogV2LegacyRetiredReceipt {
		return { path, sha256, cleanupClass, retiredAt: this.now().toISOString() };
	}
}

export function classifyCleanupClass(legacySystemRoot: string, path: string): CatalogV2LegacyCleanupClass | null {
	const classification = classifyLegacyArtifactPath(legacySystemRoot, path);
	if (classification?.artifactKind === "memo_index") return "legacy_memo_index";
	if (classification?.artifactKind === "time_buoy_index" || classification?.artifactKind === "time_buoy_state") {
		return "legacy_time_buoy";
	}
	if (classification?.artifactKind === "pending_create") return "legacy_pending_create";
	return null;
}

function commitCoversReceipt(commit: MigrationCommit, receipt: LegacyArtifactReceipt): boolean {
	const source = commit.legacySources.find((candidate) =>
		candidate.artifactKind === receipt.artifactKind
		&& candidate.artifactDigest === receipt.sha256
		&& candidate.disposition === "imported");
	return source !== undefined && receipt.requiredArtifact !== null
		&& source.receipt.path === receipt.requiredArtifact.path
		&& source.receipt.sha256 === receipt.requiredArtifact.sha256
		&& source.receipt.byteLength === receipt.requiredArtifact.byteLength;
}

function createCleanupResult(): CatalogV2LegacyCleanupResult {
	return { retired: [], failedPaths: [], skippedPaths: [], rootRetired: false };
}

function normalizeResult(result: CatalogV2LegacyCleanupResult): CatalogV2LegacyCleanupResult {
	return {
		retired: result.retired,
		failedPaths: [...new Set(result.failedPaths)].sort(),
		skippedPaths: [...new Set(result.skippedPaths)].sort(),
		rootRetired: result.rootRetired,
	};
}

function pathDepth(path: string): number {
	return normalizePath(path).split("/").length;
}
