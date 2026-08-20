import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { CatalogV2LegacyImporter } from "../src/services/CatalogV2LegacyImporter";
import { classifyLegacyArtifactPath } from "../src/services/LegacyArtifactInventory";

interface Phase2Fixture {
	"LEG-111-BASE": unknown;
	"LEG-125-STATE": {
		memoIndex: unknown;
		pluginData: unknown;
		pendingJournal: unknown;
	};
	"LEGACY-PARTIAL-JSON": unknown;
}

test("legacy path inventory accepts only canonical files and explicit conflict markers", () => {
	const root = "Memos/_knomo-system";
	assert.equal(classifyLegacyArtifactPath(root, `${root}/indexes/memo-index-2026-06.json`)?.artifactKind, "memo_index");
	assert.equal(classifyLegacyArtifactPath(root, `${root}/indexes/memo-index-2026-06 conflict.json`)?.artifactKind, "memo_index");
	assert.equal(classifyLegacyArtifactPath(root, `${root}/indexes/memo-index-2026-06 copy.json`), null);
	assert.equal(classifyLegacyArtifactPath(root, `${root}/pending-memo-creates.json`)?.artifactKind, "pending_create");
});

test("same legacy bytes produce identical package bytes on independent importers", async () => {
	const fixture = await loadFixture();
	const bytes = new TextEncoder().encode(JSON.stringify(fixture["LEG-111-BASE"]));
	const first = await new CatalogV2LegacyImporter().importArtifact({ artifactKind: "memo_index", path: "a/memo-index-2026-06.json", bytes, mtime: 1 });
	const second = await new CatalogV2LegacyImporter().importArtifact({ artifactKind: "memo_index", path: "b/memo-index-2026-06 conflict.json", bytes, mtime: 999 });
	assert.equal(first.kind, "imported");
	assert.equal(second.kind, "imported");
	if (first.kind !== "imported" || second.kind !== "imported") return;
	assert.equal(new TextDecoder().decode(first.packageBytes), new TextDecoder().decode(second.packageBytes));
	assert.equal(first.packageSha256, second.packageSha256);
	assert.equal(first.package.source.artifactDigest, second.package.source.artifactDigest);
	assert.equal("path" in first.package.source, false);
	assert.equal(JSON.stringify(first.package).includes("contentSnapshot"), false);
	assert.equal(JSON.stringify(first.package).includes("monthlyRef"), false);
	assert.deepEqual(first.package.identityClaims.map((item) => item.memoId), ["legacy-active-1"]);
	assert.deepEqual(first.package.deletedRecords.map((item) => item.memoId), ["legacy-deleted-1"]);
	assert.equal(first.deletedPayloads.length, 1);
});

test("imports explicit relation, review ordinals and pending raw block without Monthly prepared write", async () => {
	const fixture = await loadFixture();
	const importer = new CatalogV2LegacyImporter();
	const memoResult = await importer.importArtifact({ artifactKind: "memo_index", path: "memo.json", bytes: encode(fixture["LEG-125-STATE"].memoIndex), mtime: 1 });
	const reviewResult = await importer.importArtifact({ artifactKind: "plugin_data", path: ".obsidian/plugins/knomo/data.json", bytes: encode(fixture["LEG-125-STATE"].pluginData), mtime: 1 });
	const pendingResult = await importer.importArtifact({ artifactKind: "pending_create", path: "pending.json", bytes: encode(fixture["LEG-125-STATE"].pendingJournal), mtime: 1 });
	assert.equal(memoResult.kind, "imported");
	assert.equal(reviewResult.kind, "imported");
	assert.equal(pendingResult.kind, "imported");
	if (memoResult.kind !== "imported" || reviewResult.kind !== "imported" || pendingResult.kind !== "imported") return;
	assert.deepEqual(memoResult.package.relations.map((item) => item.sourceMemoId), ["legacy-source-1"]);
	assert.equal(reviewResult.package.counts.reviewOrdinals, 3);
	assert.equal(pendingResult.package.pendingCreates[0]?.rawBlock, "- 10:00 pending only");
	assert.equal(JSON.stringify(pendingResult.package).includes("monthlyWrite"), false);
});

test("invalid records quarantine the artifact and preserve valid record digests", async () => {
	const fixture = await loadFixture();
	const result = await new CatalogV2LegacyImporter().importArtifact({
		artifactKind: "memo_index",
		path: "memo-index-2026-06.json",
		bytes: encode(fixture["LEGACY-PARTIAL-JSON"]),
		mtime: 1,
	});
	assert.equal(result.kind, "quarantined");
	if (result.kind !== "quarantined") return;
	assert.equal(result.receipt.recoverableRecordCount, 1);
	assert.equal(result.receipt.preservedRecordDigests.length, 1);
});

test("deterministic importer property: local paths and mtimes never affect package bytes", async () => {
	const fixture = await loadFixture();
	const bytes = encode(fixture["LEG-111-BASE"]);
	const importer = new CatalogV2LegacyImporter();
	let expected: string | null = null;
	for (let index = 0; index < 32; index += 1) {
		const result = await importer.importArtifact({
			artifactKind: "memo_index",
			path: `device-${index}/memo-index-2026-06${index % 2 === 0 ? "" : " conflict"}.json`,
			bytes,
			mtime: index * 97,
		});
		assert.equal(result.kind, "imported");
		if (result.kind !== "imported") continue;
		const serialized = new TextDecoder().decode(result.packageBytes);
		expected ??= serialized;
		assert.equal(serialized, expected);
	}
});

async function loadFixture(): Promise<Phase2Fixture> {
	return JSON.parse(await readFile(path.join(process.cwd(), "tests/fixtures/catalog-v2/phase2/legacy-fixtures.json"), "utf8")) as Phase2Fixture;
}

function encode(value: unknown): Uint8Array {
	return new TextEncoder().encode(JSON.stringify(value));
}
