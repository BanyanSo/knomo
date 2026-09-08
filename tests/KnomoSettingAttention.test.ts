import assert from "node:assert/strict";
import test from "node:test";

import { getKnomoSettingAttentionKinds } from "../src/ui/KnomoSettingAttention";
import type { KnomoRuntimeAttentionSnapshot } from "../src/types/catalogView";

const ready: KnomoRuntimeAttentionSnapshot = {
	catalogLifecycle: { state: "ready", persistent: true, writable: true, reason: null },
	currentConfiguration: "ready",
	monthly: "ready",
	legacyMigration: "ready",
};

test("当前配置提示不受旧 Identity 初始化状态隐藏", () => {
	assert.deepEqual(getKnomoSettingAttentionKinds(ready, snapshot("ready")), []);
	assert.deepEqual(getKnomoSettingAttentionKinds({ ...ready, currentConfiguration: "missing" }, snapshot("unconfigured")), ["current-config"]);
	assert.deepEqual(getKnomoSettingAttentionKinds({ ...ready, currentConfiguration: "missing" }, snapshot("initializing", "catalog")), ["current-config"]);
});

test("独立能力分别报告故障，不以旧启动状态覆盖", () => {
	assert.deepEqual(getKnomoSettingAttentionKinds({
		...ready,
		catalogLifecycle: { state: "degraded", persistent: false, writable: false, reason: "failed" },
		currentConfiguration: "unavailable",
		monthly: "failed",
		legacyMigration: "unavailable",
	}, snapshot("unavailable", "current_config")), ["current-config", "catalog", "monthly", "legacy"]);
});

test("准备完成后按可执行动作展示故障", () => {
	assert.deepEqual(getKnomoSettingAttentionKinds({
		catalogLifecycle: { state: "read-only", persistent: true, writable: false, reason: "failed" },
		currentConfiguration: "conflicted",
		monthly: "failed",
		legacyMigration: "attention",
	}, snapshot("ready")), ["current-config", "catalog", "monthly", "legacy"]);
});

test("设置读取失败时只显示设置恢复入口", () => {
	assert.deepEqual(getKnomoSettingAttentionKinds({
		...ready,
		settings: "unavailable",
		catalogLifecycle: { state: "degraded", persistent: false, writable: false, reason: "failed" },
	}, snapshot("unavailable", "catalog")), ["settings"]);
});

function snapshot(
	status: import("../src/services/KnomoStartupBootstrapService").KnomoStartupBootstrapStatus,
	stage: import("../src/services/KnomoStartupBootstrapService").KnomoStartupBootstrapStage | null = null,
): import("../src/services/KnomoStartupBootstrapService").KnomoStartupBootstrapSnapshot {
	return { status, stage, error: null };
}
