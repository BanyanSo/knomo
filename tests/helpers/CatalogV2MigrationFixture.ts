import { canonicalJsonFileBytes, sha256Bytes } from "../../src/services/CatalogV2Protocol";
import type {
	LegacyImportResult,
	MigrationCommitVerification,
	MigrationPackage,
} from "../../src/types/catalogV2";
import { getCatalogUpgradePackagePath } from "../../src/utils/path";

export const TEST_MIGRATION_VERIFICATION: MigrationCommitVerification = {
	structure: {
		requiredArtifactsVerified: true,
		existingMemoIdsPreserved: true,
		domainCountsVerified: true,
		deletedPayloadsVerified: true,
		dailyHashesUnchanged: true,
	},
	runtime: {
		v2ColdStartPassed: true,
		outboxDrained: true,
		legacyReadsDisabled: true,
		legacyWriterRemoved: true,
	},
	catalog: {
		coverage: "complete",
		observationCount: 1,
		identifiedCount: 1,
		observedCount: 0,
		ambiguousCount: 0,
		failedPaths: [],
	},
};

export async function makeMigrationResult(memoId = "legacy-memo-1"): Promise<LegacyImportResult> {
	const sourceDigest = "a".repeat(64);
	const packageValue: MigrationPackage = {
		kind: "knomo.catalog-v2.migration-package",
		schemaVersion: 1,
		importerVersion: 1,
		source: {
			artifactDigest: sourceDigest,
			artifactKind: "memo_index",
			byteLength: 10,
			legacySchemaVersion: 3,
			period: "2026-08",
			recordCount: 1,
		},
		identityClaims: [{
			memoId,
			legacyStatus: "active",
			legacyRecordDigest: "b".repeat(64),
			evidence: {
				sourcePath: "Daily/2026-08-11.md",
				logicalDate: "2026-08-11",
				section: "## Memos",
				time: "08:00",
				contentHash: "fnv1a-12345678",
				lastKnownBlockHash: "fnv1a-87654321",
				existingBlockId: null,
				lineNumberHint: 1,
			},
		}],
		deletedRecords: [],
		relations: [],
		reviews: [],
		pendingCreates: [],
		diagnostics: [],
		counts: {
			identityClaims: 1,
			deletedRecords: 0,
			relations: 0,
			reviewOrdinals: 0,
			pendingCreates: 0,
			diagnostics: 0,
		},
	};
	const packageBytes = canonicalJsonFileBytes(packageValue);
	const packagePath = getCatalogUpgradePackagePath("", "memo_index", sourceDigest);
	const packageSha256 = await sha256Bytes(packageBytes);
	return {
		kind: "imported",
		receipt: {
			path: "Memos/_knomo-system/indexes/memo-index-2026-08.json",
			artifactKind: "memo_index",
			byteLength: 10,
			mtime: 1,
			sha256: sourceDigest,
			legacySchemaVersion: 3,
			readableRecordCount: 1,
			disposition: "imported",
			requiredArtifact: { path: packagePath, sha256: packageSha256, byteLength: packageBytes.byteLength },
			errorCode: null,
		},
		package: packageValue,
		packageBytes,
		packageSha256,
		packagePath,
		deletedPayloads: [],
	};
}
