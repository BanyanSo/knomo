import { normalizePath, TFile, TFolder } from "obsidian";
import type { App } from "obsidian";

import type {
	DeletedMemoPayload,
	LegacyArtifactInput,
	LegacyImportResult,
	MigrationPackage,
	StateOperationEnvelope,
} from "../types/catalogV2";
import type {
	LegacyIdentityImportDiagnostic,
	LegacyIdentitySource,
	LegacyIdentitySourceResult,
	VerifiedLegacyIdentitySnapshot,
} from "../types/legacyIdentityImport";
import { getCatalogDataRootPath, getCatalogUpgradeCheckpointsRootPath, getLegacySystemRootPath } from "../utils/path";
import { canonicalJson, canonicalJsonFileBytes, sha256Bytes, sha256Text } from "./CatalogV2Protocol";
import { CatalogV2DeletedPayloadStore } from "./CatalogV2DeletedPayloadStore";
import { CatalogV2LegacyImporter } from "./CatalogV2LegacyImporter";
import { CatalogV2MigrationArtifactStore } from "./CatalogV2MigrationArtifactStore";
import { CatalogV2MigrationReducer } from "./CatalogV2Migration";
import { CatalogV2StateReducer } from "./CatalogV2StateReducer";
import { CatalogV2VaultProtocol } from "./CatalogV2VaultProtocol";
import { classifyLegacyArtifactPath } from "./LegacyArtifactInventory";

export class CatalogV2ReadOnlyCompatibilitySource implements LegacyIdentitySource {
	private readonly protocol: CatalogV2VaultProtocol;

	constructor(
		private readonly app: App,
		private readonly pluginId: string,
		private readonly getKnomoDataRoot: () => string | null,
		protocol?: CatalogV2VaultProtocol,
	) {
		this.protocol = protocol ?? new CatalogV2VaultProtocol(app);
	}

	async load(): Promise<LegacyIdentitySourceResult> {
		const knomoDataRoot = this.getConfiguredRoot();
		if (knomoDataRoot === null) return { kind: "missing" };
		const catalogDataRoot = getCatalogDataRootPath(knomoDataRoot);
		const context = await this.protocol.loadConfiguredVaultContext(catalogDataRoot);
		if (context.kind === "ready") return this.loadCatalogV2(context.context, catalogDataRoot);
		if (context.kind !== "missing") {
			return {
				kind: "attention",
				diagnostics: context.kind === "awaiting_data"
					? context.missingPaths.map((path) => diagnostic("v2_missing_artifact", path, null, "A legacy V2 artifact is not fully available."))
					: context.reasons.map((reason) => diagnostic("v2_context_attention", null, null, reason)),
			};
		}
		return this.loadRawLegacy(knomoDataRoot);
	}

	isSourcePath(path: string): boolean {
		const root = this.getConfiguredRoot();
		if (root === null) return false;
		const normalized = normalizePath(path);
		const catalogRoot = getCatalogDataRootPath(root);
		const legacyRoot = getLegacySystemRootPath(root);
		return normalized === "_knomo-data/manifest.json"
			|| normalized.startsWith(`${catalogRoot}/protocol/`)
			|| normalized.startsWith(`${catalogRoot}/state/`)
			|| normalized.startsWith(`${catalogRoot}/upgrade/`)
			|| normalized.startsWith(`${legacyRoot}/`);
	}

	private async loadCatalogV2(
		context: Extract<Awaited<ReturnType<CatalogV2VaultProtocol["loadConfiguredVaultContext"]>>, { kind: "ready" }>["context"],
		catalogDataRoot: string,
	): Promise<LegacyIdentitySourceResult> {
		const selection = await this.protocol.selectGeneration(context);
		if (selection.kind !== "verified") {
			return {
				kind: "attention",
				diagnostics: generationDiagnostics(selection),
			};
		}
		const envelopes: StateOperationEnvelope[] = await Promise.all(selection.value.operations.map(async (operation) => ({
			operation,
			digest: await sha256Text(canonicalJson(operation)),
			sourcePath: `catalog-v2:${operation.opId}`,
		})));
		const eventState = await new CatalogV2StateReducer().reduce(envelopes);
		eventState.fileRevisionTransitions = collectRevisionTransitions(selection.value);
		const packages = await this.loadMigrationPackages(catalogDataRoot, selection.value.generation.migrationCommit?.path ?? null);
		if (packages.kind === "attention") return packages;
		const state = await new CatalogV2MigrationReducer().reduce(packages.values, eventState);
		const payloads = await this.loadDeletedPayloads(catalogDataRoot, state);
		return {
			kind: "ready",
			snapshot: {
				sourceKind: "catalog_v2",
				sourceId: context.bootstrap.vaultInstanceId,
				sourceRevision: selection.value.generationRef.sha256,
				state,
				operations: [...selection.value.operations],
				deletedPayloads: payloads.values,
				diagnostics: payloads.diagnostics,
			},
		};
	}

	private async loadRawLegacy(knomoDataRoot: string): Promise<LegacyIdentitySourceResult> {
		const inputs = await this.collectLegacyInputs(knomoDataRoot);
		if (inputs.length === 0) return { kind: "missing" };
		const importer = new CatalogV2LegacyImporter();
		const results = await Promise.all(inputs.map((input) => importer.importArtifact(input)));
		const packages = results.flatMap((result) => result.kind === "imported" ? [result.package] : []);
		const quarantined = results.flatMap((result) => result.kind === "quarantined"
			? [diagnostic("legacy_artifact_quarantined", result.inventory.path, null, result.receipt.errorCode)]
			: []);
		if (packages.length === 0) return { kind: "attention", diagnostics: quarantined };
		const state = await new CatalogV2MigrationReducer().reduce(packages);
		const deletedPayloads = Object.fromEntries(results.flatMap((result) => result.kind === "imported"
			? result.deletedPayloads.map((payload) => [payload.payload.deleteOpId, payload.payload] as const)
			: []));
		const sourceRevision = await sha256Text(canonicalJson(results.map((result) => result.kind === "imported"
			? result.receipt.sha256
			: result.receipt.artifactDigest).sort()));
		return {
			kind: "ready",
			snapshot: {
				sourceKind: "legacy",
				sourceId: `legacy:${normalizePath(knomoDataRoot)}`,
				sourceRevision,
				state,
				operations: [],
				deletedPayloads,
				diagnostics: quarantined,
			},
		};
	}

	private async loadMigrationPackages(
		catalogDataRoot: string,
		commitPath: string | null,
	): Promise<{ kind: "ready"; values: MigrationPackage[] } | Extract<LegacyIdentitySourceResult, { kind: "attention" }>> {
		if (commitPath === null) return { kind: "ready", values: [] };
		const root = `${normalizePath(catalogDataRoot)}/`;
		if (!normalizePath(commitPath).startsWith(root)) {
			return { kind: "attention", diagnostics: [diagnostic("v2_migration_path_invalid", commitPath, null, "The migration commit is outside the configured data root.")] };
		}
		const store = new CatalogV2MigrationArtifactStore(this.app, catalogDataRoot);
		const relativeCommitPath = normalizePath(commitPath).slice(root.length);
		const commit = await store.readCommit(relativeCommitPath);
		if (commit === null) {
			return { kind: "attention", diagnostics: [diagnostic("v2_migration_commit_missing", commitPath, null, "The verified generation references a missing migration commit.")] };
		}
		const values: MigrationPackage[] = [];
		for (const artifact of commit.value.requiredArtifacts.filter((item) => item.artifactKind === "migration_package")) {
			const stored = await store.readPackage(artifact.path);
			if (stored === null || stored.bytes.byteLength !== artifact.byteLength
				|| await sha256Bytes(stored.bytes) !== artifact.sha256) {
				return { kind: "attention", diagnostics: [diagnostic("v2_migration_package_invalid", artifact.path, null, "The migration package is missing or has a digest mismatch.")] };
			}
			values.push(stored.value);
		}
		return { kind: "ready", values };
	}

	private async loadDeletedPayloads(
		catalogDataRoot: string,
		state: VerifiedLegacyIdentitySnapshot["state"],
	): Promise<{ values: Record<string, DeletedMemoPayload>; diagnostics: LegacyIdentityImportDiagnostic[] }> {
		const store = new CatalogV2DeletedPayloadStore(this.app, catalogDataRoot);
		const values: Record<string, DeletedMemoPayload> = {};
		const diagnostics: LegacyIdentityImportDiagnostic[] = [];
		for (const memo of Object.values(state.memos)) {
			for (const version of memo.deleteVersions) {
				if (memo.restoredDeleteOperationIds.includes(version.deleteOpId)
					|| memo.purgedDeleteOperationIds.includes(version.deleteOpId)) continue;
				try {
					values[version.deleteOpId] = await store.read(version.payload);
				} catch (error) {
					diagnostics.push(diagnostic("v2_deleted_payload_invalid", version.payload.path, memo.memoId, errorMessage(error)));
				}
			}
		}
		return { values, diagnostics };
	}

	private async collectLegacyInputs(knomoDataRoot: string): Promise<LegacyArtifactInput[]> {
		const legacyRoot = getLegacySystemRootPath(knomoDataRoot);
		const folder = this.app.vault.getAbstractFileByPath(legacyRoot);
		const inputs: LegacyArtifactInput[] = [];
		if (folder instanceof TFolder) {
			for (const file of listFiles(folder)) {
				const classification = classifyLegacyArtifactPath(legacyRoot, file.path);
				if (classification === null) continue;
				inputs.push({
					artifactKind: classification.artifactKind,
					path: file.path,
					bytes: new Uint8Array(await this.app.vault.readBinary(file)),
					mtime: file.stat.mtime,
				});
			}
		}
		const pluginData = await this.readLegacyPluginData();
		if (pluginData !== null) inputs.push(pluginData);
		return inputs.sort((left, right) => left.path.localeCompare(right.path));
	}

	private async readLegacyPluginData(): Promise<LegacyArtifactInput | null> {
		const vault = this.app.vault as App["vault"] & { configDir?: string };
		const path = normalizePath(`${vault.configDir ?? ".obsidian"}/plugins/${this.pluginId}/data.json`);
		try {
			if (!await vault.adapter.exists(path)) return null;
			const bytes = new Uint8Array(await vault.adapter.readBinary(path));
			const parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as Record<string, unknown>;
			if (!("randomReunionReviewStates" in parsed)) return null;
			const projected = canonicalJsonFileBytes({ randomReunionReviewStates: parsed.randomReunionReviewStates ?? null });
			const stat = await vault.adapter.stat(path);
			return { artifactKind: "plugin_data", path, bytes: projected, mtime: stat?.mtime ?? 0 };
		} catch {
			return null;
		}
	}

	private getConfiguredRoot(): string | null {
		const value = this.getKnomoDataRoot();
		return value === null ? null : normalizePath(value);
	}
}

function collectRevisionTransitions(
	generation: Extract<Awaited<ReturnType<CatalogV2VaultProtocol["selectGeneration"]>>, { kind: "verified" }>["value"],
) {
	const transitions = new Map<string, NonNullable<VerifiedLegacyIdentitySnapshot["state"]["fileRevisionTransitions"]>[number]>();
	for (const commitRef of generation.generation.mutationCommits ?? []) {
		const prepare = generation.mutationPrepares?.[commitRef.sha256];
		if (prepare === undefined) continue;
		for (const change of prepare.changes) {
			const item = change.transition;
			transitions.set(`${item.sourcePath}\u0000${item.beforeRevision}\u0000${item.afterRevision}`, item);
		}
	}
	return [...transitions.values()].sort((left, right) =>
		`${left.sourcePath}\u0000${left.beforeRevision}\u0000${left.afterRevision}`
			.localeCompare(`${right.sourcePath}\u0000${right.beforeRevision}\u0000${right.afterRevision}`));
}

function generationDiagnostics(
	selection: Exclude<Awaited<ReturnType<CatalogV2VaultProtocol["selectGeneration"]>>, { kind: "verified" }>,
): LegacyIdentityImportDiagnostic[] {
	switch (selection.kind) {
		case "empty": return [diagnostic("v2_generation_empty", null, null, "The legacy V2 generation is empty.")];
		case "awaiting_data": return selection.missingPaths.map((path) =>
			diagnostic("v2_generation_missing", path, null, "The legacy V2 generation is not fully available."));
		case "forked": return selection.generationRefs.map((ref) =>
			diagnostic("v2_generation_fork", ref.path, null, ref.sha256));
		case "invalid": return selection.reasons.map((reason) =>
			diagnostic("v2_generation_invalid", null, null, reason));
	}
}

function listFiles(folder: TFolder): TFile[] {
	const files: TFile[] = [];
	const visit = (child: TFile | TFolder) => {
		if (child instanceof TFile) files.push(child);
		else child.children.forEach((item) => {
			if (item instanceof TFile || item instanceof TFolder) visit(item);
		});
	};
	folder.children.forEach((child) => {
		if (child instanceof TFile || child instanceof TFolder) visit(child);
	});
	return files;
}

function diagnostic(code: string, sourcePath: string | null, memoId: string | null, detail: string): LegacyIdentityImportDiagnostic {
	return { code, sourcePath, memoId, detail };
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
