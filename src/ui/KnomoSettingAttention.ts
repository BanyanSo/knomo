import type { KnomoStartupBootstrapSnapshot } from "../services/KnomoStartupBootstrapService";
import type { KnomoRuntimeAttentionSnapshot } from "../types/catalogView";

export type KnomoSettingAttentionKind = "settings" | "shared-config" | "catalog" | "monthly" | "legacy";

export function getKnomoSettingAttentionKinds(
	runtime: KnomoRuntimeAttentionSnapshot,
	_initialization: KnomoStartupBootstrapSnapshot | null,
): KnomoSettingAttentionKind[] {
	if (runtime.settings === "unavailable") return ["settings"];

	const kinds: KnomoSettingAttentionKind[] = [];
	if (runtime.sharedConfiguration !== "ready") kinds.push("shared-config");
	if (runtime.catalogLifecycle.state === "degraded"
		|| runtime.catalogLifecycle.state === "retrying"
		|| runtime.catalogLifecycle.state === "read-only") kinds.push("catalog");
	if (runtime.monthly === "failed") kinds.push("monthly");
	if (runtime.legacyMigration === "attention"
		|| runtime.legacyMigration === "unavailable") kinds.push("legacy");
	return kinds;
}
