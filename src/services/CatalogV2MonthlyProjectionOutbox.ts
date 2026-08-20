import type { CatalogV2MonthlyProjectionOutboxItem } from "../types/catalogV2Runtime";
import type { IndexedDbCatalogV2TransactionStore } from "./IndexedDbCatalogV2TransactionStore";

export interface CatalogV2MonthlyProjectionSink {
	project(item: CatalogV2MonthlyProjectionOutboxItem): Promise<void>;
}

export class CatalogV2MonthlyProjectionOutboxRunner {
	constructor(
		private readonly transactionStore: IndexedDbCatalogV2TransactionStore,
		private readonly sink: CatalogV2MonthlyProjectionSink,
	) {}

	async run(): Promise<{ projected: number; failed: number }> {
		const items = (await this.transactionStore.listOutbox()).filter((item) => item.kind === "monthly_projection");
		let projected = 0;
		let failed = 0;
		const itemsByPeriod = new Map<string, CatalogV2MonthlyProjectionOutboxItem[]>();
		for (const item of items) {
			const period = getMonthlyProjectionPeriod(item);
			const periodItems = itemsByPeriod.get(period) ?? [];
			periodItems.push(item);
			itemsByPeriod.set(period, periodItems);
		}
		for (const [period, periodItems] of [...itemsByPeriod.entries()].sort(([left], [right]) => left.localeCompare(right))) {
			const representative = periodItems[periodItems.length - 1];
			if (representative === undefined) continue;
			try {
				await this.sink.project({ ...representative, period, logicalDate: `${period}-01` });
				for (const item of periodItems) await this.transactionStore.deleteOutbox(item.id);
				projected += 1;
			} catch {
				failed += 1;
			}
		}
		return { projected, failed };
	}
}

export function getMonthlyProjectionPeriod(item: CatalogV2MonthlyProjectionOutboxItem): string {
	const period = item.period ?? item.logicalDate.slice(0, 7);
	if (!/^\d{4}-(?:0[1-9]|1[0-2])$/.test(period)) {
		throw new Error(`Invalid Monthly projection period: ${period}`);
	}
	return period;
}
