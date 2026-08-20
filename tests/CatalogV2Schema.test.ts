import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import Ajv2020 from "ajv/dist/2020";
import type { AnySchema } from "ajv";

import { buildStateCompactionCommit, buildStateSnapshot } from "../src/services/CatalogV2Protocol";
import type { StateOperation } from "../src/types/catalogV2";

test("frozen phase 2 JSON Schemas accept canonical examples and built snapshot artifacts", async (context) => {
	const ajv = new Ajv2020({ strict: false, validateFormats: false });
	const schemaRoot = path.join(process.cwd(), "docs/architecture/catalog-v2/schemas");
	const exampleRoot = path.join(process.cwd(), "docs/architecture/catalog-v2/examples");
	if (!existsSync(schemaRoot) || !existsSync(exampleRoot)) {
		context.skip("docs/ is intentionally device-local and is not a release dependency");
		return;
	}
	const migrationPackageValidator = ajv.compile(await readSchema(path.join(schemaRoot, "migration-package.schema.json")));
	const migrationCommitValidator = ajv.compile(await readSchema(path.join(schemaRoot, "migration-commit.schema.json")));
	assert.equal(migrationPackageValidator(await readJson(path.join(exampleRoot, "migration-package.valid.json"))), true, JSON.stringify(migrationPackageValidator.errors));
	assert.equal(migrationCommitValidator(await readJson(path.join(exampleRoot, "migration-commit.valid.json"))), true, JSON.stringify(migrationCommitValidator.errors));

	const segment = { path: "state/devices/w_00000000000000000000000000000001/segment-000001.jsonl", sha256: "a".repeat(64), byteLength: 100 };
	const builtSnapshot = await buildStateSnapshot({
		sourceWriterId: "w_00000000000000000000000000000001",
		coveredSegments: [segment],
		operations: [makeOperation()],
	});
	const snapshotValidator = ajv.compile(await readSchema(path.join(schemaRoot, "state-snapshot.schema.json")));
	assert.equal(snapshotValidator(builtSnapshot.snapshot), true, JSON.stringify(snapshotValidator.errors));
	const builtCommit = await buildStateCompactionCommit({
		snapshot: { path: builtSnapshot.path, sha256: builtSnapshot.digest, byteLength: builtSnapshot.bytes.byteLength },
		snapshotValue: builtSnapshot.snapshot,
		committingWriterId: "w_00000000000000000000000000000002",
		committedAt: "2026-08-09T00:00:00.000Z",
	});
	const compactionValidator = ajv.compile(await readSchema(path.join(schemaRoot, "state-compaction-commit.schema.json")));
	assert.equal(compactionValidator(builtCommit.commit), true, JSON.stringify(compactionValidator.errors));
	assert.equal(snapshotValidator({ ...builtSnapshot.snapshot, unexpected: true }), false);
});

async function readJson(filePath: string): Promise<unknown> {
	return JSON.parse(await readFile(filePath, "utf8")) as unknown;
}

async function readSchema(filePath: string): Promise<AnySchema> {
	return JSON.parse(await readFile(filePath, "utf8")) as AnySchema;
}

function makeOperation(): StateOperation {
	return {
		schemaVersion: 1,
		writerId: "w_00000000000000000000000000000001",
		sequence: 1,
		opId: "o_00000000000000000000000000000001",
		memoId: "memo-1",
		occurredAt: "2026-08-09T00:00:00.000Z",
		type: "review.record",
		baseEvidence: null,
		payload: { reviewedAt: "2026-08-09T00:00:00.000Z" },
	};
}
