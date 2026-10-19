import { t } from "../i18n";
import { logContinuationFailure } from "../utils/continuationDiagnostics";

export type ClearTrashAction = (isCurrent?: () => boolean) => Promise<void>;

interface ClearTrashActionOptions {
	getPath: () => string;
	confirm: () => Promise<boolean>;
	clear: () => Promise<void>;
	showNotice: (message: string) => void;
	isActive: () => boolean;
}

// 页面与命令共享一次确认和执行，避免重复弹窗及重复清空。
export function createClearTrashAction(options: ClearTrashActionOptions): ClearTrashAction {
	let busy = false;
	return async (isCurrent = () => true) => {
		if (busy || !options.isActive() || !isCurrent()) return;
		busy = true;
		try {
			const selectedPath = options.getPath();
			if (!await options.confirm() || !options.isActive() || !isCurrent()) return;
			if (options.getPath() !== selectedPath) throw new Error("Trash configuration changed.");
			await options.clear();
			if (options.isActive() && isCurrent()) options.showNotice(t("notice.trashCleared"));
		} catch (error) {
			logContinuationFailure("clear-trash", "execution", error);
			if (options.isActive() && isCurrent()) options.showNotice(t("error.clearTrashFailed"));
		} finally {
			busy = false;
		}
	};
}
