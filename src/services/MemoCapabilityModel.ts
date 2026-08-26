import type {
	CatalogCapabilities,
	CatalogCoverage,
	IdentityCapabilityState,
	ResolvedMemoCapabilities,
} from "../types/catalog";

export function createResolvedMemoCapabilities(identityState: IdentityCapabilityState): ResolvedMemoCapabilities {
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
		identity: {
			relation: identityState,
			review: identityState,
			recoverableDelete: identityState,
			restore: identityState,
			merge: identityState,
			repair: identityState,
			crossDeviceIdentity: identityState,
		},
	};
}

export function createIdentityLedgerMemoCapabilities(): ResolvedMemoCapabilities {
	const capabilities = createResolvedMemoCapabilities("syncing");
	return {
		markdown: capabilities.markdown,
		identity: {
			...capabilities.identity,
			relation: "ready",
			review: "ready",
			recoverableDelete: "ready",
			restore: "ready",
			repair: "ready",
			crossDeviceIdentity: "ready",
		},
	};
}

export function createIdentityLedgerConflictCapabilities(): ResolvedMemoCapabilities {
	const capabilities = createResolvedMemoCapabilities("conflicted");
	return {
		markdown: capabilities.markdown,
		identity: {
			...capabilities.identity,
			repair: "ready",
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
