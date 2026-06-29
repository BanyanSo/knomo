import test from "node:test";
import assert from "node:assert/strict";

import { KnomoPopupState } from "../src/ui/KnomoPopupState";

test("closes card and scope popup state independently", () => {
	const state = new KnomoPopupState(() => fakeWindow());

	assert.equal(state.hasOpenPopup(), false);

	state.activeMenuMemoId = "memo-1";
	assert.equal(state.hasOpenPopup(), true);
	assert.equal(state.closeCardMenu(), "memo-1");
	assert.equal(state.closeCardMenu(), null);

	state.activeMenuMemoId = "memo-2";
	state.scopeMenuOpen = true;
	assert.deepEqual(state.closeOpenPopups(), {
		closedMemoId: "memo-2",
		closedScopeMenu: true,
	});
	assert.equal(state.hasOpenPopup(), false);
});

test("outside popup events close popups and suppress the following click", () => {
	withFakeDomConstructors(() => {
		const state = new KnomoPopupState(() => fakeWindow());
		const outside = new FakeElement("div");
		const event = new FakeEvent(outside);
		state.activeMenuMemoId = "memo-1";
		state.scopeMenuOpen = true;

		const result = state.handleOpenPopupOutsideEvent(event.asEvent(), outside.asTarget(), true);

		assert.deepEqual(result, {
			handled: true,
			closedMemoId: "memo-1",
			closedScopeMenu: true,
		});
		assert.equal(state.hasOpenPopup(), false);
		assert.equal(state.suppressNextOpenPopupDismissClick, true);
		assert.equal(event.defaultPrevented, true);
		assert.equal(event.propagationStopped, true);

		const memoTimeButton = new FakeElement("button", { attr: { "data-memo-time-open": "daily" } });
		const click = new FakeEvent(memoTimeButton);
		assert.equal(state.consumeSuppressedOpenPopupDismissClick(click.asEvent()), true);
		assert.equal(state.suppressNextOpenPopupDismissClick, false);
		assert.equal(memoTimeButton.blurred, true);
		assert.equal(click.defaultPrevented, true);
		assert.equal(click.propagationStopped, true);
		assert.equal(click.immediatePropagationStopped, true);
	});
});

test("popup outside handler ignores targets inside the open card menu", () => {
	withFakeDomConstructors(() => {
		const state = new KnomoPopupState(() => fakeWindow());
		const card = new FakeElement("div", {
			cls: "knomo-card",
			attr: { "data-memo-id": "memo-1" },
		});
		const actions = card.createChild("div", { cls: "knomo-card-actions" });
		const actionButton = actions.createChild("button");
		const event = new FakeEvent(actionButton);
		state.activeMenuMemoId = "memo-1";

		const result = state.handleOpenPopupOutsideEvent(event.asEvent(), actionButton.asTarget(), true);

		assert.deepEqual(result, {
			handled: false,
			closedMemoId: null,
			closedScopeMenu: false,
		});
		assert.equal(state.activeMenuMemoId, "memo-1");
		assert.equal(event.defaultPrevented, false);
		assert.equal(event.propagationStopped, false);
		assert.equal(state.suppressNextOpenPopupDismissClick, false);
	});
});

test("popup outside handler preserves editable defaults while closing popups", () => {
	withFakeDomConstructors(() => {
		const state = new KnomoPopupState(() => fakeWindow());
		const input = new FakeInputElement("text");
		const event = new FakeEvent(input);
		state.scopeMenuOpen = true;

		const result = state.handleOpenPopupOutsideEvent(event.asEvent(), input.asTarget(), false);

		assert.equal(result.handled, true);
		assert.equal(result.closedScopeMenu, true);
		assert.equal(event.defaultPrevented, false);
		assert.equal(event.propagationStopped, true);
	});
});

function fakeWindow(): Window {
	return {
		setTimeout: () => 1,
		clearTimeout: () => undefined,
	} as unknown as Window;
}

function withFakeDomConstructors(run: () => void): void {
	const globals = globalThis as unknown as {
		Element: unknown;
		HTMLElement: unknown;
		HTMLInputElement: unknown;
	};
	const previous = {
		Element: globals.Element,
		HTMLElement: globals.HTMLElement,
		HTMLInputElement: globals.HTMLInputElement,
	};
	globals.Element = FakeElement;
	globals.HTMLElement = FakeElement;
	globals.HTMLInputElement = FakeInputElement;
	try {
		run();
	} finally {
		globals.Element = previous.Element;
		globals.HTMLElement = previous.HTMLElement;
		globals.HTMLInputElement = previous.HTMLInputElement;
	}
}

interface FakeElementOptions {
	cls?: string;
	attr?: Record<string, string>;
}

class FakeElement {
	private readonly attrs = new Map<string, string>();
	private readonly classes = new Set<string>();
	blurred = false;

	constructor(
		private readonly tagName: string,
		options: FakeElementOptions = {},
		private readonly parent: FakeElement | null = null,
	) {
		for (const cls of options.cls?.split(/\s+/) ?? []) {
			if (cls.length > 0) {
				this.classes.add(cls);
			}
		}
		for (const [key, value] of Object.entries(options.attr ?? {})) {
			this.attrs.set(key, value);
		}
	}

	asTarget(): EventTarget {
		return this as unknown as EventTarget;
	}

	createChild(tagName: string, options: FakeElementOptions = {}): FakeElement {
		return new FakeElement(tagName, options, this);
	}

	closest(selector: string): FakeElement | null {
		let current: FakeElement | null = this;
		while (current !== null) {
			if (selector.split(",").some((part) => current?.matches(part.trim()) === true)) {
				return current;
			}
			current = current.parent;
		}
		return null;
	}

	instanceOf(constructor: unknown): boolean {
		return typeof constructor === "function" && this instanceof constructor;
	}

	getAttr(key: string): string | null {
		return this.attrs.get(key) ?? null;
	}

	blur(): void {
		this.blurred = true;
	}

	protected matches(selector: string): boolean {
		if (selector.startsWith(".")) {
			return this.classes.has(selector.slice(1));
		}
		const attrMatch = selector.match(/^\[([^=\]]+)(?:='([^']*)')?\]$/);
		if (attrMatch !== null) {
			const value = this.attrs.get(attrMatch[1]);
			return attrMatch[2] === undefined ? value !== undefined : value === attrMatch[2];
		}
		return this.tagName === selector;
	}
}

class FakeInputElement extends FakeElement {
	constructor(readonly type: string) {
		super("input");
	}
}

class FakeEvent {
	defaultPrevented = false;
	propagationStopped = false;
	immediatePropagationStopped = false;

	constructor(readonly target: FakeElement) {}

	asEvent(): Event {
		return this as unknown as Event;
	}

	preventDefault(): void {
		this.defaultPrevented = true;
	}

	stopPropagation(): void {
		this.propagationStopped = true;
	}

	stopImmediatePropagation(): void {
		this.immediatePropagationStopped = true;
	}
}
