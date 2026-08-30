import assert from "node:assert/strict";
import test from "node:test";

import { getCatalogReadStatusHeaders } from "../src/ui/CatalogReadStatusPresenter";
import type { CatalogCoverage } from "../src/types/catalog";

const completeCoverage: CatalogCoverage = {
	kind: "complete",
	coveredFromDate: "2026-08-01",
	pendingFileCount: 0,
	coveredFileCount: 2,
	totalFileCount: 2,
};

test("Observation-first 全部就绪时不添加状态提示", () => {
	assert.deepEqual(getCatalogReadStatusHeaders({
		status: {
			content: "ready",
			catalog: "complete",
			identity: "ready",
			projection: "ready",
			migration: "none",
		},
		coverage: completeCoverage,
	}), []);
});

test("fresh empty Vault 的 identity absent 不显示初始化 gate", () => {
	const headers = getCatalogReadStatusHeaders({
		status: {
			content: "ready",
			catalog: "complete",
			identity: "absent",
			projection: "ready",
			migration: "none",
		},
		coverage: {
			kind: "complete",
			coveredFromDate: null,
			pendingFileCount: 0,
			coveredFileCount: 0,
			totalFileCount: 0,
		},
	});

	assert.deepEqual(headers, []);
});

test("本地扫描完成但共享配置仍在初始化时不把工程状态放进卡片流", () => {
	const headers = getCatalogReadStatusHeaders({
		status: {
			content: "ready",
			catalog: "partial",
			identity: "absent",
			projection: "ready",
			migration: "none",
		},
		coverage: {
			...completeCoverage,
			sharedConfigurationComplete: false,
		},
	});

	assert.deepEqual(headers, []);
});

test("正常后台过渡不进入卡片流，只呈现可操作故障", () => {
	const headers = getCatalogReadStatusHeaders({
		status: {
			content: "scanning",
			catalog: "partial",
			identity: "conflicted",
			identityConflict: "observation",
			projection: "stale",
			migration: "attention",
		},
		coverage: {
			kind: "partial",
			coveredFromDate: "2026-08-20",
			pendingFileCount: 2,
			coveredFileCount: 1,
			totalFileCount: 3,
		},
	});

	assert.equal(headers.length, 2);
	assert.equal(headers.every((header) => header.type === "summary"), true);
	assert.deepEqual(headers.flatMap((header) => header.type === "summary" && header.action !== undefined
		? [header.action.action]
		: []), ["open-catalog-settings"]);
	const text = headers.flatMap((header) => header.type === "summary" ? [header.text] : []).join("\n");
	assert.match(text, /legacy data/u);
	assert.doesNotMatch(text, /Local history is still building/u);
	assert.doesNotMatch(text, /Waiting for monthly memo sync/u);
	assert.doesNotMatch(text, /Creation, adoption, and monthly writes are paused/u);
});

test("局部 observation 冲突不跳空设置页，全局 Ledger 冲突保留诊断入口", () => {
	const status = {
		content: "ready" as const,
		catalog: "complete" as const,
		identity: "conflicted" as const,
		projection: "ready" as const,
		migration: "none" as const,
	};
	const local = getCatalogReadStatusHeaders({
		status: { ...status, identityConflict: "observation" },
		coverage: completeCoverage,
	});
	const ledger = getCatalogReadStatusHeaders({
		status: { ...status, identityConflict: "ledger" },
		coverage: completeCoverage,
	});

	assert.equal(local[0]?.type === "summary" ? local[0].action : undefined, undefined);
	assert.equal(
		ledger[0]?.type === "summary" ? ledger[0].action?.action : undefined,
		"open-catalog-settings",
	);
});

test("正常中间态始终不显示，但不隐藏可操作故障", () => {
	assert.deepEqual(getCatalogReadStatusHeaders({
		status: {
			content: "scanning",
			catalog: "partial",
			identity: "syncing",
			projection: "stale",
			migration: "none",
		},
		coverage: {
			kind: "partial",
			coveredFromDate: "2026-08-20",
			pendingFileCount: 2,
			coveredFileCount: 1,
			totalFileCount: 3,
		},
	}), []);

	const headers = getCatalogReadStatusHeaders({
		status: {
			content: "unavailable",
			catalog: "degraded",
			identity: "conflicted",
			projection: "failed",
			migration: "attention",
		},
		coverage: completeCoverage,
	});
	assert.equal(headers.length, 4);
});

test("旧数据暂时不可读取时显示可重试提示，不冒充数据根冲突", () => {
	const headers = getCatalogReadStatusHeaders({
		status: {
			content: "ready",
			catalog: "complete",
			identity: "ready",
			projection: "ready",
			migration: "unavailable",
		},
		coverage: completeCoverage,
	});

	assert.equal(headers.length, 1);
	assert.equal(headers[0]?.type === "summary" ? headers[0].action?.action : null, "refresh-catalog-sync-state");
	assert.match(headers[0]?.type === "summary" ? headers[0].text : "", /legacy data upgrade is temporarily unavailable/u);
	assert.doesNotMatch(headers[0]?.type === "summary" ? headers[0].text : "", /conflicting data roots/u);
});

test("降级 Catalog 扫描时只显示可操作的存储故障", () => {
	const headers = getCatalogReadStatusHeaders({
		status: {
			content: "scanning",
			catalog: "degraded",
			identity: "ready",
			projection: "ready",
			migration: "none",
		},
		coverage: { ...completeCoverage, kind: "partial", pendingFileCount: 1 },
	});

	assert.equal(headers.length, 1);
	assert.deepEqual(headers.flatMap((header) => header.type === "summary" ? [header.action?.action] : []), [
		"refresh-catalog-sync-state",
	]);
});
