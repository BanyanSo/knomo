export interface CardImageLoadItem {
	imageEl: HTMLImageElement;
	src: string;
	resourcePath?: string;
	priority?: CardImageLoadPriority;
	onLoad?: () => void;
	onError?: () => void;
	allowDisconnected?: boolean;
}

export type CardImageLoadSurface = "card-flow" | "mobile-search" | "image-preview";
export type CardImageLoadPriority = "high" | "normal" | "low";

export interface CardImageLoadRequest {
	targetEl: HTMLElement;
	images: readonly CardImageLoadItem[];
	generation: number;
	surface: CardImageLoadSurface;
	priority?: CardImageLoadPriority;
	observe?: boolean;
}

interface CardImageLoadQueueOptions {
	concurrency: number;
	getGeneration: (surface: CardImageLoadSurface) => number;
	scheduleTask: (callback: () => void, delayMs: number) => number;
	cancelTask: (taskId: number) => void;
	scheduleStartTask?: (callback: () => void) => number;
	cancelStartTask?: (taskId: number) => void;
	watchdogMs: number;
	Observer?: typeof IntersectionObserver;
	rootMargin?: string;
}

interface CardImageLoadTask {
	targetEl: HTMLElement;
	item: CardImageLoadItem;
	generation: number;
	surface: CardImageLoadSurface;
	priority: CardImageLoadPriority;
	sequence: number;
	startTaskId: number | null;
	watchdogTaskId: number | null;
	handleLoad: () => void;
	handleError: () => void;
	listening: boolean;
}

export class CardImageLoadQueue {
	private observer: IntersectionObserver | null = null;
	private readonly observedRequests = new Map<Element, CardImageLoadRequest>();
	private pendingTasks: CardImageLoadTask[] = [];
	private readonly activeTasks = new Set<CardImageLoadTask>();
	private readonly activeSources = new Set<string>();
	private readonly activeTargets = new Set<HTMLElement>();
	private readonly decodedSources = new Set<string>();
	private readonly decodedSourcePaths = new Map<string, string>();
	private readonly pausedSurfaces = new Set<CardImageLoadSurface>();
	private nextSequence = 0;
	private paused = false;

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
		if (request.images.length === 0) {
			return;
		}
		if (this.observer === null || request.observe === false) {
			this.enqueueRequest(request);
			return;
		}
		this.forget(request.targetEl);
		this.observedRequests.set(request.targetEl, request);
		this.observer.observe(request.targetEl);
	}

	forget(targetEl: HTMLElement, clearSources = false): void {
		const observedRequest = this.observedRequests.get(targetEl);
		if (observedRequest !== undefined) {
			this.observedRequests.delete(targetEl);
			this.observer?.unobserve(targetEl);
			if (clearSources) {
				for (const item of observedRequest.images) {
					item.imageEl.removeAttribute("src");
				}
			}
		}
		this.pendingTasks = this.pendingTasks.filter((task) => {
			if (task.targetEl !== targetEl) {
				return true;
			}
			if (clearSources) {
				task.item.imageEl.removeAttribute("src");
			}
			return false;
		});
		for (const task of [...this.activeTasks]) {
			if (task.targetEl === targetEl) {
				this.cancelActiveTask(task, clearSources);
			}
		}
	}

	clear(surface?: CardImageLoadSurface): void {
		for (const [target, request] of this.observedRequests) {
			if (surface !== undefined && request.surface !== surface) {
				continue;
			}
			this.observedRequests.delete(target);
			this.observer?.unobserve(target);
			for (const item of request.images) {
				item.imageEl.removeAttribute("src");
			}
		}
		this.pendingTasks = this.pendingTasks.filter((task) => {
			if (surface !== undefined && task.surface !== surface) {
				return true;
			}
			task.item.imageEl.removeAttribute("src");
			return false;
		});
		for (const task of [...this.activeTasks]) {
			if (surface === undefined || task.surface === surface) {
				this.cancelActiveTask(task, true);
			}
		}
		if (surface === undefined) {
			this.observer?.disconnect();
			this.decodedSources.clear();
			this.decodedSourcePaths.clear();
		}
	}

	dispose(): void {
		this.clear();
		this.observer = null;
	}

	setPaused(paused: boolean): void {
		if (this.paused === paused) {
			return;
		}
		this.paused = paused;
		if (!paused) {
			this.pump();
		}
	}

	setSurfacePaused(surface: CardImageLoadSurface, paused: boolean): void {
		if (paused) {
			this.pausedSurfaces.add(surface);
			return;
		}
		if (this.pausedSurfaces.delete(surface)) {
			this.pump();
		}
	}

	invalidateResourcePaths(paths: readonly string[]): void {
		const normalizedPaths = new Set(paths.map(normalizeResourcePath));
		for (const [source, resourcePath] of this.decodedSourcePaths) {
			if (normalizedPaths.has(normalizeResourcePath(resourcePath))) {
				this.decodedSourcePaths.delete(source);
				this.decodedSources.delete(source);
			}
		}
		for (const [target, request] of this.observedRequests) {
			const images = request.images.filter((item) => !matchesResourcePath(item, normalizedPaths));
			if (images.length === request.images.length) {
				continue;
			}
			for (const item of request.images) {
				if (matchesResourcePath(item, normalizedPaths)) {
					item.imageEl.removeAttribute("src");
				}
			}
			if (images.length === 0) {
				this.observedRequests.delete(target);
				this.observer?.unobserve(target);
			} else {
				this.observedRequests.set(target, { ...request, images });
			}
		}
		this.pendingTasks = this.pendingTasks.filter((task) => {
			if (!matchesResourcePath(task.item, normalizedPaths)) {
				return true;
			}
			task.item.imageEl.removeAttribute("src");
			return false;
		});
		for (const task of [...this.activeTasks]) {
			if (matchesResourcePath(task.item, normalizedPaths)) {
				this.cancelActiveTask(task, true);
			}
		}
	}

	private handleIntersections(entries: IntersectionObserverEntry[]): void {
		for (const observerEntry of entries) {
			if (!observerEntry.isIntersecting) {
				continue;
			}
			const request = this.observedRequests.get(observerEntry.target);
			if (request === undefined) {
				continue;
			}
			this.observedRequests.delete(observerEntry.target);
			this.observer?.unobserve(observerEntry.target);
			this.enqueueRequest(request);
		}
	}

	private enqueueRequest(request: CardImageLoadRequest): void {
		for (const item of request.images) {
			let task: CardImageLoadTask;
			task = {
				targetEl: request.targetEl,
				item,
				generation: request.generation,
				surface: request.surface,
				priority: item.priority ?? request.priority ?? "normal",
				sequence: this.nextSequence,
				startTaskId: null,
				watchdogTaskId: null,
				handleLoad: () => this.handleImageLoad(task),
				handleError: () => this.handleImageError(task),
				listening: false,
			};
			this.nextSequence += 1;
			this.pendingTasks.push(task);
		}
		this.pump();
	}

	private pump(): void {
		if (this.paused) {
			return;
		}
		while (this.activeTasks.size < this.options.concurrency) {
			const task = this.takeNextPendingTask();
			if (task === null) {
				return;
			}
			this.activeTasks.add(task);
			this.activeSources.add(task.item.src);
			this.activeTargets.add(task.targetEl);
			const start = () => {
				task.startTaskId = null;
				this.startTask(task);
			};
			task.startTaskId = this.options.scheduleStartTask?.(start)
				?? this.options.scheduleTask(start, 0);
		}
	}

	private takeNextPendingTask(): CardImageLoadTask | null {
		while (true) {
			let selectedIndex = -1;
			for (const [index, task] of this.pendingTasks.entries()) {
				if (!this.isCurrentTask(task)) {
					task.item.imageEl.removeAttribute("src");
					this.pendingTasks.splice(index, 1);
					selectedIndex = -2;
					break;
				}
				if (this.decodedSources.has(task.item.src)) {
					this.pendingTasks.splice(index, 1);
					this.applyDecodedSource(task);
					selectedIndex = -2;
					break;
				}
				if (
					this.pausedSurfaces.has(task.surface) ||
					this.activeSources.has(task.item.src) ||
					this.activeTargets.has(task.targetEl)
				) {
					continue;
				}
				if (
					selectedIndex === -1
					|| compareTaskPriority(task, this.pendingTasks[selectedIndex]) < 0
				) {
					selectedIndex = index;
				}
			}
			if (selectedIndex === -2) {
				continue;
			}
			if (selectedIndex === -1) {
				return null;
			}
			return this.pendingTasks.splice(selectedIndex, 1)[0];
		}
	}

	private startTask(task: CardImageLoadTask): void {
		if (!this.activeTasks.has(task)) {
			return;
		}
		if (this.paused || this.pausedSurfaces.has(task.surface)) {
			this.releaseActiveTask(task);
			this.pendingTasks.push(task);
			return;
		}
		if (!this.isCurrentTask(task)) {
			this.cancelActiveTask(task, true);
			return;
		}
		task.listening = true;
		task.item.imageEl.addEventListener("load", task.handleLoad);
		task.item.imageEl.addEventListener("error", task.handleError);
		task.item.imageEl.setAttr("src", task.item.src);
		task.watchdogTaskId = this.options.scheduleTask(() => {
			task.watchdogTaskId = null;
			if (!this.activeTasks.has(task)) {
				return;
			}
			const shouldNotify = this.isCurrentTask(task);
			this.finishTask(task, false, true, shouldNotify);
		}, this.options.watchdogMs);
	}

	private handleImageLoad(task: CardImageLoadTask): void {
		if (!this.activeTasks.has(task)) {
			return;
		}
		this.removeTaskListeners(task);
		let decodePromise: Promise<void>;
		try {
			decodePromise = typeof task.item.imageEl.decode === "function"
				? task.item.imageEl.decode()
				: Promise.resolve();
		} catch {
			decodePromise = Promise.resolve();
		}
		void decodePromise
			.catch(() => undefined)
			.then(() => {
				if (!this.activeTasks.has(task)) {
					return;
				}
				if (!this.isCurrentTask(task)) {
					this.cancelActiveTask(task, true);
					return;
				}
				this.finishTask(task, true, false, true);
			});
	}

	private handleImageError(task: CardImageLoadTask): void {
		if (!this.activeTasks.has(task)) {
			return;
		}
		this.finishTask(task, false, false, this.isCurrentTask(task));
	}

	private finishTask(
		task: CardImageLoadTask,
		loaded: boolean,
		clearSource: boolean,
		notify: boolean,
	): void {
		this.cancelTaskTimers(task);
		this.removeTaskListeners(task);
		if (clearSource) {
			task.item.imageEl.removeAttribute("src");
		}
		if (loaded) {
			this.decodedSources.add(task.item.src);
			if (task.item.resourcePath !== undefined) {
				this.decodedSourcePaths.set(task.item.src, task.item.resourcePath);
			}
		}
		if (notify) {
			if (loaded) {
				task.item.onLoad?.();
			} else {
				task.item.onError?.();
			}
		}
		this.releaseActiveTask(task);
	}

	private cancelActiveTask(task: CardImageLoadTask, clearSource: boolean): void {
		this.cancelTaskTimers(task);
		this.removeTaskListeners(task);
		if (clearSource) {
			task.item.imageEl.removeAttribute("src");
		}
		this.releaseActiveTask(task);
	}

	private cancelTaskTimers(task: CardImageLoadTask): void {
		if (task.startTaskId !== null) {
			const cancelStartTask = this.options.cancelStartTask ?? this.options.cancelTask;
			cancelStartTask(task.startTaskId);
			task.startTaskId = null;
		}
		if (task.watchdogTaskId !== null) {
			this.options.cancelTask(task.watchdogTaskId);
			task.watchdogTaskId = null;
		}
	}

	private removeTaskListeners(task: CardImageLoadTask): void {
		if (!task.listening) {
			return;
		}
		task.item.imageEl.removeEventListener("load", task.handleLoad);
		task.item.imageEl.removeEventListener("error", task.handleError);
		task.listening = false;
	}

	private releaseActiveTask(task: CardImageLoadTask): void {
		if (!this.activeTasks.delete(task)) {
			return;
		}
		this.activeSources.delete(task.item.src);
		this.activeTargets.delete(task.targetEl);
		this.pump();
	}

	private applyDecodedSource(task: CardImageLoadTask): void {
		if (!this.isCurrentTask(task)) {
			return;
		}
		task.item.imageEl.setAttr("src", task.item.src);
		if (task.item.onLoad !== undefined) {
			void Promise.resolve().then(() => {
				if (this.isCurrentTask(task) && this.decodedSources.has(task.item.src)) {
					task.item.onLoad?.();
				}
			});
		}
	}

	private isCurrentTask(task: CardImageLoadTask): boolean {
		return task.generation === this.options.getGeneration(task.surface)
			&& task.targetEl.isConnected
			&& (task.item.allowDisconnected === true || task.item.imageEl.isConnected);
	}
}

function compareTaskPriority(left: CardImageLoadTask, right: CardImageLoadTask): number {
	const priorityDifference = getPriorityRank(left.priority) - getPriorityRank(right.priority);
	return priorityDifference !== 0 ? priorityDifference : left.sequence - right.sequence;
}

function getPriorityRank(priority: CardImageLoadPriority): number {
	if (priority === "high") {
		return 0;
	}
	if (priority === "low") {
		return 2;
	}
	return 1;
}

function matchesResourcePath(item: CardImageLoadItem, paths: ReadonlySet<string>): boolean {
	return item.resourcePath !== undefined && paths.has(normalizeResourcePath(item.resourcePath));
}

function normalizeResourcePath(path: string): string {
	return path.replace(/\\/g, "/").replace(/^\/+/, "").toLowerCase();
}
