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

test("identity absent 只添加非阻塞初始化提示", () => {
	const headers = getCatalogReadStatusHeaders({
		status: {
			content: "ready",
			catalog: "complete",
			identity: "absent",
			projection: "ready",
			migration: "none",
		},
		coverage: completeCoverage,
	});

	assert.equal(headers.length, 1);
	assert.equal(headers[0]?.type, "summary");
	assert.equal(headers[0]?.type === "summary" ? headers[0].action?.action : null, "open-catalog-settings");
});

test("Catalog、identity、projection、migration 状态按独立维度同时呈现", () => {
	const headers = getCatalogReadStatusHeaders({
		status: {
			content: "scanning",
			catalog: "partial",
			identity: "conflicted",
			projection: "stale",
			migration: "running",
		},
		coverage: {
			kind: "partial",
			coveredFromDate: "2026-08-20",
			pendingFileCount: 2,
			coveredFileCount: 1,
			totalFileCount: 3,
		},
	});

	assert.equal(headers.length, 4);
	assert.equal(headers.every((header) => header.type === "summary"), true);
	assert.deepEqual(headers.flatMap((header) => header.type === "summary" && header.action !== undefined
		? [header.action.action]
		: []), ["refresh-catalog-sync-state", "open-catalog-settings", "open-catalog-settings"]);
});

test("降级 Catalog 扫描时同时显示扫描进度与存储降级", () => {
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

	assert.equal(headers.length, 2);
	assert.deepEqual(headers.flatMap((header) => header.type === "summary" ? [header.action?.action] : []), [
		"refresh-catalog-sync-state",
		"refresh-catalog-sync-state",
	]);
});
