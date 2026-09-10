import { AbstractInputSuggest } from "obsidian";
import type { App } from "obsidian";

const MAX_FOLDER_SUGGESTIONS = 50;

export function filterVaultFolderPaths(paths: readonly string[], query: string): string[] {
	const terms = query.trim().toLocaleLowerCase().split(/[\\/\s]+/u).filter(Boolean);
	return [...paths]
		.filter((path) => {
			const normalized = path.toLocaleLowerCase();
			return terms.every((term) => normalized.includes(term));
		})
		.sort((left, right) => left.localeCompare(right))
		.slice(0, MAX_FOLDER_SUGGESTIONS);
}

export class KnomoFolderSuggest extends AbstractInputSuggest<string> {
	constructor(
		app: App,
		inputEl: HTMLInputElement,
		private readonly onSelected: (path: string) => void,
	) {
		super(app, inputEl);
		this.limit = MAX_FOLDER_SUGGESTIONS;
	}

	protected getSuggestions(query: string): string[] {
		return filterVaultFolderPaths(
			this.app.vault.getAllFolders(false).map((folder) => folder.path),
			query,
		);
	}

	renderSuggestion(path: string, el: HTMLElement): void {
		el.setText(path);
	}

	selectSuggestion(path: string): void {
		this.setValue(path);
		this.onSelected(path);
		this.close();
	}
}
