import { StateEffect, StateField, type ChangeDesc } from "@codemirror/state";
import { invertedEffects } from "@codemirror/commands";

export interface ComposerImageLink {
	from: number;
	to: number;
	link: string;
	path: string;
	sourcePath: string;
}

export function imageRangeTouched(changes: ChangeDesc, from: number, to: number): boolean {
	let touched = false;
	changes.iterChangedRanges((start, end) => {
		if (from === to ? start < from && end > from
			: start === end ? start > from && start < to : start < to && end > from) touched = true;
	});
	return touched;
}

function mapImageLinks(links: readonly ComposerImageLink[], changes: ChangeDesc): readonly ComposerImageLink[] {
	return links.filter(link => !imageRangeTouched(changes, link.from, link.to))
		.map(link => ({ ...link, from: changes.mapPos(link.from, 1), to: changes.mapPos(link.to, -1) }));
}

export const setComposerImageLinks = StateEffect.define<readonly ComposerImageLink[]>({ map: mapImageLinks });
export const composerImageLinks = StateField.define<readonly ComposerImageLink[]>({
	create: () => [],
	update: (links, tr) => {
		const restored = tr.effects.find(effect => effect.is(setComposerImageLinks));
		if (restored) return restored.value;
		if (!tr.docChanged) return links;
		return mapImageLinks(links, tr.changes);
	},
});

// 元数据与正文一起撤销/恢复，Redo 不重新创建附件。
export const composerImageHistory = invertedEffects.of(tr =>
	tr.docChanged && (tr.startState.field(composerImageLinks).length > 0 || tr.effects.some(effect => effect.is(setComposerImageLinks)))
		? [setComposerImageLinks.of(tr.startState.field(composerImageLinks))] : []);
