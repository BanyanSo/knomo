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
			projection: "ready",
		},
		coverage: completeCoverage,
	}), []);
});

test("fresh empty Vault 的 identity absent 不显示初始化 gate", () => {
	const headers = getCatalogReadStatusHeaders({
		status: {
			content: "ready",
			catalog: "complete",
			projection: "ready",
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
			projection: "ready",
		},
		coverage: {
			...completeCoverage,
			configurationComplete: false,
		},
	});

	assert.deepEqual(headers, []);
});

test("正常后台过渡不进入卡片流，只呈现可操作故障", () => {
	const headers = getCatalogReadStatusHeaders({
		status: {
			content: "scanning",
			catalog: "partial",
			projection: "stale",
		},
		coverage: {
			kind: "partial",
			coveredFromDate: "2026-08-20",
			pendingFileCount: 2,
			coveredFileCount: 1,
			totalFileCount: 3,
		},
	});

	assert.deepEqual(headers, []);
});

test("正常中间态始终不显示，但不隐藏可操作故障", () => {
	assert.deepEqual(getCatalogReadStatusHeaders({
		status: {
			content: "scanning",
			catalog: "partial",
			projection: "stale",
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
			projection: "failed",
		},
		coverage: completeCoverage,
	});
	assert.equal(headers.length, 2);
});

test("旧版恢复入口不放入卡片流", () => {
	const headers = getCatalogReadStatusHeaders({
		status: {
			content: "ready",
			catalog: "complete",
			projection: "ready",
		},
		coverage: completeCoverage,
	});

	assert.deepEqual(headers, []);
});

test("降级 Catalog 扫描时只显示可操作的存储故障", () => {
	const headers = getCatalogReadStatusHeaders({
		status: {
			content: "scanning",
			catalog: "degraded",
			projection: "ready",
		},
		coverage: { ...completeCoverage, kind: "partial", pendingFileCount: 1 },
	});

	assert.equal(headers.length, 1);
	assert.deepEqual(headers.flatMap((header) => header.type === "summary" ? [header.action?.action] : []), [
		"refresh-catalog-sync-state",
	]);
});

test("跨设备设置冲突或不可读取时在前台给出对应操作", () => {
	const base = {
		content: "ready" as const,
		catalog: "complete" as const,
		projection: "ready" as const,
	};
	const conflicted = getCatalogReadStatusHeaders({
		status: { ...base, currentConfiguration: "conflicted" },
		coverage: completeCoverage,
	});
	const unavailable = getCatalogReadStatusHeaders({
		status: { ...base, currentConfiguration: "unavailable" },
		coverage: completeCoverage,
	});

	assert.equal(conflicted[0]?.type === "summary" ? conflicted[0].action?.action : null, "open-catalog-settings");
	assert.equal(unavailable[0]?.type === "summary" ? unavailable[0].action?.action : null, "refresh-catalog-sync-state");
	assert.deepEqual(getCatalogReadStatusHeaders({
		status: { ...base, currentConfiguration: "missing" },
		coverage: completeCoverage,
	}), []);
});

test("原有设置无法读取时只显示设置恢复入口", () => {
	const headers = getCatalogReadStatusHeaders({
		status: {
			content: "unavailable",
			catalog: "degraded",
			settings: "unavailable",
			projection: "failed",
		},
		coverage: completeCoverage,
	});

	assert.equal(headers.length, 1);
	assert.equal(headers[0]?.type === "summary" ? headers[0].action?.action : null, "open-catalog-settings");
	assert.doesNotMatch(headers[0]?.type === "summary" ? headers[0].text : "", /data\.json|Catalog|Identity/u);
});
