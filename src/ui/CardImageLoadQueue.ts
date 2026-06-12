export interface CardImageLoadItem {
	imageEl: HTMLImageElement;
	src: string;
	onError: () => void;
}

export interface CardImageLoadRequest {
	targetEl: HTMLElement;
	images: CardImageLoadItem[];
	generation: number;
}

interface CardImageLoadQueueOptions {
	concurrency: number;
	getGeneration: () => number;
	scheduleTask: (callback: () => void, delayMs: number) => number;
	cancelTask: (taskId: number) => void;
	watchdogMs: number;
	Observer?: typeof IntersectionObserver;
	rootMargin?: string;
}

interface ActiveCardImage {
	item: CardImageLoadItem;
	handleLoad: () => void;
	handleError: () => void;
	listening: boolean;
}

interface CardImageLoadEntry extends CardImageLoadRequest {
	startTaskId: number | null;
	watchdogTaskId: number | null;
	remainingImages: number;
	activeImages: Map<HTMLImageElement, ActiveCardImage>;
}

export class CardImageLoadQueue {
	private observer: IntersectionObserver | null = null;
	private readonly observedEntries = new Map<Element, CardImageLoadEntry>();
	private pendingEntries: CardImageLoadEntry[] = [];
	private readonly slotEntries = new Set<CardImageLoadEntry>();
	private readonly runningEntries = new Set<CardImageLoadEntry>();
	private readonly loadedSources = new Set<string>();

	constructor(private readonly options: CardImageLoadQueueOptions) {
		const Observer = options.Observer;
		if (Observer !== undefined) {
			this.observer = new Observer((entries) => this.handleIntersections(entries), {
				root: null,
				rootMargin: options.rootMargin ?? "160px 0px",
				threshold: 0.01,
			});
		}
	}

	observe(request: CardImageLoadRequest): void {
		const pendingImages = request.images.filter((item) => {
			if (!this.loadedSources.has(item.src)) {
				return true;
			}
			item.imageEl.setAttr("src", item.src);
			return false;
		});
		if (pendingImages.length === 0) {
			return;
		}
		const entry: CardImageLoadEntry = {
			...request,
			images: pendingImages,
			startTaskId: null,
			watchdogTaskId: null,
			remainingImages: pendingImages.length,
			activeImages: new Map(),
		};
		if (this.observer === null) {
			this.pendingEntries.push(entry);
			this.pump();
			return;
		}
		this.observedEntries.set(request.targetEl, entry);
		this.observer.observe(request.targetEl);
	}

	forget(targetEl: HTMLElement, clearSources = false): void {
		const observedEntry = this.observedEntries.get(targetEl);
		if (observedEntry !== undefined) {
			this.observedEntries.delete(targetEl);
			this.observer?.unobserve(targetEl);
			if (clearSources) {
				for (const item of observedEntry.images) {
					item.imageEl.removeAttribute("src");
				}
			}
		}
		this.pendingEntries = this.pendingEntries.filter((entry) => {
			if (entry.targetEl !== targetEl) {
				return true;
			}
			if (clearSources) {
				for (const item of entry.images) {
					item.imageEl.removeAttribute("src");
				}
			}
			return false;
		});
		for (const entry of [...this.runningEntries]) {
			if (entry.targetEl === targetEl) {
				this.cancelEntry(entry, clearSources);
			}
		}
	}

	clear(): void {
		this.observer?.disconnect();
		this.observedEntries.clear();
		this.pendingEntries = [];
		for (const entry of [...this.runningEntries]) {
			this.cancelEntry(entry, true);
		}
		this.slotEntries.clear();
		this.runningEntries.clear();
		this.loadedSources.clear();
	}

	dispose(): void {
		this.clear();
		this.observer = null;
	}

	private handleIntersections(entries: IntersectionObserverEntry[]): void {
		for (const observerEntry of entries) {
			if (!observerEntry.isIntersecting) {
				continue;
			}
			const entry = this.observedEntries.get(observerEntry.target);
			if (entry === undefined) {
				continue;
			}
			this.observedEntries.delete(observerEntry.target);
			this.observer?.unobserve(observerEntry.target);
			this.pendingEntries.push(entry);
		}
		this.pump();
	}

	private pump(): void {
		while (this.slotEntries.size < this.options.concurrency) {
			const entry = this.pendingEntries.shift();
			if (entry === undefined) {
				return;
			}
			if (!this.isCurrentEntry(entry)) {
				continue;
			}
			this.slotEntries.add(entry);
			this.runningEntries.add(entry);
			entry.startTaskId = this.options.scheduleTask(() => {
				entry.startTaskId = null;
				this.startEntry(entry);
			}, 0);
		}
	}

	private startEntry(entry: CardImageLoadEntry): void {
		if (!this.runningEntries.has(entry)) {
			return;
		}
		if (!this.isCurrentEntry(entry)) {
			this.cancelEntry(entry, true);
			return;
		}
		for (const item of entry.images) {
			if (!item.imageEl.isConnected) {
				entry.remainingImages -= 1;
				continue;
			}
			const activeImage: ActiveCardImage = {
				item,
				handleLoad: () => this.handleImageLoad(entry, activeImage),
				handleError: () => this.handleImageError(entry, activeImage),
				listening: true,
			};
			entry.activeImages.set(item.imageEl, activeImage);
			item.imageEl.addEventListener("load", activeImage.handleLoad);
			item.imageEl.addEventListener("error", activeImage.handleError);
			item.imageEl.setAttr("src", item.src);
		}
		if (entry.remainingImages === 0) {
			this.completeEntry(entry);
			return;
		}
		entry.watchdogTaskId = this.options.scheduleTask(() => {
			entry.watchdogTaskId = null;
			this.releaseSlot(entry);
		}, this.options.watchdogMs);
	}

	private handleImageLoad(entry: CardImageLoadEntry, activeImage: ActiveCardImage): void {
		if (entry.activeImages.get(activeImage.item.imageEl) !== activeImage) {
			return;
		}
		this.removeActiveImageListeners(activeImage);
		let decodePromise: Promise<void>;
		try {
			decodePromise = typeof activeImage.item.imageEl.decode === "function"
				? activeImage.item.imageEl.decode()
				: Promise.resolve();
		} catch {
			decodePromise = Promise.resolve();
		}
		void decodePromise
			.catch(() => undefined)
			.then(() => this.completeImage(entry, activeImage, true));
	}

	private handleImageError(entry: CardImageLoadEntry, activeImage: ActiveCardImage): void {
		if (entry.activeImages.get(activeImage.item.imageEl) !== activeImage) {
			return;
		}
		this.removeActiveImageListeners(activeImage);
		this.completeImage(entry, activeImage, false);
	}

	private completeImage(entry: CardImageLoadEntry, activeImage: ActiveCardImage, loaded: boolean): void {
		if (!this.runningEntries.has(entry)) {
			return;
		}
		if (!this.isCurrentEntry(entry)) {
			this.cancelEntry(entry, true);
			return;
		}
		entry.activeImages.delete(activeImage.item.imageEl);
		if (loaded) {
			this.loadedSources.add(activeImage.item.src);
		}
		if (!loaded && activeImage.item.imageEl.isConnected) {
			activeImage.item.onError();
		}
		entry.remainingImages -= 1;
		if (entry.remainingImages === 0) {
			this.completeEntry(entry);
		}
	}

	private completeEntry(entry: CardImageLoadEntry): void {
		this.cancelEntryTasks(entry);
		this.runningEntries.delete(entry);
		this.releaseSlot(entry);
	}

	private cancelEntry(entry: CardImageLoadEntry, clearSources: boolean): void {
		this.cancelEntryTasks(entry);
		for (const activeImage of entry.activeImages.values()) {
			this.removeActiveImageListeners(activeImage);
			if (clearSources) {
				activeImage.item.imageEl.removeAttribute("src");
			}
		}
		entry.activeImages.clear();
		this.runningEntries.delete(entry);
		this.releaseSlot(entry);
	}

	private cancelEntryTasks(entry: CardImageLoadEntry): void {
		if (entry.startTaskId !== null) {
			this.options.cancelTask(entry.startTaskId);
			entry.startTaskId = null;
		}
		if (entry.watchdogTaskId !== null) {
			this.options.cancelTask(entry.watchdogTaskId);
			entry.watchdogTaskId = null;
		}
	}

	private removeActiveImageListeners(activeImage: ActiveCardImage): void {
		if (!activeImage.listening) {
			return;
		}
		activeImage.item.imageEl.removeEventListener("load", activeImage.handleLoad);
		activeImage.item.imageEl.removeEventListener("error", activeImage.handleError);
		activeImage.listening = false;
	}

	private releaseSlot(entry: CardImageLoadEntry): void {
		if (this.slotEntries.delete(entry)) {
			this.pump();
		}
	}

	private isCurrentEntry(entry: CardImageLoadEntry): boolean {
		return entry.generation === this.options.getGeneration() && entry.targetEl.isConnected;
	}
}
