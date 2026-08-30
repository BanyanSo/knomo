import { normalizePath, TFile, TFolder } from "obsidian";
import type { App, TAbstractFile } from "obsidian";

import type { IdentityLedgerEventEnvelope, IdentityLedgerSnapshot } from "../types/identityLedger";
import { normalizeVaultPath } from "../utils/path";
import { ensureFolder } from "../utils/vault";
import {
	canonicalIdentityLedgerJson,
	getIdentityLedgerRootPath,
	parseIdentityLedgerSegment,
} from "./IdentityLedgerProtocol";
import { IdentityLedgerService, materializeIdentityLedger } from "./IdentityLedgerService";

export interface KnomoDataRootLocation {
	knomoDataRoot: string;
	knomoDataRootConfigured: boolean;
}

export interface KnomoDataRootMigrationPlan {
	action: "initialize" | "adopt" | "migrate" | "unchanged";
	oldDataRoot: string;
	newDataRoot: string;
	oldIdentityRoot: string;
	newIdentityRoot: string;
}

export interface KnomoDataRootMigrationResult {
	status: "initialized" | "adopted" | "migrated" | "unchanged";
	plan: KnomoDataRootMigrationPlan;
}

type GetLocation = () => KnomoDataRootLocation;
type CommitLocation = (nextDataRoot: string) => Promise<void>;

export interface KnomoDataRootMigrationOptions {
	migrateSharedConfiguration?: (sourceDataRoot: string, targetDataRoot: string) => Promise<void>;
}

interface IdentityLedgerImage {
	files: Map<string, string>;
	snapshot: IdentityLedgerSnapshot;
}

/** 供首次启用默认初始化及用户明确修改设置时初始化、采用或迁移 Identity Ledger。 */
export class KnomoDataRootMigrationService {
	constructor(
		private readonly app: App,
		private readonly identityLedger: IdentityLedgerService,
		private readonly getLocation: GetLocation,
		private readonly commitLocation: CommitLocation,
		private readonly options: KnomoDataRootMigrationOptions = {},
	) {}

	async plan(nextDataRoot: string): Promise<KnomoDataRootMigrationPlan> {
		const location = this.getLocation();
		const oldDataRoot = normalizeVaultPath(location.knomoDataRoot);
		const newDataRoot = normalizeVaultPath(nextDataRoot);
		const oldIdentityRoot = getIdentityLedgerRootPath(oldDataRoot);
		const newIdentityRoot = getIdentityLedgerRootPath(newDataRoot);

		if (!location.knomoDataRootConfigured) {
			const target = await this.readTargetImage(newIdentityRoot);
			return {
				action: target === null ? "initialize" : "adopt",
				oldDataRoot,
				newDataRoot,
				oldIdentityRoot,
				newIdentityRoot,
			};
		}
		this.assertSeparateRoots(oldDataRoot, newDataRoot);

		const source = await this.readImage(oldIdentityRoot);
		if (oldIdentityRoot === newIdentityRoot) {
			if (source === null) throw new Error("The configured Identity Ledger root is missing.");
			return {
				action: "unchanged",
				oldDataRoot,
				newDataRoot,
				oldIdentityRoot,
				newIdentityRoot,
			};
		}

		if (source !== null) {
			await this.readTargetImage(newIdentityRoot);
			return {
				action: "migrate",
				oldDataRoot,
				newDataRoot,
				oldIdentityRoot,
				newIdentityRoot,
			};
		}

		const target = await this.readTargetImage(newIdentityRoot);
		if (target === null || target.files.size === 0) {
			throw new Error("The configured Identity Ledger root is missing and the selected target has no identity events.");
		}
		return {
			action: "adopt",
			oldDataRoot,
			newDataRoot,
			oldIdentityRoot,
			newIdentityRoot,
		};
	}

	async migrate(nextDataRoot: string): Promise<KnomoDataRootMigrationResult> {
		let result: KnomoDataRootMigrationResult | null = null;
		await this.identityLedger.runWithWritesPaused(async () => {
			const plan = await this.plan(nextDataRoot);
			switch (plan.action) {
				case "initialize":
					await ensureFolder(this.app, `${plan.newIdentityRoot}/writers`);
					await this.requireImage(plan.newIdentityRoot);
					await this.commitLocation(plan.newDataRoot);
					result = { status: "initialized", plan };
					break;
				case "adopt":
					await this.requireImage(plan.newIdentityRoot);
					await this.commitLocation(plan.newDataRoot);
					result = { status: "adopted", plan };
					break;
				case "migrate":
					await this.copyAndVerify(plan.oldIdentityRoot, plan.newIdentityRoot);
					await this.options.migrateSharedConfiguration?.(plan.oldDataRoot, plan.newDataRoot);
					await this.commitLocation(plan.newDataRoot);
					result = { status: "migrated", plan };
					break;
				case "unchanged":
					await this.commitLocation(plan.newDataRoot);
					result = { status: "unchanged", plan };
					break;
			}
			await this.identityLedger.initialize();
		});
		await this.identityLedger.reloadConfiguredRoot();
		if (result === null) throw new Error("Knomo data root migration did not produce a result.");
		return result;
	}

	private async copyAndVerify(sourceRoot: string, targetRoot: string): Promise<void> {
		const source = await this.requireImage(sourceRoot);
		const target = await this.readTargetImage(targetRoot);
		if (target !== null) this.assertTargetIsSourceSubset(source, target);
		await ensureFolder(this.app, `${targetRoot}/writers`);
		for (const [relativePath, content] of source.files) {
			const targetPath = normalizePath(`${targetRoot}/${relativePath}`);
			await ensureFolder(this.app, parentPath(targetPath));
			await this.writeImmutable(targetPath, content);
		}
		const stableSource = await this.requireImage(sourceRoot);
		if (!imagesEqual(source, stableSource)) {
			throw new Error("Identity Ledger source changed during migration; configuration was not updated.");
		}
		const verified = await this.requireImage(targetRoot);
		this.assertImagesEqual(source, verified);
	}

	private async readImage(rootPath: string): Promise<IdentityLedgerImage | null> {
		const root = this.app.vault.getAbstractFileByPath(normalizePath(rootPath));
		if (root === null) return null;
		if (!(root instanceof TFolder)) throw new Error(`Identity Ledger root is not a folder: ${rootPath}`);
		const files = listFiles(root).sort((left, right) => left.path.localeCompare(right.path));
		const contents = new Map<string, string>();
		const envelopes: IdentityLedgerEventEnvelope[] = [];
		for (const file of files) {
			if (file.extension !== "jsonl") {
				throw new Error(`Identity Ledger contains an unexpected file: ${file.path}`);
			}
			const content = await this.app.vault.cachedRead(file);
			const parsed = await parseIdentityLedgerSegment(rootPath, file.path, content);
			const relativePath = file.path.slice(normalizePath(rootPath).length + 1);
			contents.set(relativePath, content);
			envelopes.push(...parsed.events);
		}
		return {
			files: contents,
			snapshot: await materializeIdentityLedger(envelopes),
		};
	}

	private async requireImage(rootPath: string): Promise<IdentityLedgerImage> {
		const image = await this.readImage(rootPath);
		if (image === null) throw new Error(`Identity Ledger root is missing: ${rootPath}`);
		return image;
	}

	private async readTargetImage(rootPath: string): Promise<IdentityLedgerImage | null> {
		try {
			return await this.readImage(rootPath);
		} catch (error) {
			const detail = error instanceof Error ? error.message : String(error);
			throw new Error(`The target contains conflicting Identity Ledger bytes: ${detail}`);
		}
	}

	private assertTargetIsSourceSubset(source: IdentityLedgerImage, target: IdentityLedgerImage): void {
		for (const [path, targetContent] of target.files) {
			const sourceContent = source.files.get(path);
			if (sourceContent === undefined) {
				throw new Error(`The target contains Identity Ledger events absent from the source: ${path}`);
			}
			if (sourceContent !== targetContent) {
				throw new Error(`The target contains conflicting Identity Ledger bytes: ${path}`);
			}
		}
	}

	private assertImagesEqual(source: IdentityLedgerImage, target: IdentityLedgerImage): void {
		if (source.files.size !== target.files.size) {
			throw new Error("Identity Ledger migration verification found an incomplete target.");
		}
		for (const [path, sourceContent] of source.files) {
			if (target.files.get(path) !== sourceContent) {
				throw new Error(`Identity Ledger migration byte verification failed: ${path}`);
			}
		}
		if (canonicalIdentityLedgerJson(source.snapshot) !== canonicalIdentityLedgerJson(target.snapshot)) {
			throw new Error("Identity Ledger migration reducer verification failed.");
		}
	}

	private assertSeparateRoots(sourceRoot: string, targetRoot: string): void {
		if (sourceRoot === targetRoot) return;
		if (sourceRoot.startsWith(`${targetRoot}/`) || targetRoot.startsWith(`${sourceRoot}/`)) {
			throw new Error("Knomo data root migration cannot use nested source and target roots.");
		}
	}

	private async writeImmutable(path: string, content: string): Promise<void> {
		const existing = this.app.vault.getAbstractFileByPath(path);
		if (existing instanceof TFile) {
			if (await this.app.vault.cachedRead(existing) !== content) {
				throw new Error(`The target contains conflicting Identity Ledger bytes: ${path}`);
			}
			return;
		}
		if (existing !== null) throw new Error(`Identity Ledger target path is not a file: ${path}`);
		try {
			await this.app.vault.create(path, content);
		} catch (error) {
			const raced = this.app.vault.getAbstractFileByPath(path);
			if (!(raced instanceof TFile) || await this.app.vault.cachedRead(raced) !== content) throw error;
		}
	}
}

function listFiles(root: TFolder): TFile[] {
	const files: TFile[] = [];
	const visit = (file: TAbstractFile) => {
		if (file instanceof TFile) files.push(file);
		if (file instanceof TFolder) file.children.forEach(visit);
	};
	root.children.forEach(visit);
	return files;
}

function parentPath(path: string): string {
	const separator = path.lastIndexOf("/");
	return separator < 0 ? "" : path.slice(0, separator);
}

function imagesEqual(left: IdentityLedgerImage, right: IdentityLedgerImage): boolean {
	if (left.files.size !== right.files.size) return false;
	for (const [path, content] of left.files) {
		if (right.files.get(path) !== content) return false;
	}
	return canonicalIdentityLedgerJson(left.snapshot) === canonicalIdentityLedgerJson(right.snapshot);
}
