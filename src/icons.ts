import { addIcon } from "obsidian";

export const KNOMO_ALL_NOTES_ICON = "knomo-all-notes";
export const KNOMO_LOGO_ICON = "knomo-logo";
export const KNOMO_SEARCH_ICON = "knomo-search";
export const KNOMO_SIDEBAR_MENU_ICON = "knomo-sidebar-menu";
export const KNOMO_RANDOM_REUNION_ICON = "knomo-random-reunion";
export const KNOMO_TIME_BUOY_ICON = "knomo-time-buoy";

const KNOMO_ICON_SVGS: Record<string, string> = {
	[KNOMO_ALL_NOTES_ICON]: "<g transform=\"scale(4.1666666667)\"><rect x=\"4\" y=\"4\" width=\"14\" height=\"16\" rx=\"3\" stroke=\"currentColor\" stroke-width=\"2\" fill=\"none\"/><path d=\"M8 9h6M8 13h5\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" fill=\"none\"/><circle cx=\"18\" cy=\"18\" r=\"2.1\" fill=\"currentColor\"/></g>",
	[KNOMO_LOGO_ICON]: "<g transform=\"scale(1.5625)\"><path d=\"M18 10v44\" stroke=\"currentColor\" stroke-width=\"8\" stroke-linecap=\"round\" fill=\"none\"/><path d=\"M34 32L52 15\" stroke=\"currentColor\" stroke-width=\"8\" stroke-linecap=\"round\" fill=\"none\"/><path d=\"M34 32L53 49\" stroke=\"currentColor\" stroke-width=\"8\" stroke-linecap=\"round\" fill=\"none\"/><circle cx=\"32\" cy=\"32\" r=\"5\" fill=\"currentColor\"/></g>",
	[KNOMO_SEARCH_ICON]: "<g transform=\"scale(4.1666666667)\"><circle cx=\"10.5\" cy=\"10.5\" r=\"6.5\" stroke=\"currentColor\" stroke-width=\"2\" fill=\"none\"/><path d=\"M15.5 15.5L20 20\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" fill=\"none\"/><circle cx=\"10.5\" cy=\"10.5\" r=\"2\" fill=\"currentColor\"/></g>",
	[KNOMO_SIDEBAR_MENU_ICON]: "<g transform=\"scale(4.1666666667)\"><path d=\"M5 5v14M10 7h9M10 12h7M10 17h5\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" fill=\"none\"/><circle cx=\"19\" cy=\"17\" r=\"1.8\" fill=\"currentColor\"/></g>",
	[KNOMO_RANDOM_REUNION_ICON]: "<g transform=\"scale(4.1666666667)\"><path d=\"M5 6c4-3 6 3 10 0 2-1.5 4-.5 4 2 0 3-4 3-6 5-3 2.5-1 5-5 5\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\" stroke-dasharray=\"1 4\" fill=\"none\"/><circle cx=\"5\" cy=\"6\" r=\"2\" fill=\"currentColor\"/><circle cx=\"8\" cy=\"18\" r=\"2\" fill=\"currentColor\"/></g>",
	[KNOMO_TIME_BUOY_ICON]: "<g transform=\"scale(4.1666666667)\"><path d=\"M6.3 17.1A8 8 0 1 1 17.7 17.1\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" fill=\"none\"/><circle cx=\"17.65\" cy=\"6.35\" r=\"1.65\" stroke=\"currentColor\" stroke-width=\"2\" fill=\"none\"/><circle cx=\"12\" cy=\"11.6\" r=\"1.7\" fill=\"currentColor\"/><path d=\"M12 8.2v.8M9.5 10l.7.5M14.5 10l-.7.5M12 13.3v1.1M9.8 17.4h4.4M10.8 19.4h2.4\" stroke=\"currentColor\" stroke-width=\"1.6\" stroke-linecap=\"round\" fill=\"none\"/></g>",
};

export function registerKnomoIcons(): void {
	for (const [iconId, svg] of Object.entries(KNOMO_ICON_SVGS)) {
		addIcon(iconId, svg);
	}
}
