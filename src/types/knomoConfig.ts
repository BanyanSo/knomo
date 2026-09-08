import type { MonthlyDateOrder } from "./settings";

export type KnomoCurrentConfigStatus = "missing" | "ready" | "conflicted" | "unavailable";

interface KnomoCurrentDailyConfig {
	folder: string | null;
	dateFormat: string;
	headings: string[];
}

interface KnomoCurrentMonthlyConfig {
	folder: string;
	fileFormat: string;
	dateHeadingFormat: string;
	dateOrder: MonthlyDateOrder;
	locale: string;
}

export interface KnomoCurrentConfig {
	daily: KnomoCurrentDailyConfig;
	monthly: KnomoCurrentMonthlyConfig;
}
