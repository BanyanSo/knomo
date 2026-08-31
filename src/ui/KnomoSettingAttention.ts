import type { KnomoStartupBootstrapStatus } from "../services/KnomoStartupBootstrapService";
import type { KnomoRuntimeAttentionSnapshot } from "../types/catalogView";

export type KnomoSettingAttentionKind = "shared-config" | "catalog" | "identity" | "monthly" | "legacy";

export function getKnomoSettingAttentionKinds(
	runtime: KnomoRuntimeAttentionSnapshot,
	initializationStatus: KnomoStartupBootstrapStatus | null,
): KnomoSettingAttentionKind[] {
	if (initializationStatus === "unconfigured" || initializationStatus === "initializing") return [];
	if (initializationStatus === "conflicted" || initializationStatus === "unavailable") return ["shared-config"];

	const kinds: KnomoSettingAttentionKind[] = [];
	if (runtime.sharedConfiguration !== "ready") kinds.push("shared-config");
	if (runtime.catalogLifecycle.state === "degraded"
		|| runtime.catalogLifecycle.state === "retrying"
		|| runtime.catalogLifecycle.state === "read-only") kinds.push("catalog");
	if (runtime.identity === "conflicted" || runtime.identity === "unavailable") kinds.push("identity");
	if (runtime.monthly === "failed") kinds.push("monthly");
	if (runtime.legacyMigration === "partial"
		|| runtime.legacyMigration === "attention"
		|| runtime.legacyMigration === "unavailable") kinds.push("legacy");
	return kinds;
}
