export interface CardImageLoadItem {
	imageEl: HTMLImageElement;
	src: string;
	resourcePath?: string;
	priority?: CardImageLoadPriority;
	onLoad?: () => void;
	onError?: (retry?: () => boolean) => void;
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
	scrollAware?: boolean;
	deferPresentation?: boolean;
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
	ready: boolean;
	retries: number;
	retryWhenVisible: boolean;
	attempt: number;
}

export class CardImageLoadQueue {
	private readonly surfaces = new Map<CardImageLoadSurface, {
		root: HTMLElement;
		nearby: IntersectionObserver;
		visible: IntersectionObserver;
		scrollTop: number;
		direction: number;
		scrolling: boolean;
		settleTaskId: number | null;
		onScroll: () => void;
	}>();
	private readonly ranges = new Map<Element, { surface: CardImageLoadSurface; nearby: boolean; visible: boolean; offset?: number }>();
	private readonly observedRequests = new Map<Element, CardImageLoadRequest>();
	private pendingTasks: CardImageLoadTask[] = [];
	private readonly activeTasks = new Set<CardImageLoadTask>();
	private readonly failedTasks = new Set<CardImageLoadTask>();
	private readonly activeSources = new Set<string>();
	private readonly activeTargets = new Set<HTMLElement>();
	private readonly pausedSurfaces = new Set<CardImageLoadSurface>();
	private nextSequence = 0;
	private paused = false;
	private updateTaskId: number | null = null;
	private presentationTaskId: number | null = null;

	constructor(private readonly options: CardImageLoadQueueOptions) {}

	bindSurface(surface: CardImageLoadSurface, root: HTMLElement | null): void {
		const previous = this.surfaces.get(surface);
		if (previous?.root === root) return;
		this.surfaces.delete(surface);
		previous?.nearby.disconnect();
		previous?.visible.disconnect();
		if (previous) {
			if (this.options.scrollAware) previous.root.removeEventListener("scroll", previous.onScroll);
			if (previous.settleTaskId !== null) this.options.cancelTask(previous.settleTaskId);
		}
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
		const state = {
			root, nearby, visible, scrollTop: root.scrollTop, direction: 0, scrolling: false,
			settleTaskId: null as number | null,
			onScroll: () => {
				const delta = root.scrollTop - state.scrollTop;
				state.scrollTop = root.scrollTop;
				if (delta === 0) return;
				state.direction = Math.sign(delta);
				state.scrolling = true;
				if (state.settleTaskId !== null) this.options.cancelTask(state.settleTaskId);
				state.settleTaskId = this.options.scheduleTask(() => {
					state.settleTaskId = null;
					state.scrolling = false;
					this.scheduleUpdate();
				}, 120);
			},
		};
		this.surfaces.set(surface, state);
		if (this.options.scrollAware) root.addEventListener("scroll", state.onScroll, { passive: true });
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
		for (const task of this.failedTasks) if (task.targetEl === targetEl) this.failedTasks.delete(task);
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
		for (const task of this.failedTasks) {
			if (surface === undefined || task.surface === surface) this.failedTasks.delete(task);
		}
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
		if (this.presentationTaskId !== null) {
			(this.options.cancelStartTask ?? this.options.cancelTask)(this.presentationTaskId);
			this.presentationTaskId = null;
		}
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
		for (const task of this.failedTasks) {
			if (matchesResourcePath(task.item, normalizedPaths)) this.failedTasks.delete(task);
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
			// nearby 的 rootBounds 包含预加载边距，方向计算只使用真实视口观察器的坐标。
			if (visible && entry.rootBounds && entry.boundingClientRect) {
				range.offset = entry.boundingClientRect.top - entry.rootBounds.top
					+ (this.surfaces.get(range.surface)?.root.scrollTop ?? 0);
			}
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
				ready: false,
				retries: 0,
				retryWhenVisible: false,
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
		if (task.retryWhenVisible && rank > 1) return false;
		if (rank === 3) return false;
		if (rank !== 2) return true;
		if (this.surfaces.get(task.surface)?.scrolling) return false;
		for (const active of this.activeTasks) {
			// 预加载预算覆盖解码与待显示阶段，已离屏的活动任务也不能腾出新的预加载预算。
			if (active !== task && this.regionRank(active) >= 2) return false;
		}
		return true;
	}

	private directionRank(task: CardImageLoadTask): number {
		const state = this.surfaces.get(task.surface);
		const offset = this.ranges.get(task.targetEl)?.offset;
		if (!state || offset === undefined || this.regionRank(task) !== 2) return 0;
		return (offset - state.root.scrollTop) * state.direction < 0 ? 1 : 0;
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
						|| this.directionRank(task) - this.directionRank(this.pendingTasks[selectedIndex])
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
			this.handleTaskFailure(task);
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
			if (loaded && this.options.deferPresentation) {
				task.ready = true;
				if (task.watchdogTaskId !== null) this.options.cancelTask(task.watchdogTaskId);
				task.watchdogTaskId = null;
				this.schedulePresentation();
			} else if (loaded) {
				this.finishTask(task, true, false, true);
			} else {
				this.handleTaskFailure(task);
			}
		};
		void this.decodeImage(task).then(() => settle(true), () => settle(false));
		this.pump();
	}

	private schedulePresentation(): void {
		if (this.presentationTaskId !== null || ![...this.activeTasks].some(task => task.ready)) return;
		// 第一张就绪图直接显示；仅将同帧内集中完成的后续图片延至下一帧。
		const task = [...this.activeTasks].filter(task => task.ready).sort((a, b) =>
			this.regionRank(a) - this.regionRank(b) || compareTaskPriority(a, b))[0];
		if (this.isCurrentTask(task)) this.finishTask(task, true, false, true);
		else this.cancelActiveTask(task, true);
		const nextFrame = () => {
			this.presentationTaskId = null;
			this.schedulePresentation();
		};
		this.presentationTaskId = this.options.scheduleStartTask?.(nextFrame) ?? this.options.scheduleTask(nextFrame, 16);
	}

	private handleImageError(task: CardImageLoadTask): void {
		if (!this.activeTasks.has(task)) {
			return;
		}
		this.handleTaskFailure(task);
	}

	private handleTaskFailure(task: CardImageLoadTask): void {
		if (!this.isCurrentTask(task)) { this.cancelActiveTask(task, true); return; }
		// 离屏或滚动中断不应立即变成永久错误；仅在重新可见时自动重试一次。
		if (task.surface !== "image-preview" && this.ranges.has(task.targetEl) && task.retries < 1) {
			task.retries++;
			task.retryWhenVisible = true;
			this.preemptActiveTask(task);
			return;
		}
		this.finishTask(task, false, true, true);
	}

	private retryFailedTask(task: CardImageLoadTask): boolean {
		if (!this.failedTasks.delete(task) || !this.isCurrentTask(task)) return false;
		task.retries = 0;
		task.retryWhenVisible = false;
		task.decoding = false;
		task.ready = false;
		this.pendingTasks.push(task);
		this.pump();
		return true;
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
				this.failedTasks.add(task);
				task.item.onError?.(() => this.retryFailedTask(task));
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
			task.ready = false;
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
