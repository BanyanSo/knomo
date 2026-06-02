import { t } from "../i18n";
import type { TranslationKey } from "../i18n";
import { en } from "../i18n/en";
import { legacyZhCNText } from "../i18n/zh-CN";

export function formatSettingsText(text: string): string {
	const sourceText = formatStructuredServiceText(text)
		?? text.split("\n").map((line) => formatStructuredServiceText(line) ?? line).join("\n");
	return replaceKnownServiceText(sourceText)
		.replace(/\bmemo-index\b/gi, t("term.memoIndex"))
		.replace(/\bmemo block\b/gi, t("term.memoBlock"))
		.replace(/\bmemo index\b/gi, t("term.memoIndex"))
		.replace(/\bmemoId\b/g, t("term.memoId"))
		.replace(/\bmemo\b|\bMemo\b|\bMEMO\b/g, t("term.memo"))
		.replace(/\bdaily block\b/gi, t("term.dailyBlock"))
		.replace(/\bmonthly block\b/gi, t("term.monthlyBlock"))
		.replace(/\bblockId\b/g, t("term.blockId"))
		.replace(/\bblock\b/gi, t("term.block"))
		.replace(/_knomo-system/g, t("term.systemFolder"));
}

const KNOWN_SERVICE_TEXT_KEYS: TranslationKey[] = [
	"service.unknownError",
	"service.referenceNotInitialized",
	"service.referenceTargetMissing",
	"service.dailyNotesUnavailable",
	"service.dailyNotesDisabled",
	"service.dailyNotesEnabled",
	"service.systemPathUnchanged",
	"service.monthlyFolderMigrated",
	"service.monthlyArchiveFileMissing",
	"service.monthlyArchiveBlockMissing",
	"service.updateDeleteNeedsStartLine",
	"service.trashOnlyPurge",
	"service.autoExcludeUnsupported",
	"service.dailyBlockAmbiguous",
	"service.monthlyDeleteFailed",
	"service.monthlySyncFailed",
	"service.untitledSection",
	"service.memoContentEmpty",
	"service.dailyFileMissing",
	"service.dailyBlockMissing",
	"service.deleteDailyBlockMissing",
	"service.memoNotFoundOrCleaned",
	"service.restoreFailedRetry",
	"service.monthlyDeleteRetryFailed",
	"service.retryMonthlySyncDailyMissing",
	"service.restoreVerifyDailyFailed",
	"service.missingDeleteSnapshot",
	"service.monthlyIncomplete",
	"service.rebuildIndexFailedGeneric",
	"service.backupNotFound",
	"service.uniqueBlockIdFailed",
];

function replaceKnownServiceText(text: string): string {
	let nextText = text;
	for (const key of KNOWN_SERVICE_TEXT_KEYS) {
		nextText = replaceLiteral(nextText, en[key], t(key));
		const legacyText = legacyZhCNText[key];
		if (legacyText !== undefined) {
			nextText = replaceLiteral(nextText, legacyText, t(key));
		}
	}
	nextText = replaceLegacyBackupPathPrefix(nextText);
	return nextText;
}

function formatStructuredServiceText(text: string): string | null {
	const targetConflictMatch = text.match(/^Target path has conflicts; migration stopped: (.+)$/s);
	if (targetConflictMatch !== null) {
		return t("service.targetPathConflicts", { paths: targetConflictMatch[1] });
	}
	const oldSystemPathMatch = text.match(/^Old system path is not a folder: (.+)$/s);
	if (oldSystemPathMatch !== null) {
		return t("service.oldSystemPathNotFolder", { path: oldSystemPathMatch[1] });
	}
	const indexBackupMatch = text.match(/^Index backup does not exist: (.+)$/s);
	if (indexBackupMatch !== null) {
		return t("service.indexBackupMissing", { path: indexBackupMatch[1] });
	}
	const importFailedMatch = text.match(/^Import failed: (.+)$/s);
	if (importFailedMatch !== null) {
		return t("service.importFailed", { path: importFailedMatch[1] });
	}
	const scanFailedMatch = text.match(/^Scan failed: (.+)$/s);
	if (scanFailedMatch !== null) {
		return t("service.scanFailed", { path: scanFailedMatch[1] });
	}
	const backupPathMatch = text.match(/^Backup path: (.+)$/s);
	if (backupPathMatch !== null) {
		return t("service.backupPath", { path: backupPathMatch[1] });
	}
	const rebuildIndexMatch = text.match(/^Rebuild index failed: (\d+) files did not sync; stopped refreshing the view\.$/s);
	if (rebuildIndexMatch !== null) {
		return t("service.rebuildIndexFailed", { count: rebuildIndexMatch[1] });
	}
	const indexWriteMatch = text.match(
		/^Failed to write memo-index while (.+?) memo\. The daily note may already be written: (.*); monthly archive: (.*)\. Repair memo-index or run manual scan before sending again\. Original error: (.*)$/s,
	);
	if (indexWriteMatch !== null) {
		return t("service.indexWriteFailed", {
			action: getIndexWriteActionLabel(indexWriteMatch[1]),
			dailyPath: indexWriteMatch[2],
			monthlyPath: formatSettingsText(indexWriteMatch[3]),
			reason: formatSettingsText(indexWriteMatch[4]),
		});
	}
	return null;
}

function getIndexWriteActionLabel(action: string): string {
	if (action === "creating") return t("service.actionCreate");
	if (action === "editing") return t("service.actionEdit");
	if (action === "deleting") return t("service.actionDelete");
	if (action === "restoring") return t("service.actionRestore");
	if (action === "generating reference") return t("service.actionReference");
	return action;
}

function replaceLiteral(text: string, search: string, replacement: string): string {
	return search.length === 0 ? text : text.split(search).join(replacement);
}

function replaceLegacyBackupPathPrefix(text: string): string {
	const index = text.indexOf(legacyZhCNText.backupPathPrefix);
	if (index === -1) {
		return text;
	}
	const before = text.slice(0, index);
	const path = text.slice(index + legacyZhCNText.backupPathPrefix.length);
	return `${before}${t("service.backupPath", { path })}`;
}
