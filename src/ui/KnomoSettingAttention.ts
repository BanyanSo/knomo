import type { KnomoStartupBootstrapStatus } from "../services/KnomoStartupBootstrapService";
import type { KnomoRuntimeAttentionSnapshot } from "../types/catalogView";

export type KnomoSettingAttentionKind = "settings" | "shared-config" | "catalog" | "identity" | "monthly" | "legacy";

export interface KnomoSettingAttentionOptions {
	legacyMigrationAcknowledged?: boolean;
}

export function getKnomoSettingAttentionKinds(
	runtime: KnomoRuntimeAttentionSnapshot,
	initializationStatus: KnomoStartupBootstrapStatus | null,
	options: KnomoSettingAttentionOptions = {},
): KnomoSettingAttentionKind[] {
	if (runtime.settings === "unavailable") return ["settings"];
	if (initializationStatus === "unconfigured" || initializationStatus === "initializing") return [];
	if (initializationStatus === "conflicted" || initializationStatus === "unavailable") return ["shared-config"];

	const kinds: KnomoSettingAttentionKind[] = [];
	if (runtime.sharedConfiguration !== "ready") kinds.push("shared-config");
	if (runtime.catalogLifecycle.state === "degraded"
		|| runtime.catalogLifecycle.state === "retrying"
		|| runtime.catalogLifecycle.state === "read-only") kinds.push("catalog");
	if (runtime.identity === "conflicted" || runtime.identity === "unavailable") kinds.push("identity");
	if (runtime.monthly === "failed") kinds.push("monthly");
	if ((runtime.legacyMigration === "partial" && options.legacyMigrationAcknowledged !== true)
		|| runtime.legacyMigration === "attention"
		|| runtime.legacyMigration === "unavailable") kinds.push("legacy");
	return kinds;
}
