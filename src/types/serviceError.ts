import type { TranslationKey } from "../i18n";

export type ServiceErrorParamValue = string | number | boolean | null;
export type ServiceErrorParams = Record<string, ServiceErrorParamValue>;

interface KnomoErrorDefinition {
	messageKey: TranslationKey;
	fallbackMessage: string;
}

export const KNOMO_ERROR_DEFINITIONS = {
	reference_not_initialized: {
		messageKey: "service.referenceNotInitialized",
		fallbackMessage: "Reference service is not initialized.",
	},
	reference_target_missing: {
		messageKey: "service.referenceTargetMissing",
		fallbackMessage: "Reference target daily note file does not exist.",
	},
	daily_notes_unavailable: {
		messageKey: "service.dailyNotesUnavailable",
		fallbackMessage: "Daily Notes core plugin is unavailable; Knomo cannot resolve the daily note.",
	},
	daily_notes_disabled: {
		messageKey: "service.dailyNotesDisabled",
		fallbackMessage: "Enable the Daily Notes core plugin in Obsidian settings. Knomo will read the Daily Notes settings automatically; you do not need to configure the daily note path in Knomo.",
	},
	target_path_conflicts: {
		messageKey: "service.targetPathConflicts",
		fallbackMessage: "Target path has conflicts; migration stopped: {{paths}}",
	},
	old_system_path_not_folder: {
		messageKey: "service.oldSystemPathNotFolder",
		fallbackMessage: "Old system path is not a folder: {{path}}",
	},
	monthly_archive_file_missing: {
		messageKey: "service.monthlyArchiveFileMissing",
		fallbackMessage: "Monthly archive file does not exist.",
	},
	monthly_archive_block_missing: {
		messageKey: "service.monthlyArchiveBlockMissing",
		fallbackMessage: "Monthly archive block does not exist.",
	},
	monthly_archive_block_ambiguous: {
		messageKey: "service.monthlyArchiveBlockAmbiguous",
		fallbackMessage: "Multiple memo blocks may match under the monthly archive date heading, so Knomo cannot update the archive automatically.",
	},
	monthly_archive_period_invalid: {
		messageKey: "service.monthlyArchivePeriodInvalid",
		fallbackMessage: "Invalid monthly archive period: {{period}}",
	},
	monthly_archive_index_missing: {
		messageKey: "service.monthlyArchiveIndexMissing",
		fallbackMessage: "Monthly memo-index does not exist for {{period}}.",
	},
	monthly_archive_period_unresolved: {
		messageKey: "service.monthlyArchivePeriodUnresolved",
		fallbackMessage: "Unable to resolve a unique monthly archive period for {{path}}.",
	},
	trash_only_purge: {
		messageKey: "service.trashOnlyPurge",
		fallbackMessage: "Only memos in trash can be permanently deleted.",
	},
	index_backup_missing: {
		messageKey: "service.indexBackupMissing",
		fallbackMessage: "Index backup does not exist: {{path}}",
	},
	auto_exclude_unsupported: {
		messageKey: "service.autoExcludeUnsupported",
		fallbackMessage: "This Obsidian environment does not support automatic exclude rule updates.",
	},
	daily_block_ambiguous: {
		messageKey: "service.dailyBlockAmbiguous",
		fallbackMessage: "Multiple memo blocks may match under the current daily note heading, so Knomo cannot sync automatically.",
	},
	monthly_delete_failed: {
		messageKey: "service.monthlyDeleteFailed",
		fallbackMessage: "Monthly archive delete failed.",
	},
	monthly_sync_failed: {
		messageKey: "service.monthlySyncFailed",
		fallbackMessage: "Monthly archive sync failed.",
	},
	memo_content_empty: {
		messageKey: "service.memoContentEmpty",
		fallbackMessage: "Memo content cannot be empty.",
	},
	daily_file_missing: {
		messageKey: "service.dailyFileMissing",
		fallbackMessage: "Daily note file does not exist.",
	},
	daily_block_missing: {
		messageKey: "service.dailyBlockMissing",
		fallbackMessage: "Unable to find the memo block in the daily note.",
	},
	delete_daily_block_missing: {
		messageKey: "service.deleteDailyBlockMissing",
		fallbackMessage: "Unable to find the daily memo block to delete.",
	},
	delete_daily_block_ambiguous: {
		messageKey: "service.deleteDailyBlockAmbiguous",
		fallbackMessage: "Multiple daily memo blocks may match, so Knomo cannot delete the memo automatically.",
	},
	memo_not_found_or_cleaned: {
		messageKey: "service.memoNotFoundOrCleaned",
		fallbackMessage: "Memo does not exist or has already been cleaned up.",
	},
	restore_failed_retry: {
		messageKey: "service.restoreFailedRetry",
		fallbackMessage: "Restore failed. Please try again later.",
	},
	monthly_delete_retry_failed: {
		messageKey: "service.monthlyDeleteRetryFailed",
		fallbackMessage: "Monthly archive delete retry failed.",
	},
	retry_monthly_sync_daily_missing: {
		messageKey: "service.retryMonthlySyncDailyMissing",
		fallbackMessage: "Unable to find the daily memo block before retrying monthly sync.",
	},
	restore_verify_daily_failed: {
		messageKey: "service.restoreVerifyDailyFailed",
		fallbackMessage: "Restore failed: unable to verify the daily block.",
	},
	missing_delete_snapshot: {
		messageKey: "service.missingDeleteSnapshot",
		fallbackMessage: "Missing delete snapshot.",
	},
	index_write_failed: {
		messageKey: "service.indexWriteFailed",
		fallbackMessage: "Failed to write memo-index while {{action}} memo. The daily note may already be written: {{dailyPath}}; monthly archive: {{monthlyPath}}. Repair memo-index or run manual scan before sending again. Original error: {{reason}}",
	},
	rebuild_index_failed: {
		messageKey: "service.rebuildIndexFailed",
		fallbackMessage: "Rebuild index failed: {{count}} files did not sync; stopped refreshing the view.",
	},
	rebuild_index_failed_generic: {
		messageKey: "service.rebuildIndexFailedGeneric",
		fallbackMessage: "Rebuild index failed.",
	},
	backup_not_found: {
		messageKey: "service.backupNotFound",
		fallbackMessage: "No restorable previous index backup was found.",
	},
	unique_block_id_failed: {
		messageKey: "service.uniqueBlockIdFailed",
		fallbackMessage: "Unable to generate a unique blockId.",
	},
} as const satisfies Record<string, KnomoErrorDefinition>;

export type KnomoErrorCode = keyof typeof KNOMO_ERROR_DEFINITIONS;

export function isKnomoErrorCode(value: unknown): value is KnomoErrorCode {
	return typeof value === "string" && Object.prototype.hasOwnProperty.call(KNOMO_ERROR_DEFINITIONS, value);
}

export class KnomoError extends Error {
	readonly code: KnomoErrorCode;
	readonly params: ServiceErrorParams;
	readonly detail: unknown;

	constructor(code: KnomoErrorCode, params: ServiceErrorParams = {}, detail?: unknown) {
		const fallbackParams = detail === undefined || params.reason !== undefined
			? params
			: { ...params, reason: getUnknownErrorMessage(detail) };
		const message = formatFallbackMessage(KNOMO_ERROR_DEFINITIONS[code].fallbackMessage, fallbackParams);
		const backupText = typeof params.backupPath === "string"
			? `Backup path: ${params.backupPath}`
			: params.backupMissing === true
				? "No restorable previous index backup was found."
				: null;
		super(backupText === null ? message : `${message}\n${backupText}`);
		this.name = "KnomoError";
		this.code = code;
		this.params = params;
		this.detail = detail;
	}
}

function formatFallbackMessage(template: string, params: ServiceErrorParams): string {
	return template.replace(/\{\{(\w+)\}\}/g, (match, name: string) => {
		const value = params[name];
		return value === null || value === undefined ? match : String(value);
	});
}

function getUnknownErrorMessage(error: unknown): string {
	return error instanceof Error && error.message.length > 0 ? error.message : "Unknown error";
}
