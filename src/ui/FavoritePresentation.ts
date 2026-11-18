import { t } from "../i18n";
import type { FavoriteService } from "../services/FavoriteService";
import type { FavoriteQueryProgress } from "../types/favorite";

export function getFavoriteFeedback(
	status: FavoriteService["status"], progress: FavoriteQueryProgress | undefined, hasResults: boolean, hasMore: boolean,
): { title: string; description: string; loading?: true } | null {
	if (status === "error") return { title: t("favorite.error.title"), description: t("favorite.error.description") };
	if (status === "conflict") return { title: t("favorite.conflict.title"), description: t("favorite.conflict.description") };
	if (status === "loading" || !progress) return { title: t("favorite.loading.title"), description: "", loading: true };
	if (!progress.persisted) return { title: t("favorite.empty.title"), description: t("favorite.empty.description") };
	if (progress.waiting || progress.missing) return hasResults
		? { title: t("favorite.partial.title"), description: "" }
		: { title: t("favorite.missing.title"), description: t("favorite.missing.description") };
	if (!hasResults && !hasMore) return { title: t("favorite.noMatch.title"), description: t("favorite.noMatch.description") };
	return null;
}
