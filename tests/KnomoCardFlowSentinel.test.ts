import test from "node:test";
import assert from "node:assert/strict";
import { ensureObsidianStub } from "./helpers/obsidianStub";

test("renders and observes the card flow load-more sentinel", async () => {
	await ensureObsidianStub();
	const { KnomoCardFlowSentinel } = await import("../src/ui/KnomoCardFlowSentinel");
	FakeIntersectionObserver.instances = [];
	const root = new TestElement("div");
	const sentinel = new KnomoCardFlowSentinel();
	const intersections: number[] = [];

	sentinel.render({
		root: root.asHtml(),
		remainingCount: 8,
		generation: 4,
		Observer: FakeIntersectionObserver as unknown as typeof IntersectionObserver,
		isCurrentGeneration: (generation) => generation === 4,
		onIntersect: (generation) => intersections.push(generation),
	});

	const button = root.find("[data-load-more-sentinel='true']");
	assert.equal(button?.getAttr("data-action"), "load-more");
	assert.equal(button?.getText(), "Load more (8 remaining)");
	assert.equal(FakeIntersectionObserver.instances.length, 1);
	const observer = FakeIntersectionObserver.instances[0];
	assert.equal(observer.options?.root, root.asHtml());
	assert.equal(observer.options?.rootMargin, "240px 0px");
	assert.equal(observer.options?.threshold, 0);
	assert.equal(observer.observed[0], button?.asHtml());
	assert.equal(sentinel.isObserving, true);

	observer.trigger(false);
	assert.deepEqual(intersections, []);
	observer.trigger(true);
	assert.deepEqual(intersections, [4]);
});

test("ignores stale card flow sentinel intersections", async () => {
	await ensureObsidianStub();
	const { KnomoCardFlowSentinel } = await import("../src/ui/KnomoCardFlowSentinel");
	FakeIntersectionObserver.instances = [];
	const root = new TestElement("div");
	const sentinel = new KnomoCardFlowSentinel();
	let intersected = false;

	sentinel.render({
		root: root.asHtml(),
		remainingCount: 1,
		generation: 2,
		Observer: FakeIntersectionObserver as unknown as typeof IntersectionObserver,
		isCurrentGeneration: () => false,
		onIntersect: () => {
			intersected = true;
		},
	});

	FakeIntersectionObserver.instances[0].trigger(true);
	assert.equal(intersected, false);
});

test("keeps scroll fallback available when IntersectionObserver is missing", async () => {
	await ensureObsidianStub();
	const { KnomoCardFlowSentinel } = await import("../src/ui/KnomoCardFlowSentinel");
	const root = new TestElement("div");
	const sentinel = new KnomoCardFlowSentinel();

	sentinel.render({
		root: root.asHtml(),
		remainingCount: 3,
		generation: 1,
		isCurrentGeneration: () => true,
		onIntersect: () => undefined,
	});

	assert.equal(root.find("[data-load-more-sentinel='true']")?.getAttr("data-action"), "load-more");
	assert.equal(sentinel.isObserving, false);
});

test("removes the card flow sentinel and disconnects the observer", async () => {
	await ensureObsidianStub();
	const { KnomoCardFlowSentinel } = await import("../src/ui/KnomoCardFlowSentinel");
	FakeIntersectionObserver.instances = [];
	const root = new TestElement("div");
	const sentinel = new KnomoCardFlowSentinel();

	sentinel.render({
		root: root.asHtml(),
		remainingCount: 2,
		generation: 1,
		Observer: FakeIntersectionObserver as unknown as typeof IntersectionObserver,
		isCurrentGeneration: () => true,
		onIntersect: () => undefined,
	});
	const button = root.find("[data-load-more-sentinel='true']");
	const observer = FakeIntersectionObserver.instances[0];

	sentinel.remove();

	assert.equal(observer.disconnected, true);
	assert.equal(button?.detached, true);
	assert.equal(sentinel.isObserving, false);
});

interface CreateElementOptions {
	cls?: string;
	text?: string;
	attr?: Record<string, string>;
}

class TestElement {
	readonly children: TestElement[] = [];
	readonly classes = new Set<string>();
	readonly attrs = new Map<string, string>();
	detached = false;
	private text = "";

	constructor(private readonly tagName: string) {}

	asHtml(): HTMLElement {
		return this as unknown as HTMLElement;
	}

	createEl(tagName: string, options: CreateElementOptions = {}): TestElement {
		const child = new TestElement(tagName);
		if (options.cls !== undefined) {
			for (const cls of options.cls.split(/\s+/)) {
				if (cls.length > 0) {
					child.classes.add(cls);
				}
			}
		}
		if (options.text !== undefined) {
			child.text = options.text;
		}
		for (const [key, value] of Object.entries(options.attr ?? {})) {
			child.attrs.set(key, value);
		}
		this.children.push(child);
		return child;
	}

	getText(): string {
		return this.text + this.children.map((child) => child.getText()).join("");
	}

	getAttr(key: string): string | null {
		return this.attrs.get(key) ?? null;
	}

	detach(): void {
		this.detached = true;
	}

	find(selector: string): TestElement | null {
		for (const child of this.children) {
			const result = child.findSelfOrDescendant(selector);
			if (result !== null) {
				return result;
			}
		}
		return null;
	}

	private findSelfOrDescendant(selector: string): TestElement | null {
		if (this.matches(selector)) {
			return this;
		}
		for (const child of this.children) {
			const result = child.findSelfOrDescendant(selector);
			if (result !== null) {
				return result;
			}
		}
		return null;
	}

	private matches(selector: string): boolean {
		const attrMatch = selector.match(/^\[([^=\]]+)(?:='([^']*)')?\]$/);
		if (attrMatch !== null) {
			const value = this.attrs.get(attrMatch[1]);
			return attrMatch[2] === undefined ? value !== undefined : value === attrMatch[2];
		}
		return this.tagName === selector;
	}
}

class FakeIntersectionObserver implements IntersectionObserver {
	static instances: FakeIntersectionObserver[] = [];
	readonly root: Element | Document | null = null;
	readonly rootMargin = "";
	readonly thresholds: readonly number[] = [];
	readonly observed: Element[] = [];
	disconnected = false;

	constructor(
		private readonly callback: IntersectionObserverCallback,
		readonly options?: IntersectionObserverInit,
	) {
		FakeIntersectionObserver.instances.push(this);
	}

	observe(target: Element): void {
		this.observed.push(target);
	}

	unobserve(_target: Element): void {}

	disconnect(): void {
		this.disconnected = true;
	}

	takeRecords(): IntersectionObserverEntry[] {
		return [];
	}

	trigger(isIntersecting: boolean): void {
		this.callback([{ isIntersecting } as IntersectionObserverEntry], this);
	}
}
