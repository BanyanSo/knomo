import { addIcon } from "obsidian";

export const KNOMO_LOGO_ICON = "knomo-logo";
export const KNOMO_SEARCH_ICON = "knomo-search";
export const KNOMO_SIDEBAR_MENU_ICON = "knomo-sidebar-menu";
export const KNOMO_RANDOM_REUNION_ICON = "knomo-random-reunion";

const KNOMO_ICON_SVGS: Record<string, string> = {
	[KNOMO_LOGO_ICON]: "<g transform=\"scale(1.5625)\"><path d=\"M18 10v44\" stroke=\"currentColor\" stroke-width=\"8\" stroke-linecap=\"round\" fill=\"none\"/><path d=\"M34 32L52 15\" stroke=\"currentColor\" stroke-width=\"8\" stroke-linecap=\"round\" fill=\"none\"/><path d=\"M34 32L53 49\" stroke=\"currentColor\" stroke-width=\"8\" stroke-linecap=\"round\" fill=\"none\"/><circle cx=\"32\" cy=\"32\" r=\"5\" fill=\"currentColor\"/></g>",
	[KNOMO_SEARCH_ICON]: "<g transform=\"scale(4.1666666667)\"><circle cx=\"10.5\" cy=\"10.5\" r=\"6.5\" stroke=\"currentColor\" stroke-width=\"2\" fill=\"none\"/><path d=\"M15.5 15.5L20 20\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" fill=\"none\"/><circle cx=\"10.5\" cy=\"10.5\" r=\"2\" fill=\"currentColor\"/></g>",
	[KNOMO_SIDEBAR_MENU_ICON]: "<g transform=\"scale(4.1666666667)\"><path d=\"M5 5v14M10 7h9M10 12h7M10 17h5\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" fill=\"none\"/><circle cx=\"19\" cy=\"17\" r=\"1.8\" fill=\"currentColor\"/></g>",
	[KNOMO_RANDOM_REUNION_ICON]: "<g transform=\"scale(4.1666666667)\"><path d=\"M5 6c4-3 6 3 10 0 2-1.5 4-.5 4 2 0 3-4 3-6 5-3 2.5-1 5-5 5\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\" stroke-dasharray=\"1 4\" fill=\"none\"/><circle cx=\"5\" cy=\"6\" r=\"2\" fill=\"currentColor\"/><circle cx=\"8\" cy=\"18\" r=\"2\" fill=\"currentColor\"/></g>",
};

export function registerKnomoIcons(): void {
	for (const [iconId, svg] of Object.entries(KNOMO_ICON_SVGS)) {
		addIcon(iconId, svg);
	}
}
