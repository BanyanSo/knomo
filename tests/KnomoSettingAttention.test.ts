import assert from "node:assert/strict";
import test from "node:test";

import { getKnomoSettingAttentionKinds } from "../src/ui/KnomoSettingAttention";
import type { KnomoRuntimeAttentionSnapshot } from "../src/types/catalogView";

const ready: KnomoRuntimeAttentionSnapshot = {
	catalogLifecycle: { state: "ready", persistent: true, writable: true, reason: null },
	identity: "ready",
	sharedConfiguration: "ready",
	monthly: "ready",
	legacyMigration: "ready",
};

test("健康状态和正常初始化过程不显示需要处理", () => {
	assert.deepEqual(getKnomoSettingAttentionKinds(ready, "ready"), []);
	assert.deepEqual(getKnomoSettingAttentionKinds({ ...ready, sharedConfiguration: "missing" }, "unconfigured"), []);
	assert.deepEqual(getKnomoSettingAttentionKinds({ ...ready, sharedConfiguration: "missing" }, "initializing"), []);
});

test("启动失败只显示一个用户可处理入口，避免重复工程状态", () => {
	assert.deepEqual(getKnomoSettingAttentionKinds({
		...ready,
		catalogLifecycle: { state: "degraded", persistent: false, writable: false, reason: "failed" },
		identity: "unavailable",
		sharedConfiguration: "unavailable",
		monthly: "failed",
		legacyMigration: "unavailable",
	}, "unavailable"), ["shared-config"]);
});

test("准备完成后按可执行动作展示故障", () => {
	assert.deepEqual(getKnomoSettingAttentionKinds({
		catalogLifecycle: { state: "read-only", persistent: true, writable: false, reason: "failed" },
		identity: "conflicted",
		sharedConfiguration: "conflicted",
		monthly: "failed",
		legacyMigration: "attention",
	}, "ready"), ["shared-config", "catalog", "identity", "monthly", "legacy"]);
});

test("最终无法完整恢复的旧版状态只在尚未确认时显示", () => {
	const partial = { ...ready, legacyMigration: "partial" as const };

	assert.deepEqual(getKnomoSettingAttentionKinds(partial, "ready"), ["legacy"]);
	assert.deepEqual(getKnomoSettingAttentionKinds(partial, "ready", {
		legacyMigrationAcknowledged: true,
	}), []);
});

test("设置读取失败时只显示设置恢复入口", () => {
	assert.deepEqual(getKnomoSettingAttentionKinds({
		...ready,
		settings: "unavailable",
		catalogLifecycle: { state: "degraded", persistent: false, writable: false, reason: "failed" },
		identity: "unavailable",
	}, "unavailable"), ["settings"]);
});
