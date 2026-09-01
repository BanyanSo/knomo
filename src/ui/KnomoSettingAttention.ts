import type { KnomoStartupBootstrapSnapshot } from "../services/KnomoStartupBootstrapService";
import type { KnomoRuntimeAttentionSnapshot } from "../types/catalogView";

export type KnomoSettingAttentionKind = "settings" | "shared-config" | "catalog" | "identity" | "monthly" | "legacy";

export interface KnomoSettingAttentionOptions {
	legacyMigrationAcknowledged?: boolean;
}

export function getKnomoSettingAttentionKinds(
	runtime: KnomoRuntimeAttentionSnapshot,
	initialization: KnomoStartupBootstrapSnapshot | null,
	options: KnomoSettingAttentionOptions = {},
): KnomoSettingAttentionKind[] {
	if (runtime.settings === "unavailable") return ["settings"];
	if (initialization?.status === "unconfigured" || initialization?.status === "initializing") return [];
	if (initialization?.status === "conflicted") return ["shared-config"];
	if (initialization?.status === "unavailable") {
		if (initialization.stage === "identity") {
			return runtime.identityAttention === "settings_retry" ? ["identity"] : [];
		}
		if (initialization.stage === "catalog") return ["catalog"];
		return ["shared-config"];
	}

	const kinds: KnomoSettingAttentionKind[] = [];
	if (runtime.sharedConfiguration !== "ready") kinds.push("shared-config");
	if (runtime.catalogLifecycle.state === "degraded"
		|| runtime.catalogLifecycle.state === "retrying"
		|| runtime.catalogLifecycle.state === "read-only") kinds.push("catalog");
	if (runtime.identityAttention === "settings_retry") kinds.push("identity");
	if (runtime.monthly === "failed") kinds.push("monthly");
	if ((runtime.legacyMigration === "partial" && options.legacyMigrationAcknowledged !== true)
		|| runtime.legacyMigration === "attention"
		|| runtime.legacyMigration === "unavailable") kinds.push("legacy");
	return kinds;
}
