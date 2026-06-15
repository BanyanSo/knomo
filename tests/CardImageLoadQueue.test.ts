import test from "node:test";
import assert from "node:assert/strict";

import { CardImageLoadQueue } from "../src/ui/CardImageLoadQueue";
import type {
	CardImageLoadItem,
	CardImageLoadSurface,
} from "../src/ui/CardImageLoadQueue";

test("limits concurrency by individual image and waits for decode", async () => {
	const scheduler = new FakeScheduler();
	const first = new FakeImage();
	const second = new FakeImage();
	const third = new FakeImage();
	const queue = createQueue(scheduler, { concurrency: 2 });

	queue.observe(createRequest("card-flow", new FakeCard(), [
		createLoadItem(first, "app://first.png"),
		createLoadItem(second, "app://second.png"),
		createLoadItem(third, "app://third.png"),
	]));

	assert.deepEqual(scheduler.delays, [0, 0]);
	scheduler.flushDelay(0);
	scheduler.flushDelay(0);
	assert.deepEqual(getSources(first, second, third), [
		"app://first.png",
		"app://second.png",
		null,
	]);

	first.dispatch("load");
	assert.equal(first.decodeCalls, 1);
	assert.equal(third.getAttr("src"), null);

	first.resolveDecode();
	await flushMicrotasks();
	assert.ok(scheduler.delays.includes(0));
	scheduler.flushDelay(0);
	assert.equal(third.getAttr("src"), "app://third.png");
});

test("shares in-flight and decoded sources across surfaces", async () => {
	const scheduler = new FakeScheduler();
	const cardImage = new FakeImage();
	const searchImage = new FakeImage();
	const queue = createQueue(scheduler, { concurrency: 2 });

	queue.observe(createRequest("card-flow", new FakeCard(), [
		createLoadItem(cardImage, "app://shared.png"),
	]));
	queue.observe(createRequest("mobile-search", new FakeCard(), [
		createLoadItem(searchImage, "app://shared.png"),
	]));

	assert.deepEqual(scheduler.delays, [0]);
	scheduler.flushDelay(0);
	cardImage.dispatch("load");
	cardImage.resolveDecode();
	await flushMicrotasks();

	assert.equal(searchImage.getAttr("src"), "app://shared.png");
	assert.equal(searchImage.decodeCalls, 0);
	assert.equal(scheduler.size, 0);
});

test("reuses a decoded source without another scheduled decode", async () => {
	const scheduler = new FakeScheduler();
	const first = new FakeImage();
	const second = new FakeImage();
	let reusedLoadCount = 0;
	const queue = createQueue(scheduler);

	queue.observe(createRequest("card-flow", new FakeCard(), [
		createLoadItem(first, "app://decoded.png"),
	]));
	scheduler.flushDelay(0);
	first.dispatch("load");
	first.resolveDecode();
	await flushMicrotasks();

	queue.observe(createRequest("mobile-search", new FakeCard(), [
		{
			...createLoadItem(second, "app://decoded.png"),
			onLoad: () => {
				reusedLoadCount += 1;
			},
		},
	]));

	assert.equal(second.getAttr("src"), "app://decoded.png");
	assert.equal(second.decodeCalls, 0);
	assert.equal(reusedLoadCount, 0);
	assert.equal(scheduler.size, 0);
	await flushMicrotasks();
	assert.equal(reusedLoadCount, 1);
});

test("can pause one surface without blocking another", () => {
	const scheduler = new FakeScheduler();
	const cardImage = new FakeImage();
	const searchImage = new FakeImage();
	const queue = createQueue(scheduler);

	queue.setSurfacePaused("card-flow", true);
	queue.observe(createRequest("card-flow", new FakeCard(), [
		createLoadItem(cardImage, "app://card.png"),
	]));
	queue.observe(createRequest("mobile-search", new FakeCard(), [
		createLoadItem(searchImage, "app://search.png"),
	]));

	assert.deepEqual(scheduler.delays, [0]);
	scheduler.flushDelay(0);
	assert.equal(searchImage.getAttr("src"), "app://search.png");
	assert.equal(cardImage.getAttr("src"), null);

	searchImage.dispatch("error");
	queue.setSurfacePaused("card-flow", false);
	scheduler.flushDelay(0);
	assert.equal(cardImage.getAttr("src"), "app://card.png");
});

test("clears one surface without cancelling another", () => {
	const scheduler = new FakeScheduler();
	const cardImage = new FakeImage();
	const searchImage = new FakeImage();
	const queue = createQueue(scheduler, { concurrency: 2 });

	queue.observe(createRequest("card-flow", new FakeCard(), [
		createLoadItem(cardImage, "app://card.png"),
	]));
	queue.observe(createRequest("mobile-search", new FakeCard(), [
		createLoadItem(searchImage, "app://search.png"),
	]));
	scheduler.flushDelay(0);
	scheduler.flushDelay(0);

	queue.clear("card-flow");

	assert.equal(cardImage.getAttr("src"), null);
	assert.equal(searchImage.getAttr("src"), "app://search.png");
});

test("clears stale image sources when a surface generation changes during decode", async () => {
	const scheduler = new FakeScheduler();
	const image = new FakeImage();
	const generations = new Map<CardImageLoadSurface, number>([
		["card-flow", 1],
		["mobile-search", 1],
		["image-preview", 1],
	]);
	const queue = createQueue(scheduler, { generations });

	queue.observe(createRequest("card-flow", new FakeCard(), [
		createLoadItem(image, "app://stale.png"),
	]));
	scheduler.flushDelay(0);
	image.dispatch("load");

	generations.set("card-flow", 2);
	image.resolveDecode();
	await flushMicrotasks();

	assert.equal(image.getAttr("src"), null);
	assert.equal(scheduler.size, 0);
});

test("watchdog cancels a slow image and starts the next task", () => {
	const scheduler = new FakeScheduler();
	const failed: string[] = [];
	const slow = new FakeImage();
	const next = new FakeImage();
	const queue = createQueue(scheduler);

	queue.observe(createRequest("card-flow", new FakeCard(), [
		createLoadItem(slow, "app://slow.png", undefined, () => failed.push("slow")),
		createLoadItem(next, "app://next.png"),
	]));
	scheduler.flushDelay(0);
	scheduler.flushDelay(10_000);

	assert.equal(slow.getAttr("src"), null);
	assert.deepEqual(failed, ["slow"]);
	scheduler.flushDelay(0);
	assert.equal(next.getAttr("src"), "app://next.png");
});

test("starts high-priority images before earlier low-priority work", () => {
	const scheduler = new FakeScheduler();
	const low = new FakeImage();
	const high = new FakeImage();
	const queue = createQueue(scheduler);

	queue.setPaused(true);
	queue.observe({
		...createRequest("card-flow", new FakeCard(), [
			createLoadItem(low, "app://low.png"),
		]),
		priority: "low",
	});
	queue.observe({
		...createRequest("image-preview", new FakeCard(), [
			createLoadItem(high, "app://high.png"),
		]),
		priority: "high",
	});
	queue.setPaused(false);
	scheduler.flushDelay(0);

	assert.equal(high.getAttr("src"), "app://high.png");
	assert.equal(low.getAttr("src"), null);
});

test("invalidates decoded state by local resource path", async () => {
	const scheduler = new FakeScheduler();
	const first = new FakeImage();
	const second = new FakeImage();
	const queue = createQueue(scheduler);

	queue.observe(createRequest("card-flow", new FakeCard(), [
		createLoadItem(first, "app://photo.png", "Attachments/photo.png"),
	]));
	scheduler.flushDelay(0);
	first.dispatch("load");
	first.resolveDecode();
	await flushMicrotasks();

	queue.invalidateResourcePaths(["Attachments/photo.png"]);
	queue.observe(createRequest("mobile-search", new FakeCard(), [
		createLoadItem(second, "app://photo.png", "Attachments/photo.png"),
	]));

	assert.deepEqual(scheduler.delays, [0]);
	assert.equal(second.getAttr("src"), null);
});

test("defers observed work until the target intersects", () => {
	FakeIntersectionObserver.instances = [];
	const scheduler = new FakeScheduler();
	const card = new FakeCard();
	const image = new FakeImage();
	const queue = createQueue(scheduler, { observe: true });

	queue.observe({
		...createRequest("card-flow", card, [
			createLoadItem(image, "app://lazy.png"),
		]),
		observe: true,
	});
	assert.equal(scheduler.size, 0);

	FakeIntersectionObserver.instances[0].trigger([card]);
	scheduler.flushDelay(0);
	assert.equal(image.getAttr("src"), "app://lazy.png");
});

interface CreateQueueOptions {
	concurrency?: number;
	generations?: Map<CardImageLoadSurface, number>;
	observe?: boolean;
}

function createQueue(scheduler: FakeScheduler, options: CreateQueueOptions = {}): CardImageLoadQueue {
	const generations = options.generations ?? new Map<CardImageLoadSurface, number>([
		["card-flow", 1],
		["mobile-search", 1],
		["image-preview", 1],
	]);
	return new CardImageLoadQueue({
		concurrency: options.concurrency ?? 1,
		getGeneration: (surface) => generations.get(surface) ?? 0,
		scheduleTask: (callback, delayMs) => scheduler.schedule(callback, delayMs),
		cancelTask: (taskId) => scheduler.cancel(taskId),
		watchdogMs: 10_000,
		Observer: options.observe
			? FakeIntersectionObserver as unknown as typeof IntersectionObserver
			: undefined,
	});
}

function createRequest(
	surface: CardImageLoadSurface,
	card: FakeCard,
	images: readonly CardImageLoadItem[],
) {
	return {
		targetEl: card.asElement(),
		images,
		generation: 1,
		surface,
		observe: false,
	};
}

function createLoadItem(
	image: FakeImage,
	src: string,
	resourcePath?: string,
	onError?: () => void,
): CardImageLoadItem {
	return {
		imageEl: image.asImage(),
		src,
		resourcePath,
		onError,
	};
}

function getSources(...images: FakeImage[]): Array<string | null> {
	return images.map((image) => image.getAttr("src"));
}

async function flushMicrotasks(): Promise<void> {
	await Promise.resolve();
	await Promise.resolve();
}

interface ScheduledTask {
	callback: () => void;
	delayMs: number;
}

class FakeScheduler {
	private nextId = 1;
	private readonly tasks = new Map<number, ScheduledTask>();

	get size(): number {
		return this.tasks.size;
	}

	get delays(): number[] {
		return [...this.tasks.values()].map((task) => task.delayMs);
	}

	schedule(callback: () => void, delayMs: number): number {
		const taskId = this.nextId;
		this.nextId += 1;
		this.tasks.set(taskId, { callback, delayMs });
		return taskId;
	}

	cancel(taskId: number): void {
		this.tasks.delete(taskId);
	}

	flushDelay(delayMs: number): void {
		const next = [...this.tasks.entries()].find(([, task]) => task.delayMs === delayMs);
		if (next === undefined) {
			throw new Error(`Expected a scheduled task with delay ${delayMs}`);
		}
		const [taskId, task] = next;
		this.tasks.delete(taskId);
		task.callback();
	}
}

class FakeIntersectionObserver {
	static instances: FakeIntersectionObserver[] = [];
	private readonly observed = new Set<Element>();

	constructor(
		private readonly callback: IntersectionObserverCallback,
		readonly options?: IntersectionObserverInit,
	) {
		FakeIntersectionObserver.instances.push(this);
	}

	observe(target: Element): void {
		this.observed.add(target);
	}

	unobserve(target: Element): void {
		this.observed.delete(target);
	}

	disconnect(): void {
		this.observed.clear();
	}

	takeRecords(): IntersectionObserverEntry[] {
		return [];
	}

	trigger(cards: FakeCard[]): void {
		const entries = cards
			.map((card) => card.asElement())
			.filter((card) => this.observed.has(card))
			.map((card) => ({
				isIntersecting: true,
				target: card,
			} as unknown as IntersectionObserverEntry));
		this.callback(entries, this as unknown as IntersectionObserver);
	}
}

class FakeCard {
	isConnected = true;

	asElement(): HTMLElement {
		return this as unknown as HTMLElement;
	}
}

class FakeImage {
	isConnected = true;
	decodeCalls = 0;
	private readonly attrs = new Map<string, string>();
	private readonly listeners = new Map<string, Set<() => void>>();
	private readonly decodePromise: Promise<void>;
	private resolveDecodePromise: () => void = () => undefined;

	constructor() {
		this.decodePromise = new Promise<void>((resolve) => {
			this.resolveDecodePromise = resolve;
		});
	}

	asImage(): HTMLImageElement {
		return this as unknown as HTMLImageElement;
	}

	setAttr(name: string, value: string): void {
		this.attrs.set(name, value);
	}

	removeAttribute(name: string): void {
		this.attrs.delete(name);
	}

	getAttr(name: string): string | null {
		return this.attrs.get(name) ?? null;
	}

	addEventListener(type: string, handler: () => void): void {
		const handlers = this.listeners.get(type) ?? new Set<() => void>();
		handlers.add(handler);
		this.listeners.set(type, handlers);
	}

	removeEventListener(type: string, handler: () => void): void {
		this.listeners.get(type)?.delete(handler);
	}

	dispatch(type: string): void {
		for (const handler of this.listeners.get(type) ?? []) {
			handler();
		}
	}

	decode(): Promise<void> {
		this.decodeCalls += 1;
		return this.decodePromise;
	}

	resolveDecode(): void {
		this.resolveDecodePromise();
	}
}
