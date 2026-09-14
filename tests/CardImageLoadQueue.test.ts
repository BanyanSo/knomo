import test from "node:test";
import assert from "node:assert/strict";

import { CardImageLoadQueue } from "../src/ui/CardImageLoadQueue";
import type {
	CardImageLoadItem,
	CardImageLoadSurface,
} from "../src/ui/CardImageLoadQueue";

test("loads one image per card at a time and waits for decode", async () => {
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

	assert.deepEqual(scheduler.delays, [0]);
	scheduler.flushDelay(0);
	assert.deepEqual(getSources(first, second, third), [
		"app://first.png",
		null,
		null,
	]);

	first.dispatch("load");
	assert.equal(first.decodeCalls, 1);
	assert.equal(second.getAttr("src"), null);

	first.resolveDecode();
	await flushMicrotasks();
	assert.ok(scheduler.delays.includes(0));
	scheduler.flushDelay(0);
	assert.equal(second.getAttr("src"), "app://second.png");
});

test("load releases a loading position but retains decode management and placeholder", async () => {
	const scheduler = new FakeScheduler();
	const first = new FakeImage();
	const second = new FakeImage();
	let loaded = 0;
	const queue = createQueue(scheduler);
	queue.observe(createRequest("card-flow", new FakeCard(), [{ ...createLoadItem(first, "app://first"), onLoad: () => loaded++ }]));
	queue.observe(createRequest("card-flow", new FakeCard(), [createLoadItem(second, "app://second")]));
	scheduler.flushDelay(0);
	first.dispatch("load");
	assert.equal(loaded, 0);
	assert.ok(scheduler.delays.includes(10_000));
	scheduler.flushDelay(0);
	assert.equal(second.getAttr("src"), "app://second");
	first.resolveDecode();
	await flushMicrotasks();
	assert.equal(loaded, 1);
});

test("each new element waits for its own decode even for an already loaded URL", async () => {
	const scheduler = new FakeScheduler();
	const first = new FakeImage();
	const second = new FakeImage();
	let reusedLoadCount = 0;
	const queue = createQueue(scheduler, {
	});

	queue.observe(createRequest("card-flow", new FakeCard(), [
		createLoadItem(first, "app://decoded-after-load.png"),
	]));
	scheduler.flushDelay(0);
	first.dispatch("load");
	first.resolveDecode();
	await flushMicrotasks();

	queue.observe(createRequest("mobile-search", new FakeCard(), [
		{
			...createLoadItem(second, "app://decoded-after-load.png"),
			onLoad: () => {
				reusedLoadCount += 1;
			},
		},
	]));

	assert.equal(second.getAttr("src"), null);
	scheduler.flushDelay(0);
	second.dispatch("load");
	assert.equal(second.decodeCalls, 1);
	assert.equal(reusedLoadCount, 0);
	second.resolveDecode();
	await flushMicrotasks();
	assert.equal(reusedLoadCount, 1);
});

test("release-on-load skips async decode caching after generation changes", async () => {
	const scheduler = new FakeScheduler();
	const first = new FakeImage();
	const second = new FakeImage();
	const generations = new Map<CardImageLoadSurface, number>([
		["card-flow", 1],
		["mobile-search", 1],
		["image-preview", 1],
	]);
	const queue = createQueue(scheduler, {
		generations,
	});

	queue.observe(createRequest("card-flow", new FakeCard(), [
		createLoadItem(first, "app://stale-after-load.png"),
	]));
	scheduler.flushDelay(0);
	first.dispatch("load");
	generations.set("card-flow", 2);
	first.resolveDecode();
	await flushMicrotasks();

	queue.observe({
		...createRequest("card-flow", new FakeCard(), [
			createLoadItem(second, "app://stale-after-load.png"),
		]),
		generation: 2,
	});

	assert.equal(second.getAttr("src"), null);
	assert.deepEqual(scheduler.delays, [0]);
});

test("release-on-load skips async decode caching after resource invalidation", async () => {
	const scheduler = new FakeScheduler();
	const first = new FakeImage();
	const second = new FakeImage();
	const queue = createQueue(scheduler, {
	});

	queue.observe(createRequest("card-flow", new FakeCard(), [
		createLoadItem(first, "app://photo.png", "Attachments/photo.png"),
	]));
	scheduler.flushDelay(0);
	first.dispatch("load");
	queue.invalidateResourcePaths(["Attachments/photo.png"]);
	first.resolveDecode();
	await flushMicrotasks();

	queue.observe(createRequest("mobile-search", new FakeCard(), [
		createLoadItem(second, "app://photo.png", "Attachments/photo.png"),
	]));

	assert.equal(second.getAttr("src"), null);
	assert.deepEqual(scheduler.delays, [0]);
});

test("forget clears a stale active target before a direct eager replacement", () => {
	const scheduler = new FakeScheduler();
	const card = new FakeCard();
	const stale = new FakeImage();
	const replacement = new FakeImage();
	const queue = createQueue(scheduler);

	queue.observe(createRequest("card-flow", card, [
		createLoadItem(stale, "app://stale.png"),
	]));
	scheduler.flushDelay(0);
	assert.equal(stale.getAttr("src"), "app://stale.png");
	assert.deepEqual(scheduler.delays, [10_000]);

	queue.forget(card.asElement(), true);
	queue.observe(createRequest("card-flow", card, [
		createLoadItem(replacement, "app://replacement.png"),
	]));

	assert.equal(stale.getAttr("src"), null);
	assert.deepEqual(scheduler.delays, [0]);
	scheduler.flushDelay(0);
	assert.equal(replacement.getAttr("src"), "app://replacement.png");
});

test("starts the primary image from each card before secondary images", () => {
	const scheduler = new FakeScheduler();
	const firstPrimary = new FakeImage();
	const firstSecondary = new FakeImage();
	const secondPrimary = new FakeImage();
	const queue = createQueue(scheduler, { concurrency: 2 });

	queue.setPaused(true);
	queue.observe(createRequest("card-flow", new FakeCard(), [
		{ ...createLoadItem(firstPrimary, "app://first-primary.png"), priority: "high" },
		{ ...createLoadItem(firstSecondary, "app://first-secondary.png"), priority: "low" },
	]));
	queue.observe(createRequest("card-flow", new FakeCard(), [
		{ ...createLoadItem(secondPrimary, "app://second-primary.png"), priority: "high" },
	]));
	queue.setPaused(false);

	assert.deepEqual(scheduler.delays, [0, 0]);
	scheduler.flushDelay(0);
	scheduler.flushDelay(0);
	assert.equal(firstPrimary.getAttr("src"), "app://first-primary.png");
	assert.equal(secondPrimary.getAttr("src"), "app://second-primary.png");
	assert.equal(firstSecondary.getAttr("src"), null);
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

	scheduler.flushDelay(0);
	assert.equal(searchImage.getAttr("src"), "app://shared.png");
	assert.equal(searchImage.decodeCalls, 0);
	assert.ok(scheduler.delays.includes(10_000));
});

test("already loaded URLs still respect surface pauses", async () => {
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

	queue.setSurfacePaused("mobile-search", true);
	queue.observe(createRequest("mobile-search", new FakeCard(), [
		{
			...createLoadItem(second, "app://decoded.png"),
			onLoad: () => {
				reusedLoadCount += 1;
			},
		},
	]));

	assert.equal(second.getAttr("src"), null);
	assert.equal(second.decodeCalls, 0);
	assert.equal(reusedLoadCount, 0);
	assert.equal(scheduler.size, 0);
	queue.setSurfacePaused("mobile-search", false);
	scheduler.flushDelay(0);
	second.dispatch("load");
	second.resolveDecode();
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

test("paused background surfaces do not block image preview", () => {
	const scheduler = new FakeScheduler();
	const cardImage = new FakeImage();
	const searchImage = new FakeImage();
	const previewImage = new FakeImage();
	const queue = createQueue(scheduler);

	queue.setSurfacePaused("card-flow", true);
	queue.setSurfacePaused("mobile-search", true);
	queue.observe(createRequest("card-flow", new FakeCard(), [
		createLoadItem(cardImage, "app://card.png"),
	]));
	queue.observe(createRequest("mobile-search", new FakeCard(), [
		createLoadItem(searchImage, "app://search.png"),
	]));
	queue.observe({
		...createRequest("image-preview", new FakeCard(), [
			createLoadItem(previewImage, "app://preview.png"),
		]),
		priority: "high",
	});

	assert.deepEqual(scheduler.delays, [0]);
	scheduler.flushDelay(0);
	assert.equal(previewImage.getAttr("src"), "app://preview.png");
	assert.equal(cardImage.getAttr("src"), null);
	assert.equal(searchImage.getAttr("src"), null);

	previewImage.dispatch("error");
	queue.setSurfacePaused("card-flow", false);
	scheduler.flushDelay(0);
	assert.equal(cardImage.getAttr("src"), "app://card.png");
	assert.equal(searchImage.getAttr("src"), null);
});

test("preempted active card flow does not block mobile search images", () => {
	const scheduler = new FakeScheduler();
	const firstCardImage = new FakeImage();
	const secondCardImage = new FakeImage();
	const searchImage = new FakeImage();
	const queue = createQueue(scheduler, { concurrency: 2 });

	queue.observe(createRequest("card-flow", new FakeCard(), [
		createLoadItem(firstCardImage, "app://first-card.png"),
	]));
	queue.observe(createRequest("card-flow", new FakeCard(), [
		createLoadItem(secondCardImage, "app://second-card.png"),
	]));
	scheduler.flushDelay(0);
	scheduler.flushDelay(0);
	assert.equal(firstCardImage.getAttr("src"), "app://first-card.png");
	assert.equal(secondCardImage.getAttr("src"), "app://second-card.png");

	queue.observe({
		...createRequest("mobile-search", new FakeCard(), [
			createLoadItem(searchImage, "app://search.png"),
		]),
		priority: "high",
	});
	queue.setSurfacePaused("card-flow", true);
	queue.preemptActiveSurface("card-flow");

	assert.equal(firstCardImage.getAttr("src"), null);
	assert.equal(secondCardImage.getAttr("src"), null);
	assert.deepEqual(scheduler.delays, [0]);
	scheduler.flushDelay(0);
	assert.equal(searchImage.getAttr("src"), "app://search.png");

	searchImage.dispatch("error");
	queue.setSurfacePaused("card-flow", false);
	scheduler.flushDelay(0);
	scheduler.flushDelay(0);
	assert.equal(firstCardImage.getAttr("src"), "app://first-card.png");
	assert.equal(secondCardImage.getAttr("src"), "app://second-card.png");
});

test("preempted active background surfaces do not block image preview", () => {
	const scheduler = new FakeScheduler();
	const cardImage = new FakeImage();
	const searchImage = new FakeImage();
	const previewImage = new FakeImage();
	const queue = createQueue(scheduler, { concurrency: 2 });

	queue.observe(createRequest("card-flow", new FakeCard(), [
		createLoadItem(cardImage, "app://card.png"),
	]));
	queue.observe(createRequest("mobile-search", new FakeCard(), [
		createLoadItem(searchImage, "app://search.png"),
	]));
	scheduler.flushDelay(0);
	scheduler.flushDelay(0);
	assert.equal(cardImage.getAttr("src"), "app://card.png");
	assert.equal(searchImage.getAttr("src"), "app://search.png");

	queue.observe({
		...createRequest("image-preview", new FakeCard(), [
			createLoadItem(previewImage, "app://preview.png"),
		]),
		priority: "high",
	});
	queue.setSurfacePaused("card-flow", true);
	queue.preemptActiveSurface("card-flow");
	queue.setSurfacePaused("mobile-search", true);
	queue.preemptActiveSurface("mobile-search");

	assert.equal(cardImage.getAttr("src"), null);
	assert.equal(searchImage.getAttr("src"), null);
	assert.deepEqual(scheduler.delays, [0]);
	scheduler.flushDelay(0);
	assert.equal(previewImage.getAttr("src"), "app://preview.png");

	previewImage.dispatch("error");
	queue.setSurfacePaused("card-flow", false);
	queue.setSurfacePaused("mobile-search", false);
	scheduler.flushDelay(0);
	scheduler.flushDelay(0);
	assert.equal(cardImage.getAttr("src"), "app://card.png");
	assert.equal(searchImage.getAttr("src"), "app://search.png");
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

	queue.bindSurface("card-flow", new FakeCard().asElement());
	queue.observe({
		...createRequest("card-flow", card, [
			createLoadItem(image, "app://lazy.png"),
		]),
		observe: true,
	});
	assert.equal(scheduler.size, 0);

	FakeIntersectionObserver.instances[0].trigger([card]);
	scheduler.flushDelay(16);
	assert.equal(image.getAttr("src"), "app://lazy.png");
});

test("observation roots are surface scoped and old callbacks cannot start work", () => {
	FakeIntersectionObserver.instances = [];
	const scheduler = new FakeScheduler();
	const queue = createQueue(scheduler, { observe: true });
	const root = new FakeCard();
	queue.bindSurface("card-flow", root.asElement());
	const oldObserver = FakeIntersectionObserver.instances[0];
	assert.equal(oldObserver.options?.root, root.asElement());
	assert.equal(FakeIntersectionObserver.instances[1].options?.rootMargin, "0px");
	const card = new FakeCard();
	const image = new FakeImage();
	queue.observe({ ...createRequest("card-flow", card, [createLoadItem(image, "app://old.png")]), observe: true });
	queue.bindSurface("card-flow", new FakeCard().asElement());
	oldObserver.trigger([card], true, true);
	assert.equal(scheduler.size, 0);
	queue.bindSurface("mobile-search", root.asElement());
	assert.equal(FakeIntersectionObserver.instances[4].options?.root, root.asElement());
	queue.dispose();
});

test("limits loading plus decode work to four and decode timeout releases budget", async () => {
	const scheduler = new FakeScheduler();
	const queue = createQueue(scheduler, { concurrency: 2, maxInFlight: 4 });
	const images = Array.from({length: 6}, () => new FakeImage());
	let errors = 0;
	let loaded = 0;
	images.forEach((image, index) => queue.observe(createRequest("card-flow", new FakeCard(), [{ ...createLoadItem(image, "app://" + index, undefined, () => errors++), onLoad: () => loaded++ }])));
	for (let i=0; i<4; i++) { scheduler.flushDelay(0); images[i].dispatch("load"); }
	assert.equal(images[4].getAttr("src"), null);
	assert.equal(scheduler.delays.filter(delay => delay === 0).length, 0);
	scheduler.flushDelay(10_000);
	assert.equal(errors, 1);
	scheduler.flushDelay(0);
	assert.equal(images[4].getAttr("src"), "app://4");
	images[0].resolveDecode();
	await flushMicrotasks();
	assert.equal(loaded, 0);
	queue.clear();
	images[1].resolveDecode();
	await flushMicrotasks();
	assert.equal(loaded, 0);
});

test("decode rejection settles once and a preempted decode cannot settle its retry", async () => {
	const scheduler = new FakeScheduler();
	const queue = createQueue(scheduler);
	const image = new FakeImage();
	let errors = 0;
	let loaded = 0;
	queue.observe(createRequest("card-flow", new FakeCard(), [{ ...createLoadItem(image, "app://retry", undefined, () => errors++), onLoad: () => loaded++ }]));
	scheduler.flushDelay(0);
	image.dispatch("load");
	queue.setSurfacePaused("card-flow", true);
	queue.preemptActiveSurface("card-flow");
	image.resolveDecode();
	await flushMicrotasks();
	assert.equal(loaded, 0);
	queue.setSurfacePaused("card-flow", false);
	scheduler.flushDelay(0);
	image.decode = () => Promise.reject(new Error("decode failed"));
	image.dispatch("load");
	await flushMicrotasks();
	assert.equal(errors, 1);
	assert.equal(loaded, 0);
	assert.equal(scheduler.size, 0);
});

test("visible secondary beats nearby primary; leaving range holds waiting tasks without clearing loaded images", async () => {
	FakeIntersectionObserver.instances = [];
	const scheduler = new FakeScheduler();
	const queue = createQueue(scheduler, { observe: true, concurrency: 2 });
	queue.bindSurface("card-flow", new FakeCard().asElement());
	const [nearby, visible] = FakeIntersectionObserver.instances;
	const nearCard = new FakeCard(), farCard = new FakeCard(), screenCard = new FakeCard();
	const near = new FakeImage(), far = new FakeImage(), screen = new FakeImage();
	queue.observe({ ...createRequest("card-flow", nearCard, [{...createLoadItem(near, "https://near"), priority: "high"}]), observe: true });
	queue.observe({ ...createRequest("card-flow", farCard, [createLoadItem(far, "https://far")]), observe: true });
	queue.observe({ ...createRequest("card-flow", screenCard, [{...createLoadItem(screen, "https://visible"), priority: "low"}]), observe: true });
	nearby.trigger([nearCard, farCard, screenCard]);
	visible.trigger([screenCard]);
	scheduler.flushDelay(16);
	assert.equal(screen.getAttr("src"), "https://visible");
	assert.equal(screen.getAttr("fetchpriority"), "high");
	assert.equal(near.getAttr("src"), "https://near");
	assert.equal(far.getAttr("src"), null);
	nearby.trigger([farCard], false);
	visible.trigger([screenCard], false);
	nearby.trigger([screenCard], false);
	screen.dispatch("load"); screen.resolveDecode();
	await flushMicrotasks();
	assert.equal(screen.getAttr("src"), "https://visible");
	assert.equal(far.getAttr("src"), null);
	nearby.trigger([farCard]);
	visible.trigger([farCard]);
	scheduler.flushDelay(16);
	assert.equal(far.getAttr("src"), "https://far");
});

test("without decode the load result must contain pixels", async () => {
	const scheduler = new FakeScheduler();
	const queue = createQueue(scheduler);
	let loaded = 0, errors = 0;
	for (const naturalWidth of [32, 0]) {
		const image = new FakeImage();
		Object.defineProperties(image, { decode: { value: undefined }, naturalWidth: { value: naturalWidth } });
		queue.observe(createRequest("card-flow", new FakeCard(), [{ ...createLoadItem(image, "app://" + naturalWidth), onLoad: () => loaded++, onError: () => errors++ }]));
		scheduler.flushDelay(0); image.dispatch("load"); await flushMicrotasks();
	}
	assert.equal(loaded, 1); assert.equal(errors, 1); assert.equal(scheduler.size, 0);
});

test("leaving range before the scheduled start defers until reentry", () => {
	FakeIntersectionObserver.instances = [];
	const scheduler = new FakeScheduler();
	const queue = createQueue(scheduler, { observe: true });
	queue.bindSurface("card-flow", new FakeCard().asElement());
	const card = new FakeCard(), image = new FakeImage();
	const nearby = FakeIntersectionObserver.instances[0];
	queue.observe({ ...createRequest("card-flow", card, [createLoadItem(image, "app://near")]), observe: true });
	nearby.trigger([card]);
	nearby.trigger([card], false); scheduler.flushDelay(16);
	assert.equal(image.getAttr("src"), null);
	nearby.trigger([card]); scheduler.flushDelay(16);
	assert.equal(image.getAttr("src"), "app://near");
	queue.dispose(); assert.equal(scheduler.size, 0);
});

interface CreateQueueOptions {
	concurrency?: number;
	generations?: Map<CardImageLoadSurface, number>;
	observe?: boolean;
	maxInFlight?: number;
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
		maxInFlight: options.maxInFlight,
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

	trigger(cards: FakeCard[], isIntersecting = true, stale = false): void {
		const entries = cards
			.map((card) => card.asElement())
			.filter((card) => stale || this.observed.has(card))
			.map((card) => ({
				isIntersecting,
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
