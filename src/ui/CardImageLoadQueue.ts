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
	maxInFlight?: number;
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
	decoding: boolean;
	attempt: number;
}

export class CardImageLoadQueue {
	private readonly surfaces = new Map<CardImageLoadSurface, {
		root: HTMLElement;
		nearby: IntersectionObserver;
		visible: IntersectionObserver;
	}>();
	private readonly ranges = new Map<Element, { surface: CardImageLoadSurface; nearby: boolean; visible: boolean }>();
	private readonly observedRequests = new Map<Element, CardImageLoadRequest>();
	private pendingTasks: CardImageLoadTask[] = [];
	private readonly activeTasks = new Set<CardImageLoadTask>();
	private readonly activeSources = new Set<string>();
	private readonly activeTargets = new Set<HTMLElement>();
	private readonly pausedSurfaces = new Set<CardImageLoadSurface>();
	private nextSequence = 0;
	private paused = false;
	private updateTaskId: number | null = null;

	constructor(private readonly options: CardImageLoadQueueOptions) {}

	bindSurface(surface: CardImageLoadSurface, root: HTMLElement | null): void {
		const previous = this.surfaces.get(surface);
		if (previous?.root === root) return;
		this.surfaces.delete(surface);
		previous?.nearby.disconnect();
		previous?.visible.disconnect();
		this.clear(surface);
		const Observer = this.options.Observer;
		if (root === null || Observer === undefined) return;
		const nearby = new Observer((entries) => {
			if (this.surfaces.get(surface)?.nearby !== nearby) return;
			this.handleIntersections(entries, false);
		}, { root, rootMargin: this.options.rootMargin ?? "160px 0px", threshold: 0 });
		const visible = new Observer((entries) => {
			if (this.surfaces.get(surface)?.visible !== visible) return;
			this.handleIntersections(entries, true);
		}, { root, rootMargin: "0px", threshold: 0 });
		this.surfaces.set(surface, { root, nearby, visible });
	}

	private unobserve(target: Element): void {
		const range = this.ranges.get(target);
		const observers = range && this.surfaces.get(range.surface);
		observers?.nearby.unobserve(target);
		observers?.visible.unobserve(target);
		this.ranges.delete(target);
	}

	observe(request: CardImageLoadRequest): void {
		if (request.images.length === 0) {
			return;
		}
		if (!this.surfaces.has(request.surface) || request.observe === false) {
			this.enqueueRequest(request);
			return;
		}
		this.forget(request.targetEl);
		this.observedRequests.set(request.targetEl, request);
		this.ranges.set(request.targetEl, { surface: request.surface, nearby: false, visible: false });
		this.surfaces.get(request.surface)?.nearby.observe(request.targetEl);
		this.surfaces.get(request.surface)?.visible.observe(request.targetEl);
	}

	forget(targetEl: HTMLElement, clearSources = false): void {
		this.unobserve(targetEl);
		const observedRequest = this.observedRequests.get(targetEl);
		if (observedRequest !== undefined) {
			this.observedRequests.delete(targetEl);
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
			this.unobserve(target);
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
		for (const [target, range] of this.ranges) {
			if (surface === undefined || range.surface === surface) this.unobserve(target);
		}
	}

	dispose(): void {
		if (this.updateTaskId !== null) {
			(this.options.cancelStartTask ?? this.options.cancelTask)(this.updateTaskId);
			this.updateTaskId = null;
		}
		this.clear();
		for (const surface of [...this.surfaces.keys()]) this.bindSurface(surface, null);
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

	preemptActiveSurface(surface: CardImageLoadSurface): void {
		for (const task of [...this.activeTasks]) {
			if (task.surface === surface) {
				this.preemptActiveTask(task);
			}
		}
	}

	invalidateResourcePaths(paths: readonly string[]): void {
		const normalizedPaths = new Set(paths.map(normalizeResourcePath));
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
				this.unobserve(target);
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

	private handleIntersections(entries: IntersectionObserverEntry[], visible: boolean): void {
		for (const entry of entries) {
			const range = this.ranges.get(entry.target);
			if (!range) continue;
			if (visible) range.visible = entry.isIntersecting;
			else range.nearby = entry.isIntersecting;
			if (!range.nearby && !range.visible) continue;
			const request = this.observedRequests.get(entry.target);
			if (request === undefined) continue;
			this.observedRequests.delete(entry.target);
			this.enqueueRequest(request, false);
		}
		this.scheduleUpdate();
	}

	private enqueueRequest(request: CardImageLoadRequest, pump = true): void {
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
				decoding: false,
				attempt: 0,
			};
			this.nextSequence += 1;
			this.pendingTasks.push(task);
		}
		if (pump) this.pump();
	}

	private scheduleUpdate(): void {
		if (this.updateTaskId !== null) return;
		const update = () => { this.updateTaskId = null; this.pump(true); };
		this.updateTaskId = this.options.scheduleStartTask?.(update) ?? this.options.scheduleTask(update, 16);
	}

	private regionRank(task: CardImageLoadTask): number {
		if (task.surface === "image-preview") return 0;
		const range = this.ranges.get(task.targetEl);
		if (!range || range.visible) return 1;
		return range.nearby ? 2 : 3;
	}

	private canStartInRange(task: CardImageLoadTask): boolean {
		const rank = this.regionRank(task);
		if (rank === 3) return false;
		if (rank !== 2) return true;
		for (const active of this.activeTasks) {
			if (active !== task && !active.decoding && this.regionRank(active) === 2) return false;
		}
		return true;
	}

	private get loadingCount(): number {
		let count = 0;
		for (const task of this.activeTasks) if (!task.decoding) count++;
		return count;
	}

	private pump(startInCurrentFrame = false): void {
		if (this.paused) {
			return;
		}
		while (this.loadingCount < this.options.concurrency
			&& this.activeTasks.size < (this.options.maxInFlight ?? 4)) {
			const task = this.takeNextPendingTask();
			if (task === null) {
				return;
			}
			this.activeTasks.add(task);
			this.activeSources.add(task.item.src);
			this.activeTargets.add(task.targetEl);
			if (startInCurrentFrame) {
				this.startTask(task);
				continue;
			}
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
				if (
					!this.canStartInRange(task) ||
					this.pausedSurfaces.has(task.surface) ||
					this.activeSources.has(task.item.src) ||
					this.activeTargets.has(task.targetEl)
				) {
					continue;
				}
				if (
					selectedIndex === -1
					|| (this.regionRank(task) - this.regionRank(this.pendingTasks[selectedIndex])
						|| compareTaskPriority(task, this.pendingTasks[selectedIndex])) < 0
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
		if (this.paused || this.pausedSurfaces.has(task.surface) || !this.canStartInRange(task)) {
			this.pendingTasks.push(task);
			this.releaseActiveTask(task);
			return;
		}
		if (!this.isCurrentTask(task)) {
			this.cancelActiveTask(task, true);
			return;
		}
		if (/^https?:/i.test(task.item.src)) {
			task.item.imageEl.setAttr("fetchpriority", this.regionRank(task) <= 1 ? "high" : "low");
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
		if (!this.activeTasks.has(task) || task.decoding) return;
		if (!this.isCurrentTask(task)) {
			this.cancelActiveTask(task, true);
			return;
		}
		this.removeTaskListeners(task);
		// 只释放加载预算；解码仍保留目标、URL 锁、超时和本次尝试编号。
		task.decoding = true;
		const attempt = task.attempt;
		const settle = (loaded: boolean) => {
			if (!this.activeTasks.has(task) || task.attempt !== attempt) return;
			if (!this.isCurrentTask(task)) {
				this.cancelActiveTask(task, true);
				return;
			}
			this.finishTask(task, loaded, !loaded, true);
		};
		void this.decodeImage(task).then(() => settle(true), () => settle(false));
		this.pump();
	}

	private handleImageError(task: CardImageLoadTask): void {
		if (!this.activeTasks.has(task)) {
			return;
		}
		this.finishTask(task, false, true, this.isCurrentTask(task));
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
		this.releaseActiveTask(task);
		if (notify) {
			if (loaded) {
				task.item.onLoad?.();
			} else {
				task.item.onError?.();
			}
		}
	}

	private decodeImage(task: CardImageLoadTask): Promise<void> {
		try {
			return typeof task.item.imageEl.decode === "function"
				? task.item.imageEl.decode()
				: task.item.imageEl.naturalWidth > 0
					? Promise.resolve()
					: Promise.reject(new Error("Image has no decoded pixels."));
		} catch {
			return Promise.reject(new Error("Failed to decode card image."));
		}
	}

	private cancelActiveTask(task: CardImageLoadTask, clearSource: boolean): void {
		this.cancelTaskTimers(task);
		this.removeTaskListeners(task);
		if (clearSource) {
			task.item.imageEl.removeAttribute("src");
		}
		this.releaseActiveTask(task);
	}

	private preemptActiveTask(task: CardImageLoadTask): void {
		this.cancelTaskTimers(task);
		this.removeTaskListeners(task);
		task.item.imageEl.removeAttribute("src");
		const shouldResume = this.isCurrentTask(task);
		if (this.activeTasks.delete(task)) {
			this.activeSources.delete(task.item.src);
			this.activeTargets.delete(task.targetEl);
		}
		if (shouldResume) {
			task.decoding = false;
			this.pendingTasks.push(task);
		}
		this.pump();
	}

	private cancelTaskTimers(task: CardImageLoadTask): void {
		task.attempt += 1;
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
		if (!this.pendingTasks.some((pending) => pending.targetEl === task.targetEl)) this.unobserve(task.targetEl);
		this.pump();
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
