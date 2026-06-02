import test from "node:test";
import assert from "node:assert/strict";

test("routes root clicks by DOM action priority", async () => {
	const cleanup = installDomGlobals();
	try {
		const { getRootClickRoute } = await import("../src/ui/KnomoActionRouter");

		const tagToggle = new TestElement("button", { attr: { "data-tag-toggle": "project" } });
		assert.deepEqual(pickRoute(getRootClickRoute(tagToggle.asElement(), false)), {
			type: "tag-toggle",
			tag: "project",
		});

		const tag = new TestElement("button", { attr: { "data-tag": "Project/Knomo", "data-tag-key": "project/knomo" } });
		assert.deepEqual(pickRoute(getRootClickRoute(tag.asElement(), false)), {
			type: "tag",
			tag: "Project/Knomo",
			tagKey: "project/knomo",
		});

		const nav = new TestElement("button", { attr: { "data-nav": "review" } });
		assert.deepEqual(pickRoute(getRootClickRoute(nav.asElement(), false)), {
			type: "nav",
			nav: "review",
		});

		const titleMode = new TestElement("button", { attr: { "data-title-mode": "random" } });
		assert.deepEqual(pickRoute(getRootClickRoute(titleMode.asElement(), false)), {
			type: "title-mode",
			mode: "random",
		});

		const searchDate = new TestElement("button", { attr: { "data-search-date": "last-7" } });
		assert.deepEqual(pickRoute(getRootClickRoute(searchDate.asElement(), false)), {
			type: "search-date",
			filter: "last-7",
		});

		const trashAction = new TestElement("button", {
			attr: { "data-trash-action": "restore", "data-memo-id": "memo-1" },
		});
		assert.deepEqual(pickRoute(getRootClickRoute(trashAction.asElement(), false)), {
			type: "trash-action",
			action: "restore",
			memoId: "memo-1",
		});
		const parentAction = new TestElement("div", { attr: { "data-action": "open-drawer" } });
		const memoAction = parentAction.createChild("button", {
			attr: { "data-memo-action": "edit", "data-memo-id": "memo-2" },
		});
		assert.deepEqual(pickRoute(getRootClickRoute(memoAction.asElement(), false)), {
			type: "memo-action",
			action: "edit",
			memoId: "memo-2",
		});
	} finally {
		cleanup();
	}
});

test("routes generic actions, random cards, composer tools, and outside clicks", async () => {
	const cleanup = installDomGlobals();
	try {
		const {
			getComposerToolButtonRoute,
			getRandomReunionCardRoute,
			getRootClickRoute,
			shouldOpenRandomReunionCard,
		} = await import("../src/ui/KnomoActionRouter");

		const toolButton = new TestElement("button", {
			cls: "knomo-tool-button",
			attr: { "data-action": "insert-tag", "data-memo-id": "memo-3" },
		});
		const toolChild = toolButton.createChild("span");
		const actionRoute = getRootClickRoute(toolChild.asElement(), true);
		assert.equal(actionRoute.type, "action");
		if (actionRoute.type === "action") {
			assert.equal(actionRoute.action, "insert-tag");
			assert.equal(actionRoute.memoId, "memo-3");
			assert.equal(actionRoute.mobileToolButtonEl, toolButton.asElement());
		}

		const composerToolRoute = getComposerToolButtonRoute(toolChild.asElement());
		assert.equal(composerToolRoute?.element, toolButton.asElement());
		assert.equal(composerToolRoute?.action, "insert-tag");

		const randomCard = new TestElement("article", {
			attr: { "data-random-reunion-card": "true", "data-memo-id": "memo-4" },
		});
		const randomContent = randomCard.createChild("div");
		assert.equal(getRandomReunionCardRoute(randomContent.asElement()), randomCard.asElement());
		assert.deepEqual(pickRoute(getRootClickRoute(randomContent.asElement(), false)), {
			type: "random-reunion-card",
			memoId: "memo-4",
		});

		const linkInRandomCard = randomCard.createChild("a");
		assert.equal(shouldOpenRandomReunionCard(linkInRandomCard.asElement()), false);
		assert.equal(getRandomReunionCardRoute(linkInRandomCard.asElement()), null);

		const outside = new TestElement("div");
		assert.deepEqual(pickRoute(getRootClickRoute(outside.asElement(), false)), {
			type: "outside",
			closeCardMenu: true,
			closeScopeMenu: true,
			closeDesktopSearch: true,
			closeCompactSearch: true,
		});

		const scopePopover = new TestElement("div", { cls: "knomo-scope-popover" });
		const scopeChild = scopePopover.createChild("span");
		assert.deepEqual(pickRoute(getRootClickRoute(scopeChild.asElement(), false)), {
			type: "outside",
			closeCardMenu: true,
			closeScopeMenu: false,
			closeDesktopSearch: true,
			closeCompactSearch: true,
		});
	} finally {
		cleanup();
	}
});

function installDomGlobals(): () => void {
	const globals = globalThis as unknown as { Element?: unknown; HTMLElement?: unknown };
	const previousElement = globals.Element;
	const previousHTMLElement = globals.HTMLElement;
	globals.Element = TestElement;
	globals.HTMLElement = TestElement;
	return () => {
		globals.Element = previousElement;
		globals.HTMLElement = previousHTMLElement;
	};
}

function pickRoute(route: ReturnType<typeof import("../src/ui/KnomoActionRouter").getRootClickRoute>): Record<string, unknown> {
	if (route.type === "tag-toggle") return { type: route.type, tag: route.tag };
	if (route.type === "tag") return { type: route.type, tag: route.tag, tagKey: route.tagKey };
	if (route.type === "nav") return { type: route.type, nav: route.nav };
	if (route.type === "title-mode") return { type: route.type, mode: route.mode };
	if (route.type === "search-date") return { type: route.type, filter: route.filter };
	if (route.type === "trash-action") return { type: route.type, action: route.action, memoId: route.memoId };
	if (route.type === "memo-action") return { type: route.type, action: route.action, memoId: route.memoId };
	if (route.type === "action") return { type: route.type, action: route.action, memoId: route.memoId };
	if (route.type === "random-reunion-card") return { type: route.type, memoId: route.memoId };
	return {
		type: route.type,
		closeCardMenu: route.closeCardMenu,
		closeScopeMenu: route.closeScopeMenu,
		closeDesktopSearch: route.closeDesktopSearch,
		closeCompactSearch: route.closeCompactSearch,
	};
}

interface CreateElementOptions {
	cls?: string;
	attr?: Record<string, string>;
}

class TestElement {
	private readonly attrs = new Map<string, string>();
	private readonly classes = new Set<string>();

	constructor(
		private readonly tagName: string,
		options: CreateElementOptions = {},
		private readonly parent: TestElement | null = null,
	) {
		for (const [key, value] of Object.entries(options.attr ?? {})) {
			this.setAttr(key, value);
		}
		if (options.cls !== undefined) {
			for (const cls of options.cls.split(/\s+/)) {
				if (cls.length > 0) {
					this.classes.add(cls);
				}
			}
		}
	}

	asElement(): Element {
		return this as unknown as Element;
	}

	createChild(tagName: string, options: CreateElementOptions = {}): TestElement {
		return new TestElement(tagName, options, this);
	}

	closest(selector: string): TestElement | null {
		let current: TestElement | null = this;
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

	setAttr(key: string, value: string): void {
		this.attrs.set(key, value);
	}

	private matches(selector: string): boolean {
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
