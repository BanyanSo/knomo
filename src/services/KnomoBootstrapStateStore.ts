import { isRecord } from "../utils/object";
import { KnomoCurrentStateStore } from "./KnomoCurrentStateStore";

/** 首次导入只保留进行中的授权；1.2.9 只保留当前源的迁移结果，不依赖历史事件回执。 */
export class KnomoBootstrapStateStore {
	constructor(private readonly store: KnomoCurrentStateStore) {}
	getMeta<T>(key: string): Promise<T | null> { return this.store.getMeta<T>(key); }
	getMetaValues<T>(key: string): Promise<T[]> { return this.store.getMetaValues<T>(key); }
	deleteMeta(key: string): Promise<void> { return this.store.deleteMeta(key); }
	setMeta(key: string, value: unknown): Promise<void> {
		if (key === "historicalIdentityBootstrap" && isRecord(value) && value.state === "completed") {
			return this.store.deleteMeta(key);
		}
		if (isRecord(value)) {
			const { requiredIdentityEventIds: _dependencies, ...current } = value;
			return this.store.setMeta(key, current);
		}
		return this.store.setMeta(key, value);
	}
}
