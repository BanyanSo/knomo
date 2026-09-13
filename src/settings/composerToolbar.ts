export const COMPOSER_ACTIONS = ["tag", "image", "time-buoy", "task", "list", "bold", "highlight", "link", "numbered-list"] as const;
export type ComposerAction = typeof COMPOSER_ACTIONS[number];
export interface ComposerToolbarPreferences { order: ComposerAction[]; hidden: ComposerAction[] }
export function normalizeComposerToolbar(value: unknown): ComposerToolbarPreferences {
	const record = value !== null && typeof value === "object" ? value as Record<string, unknown> : {};
	const valid = (entry: unknown): entry is ComposerAction => typeof entry === "string" && (COMPOSER_ACTIONS as readonly string[]).includes(entry);
	const order = Array.isArray(record.order) ? [...new Set(record.order.filter(valid))] : [];
	return { order: [...order, ...COMPOSER_ACTIONS.filter(action => !order.includes(action))],
		hidden: Array.isArray(record.hidden) ? [...new Set(record.hidden.filter(valid))] : ["bold", "highlight", "link", "numbered-list"] };
}
