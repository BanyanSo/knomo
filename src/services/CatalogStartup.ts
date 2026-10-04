export interface CatalogStartupOptions {
	initializeCatalog: () => Promise<void>;
	primeCatalog: () => Promise<void>;
	initializeConfiguration: () => Promise<void>;
	initializeMonthly: () => Promise<void>;
	initializeRecovery: () => Promise<void>;
	isCancelled: () => boolean;
	onAuxiliaryError: (error: unknown) => void;
}

// Catalog 自身失败仍报告；配置/投影和旧恢复独立运行，不能成为普通查询前置条件。
export async function initializeCatalogRuntime(options: CatalogStartupOptions): Promise<boolean> {
	if (options.isCancelled()) return false;
	const configuration = Promise.resolve().then(() => {
		if (!options.isCancelled()) return options.initializeConfiguration();
	});
	// 配置与 inventory 独立；立即处理失败，Monthly 仍须等待两者。
	const configurationReady = configuration.then(() => true, error => {
		options.onAuxiliaryError(error);
		return false;
	});
	await options.initializeCatalog();
	if (options.isCancelled()) return false;
	void (async () => {
		if (await configurationReady && !options.isCancelled()) await options.initializeMonthly();
	})().catch(options.onAuxiliaryError);
	void Promise.resolve().then(() => {
		if (!options.isCancelled()) return options.initializeRecovery();
	}).catch(options.onAuxiliaryError);
	await options.primeCatalog();
	return !options.isCancelled();
}
