import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { CatalogV2LegacyImporter } from "../src/services/CatalogV2LegacyImporter";
import {
	buildMigrationCommit,
	CatalogV2MigrationReducer,
	evaluateMigrationCommit,
	selectMigrationCommit,
} from "../src/services/CatalogV2Migration";
import type { LegacyImportResult, MigrationCommitVerification } from "../src/types/catalogV2";

const verification: MigrationCommitVerification = {
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
		observationCount: 2,
		identifiedCount: 2,
		observedCount: 0,
		ambiguousCount: 0,
		failedPaths: [],
	},
};

test("migration commit generation ignores writer and committed time", async () => {
	const result = await importBaseFixture();
	const first = await buildMigrationCommit({
		writerId: "w_00000000000000000000000000000001",
		committedAt: "2026-08-09T01:00:00.000Z",
		results: [result],
		verification,
	});
	const second = await buildMigrationCommit({
		writerId: "w_00000000000000000000000000000002",
		committedAt: "2026-08-09T02:00:00.000Z",
		results: [result],
		verification,
	});
	assert.equal(first.commit.generationDigest, second.commit.generationDigest);
	assert.notEqual(first.path, second.path);
});

test("commit remains awaiting_data until every required artifact arrives and matches", async () => {
	const result = await importBaseFixture();
	const built = await buildMigrationCommit({
		writerId: "w_00000000000000000000000000000001",
		committedAt: "2026-08-09T01:00:00.000Z",
		results: [result],
		verification,
	});
	assert.equal((await evaluateMigrationCommit(built.commit, [])).status, "awaiting_data");
	const artifacts = result.kind === "imported" ? [
		{ path: result.packagePath, bytes: result.packageBytes },
		...result.deletedPayloads.map((payload) => ({ path: payload.path, bytes: payload.bytes })),
	] : [];
	assert.equal((await evaluateMigrationCommit(built.commit, artifacts)).status, "complete");
	assert.equal((await evaluateMigrationCommit(built.commit, artifacts.map((artifact, index) => index === 0
		? { ...artifact, bytes: new Uint8Array([1]) }
		: artifact))).status, "quarantined");
});

test("migration reducer is duplicate- and order-independent and review snapshots use ordinal union", async () => {
	const fixture = await loadFixture();
	const importer = new CatalogV2LegacyImporter();
	const memo = await importer.importArtifact({ artifactKind: "memo_index", path: "memo.json", bytes: encode(fixture["LEG-125-STATE"].memoIndex), mtime: 1 });
	const review = await importer.importArtifact({ artifactKind: "plugin_data", path: "data.json", bytes: encode(fixture["LEG-125-STATE"].pluginData), mtime: 1 });
	assert.equal(memo.kind, "imported");
	assert.equal(review.kind, "imported");
	if (memo.kind !== "imported" || review.kind !== "imported") return;
	const reducer = new CatalogV2MigrationReducer();
	const first = await reducer.reduce([memo.package, review.package, review.package]);
	const second = await reducer.reduce([review.package, memo.package]);
	assert.deepEqual(first, second);
	assert.equal(first.memos["legacy-child-1"]?.reviewCount, 3);
	assert.deepEqual(first.memos["legacy-child-1"]?.sourceMemoIds, ["legacy-source-1"]);
});

test("commit selection keeps the complete generation while a strict superset is missing data", async () => {
	const fixture = await loadFixture();
	const base = await importBaseFixture();
	const review = await new CatalogV2LegacyImporter().importArtifact({
		artifactKind: "plugin_data",
		path: ".obsidian/plugins/knomo/data.json",
		bytes: encode(fixture["LEG-125-STATE"].pluginData),
		mtime: 1,
	});
	const first = await buildMigrationCommit({
		writerId: "w_00000000000000000000000000000001",
		committedAt: "2026-08-09T01:00:00.000Z",
		results: [base],
		verification,
	});
	const superset = await buildMigrationCommit({
		writerId: "w_00000000000000000000000000000002",
		committedAt: "2026-08-09T02:00:00.000Z",
		results: [review, base],
		verification,
	});
	const baseArtifacts = base.kind === "imported" ? [
		{ path: base.packagePath, bytes: base.packageBytes },
		...base.deletedPayloads.map((payload) => ({ path: payload.path, bytes: payload.bytes })),
	] : [];
	const waitingSelection = await selectMigrationCommit([superset.commit, first.commit], baseArtifacts);
	assert.equal(waitingSelection.status, "selected");
	if (waitingSelection.status === "selected") assert.equal(waitingSelection.commit.generationDigest, first.commit.generationDigest);
	const allArtifacts = review.kind === "imported"
		? [...baseArtifacts, { path: review.packagePath, bytes: review.packageBytes }]
		: baseArtifacts;
	const completeSelection = await selectMigrationCommit([first.commit, superset.commit], allArtifacts);
	assert.equal(completeSelection.status, "selected");
	if (completeSelection.status === "selected") assert.equal(completeSelection.commit.generationDigest, superset.commit.generationDigest);
});

test("late legacy artifact 基于已选 generation 形成输入并集的新 commit", async () => {
	const fixture = await loadFixture();
	const base = await importBaseFixture();
	const review = await new CatalogV2LegacyImporter().importArtifact({
		artifactKind: "plugin_data",
		path: ".obsidian/plugins/knomo/data.json",
		bytes: encode(fixture["LEG-125-STATE"].pluginData),
		mtime: 2,
	});
	assert.equal(base.kind, "imported");
	assert.equal(review.kind, "imported");
	if (base.kind !== "imported" || review.kind !== "imported") return;
	const first = await buildMigrationCommit({
		writerId: "w_00000000000000000000000000000001",
		committedAt: "2026-08-09T01:00:00.000Z",
		results: [base],
		verification,
	});
	const late = await buildMigrationCommit({
		writerId: "w_00000000000000000000000000000002",
		committedAt: "2026-08-11T01:00:00.000Z",
		results: [review],
		verification,
		baseCommits: [first.commit],
		basePackages: [base.package],
	});
	assert.equal(late.commit.legacySources.length, 2);
	assert.notEqual(late.commit.generationDigest, first.commit.generationDigest);
	assert.equal(late.commit.requiredArtifacts.some((item) => item.path === base.packagePath), true);
	assert.equal(late.commit.requiredArtifacts.some((item) => item.path === review.packagePath), true);
});

async function importBaseFixture(): Promise<LegacyImportResult> {
	const fixture = await loadFixture();
	return new CatalogV2LegacyImporter().importArtifact({
		artifactKind: "memo_index",
		path: "Memos/_knomo-system/indexes/memo-index-2026-06.json",
		bytes: encode(fixture["LEG-111-BASE"]),
		mtime: 1,
	});
}

async function loadFixture(): Promise<Record<string, Record<string, unknown>>> {
	return JSON.parse(await readFile(path.join(process.cwd(), "tests/fixtures/catalog-v2/phase2/legacy-fixtures.json"), "utf8")) as Record<string, Record<string, unknown>>;
}

function encode(value: unknown): Uint8Array {
	return new TextEncoder().encode(JSON.stringify(value));
}
