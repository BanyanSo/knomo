import test from "node:test";
import assert from "node:assert/strict";

import { CardImageLoadQueue } from "../src/ui/CardImageLoadQueue";

test("starts all images in one memo card together and waits before starting the next card", async () => {
	FakeIntersectionObserver.instances = [];
	const scheduler = new FakeScheduler();
	const failed: string[] = [];
	const firstCard = new FakeCard();
	const secondCard = new FakeCard();
	const firstImage = new FakeImage();
	const secondImage = new FakeImage();
	const thirdImage = new FakeImage();
	const queue = createQueue(scheduler);

	queue.observe({
		targetEl: firstCard.asElement(),
		images: [
			createLoadItem(firstImage, "app://first.png", () => failed.push("first")),
			createLoadItem(secondImage, "app://second.png", () => failed.push("second")),
		],
		generation: 1,
	});
	queue.observe({
		targetEl: secondCard.asElement(),
		images: [
			createLoadItem(thirdImage, "app://third.png", () => failed.push("third")),
		],
		generation: 1,
	});

	FakeIntersectionObserver.instances[0].trigger([firstCard, secondCard]);
	assert.deepEqual(scheduler.delays, [0]);

	scheduler.flushDelay(0);

	assert.deepEqual(getSources(firstImage, secondImage, thirdImage), [
		"app://first.png",
		"app://second.png",
		null,
	]);
	assert.deepEqual(scheduler.delays, [10_000]);

	firstImage.dispatch("load");
	secondImage.dispatch("error");

	assert.equal(firstImage.decodeCalls, 1);
	assert.deepEqual(failed, ["second"]);
	assert.equal(thirdImage.getAttr("src"), null);

	firstImage.resolveDecode();
	await flushMicrotasks();

	assert.deepEqual(scheduler.delays, [0]);

	scheduler.flushDelay(0);
	assert.equal(thirdImage.getAttr("src"), "app://third.png");
});

test("releases the card slot after the watchdog without cancelling slow images", async () => {
	FakeIntersectionObserver.instances = [];
	const scheduler = new FakeScheduler();
	const firstCard = new FakeCard();
	const secondCard = new FakeCard();
	const slowImage = new FakeImage();
	const nextImage = new FakeImage();
	const queue = createQueue(scheduler);

	queue.observe({
		targetEl: firstCard.asElement(),
		images: [
			createLoadItem(slowImage, "https://example.com/slow.png"),
		],
		generation: 1,
	});
	queue.observe({
		targetEl: secondCard.asElement(),
		images: [createLoadItem(nextImage, "app://next.png")],
		generation: 1,
	});
	FakeIntersectionObserver.instances[0].trigger([firstCard, secondCard]);
	scheduler.flushDelay(0);

	scheduler.flushDelay(10_000);
	assert.deepEqual(scheduler.delays, [0]);

	scheduler.flushDelay(0);
	assert.equal(nextImage.getAttr("src"), "app://next.png");

	slowImage.dispatch("load");
	slowImage.resolveDecode();
	await flushMicrotasks();

	assert.equal(slowImage.getAttr("src"), "https://example.com/slow.png");
});

test("clears stale image sources when the render generation changes during decode", async () => {
	FakeIntersectionObserver.instances = [];
	const scheduler = new FakeScheduler();
	const card = new FakeCard();
	const firstImage = new FakeImage();
	const secondImage = new FakeImage();
	let generation = 1;
	const queue = createQueue(scheduler, () => generation);

	queue.observe({
		targetEl: card.asElement(),
		images: [
			createLoadItem(firstImage, "app://first.png"),
			createLoadItem(secondImage, "app://second.png"),
		],
		generation: 1,
	});
	FakeIntersectionObserver.instances[0].trigger([card]);
	scheduler.flushDelay(0);
	firstImage.dispatch("load");

	generation = 2;
	firstImage.resolveDecode();
	await flushMicrotasks();

	assert.deepEqual(getSources(firstImage, secondImage), [null, null]);
	assert.equal(scheduler.size, 0);
});

test("completes the card image task when decode rejects", async () => {
	FakeIntersectionObserver.instances = [];
	const scheduler = new FakeScheduler();
	const card = new FakeCard();
	const image = new FakeImage();
	const queue = createQueue(scheduler);

	queue.observe({
		targetEl: card.asElement(),
		images: [
			createLoadItem(image, "https://example.com/image.png"),
		],
		generation: 1,
	});
	FakeIntersectionObserver.instances[0].trigger([card]);
	scheduler.flushDelay(0);
	image.dispatch("load");
	image.rejectDecode();
	await flushMicrotasks();

	assert.equal(scheduler.size, 0);
});

test("reuses a decoded image source without scheduling another load", async () => {
	FakeIntersectionObserver.instances = [];
	const scheduler = new FakeScheduler();
	const firstCard = new FakeCard();
	const secondCard = new FakeCard();
	const firstImage = new FakeImage();
	const secondImage = new FakeImage();
	const queue = createQueue(scheduler);

	queue.observe({
		targetEl: firstCard.asElement(),
		images: [createLoadItem(firstImage, "app://shared.png")],
		generation: 1,
	});
	FakeIntersectionObserver.instances[0].trigger([firstCard]);
	scheduler.flushDelay(0);
	firstImage.dispatch("load");
	firstImage.resolveDecode();
	await flushMicrotasks();

	queue.observe({
		targetEl: secondCard.asElement(),
		images: [createLoadItem(secondImage, "app://shared.png")],
		generation: 1,
	});

	assert.equal(secondImage.getAttr("src"), "app://shared.png");
	assert.equal(scheduler.size, 0);
});

function createQueue(
	scheduler: FakeScheduler,
	getGeneration: () => number = () => 1,
): CardImageLoadQueue {
	return new CardImageLoadQueue({
		concurrency: 1,
		getGeneration,
		scheduleTask: (callback, delayMs) => scheduler.schedule(callback, delayMs),
		cancelTask: (taskId) => scheduler.cancel(taskId),
		watchdogMs: 10_000,
		Observer: FakeIntersectionObserver as unknown as typeof IntersectionObserver,
	});
}

function createLoadItem(
	image: FakeImage,
	src: string,
	onError: () => void = () => undefined,
) {
	return {
		imageEl: image.asImage(),
		src,
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
	private rejectDecodePromise: () => void = () => undefined;

	constructor() {
		this.decodePromise = new Promise<void>((resolve, reject) => {
			this.resolveDecodePromise = resolve;
			this.rejectDecodePromise = reject;
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

	rejectDecode(): void {
		this.rejectDecodePromise();
	}
}
