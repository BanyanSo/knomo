import type { LegacyIdentityImportReport } from "../types/legacyMigration";
import {
	buildPluginDataWithLegacyMigrationAcknowledgedSourceRevision,
	extractLegacyMigrationAcknowledgedSourceRevision,
} from "../utils/pluginData";
import { PluginDataStore } from "./PluginDataStore";

export class LegacyMigrationAcknowledgementService {
	private acknowledgedSourceRevision: string | null = null;

	constructor(private readonly pluginDataStore: PluginDataStore) {}

	async initialize(): Promise<void> {
		this.acknowledgedSourceRevision = extractLegacyMigrationAcknowledgedSourceRevision(
			await this.pluginDataStore.read(),
		);
	}

	isAcknowledged(report: LegacyIdentityImportReport): boolean {
		return report.status === "partial"
			&& report.sourceRevision !== null
			&& report.sourceRevision === this.acknowledgedSourceRevision;
	}

	async acknowledge(report: LegacyIdentityImportReport): Promise<boolean> {
		if (report.status !== "partial" || report.sourceRevision === null) return false;
		const sourceRevision = report.sourceRevision;
		await this.pluginDataStore.mutate((savedData) => ({
			nextData: buildPluginDataWithLegacyMigrationAcknowledgedSourceRevision(savedData, sourceRevision),
			result: undefined,
		}));
		this.acknowledgedSourceRevision = sourceRevision;
		return true;
	}
}
