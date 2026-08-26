import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { ensureObsidianStub } from "./helpers/obsidianStub";

test("生产源码只暴露无版本 Catalog 模块和存储名称", async () => {
	const sourceFiles = listFiles("src").filter((file) => file.endsWith(".ts"));
	const forbidden = /CatalogV[23]|catalogV[23]|CATALOG_V[23]|catalog-v[23]|catalogShadow|identity-v[23]|catalog\.v[23]Unavailable/u;
	const violations = sourceFiles.flatMap((file) => {
		const relativePath = file.replace(/\\/gu, "/");
		return forbidden.test(relativePath) || forbidden.test(fs.readFileSync(file, "utf8")) ? [relativePath] : [];
	});

	assert.deepEqual(violations, []);
	for (const expected of [
		"src/services/CatalogReadService.ts",
		"src/services/MemoCommandService.ts",
		"src/services/CatalogIndexCoordinator.ts",
		"src/services/DailyMemoWriteGateway.ts",
		"src/services/MonthlyProjection.ts",
	]) {
		assert.equal(fs.existsSync(expected), true, `${expected} should remain the canonical module.`);
	}
	const main = fs.readFileSync("src/main.ts", "utf8");
	assert.equal(main.includes("initializeMonthlyExcludeDefaultSafely"), true);
	for (const serviceName of [
		"CatalogReadService",
		"MemoCommandService",
		"LegacyIndexReader",
		"LegacyIndexMigrationService",
	]) {
		assert.equal(main.includes(serviceName), true, `main.ts should wire ${serviceName}.`);
	}
	const coordinator = fs.readFileSync("src/services/CatalogIndexCoordinator.ts", "utf8");
	assert.equal(coordinator.includes("knomo-catalog-${"), true);
	assert.equal(coordinator.includes("knomo-catalog-v"), false);
	const identityProtocol = fs.readFileSync("src/services/IdentityLedgerProtocol.ts", "utf8");
	const identitySchema = fs.readFileSync("docs/architecture/catalog/schemas/identity-ledger-event.schema.json", "utf8");
	assert.equal(identityProtocol.includes("m_[a-f0-9]{32}"), false);
	assert.equal(identitySchema.includes("m_[a-f0-9]{32}"), false);
});

test("Identity 与共享配置使用稳定目录，协议版本只留在 schemaVersion", async () => {
	await ensureObsidianStub();
	const { IDENTITY_LEDGER_RELATIVE_ROOT } = await import("../src/services/IdentityLedgerProtocol");
	const { KNOMO_SHARED_CONFIG_RELATIVE_ROOT } = await import("../src/services/KnomoSharedConfigProtocol");

	assert.equal(IDENTITY_LEDGER_RELATIVE_ROOT, "_knomo-data/identity");
	assert.equal(KNOMO_SHARED_CONFIG_RELATIVE_ROOT, "_knomo-data/config");
	assert.equal(fs.existsSync("docs/architecture/catalog/schemas/identity-ledger-event.schema.json"), true);
	assert.equal(fs.existsSync("docs/architecture/catalog/schemas/shared-config-event.schema.json"), true);
});

test("全库统计和功能查询只从 Catalog Read Service 获取", () => {
	const view = fs.readFileSync("src/ui/KnomoView.ts", "utf8");
	const readService = fs.readFileSync("src/services/CatalogReadService.ts", "utf8");
	assert.equal(view.includes("getMemoStats(this.memos)"), false);
	assert.equal(view.includes("collectTags(this.memos"), false);
	assert.equal(view.includes("ensureAllMemosLoaded"), false);
	for (const method of [
		"getLibrarySummary",
		"getTagFacets",
		"queryReviewItems",
		"queryRecordStatsDrilldown",
		"getCoverageForRange",
	]) {
		assert.equal(readService.includes(method), true, `${method} should remain a Catalog Read Service API.`);
	}
});

function listFiles(root: string): string[] {
	return fs.readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
		const fullPath = path.join(root, entry.name);
		return entry.isDirectory() ? listFiles(fullPath) : [fullPath];
	});
}
