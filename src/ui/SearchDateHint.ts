import { t } from "../i18n";
import type { SearchSession } from "./SearchSession";

// 日期尚未完成时只提示输入问题，保留当前结果及原有搜索布局。
export function renderSearchDateHint(container: HTMLElement, session: SearchSession): void {
	const error = session.draft.composing ? undefined : session.draft.parsed.error;
	if (error === undefined) container.setAttr("hidden", "");
	else container.removeAttribute("hidden");
	container.setText(error === undefined ? "" : t(`search.error.${error}`)
		+ " " + t(session.result ? "search.statusUnapplied" : "search.statusDraft"));
}
