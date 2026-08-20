import type { CatalogV2MaterializedState, MigrationPackage } from "../types/catalogV2";
import { CatalogV2MigrationReducer } from "./CatalogV2Migration";
import { canonicalJson } from "./CatalogV2Protocol";
import type { IndexedDbCatalogV2StateStore } from "./IndexedDbCatalogV2StateStore";

export class CatalogV2ColdStartVerifier {
	constructor(private readonly stateStore: IndexedDbCatalogV2StateStore) {}

	async verify(input: {
		generationDigest: string;
		packages: readonly MigrationPackage[];
		eventState: CatalogV2MaterializedState;
		expectedState: CatalogV2MaterializedState;
	}): Promise<boolean> {
		if (!/^[a-f0-9]{64}$/u.test(input.generationDigest)) return false;
		const suffix = `${input.generationDigest}-${Date.now().toString(16)}`;
		await this.stateStore.deleteIsolatedVerificationStore(suffix);
		const isolated = this.stateStore.createIsolatedVerificationStore(suffix);
		try {
			await isolated.open();
			const materialized = await new CatalogV2MigrationReducer().reduce(input.packages, input.eventState);
			await isolated.saveMaterializedState(materialized);
			isolated.close();
			const reopened = this.stateStore.createIsolatedVerificationStore(suffix);
			try {
				await reopened.open();
				const snapshot = await reopened.loadMaterializedSnapshot();
				return snapshot !== null
					&& canonicalJson(snapshot.state) === canonicalJson(input.expectedState)
					&& canonicalJson(materialized) === canonicalJson(input.expectedState);
			} finally {
				reopened.close();
			}
		} finally {
			isolated.close();
			await this.stateStore.deleteIsolatedVerificationStore(suffix);
		}
	}
}
