import type { MonthlyDateOrder } from "./settings";

export type KnomoSharedConfigStatus = "missing" | "ready" | "conflicted" | "unavailable";

interface KnomoSharedDailyConfig {
	folder: string | null;
	dateFormat: string;
	headings: string[];
}

interface KnomoSharedMonthlyConfig {
	folder: string;
	fileFormat: string;
	dateHeadingFormat: string;
	dateOrder: MonthlyDateOrder;
	locale: string;
}

export interface KnomoSharedConfig {
	daily: KnomoSharedDailyConfig;
	monthly: KnomoSharedMonthlyConfig;
}

export interface KnomoSharedConfigEvent {
	eventId: string;
	writerId: string;
	type: "set_config";
	baseEventIds: string[];
	occurredAt: string;
	config: KnomoSharedConfig;
}

export interface KnomoSharedConfigEventEnvelope {
	event: KnomoSharedConfigEvent;
	digest: string;
	sourcePath: string;
}

export interface ParsedKnomoSharedConfigSegment {
	path: string;
	writerId: string;
	digest: string;
	events: KnomoSharedConfigEventEnvelope[];
}

export interface KnomoSharedConfigSnapshot {
	status: Exclude<KnomoSharedConfigStatus, "unavailable">;
	revision: string;
	config: KnomoSharedConfig | null;
	headEventIds: string[];
	pendingEventIds: string[];
	quarantinedEventIds: string[];
	eventCount: number;
}
