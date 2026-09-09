import type { KnomoStartupBootstrapSnapshot } from "../services/KnomoStartupBootstrapService";
import type { KnomoRuntimeAttentionSnapshot } from "../types/catalogView";

export type KnomoSettingAttentionKind = "settings" | "current-config" | "catalog" | "monthly" | "legacy";

export function getKnomoSettingAttentionKinds(
	runtime: KnomoRuntimeAttentionSnapshot,
	_initialization: KnomoStartupBootstrapSnapshot | null,
): KnomoSettingAttentionKind[] {
	if (runtime.settings === "unavailable") return ["settings"];

	const kinds: KnomoSettingAttentionKind[] = [];
	if (runtime.currentConfiguration !== "ready") kinds.push("current-config");
	if (runtime.catalogLifecycle.state === "degraded"
		|| runtime.catalogLifecycle.state === "retrying"
		|| runtime.catalogLifecycle.state === "read-only") kinds.push("catalog");
	if (runtime.monthly === "failed") kinds.push("monthly");
	if (runtime.legacyMigration === "recovery_required") kinds.push("legacy");
	return kinds;
}
