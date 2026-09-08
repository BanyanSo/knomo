import type {
	CatalogCapabilities,
	CatalogCoverage,
	ResolvedMemoCapabilities,
} from "../types/catalog";

export function createResolvedMemoCapabilities(): ResolvedMemoCapabilities {
	return {
		markdown: {
			view: true,
			create: true,
			edit: true,
			task: true,
			copy: true,
			move: true,
			remove: true,
			openDaily: true,
			openLinks: true,
			openImages: true,
			explicitBlockReference: true,
		},

	};
}

export function createCatalogCapabilities(coverage: CatalogCoverage): CatalogCapabilities {
	const state = coverage.kind === "complete" && coverage.sharedConfigurationComplete !== false
		? "complete"
		: "partial";
	return {
		browse: state,
		search: state,
		stats: state,
		shuffle: state,
		random: state,
		timeBuoy: state,
		fullHistory: state,
	};
}
