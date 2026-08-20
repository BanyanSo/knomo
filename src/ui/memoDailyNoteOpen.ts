import type { OpenViewState, TFile, Workspace } from "obsidian";

import type { MemoViewItem as MemoRecord } from "../types/memoView";

export type MemoDailyNoteRef = Pick<MemoRecord, "dailyRef">;

export function buildDailyNoteOpenState(lineNumberHint: number | null): OpenViewState {
	if (lineNumberHint === null) {
		return { active: true };
	}
	return {
		active: true,
		eState: { line: getLineIndex(lineNumberHint) },
	};
}

export async function openMemoDailyNoteDefault(
	workspace: Workspace,
	memo: MemoDailyNoteRef,
): Promise<void> {
	if (memo.dailyRef.lineNumberHint === null) {
		await workspace.openLinkText(memo.dailyRef.path, "", false, { active: true });
		return;
	}
	try {
		await workspace.openLinkText(memo.dailyRef.path, "", false, buildDailyNoteOpenState(memo.dailyRef.lineNumberHint));
	} catch {
		await workspace.openLinkText(memo.dailyRef.path, "", false, { active: true });
	}
}

export async function openMemoDailyNoteInNewTab(
	workspace: Workspace,
	file: TFile,
	lineNumberHint: number | null,
): Promise<void> {
	const leaf = workspace.getLeaf("tab");
	if (lineNumberHint === null) {
		await leaf.openFile(file, { active: true });
		return;
	}
	try {
		await leaf.openFile(file, buildDailyNoteOpenState(lineNumberHint));
	} catch {
		await leaf.openFile(file, { active: true });
	}
}

function getLineIndex(lineNumberHint: number): number {
	return Math.max(0, lineNumberHint - 1);
}
