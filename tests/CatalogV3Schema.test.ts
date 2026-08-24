import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import Ajv2020 from "ajv/dist/2020";
import type { AnySchema } from "ajv";

import { assertIdentityLedgerEvent } from "../src/services/IdentityLedgerProtocol";
import { assertKnomoSharedConfigEvent } from "../src/services/KnomoSharedConfigProtocol";

test("P2 第 8 步：V3 schemas/examples 必须纳入版本控制且与运行时校验一致", async () => {
	const root = path.join(process.cwd(), "docs/architecture/catalog-v3");
	const identitySchemaPath = path.join(root, "schemas/identity-ledger-event.schema.json");
	const configSchemaPath = path.join(root, "schemas/shared-config-event.schema.json");
	const identityExamplePath = path.join(root, "examples/identity-ledger-claim.valid.json");
	const configExamplePath = path.join(root, "examples/shared-config-set.valid.json");
	for (const filePath of [identitySchemaPath, configSchemaPath, identityExamplePath, configExamplePath]) {
		assert.equal(existsSync(filePath), true, `Required V3 schema artifact is missing: ${filePath}`);
	}

	const ajv = new Ajv2020({ strict: false, validateFormats: false });
	const identityValidator = ajv.compile(await readSchema(identitySchemaPath));
	const configValidator = ajv.compile(await readSchema(configSchemaPath));
	const identity = await readJson(identityExamplePath);
	const config = await readJson(configExamplePath);

	assert.equal(identityValidator(identity), true, JSON.stringify(identityValidator.errors));
	assert.equal(configValidator(config), true, JSON.stringify(configValidator.errors));
	assert.doesNotThrow(() => assertIdentityLedgerEvent(identity));
	assert.doesNotThrow(() => assertKnomoSharedConfigEvent(config));
	const deleteCommit = {
		...(identity as Record<string, unknown>),
		eventId: "e_11111111111111111111111111111111",
		type: "delete_commit",
		baseBindingId: (identity as { eventId: string }).eventId,
		evidence: { deleteEventId: "e_22222222222222222222222222222222" },
	};
	assert.equal(identityValidator(deleteCommit), true, JSON.stringify(identityValidator.errors));
	assert.doesNotThrow(() => assertIdentityLedgerEvent(deleteCommit));
	const invalidIdentity = structuredClone(identity) as Record<string, unknown>;
	const evidence = invalidIdentity.evidence as { observation: Record<string, unknown> };
	evidence.observation.existingBlockId = "knomo-internal";
	assert.equal(identityValidator(invalidIdentity), false);
	assert.throws(() => assertIdentityLedgerEvent(invalidIdentity), /Invalid Identity Ledger event/u);

	const invalidConfig = structuredClone(config) as Record<string, unknown>;
	(invalidConfig.config as Record<string, unknown>).vaultIdentity = "forbidden";
	assert.equal(configValidator(invalidConfig), false);
	assert.throws(() => assertKnomoSharedConfigEvent(invalidConfig), /Invalid Knomo shared configuration/u);
});

async function readJson(filePath: string): Promise<unknown> {
	return JSON.parse(await readFile(filePath, "utf8")) as unknown;
}

async function readSchema(filePath: string): Promise<AnySchema> {
	return JSON.parse(await readFile(filePath, "utf8")) as AnySchema;
}
