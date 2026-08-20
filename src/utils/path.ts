import { normalizePath } from "obsidian";

import { DEFAULT_MONTHLY_MEMO_FOLDER } from "../constants";

export const CATALOG_V2_BOOTSTRAP_ROOT = "_knomo-data";

export function normalizeVaultPath(path: string): string {
	const trimmedPath = path.trim();
	const normalizedPath = normalizePath(trimmedPath || DEFAULT_MONTHLY_MEMO_FOLDER);
	return normalizedPath.replace(/^\/+/, "");
}

export function getCatalogDataRootPath(monthlyMemoFolder: string): string {
	return normalizePath(`${normalizeVaultPath(monthlyMemoFolder)}/_knomo-data`);
}

export function getCatalogBootstrapPath(): string {
	return normalizePath(`${CATALOG_V2_BOOTSTRAP_ROOT}/manifest.json`);
}

export function getCatalogContractsRootPath(catalogDataRoot: string): string {
	return joinCatalogPath(catalogDataRoot, "protocol/contracts");
}

export function getCatalogContractPath(catalogDataRoot: string, digest: string): string {
	return joinCatalogPath(getCatalogContractsRootPath(catalogDataRoot), `contract-${digest}.json`);
}

export function getCatalogControlGenerationsRootPath(catalogDataRoot: string): string {
	return joinCatalogPath(catalogDataRoot, "protocol/control/generations");
}

export function getCatalogControlGenerationPath(catalogDataRoot: string, digest: string): string {
	return joinCatalogPath(getCatalogControlGenerationsRootPath(catalogDataRoot), `control-${digest}.json`);
}

export function getCatalogAuthorityRequestsRootPath(catalogDataRoot: string): string {
	return joinCatalogPath(catalogDataRoot, "protocol/control/authority-requests");
}

export function getCatalogAuthorityRequestPath(catalogDataRoot: string, requestId: string, digest: string): string {
	return joinCatalogPath(getCatalogAuthorityRequestsRootPath(catalogDataRoot), `request-${requestId}-${digest}.json`);
}

export function getCatalogMutationsRootPath(catalogDataRoot: string): string {
	return joinCatalogPath(catalogDataRoot, "protocol/mutations");
}

export function getCatalogMutationPreparePath(catalogDataRoot: string, mutationId: string, digest: string): string {
	return joinCatalogPath(getCatalogMutationsRootPath(catalogDataRoot), `${mutationId}/prepare-${digest}.json`);
}

export function getCatalogMutationCommitPath(catalogDataRoot: string, mutationId: string, digest: string): string {
	return joinCatalogPath(getCatalogMutationsRootPath(catalogDataRoot), `${mutationId}/commit-${digest}.json`);
}

export function getCatalogMutationAbandonPath(catalogDataRoot: string, mutationId: string, digest: string): string {
	return joinCatalogPath(getCatalogMutationsRootPath(catalogDataRoot), `${mutationId}/abandon-${digest}.json`);
}

export function getCatalogWritersRootPath(catalogDataRoot: string): string {
	return joinCatalogPath(getCatalogStateRootPath(catalogDataRoot), "writers");
}

export function getCatalogWriterRootPath(catalogDataRoot: string, writerId: string): string {
	return joinCatalogPath(getCatalogWritersRootPath(catalogDataRoot), writerId);
}

export function getCatalogWriterRegistrationPath(catalogDataRoot: string, writerId: string, digest: string): string {
	return joinCatalogPath(getCatalogWriterRootPath(catalogDataRoot, writerId), `registration-${digest}.json`);
}

export function getCatalogWriterSegmentsRootPath(catalogDataRoot: string, writerId: string): string {
	return joinCatalogPath(getCatalogWriterRootPath(catalogDataRoot, writerId), "segments");
}

export function getCatalogWriterSegmentPath(
	catalogDataRoot: string,
	writerId: string,
	firstSequence: number,
	lastSequence: number,
	digest: string,
): string {
	return joinCatalogPath(
		getCatalogWriterSegmentsRootPath(catalogDataRoot, writerId),
		`segment-${firstSequence}-${lastSequence}-${digest}.json`,
	);
}

export function getCatalogWriterHeadsRootPath(catalogDataRoot: string, writerId: string): string {
	return joinCatalogPath(getCatalogWriterRootPath(catalogDataRoot, writerId), "heads");
}

export function getCatalogWriterHeadPath(
	catalogDataRoot: string,
	writerId: string,
	lastSequence: number,
	digest: string,
): string {
	return joinCatalogPath(
		getCatalogWriterHeadsRootPath(catalogDataRoot, writerId),
		`head-${lastSequence}-${digest}.json`,
	);
}

export function getCatalogStateGenerationsRootPath(catalogDataRoot: string): string {
	return joinCatalogPath(getCatalogStateRootPath(catalogDataRoot), "generations");
}

export function getCatalogStateGenerationPath(catalogDataRoot: string, digest: string): string {
	return joinCatalogPath(getCatalogStateGenerationsRootPath(catalogDataRoot), `generation-${digest}.json`);
}

export function getLegacySystemRootPath(monthlyMemoFolder: string): string {
	return normalizePath(`${normalizeVaultPath(monthlyMemoFolder)}/_knomo-system`);
}

export function getCatalogStateRootPath(catalogDataRoot: string): string {
	return joinCatalogPath(catalogDataRoot, "state");
}

export function getCatalogDevicesRootPath(catalogDataRoot: string): string {
	return joinCatalogPath(getCatalogStateRootPath(catalogDataRoot), "devices");
}

export function getCatalogDevicePath(catalogDataRoot: string, writerId: string): string {
	return joinCatalogPath(getCatalogDevicesRootPath(catalogDataRoot), writerId);
}

export function getCatalogStateSegmentPath(catalogDataRoot: string, writerId: string, segmentNumber: number): string {
	return joinCatalogPath(getCatalogDevicePath(catalogDataRoot, writerId), `segment-${String(segmentNumber).padStart(6, "0")}.jsonl`);
}

export function getCatalogSnapshotsRootPath(catalogDataRoot: string): string {
	return joinCatalogPath(getCatalogStateRootPath(catalogDataRoot), "snapshots");
}

export function getCatalogSnapshotPath(
	catalogDataRoot: string,
	sourceWriterId: string,
	firstSequence: number,
	lastSequence: number,
	digest: string,
): string {
	return joinCatalogPath(
		getCatalogSnapshotsRootPath(catalogDataRoot),
		`${sourceWriterId}/snapshot-${firstSequence}-${lastSequence}-${digest}.json`,
	);
}

export function getCatalogStateCheckpointsRootPath(catalogDataRoot: string): string {
	return joinCatalogPath(getCatalogStateRootPath(catalogDataRoot), "checkpoints");
}

export function getCatalogStateCheckpointPath(catalogDataRoot: string, snapshotDigest: string, writerId: string): string {
	return joinCatalogPath(getCatalogStateCheckpointsRootPath(catalogDataRoot), `commit-${snapshotDigest}-${writerId}.json`);
}

export function getCatalogDeletedRootPath(catalogDataRoot: string): string {
	return joinCatalogPath(getCatalogStateRootPath(catalogDataRoot), "deleted");
}

export function getCatalogDeletedPayloadPath(catalogDataRoot: string, memoId: string, deleteOpId: string): string {
	return joinCatalogPath(getCatalogDeletedRootPath(catalogDataRoot), `${memoId}/${deleteOpId}.json`);
}

export function getCatalogUpgradeRootPath(catalogDataRoot: string): string {
	return joinCatalogPath(catalogDataRoot, "upgrade");
}

export function getCatalogUpgradePackagesRootPath(catalogDataRoot: string): string {
	return joinCatalogPath(getCatalogUpgradeRootPath(catalogDataRoot), "packages");
}

export function getCatalogUpgradePackagePath(catalogDataRoot: string, artifactKind: string, digest: string): string {
	return joinCatalogPath(getCatalogUpgradePackagesRootPath(catalogDataRoot), `${artifactKind}-${digest}.json`);
}

export function getCatalogUpgradeCheckpointsRootPath(catalogDataRoot: string): string {
	return joinCatalogPath(getCatalogUpgradeRootPath(catalogDataRoot), "checkpoints");
}

export function getCatalogUpgradeCheckpointPath(catalogDataRoot: string, generationDigest: string, writerId: string): string {
	return joinCatalogPath(getCatalogUpgradeCheckpointsRootPath(catalogDataRoot), `commit-${generationDigest}-${writerId}.json`);
}

export function getCatalogUpgradeIssuesRootPath(catalogDataRoot: string): string {
	return joinCatalogPath(getCatalogUpgradeRootPath(catalogDataRoot), "issues");
}

export function getCatalogUpgradeIssuePath(catalogDataRoot: string, artifactKind: string, digest: string): string {
	return joinCatalogPath(getCatalogUpgradeIssuesRootPath(catalogDataRoot), `${artifactKind}-${digest}.json`);
}

export function getCatalogTempRootPath(catalogDataRoot: string): string {
	return joinCatalogPath(catalogDataRoot, "temp");
}

export function getCatalogMigrationTempPath(catalogDataRoot: string, runId: string): string {
	return joinCatalogPath(getCatalogTempRootPath(catalogDataRoot), `migration-${runId}`);
}

function joinCatalogPath(root: string, relativePath: string): string {
	const normalizedRoot = normalizePath(root).replace(/^\/+|\/+$/gu, "");
	const normalizedRelative = normalizePath(relativePath).replace(/^\/+|\/+$/gu, "");
	return normalizePath(normalizedRoot.length === 0 ? normalizedRelative : `${normalizedRoot}/${normalizedRelative}`);
}
