import { normalizePath, TFile, TFolder } from "obsidian";
import type { App, Component, TAbstractFile } from "obsidian";

import type {
	KnomoSharedConfig,
	KnomoSharedConfigEvent,
	KnomoSharedConfigEventEnvelope,
	KnomoSharedConfigSnapshot,
	KnomoSharedConfigStatus,
} from "../types/knomoConfig";
import { ensureFolder as ensureVaultFolder } from "../utils/vault";
import {
	canonicalKnomoSharedConfigJson,
	createKnomoSharedConfigEventId,
	getKnomoSharedConfigSegmentPath,
	getKnomoSharedConfigWriterSegmentsPath,
	parseKnomoSharedConfigSegment,
	serializeKnomoSharedConfigSegment,
	sha256KnomoSharedConfigText,
	getKnomoSharedConfigRootPath,
	KNOMO_SHARED_CONFIG_RELATIVE_ROOT,
} from "./KnomoSharedConfigProtocol";
import { normalizeMonthlyLocaleKey } from "./MonthlyProjection";

export interface KnomoSharedConfigServiceOptions {
	getRootPath: () => string | null;
	getWriterId: () => Promise<string>;
	getCurrentLocale: () => string;
	getLocalConfig: (monthlyLocale: string) => Promise<KnomoSharedConfig>;
	createEventId?: () => string;
	now?: () => Date;
}

export class KnomoSharedConfigService {
	private readonly createEventId: () => string;
	private readonly now: () => Date;
	private localConfig: KnomoSharedConfig | null = null;
	private monthlyLocale: string | null = null;
	private envelopes: KnomoSharedConfigEventEnvelope[] = [];
	private snapshot: KnomoSharedConfigSnapshot = createEmptySnapshot();
	private status: KnomoSharedConfigStatus = "missing";
	private lastError: string | null = null;
	private invalidFileCount = 0;
	private onChanged: (() => void | Promise<void>) | null = null;
	private changeNotificationQueue: Promise<void> = Promise.resolve();
	private refreshQueue: Promise<void> = Promise.resolve();
	private refreshRequested = false;
	private writeQueue: Promise<void> = Promise.resolve();
	private writePauseCount = 0;

	constructor(
		private readonly app: App,
		private readonly options: KnomoSharedConfigServiceOptions,
	) {
		this.createEventId = options.createEventId ?? createKnomoSharedConfigEventId;
		this.now = options.now ?? (() => new Date());
	}

	start(owner: Component, onChanged: () => void | Promise<void>): void {
		this.onChanged = onChanged;
		const handle = (file: unknown, oldPath?: unknown) => {
			const rootPath = this.getRootPath();
			if (!isConfigFile(file, rootPath) && !isConfigPath(oldPath, rootPath)) return;
			this.scheduleRefresh();
		};
		owner.registerEvent(this.app.vault.on("create", handle));
		owner.registerEvent(this.app.vault.on("modify", handle));
		owner.registerEvent(this.app.vault.on("delete", handle));
		owner.registerEvent(this.app.vault.on("rename", handle));
		owner.register(() => { this.onChanged = null; });
		// 监听建立后补扫一次，覆盖初始化扫描与事件注册之间的变更窗口。
		this.scheduleRefresh();
	}

	async initializeLocalConfig(): Promise<void> {
		let localConfig: KnomoSharedConfig | null = null;
		try {
			localConfig = await this.readLocalConfig();
		} catch {
			// 共享配置可在本机 Daily Notes 设置不可用时继续提供只读解析配置。
		}
		this.localConfig = localConfig;
	}

	async initialize(): Promise<void> {
		await this.initializeLocalConfig();
		try {
			await this.refreshFromVault();
			if (this.status !== "ready" && this.localConfig === null) this.status = "unavailable";
			this.lastError = null;
		} catch (error) {
			this.status = "unavailable";
			this.snapshot = createEmptySnapshot();
			this.lastError = errorDetail(error);
		}
	}

	async reloadConfiguredRoot(): Promise<void> {
		await this.initialize();
		this.notifyChanged();
	}

	async refreshLocalConfig(): Promise<void> {
		this.localConfig = await this.readLocalConfig();
		this.notifyChanged();
	}

	getStatus(): KnomoSharedConfigStatus {
		return this.status;
	}

	getLastError(): string | null {
		return this.lastError;
	}

	getSnapshot(): KnomoSharedConfigSnapshot {
		return cloneSnapshot(this.snapshot);
	}

	getMonthlyLocale(): string | null {
		if (this.status === "ready" && this.snapshot.config !== null) {
			return this.snapshot.config.monthly.locale;
		}
		return this.localConfig?.monthly.locale ?? this.monthlyLocale;
	}

	getEffectiveConfig(): KnomoSharedConfig {
		const sharedConfig = this.status === "ready" ? this.snapshot.config : null;
		const config = sharedConfig ?? this.localConfig;
		if (config === null) throw new Error("Knomo shared configuration is not initialized.");
		return cloneConfig(config);
	}

	isCoverageComplete(): boolean {
		return this.status === "ready";
	}

	isMonthlyProjectionAllowed(): boolean {
		return this.status === "ready" && this.snapshot.config !== null;
	}

	async publishLocalConfig(): Promise<void> {
		this.localConfig = await this.readLocalConfig();
		if (this.status === "conflicted") {
			throw new Error("Shared configuration is conflicted; explicit resolution is required.");
		}
		if (this.status === "unavailable") {
			throw new Error("Shared configuration cannot be safely updated.");
		}
		const localConfig = this.requireLocalConfig();
		if (this.status === "ready" && this.snapshot.config !== null
			&& canonicalKnomoSharedConfigJson(this.snapshot.config) === canonicalKnomoSharedConfigJson(localConfig)) {
			return;
		}
		await this.appendConfig(localConfig, this.status === "ready" ? this.snapshot.headEventIds : []);
	}

	async resolveWithLocalConfig(): Promise<void> {
		this.localConfig = await this.readLocalConfig();
		if (this.status !== "conflicted") {
			await this.publishLocalConfig();
			return;
		}
		await this.appendConfig(this.requireLocalConfig(), this.snapshot.headEventIds);
	}

	async useCurrentObsidianLocale(): Promise<boolean> {
		if (this.status === "conflicted") {
			throw new Error("Shared configuration is conflicted; explicit resolution is required.");
		}
		if (this.status === "unavailable") {
			throw new Error("Shared configuration cannot be safely updated.");
		}
		const locale = normalizeMonthlyLocaleKey(this.options.getCurrentLocale());
		const source = this.status === "ready" && this.snapshot.config !== null
			? this.snapshot.config
			: this.requireLocalConfig();
		const nextConfig = withMonthlyLocale(source, locale);
		this.monthlyLocale = locale;
		if (this.localConfig !== null) this.localConfig = withMonthlyLocale(this.localConfig, locale);
		if (this.status === "ready" && this.snapshot.config !== null
			&& canonicalKnomoSharedConfigJson(this.snapshot.config) === canonicalKnomoSharedConfigJson(nextConfig)) {
			return false;
		}
		await this.appendConfig(nextConfig, this.status === "ready" ? this.snapshot.headEventIds : []);
		return true;
	}

	async runWithWritesPaused<T>(operation: () => Promise<T>): Promise<T> {
		this.writePauseCount += 1;
		await this.writeQueue;
		try {
			return await operation();
		} finally {
			this.writePauseCount -= 1;
		}
	}

	async copyAndVerifyDataRoot(sourceDataRoot: string, targetDataRoot: string): Promise<void> {
		await this.runWithWritesPaused(async () => {
			const sourceRoot = getKnomoSharedConfigRootPath(sourceDataRoot);
			const targetRoot = getKnomoSharedConfigRootPath(targetDataRoot);
			const source = await this.readImage(sourceRoot);
			const target = await this.readImage(targetRoot);
			if (source === null) {
				if (target !== null && target.size > 0) {
					throw new Error("The target contains shared configuration absent from the source.");
				}
				return;
			}
			if (target !== null) assertImageSubset(source, target);
			await this.ensureFolder(targetRoot, `${targetRoot}/writers`);
			for (const [relativePath, content] of source) {
				const targetPath = normalizePath(`${targetRoot}/${relativePath}`);
				await this.ensureFolder(targetRoot, parentPath(targetPath));
				await this.writeImmutable(targetPath, content);
			}
			const stableSource = await this.readImage(sourceRoot);
			if (stableSource === null || !imagesEqual(source, stableSource)) {
				throw new Error("Shared configuration source changed during migration.");
			}
			const verified = await this.readImage(targetRoot);
			if (verified === null || !imagesEqual(source, verified)) {
				throw new Error("Shared configuration migration verification failed.");
			}
		});
	}

	private async appendConfig(config: KnomoSharedConfig, baseEventIds: readonly string[]): Promise<void> {
		if (this.writePauseCount > 0) throw new Error("Shared configuration writes are paused.");
		const event: KnomoSharedConfigEvent = {
			eventId: this.createEventId(),
			writerId: await this.options.getWriterId(),
			type: "set_config",
			baseEventIds: [...new Set(baseEventIds)].sort(),
			occurredAt: this.now().toISOString(),
			config: cloneConfig(config),
		};
		const previous = this.writeQueue;
		let releaseQueue: () => void = () => undefined;
		this.writeQueue = new Promise<void>((resolve) => { releaseQueue = resolve; });
		await previous;
		try {
			const rootPath = this.requireWritableRoot();
			const content = serializeKnomoSharedConfigSegment([event]);
			const digest = await sha256KnomoSharedConfigText(content);
			const path = getKnomoSharedConfigSegmentPath(rootPath, event.writerId, event.eventId, digest);
			await this.ensureFolder(rootPath, getKnomoSharedConfigWriterSegmentsPath(rootPath, event.writerId));
			await this.writeImmutable(path, content);
			const parsed = await parseKnomoSharedConfigSegment(rootPath, path, content);
			this.envelopes = mergeEnvelopes(this.envelopes, parsed.events);
			await this.materialize();
			this.lastError = null;
		} catch (error) {
			this.status = "unavailable";
			this.lastError = errorDetail(error);
			throw error;
		} finally {
			releaseQueue();
		}
		this.notifyChanged();
	}

	private async refreshFromVault(): Promise<void> {
		const rootPath = this.getRootPath();
		if (rootPath === null) {
			this.setMissing();
			return;
		}
		const root = this.app.vault.getAbstractFileByPath(rootPath);
		if (root === null) {
			this.setMissing();
			return;
		}
		if (!(root instanceof TFolder)) throw new Error("Knomo shared configuration root is not a folder.");
		const envelopes: KnomoSharedConfigEventEnvelope[] = [];
		let invalidFiles = 0;
		for (const file of listFiles(root).sort((left, right) => left.path.localeCompare(right.path))) {
			try {
				const parsed = await parseKnomoSharedConfigSegment(rootPath, file.path, await this.app.vault.cachedRead(file));
				envelopes.push(...parsed.events);
			} catch {
				invalidFiles += 1;
			}
		}
		this.envelopes = envelopes;
		this.invalidFileCount = invalidFiles;
		await this.materialize();
	}

	private async readImage(rootPath: string): Promise<Map<string, string> | null> {
		const root = this.app.vault.getAbstractFileByPath(normalizePath(rootPath));
		if (root === null) return null;
		if (!(root instanceof TFolder)) throw new Error(`Shared configuration root is not a folder: ${rootPath}`);
		const normalizedRoot = normalizePath(rootPath);
		const image = new Map<string, string>();
		for (const file of listFiles(root).sort((left, right) => left.path.localeCompare(right.path))) {
			image.set(file.path.slice(normalizedRoot.length + 1), await this.app.vault.cachedRead(file));
		}
		return image;
	}

	private async materialize(): Promise<void> {
		this.snapshot = await materializeKnomoSharedConfig(this.envelopes);
		this.status = this.invalidFileCount > 0 || this.snapshot.status === "conflicted"
			? "conflicted"
			: this.snapshot.status;
		if (this.status === "ready" && this.snapshot.config !== null) {
			this.monthlyLocale = this.snapshot.config.monthly.locale;
		}
	}

	private scheduleRefresh(): void {
		this.refreshRequested = true;
		this.refreshQueue = this.refreshQueue.then(async () => {
			if (!this.refreshRequested) return;
			this.refreshRequested = false;
			await this.refreshFromVault();
			this.notifyChanged();
		}).catch((error) => {
			this.status = "unavailable";
			this.lastError = errorDetail(error);
		});
	}

	private notifyChanged(): void {
		this.changeNotificationQueue = this.changeNotificationQueue.then(
			async () => { await this.onChanged?.(); },
			async () => { await this.onChanged?.(); },
		).catch(() => undefined);
	}

	private getRootPath(): string | null {
		const rootPath = this.options.getRootPath();
		return rootPath === null ? null : normalizePath(rootPath);
	}

	private requireWritableRoot(): string {
		const rootPath = this.getRootPath();
		if (rootPath === null) throw new Error("Knomo shared configuration root is not configured.");
		const dataFolder = getDataFolderFromConfigRoot(rootPath);
		if (!(this.app.vault.getAbstractFileByPath(dataFolder) instanceof TFolder)) {
			throw new Error("Configured Knomo Data Root is missing.");
		}
		return rootPath;
	}

	private requireLocalConfig(): KnomoSharedConfig {
		if (this.localConfig === null) throw new Error("Local configuration is unavailable.");
		return cloneConfig(this.localConfig);
	}

	private async readLocalConfig(): Promise<KnomoSharedConfig> {
		return cloneConfig(await this.options.getLocalConfig(this.getPinnedMonthlyLocale()));
	}

	private getPinnedMonthlyLocale(): string {
		this.monthlyLocale ??= normalizeMonthlyLocaleKey(this.options.getCurrentLocale());
		return this.monthlyLocale;
	}

	private setMissing(): void {
		this.envelopes = [];
		this.snapshot = createEmptySnapshot();
		this.invalidFileCount = 0;
		this.status = "missing";
		this.lastError = null;
	}

	private async ensureFolder(rootPath: string, path: string): Promise<void> {
		const dataFolder = getDataFolderFromConfigRoot(rootPath);
		const normalizedPath = normalizePath(path);
		if (!normalizedPath.startsWith(`${dataFolder}/`)) throw new Error("Configuration child path escaped Knomo Data Root.");
		await ensureVaultFolder(this.app, normalizedPath);
	}

	private async writeImmutable(path: string, content: string): Promise<void> {
		const existing = this.app.vault.getAbstractFileByPath(path);
		if (existing instanceof TFile) {
			if (await this.app.vault.cachedRead(existing) !== content) throw new Error(`Configuration collision: ${path}`);
			return;
		}
		if (existing !== null) throw new Error(`Configuration path is not a file: ${path}`);
		try {
			await this.app.vault.create(path, content);
		} catch (error) {
			const raced = this.app.vault.getAbstractFileByPath(path);
			if (!(raced instanceof TFile) || await this.app.vault.cachedRead(raced) !== content) throw error;
		}
	}
}

export async function materializeKnomoSharedConfig(
	envelopes: readonly KnomoSharedConfigEventEnvelope[],
): Promise<KnomoSharedConfigSnapshot> {
	const byEventId = new Map<string, KnomoSharedConfigEventEnvelope[]>();
	for (const envelope of envelopes) {
		const values = byEventId.get(envelope.event.eventId) ?? [];
		values.push(envelope);
		byEventId.set(envelope.event.eventId, values);
	}
	const unique = new Map<string, KnomoSharedConfigEventEnvelope>();
	const quarantinedEventIds: string[] = [];
	for (const [eventId, values] of [...byEventId.entries()].sort(([left], [right]) => left.localeCompare(right))) {
		if (new Set(values.map((value) => value.digest)).size !== 1) {
			quarantinedEventIds.push(eventId);
			continue;
		}
		const selected = [...values].sort((left, right) => left.sourcePath.localeCompare(right.sourcePath))[0];
		if (selected !== undefined) unique.set(eventId, selected);
	}
	const accepted = new Map<string, KnomoSharedConfigEventEnvelope>();
	let progressed = true;
	while (progressed) {
		progressed = false;
		for (const [eventId, envelope] of unique) {
			if (accepted.has(eventId)) continue;
			if (envelope.event.baseEventIds.length === 0
				|| envelope.event.baseEventIds.every((baseId) => accepted.has(baseId))) {
				accepted.set(eventId, envelope);
				progressed = true;
			}
		}
	}
	const pendingEventIds = [...unique.keys()].filter((eventId) => !accepted.has(eventId)).sort();
	const referenced = new Set([...accepted.values()].flatMap((item) => item.event.baseEventIds));
	const heads = [...accepted.values()].filter((item) => !referenced.has(item.event.eventId))
		.sort((left, right) => left.event.eventId.localeCompare(right.event.eventId));
	const configValues = new Map<string, KnomoSharedConfig>();
	for (const head of heads) configValues.set(canonicalKnomoSharedConfigJson(head.event.config), head.event.config);
	const status = quarantinedEventIds.length > 0 || configValues.size > 1
		? "conflicted"
		: heads.length === 0 ? "missing" : "ready";
	const config = status === "ready" ? cloneConfig([...configValues.values()][0] as KnomoSharedConfig) : null;
	const revision = await sha256KnomoSharedConfigText(canonicalKnomoSharedConfigJson({
		heads: heads.map((head) => ({ eventId: head.event.eventId, digest: head.digest })),
		pendingEventIds,
		quarantinedEventIds,
	}));
	return {
		status,
		revision,
		config,
		headEventIds: heads.map((head) => head.event.eventId),
		pendingEventIds,
		quarantinedEventIds,
		eventCount: accepted.size,
	};
}

function createEmptySnapshot(): KnomoSharedConfigSnapshot {
	return {
		status: "missing",
		revision: "",
		config: null,
		headEventIds: [],
		pendingEventIds: [],
		quarantinedEventIds: [],
		eventCount: 0,
	};
}

function cloneConfig(config: KnomoSharedConfig): KnomoSharedConfig {
	return {
		daily: { ...config.daily, headings: [...config.daily.headings] },
		monthly: { ...config.monthly },
	};
}

function withMonthlyLocale(config: KnomoSharedConfig, locale: string): KnomoSharedConfig {
	return {
		daily: { ...config.daily, headings: [...config.daily.headings] },
		monthly: {
			...config.monthly,
			locale: normalizeMonthlyLocaleKey(locale),
		},
	};
}

function cloneSnapshot(snapshot: KnomoSharedConfigSnapshot): KnomoSharedConfigSnapshot {
	return {
		...snapshot,
		config: snapshot.config === null ? null : cloneConfig(snapshot.config),
		headEventIds: [...snapshot.headEventIds],
		pendingEventIds: [...snapshot.pendingEventIds],
		quarantinedEventIds: [...snapshot.quarantinedEventIds],
	};
}

function mergeEnvelopes(
	current: readonly KnomoSharedConfigEventEnvelope[],
	next: readonly KnomoSharedConfigEventEnvelope[],
): KnomoSharedConfigEventEnvelope[] {
	const byPathAndId = new Map<string, KnomoSharedConfigEventEnvelope>();
	for (const envelope of [...current, ...next]) {
		byPathAndId.set(`${envelope.sourcePath}\u0000${envelope.event.eventId}`, envelope);
	}
	return [...byPathAndId.values()];
}

function listFiles(root: TFolder): TFile[] {
	const files: TFile[] = [];
	const visit = (file: TAbstractFile) => {
		if (file instanceof TFile) files.push(file);
		if (file instanceof TFolder) file.children.forEach(visit);
	};
	root.children.forEach(visit);
	return files;
}

function isConfigFile(value: unknown, rootPath: string | null): value is TFile {
	return value instanceof TFile && isConfigPath(value.path, rootPath);
}

function isConfigPath(value: unknown, rootPath: string | null): value is string {
	if (typeof value !== "string" || rootPath === null) return false;
	const normalizedRoot = normalizePath(rootPath);
	const normalizedPath = normalizePath(value);
	return normalizedPath === normalizedRoot || normalizedPath.startsWith(`${normalizedRoot}/`);
}

function parentPath(path: string): string {
	const separator = path.lastIndexOf("/");
	return separator < 0 ? "" : path.slice(0, separator);
}

function errorDetail(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function getDataFolderFromConfigRoot(rootPath: string): string {
	const normalizedRoot = normalizePath(rootPath);
	const suffix = KNOMO_SHARED_CONFIG_RELATIVE_ROOT.slice("_knomo-data".length);
	if (!normalizedRoot.endsWith(suffix)) {
		throw new Error("Knomo shared configuration root is outside Knomo Data Root.");
	}
	const dataFolder = normalizedRoot.slice(0, -suffix.length);
	if (dataFolder !== "_knomo-data" && !dataFolder.endsWith("/_knomo-data")) {
		throw new Error("Knomo shared configuration root is outside Knomo Data Root.");
	}
	return dataFolder;
}

function assertImageSubset(source: ReadonlyMap<string, string>, target: ReadonlyMap<string, string>): void {
	for (const [path, content] of target) {
		if (source.get(path) !== content) {
			throw new Error(`The target contains conflicting shared configuration bytes: ${path}`);
		}
	}
}

function imagesEqual(left: ReadonlyMap<string, string>, right: ReadonlyMap<string, string>): boolean {
	if (left.size !== right.size) return false;
	for (const [path, content] of left) {
		if (right.get(path) !== content) return false;
	}
	return true;
}
