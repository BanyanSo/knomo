import test from "node:test";
import assert from "node:assert/strict";

import { getMarkdownInternalLinkInfo } from "../src/ui/MarkdownInternalLink";

test("markdown internal link info prefers data-href over href", () => {
	withDomGlobals(() => {
		const link = new TestElement("a", {
			cls: "internal-link",
			attr: {
				href: "Fallback",
				"data-href": "Project",
				"data-knomo-source-path": "Daily/2026-06-02.md",
			},
		});

		assert.deepEqual(toPlainInfo(getMarkdownInternalLinkInfo(link.asEventTarget())), {
			element: link,
			linktext: "Project",
			sourcePath: "Daily/2026-06-02.md",
		});
	});
});

test("markdown internal link info resolves nested link targets", () => {
	withDomGlobals(() => {
		const link = new TestElement("a", {
			cls: "internal-link",
			attr: {
				href: "Project",
				"data-knomo-source-path": "Daily/2026-06-02.md",
			},
		});
		const child = link.createSpan();

		assert.deepEqual(toPlainInfo(getMarkdownInternalLinkInfo(child.asEventTarget())), {
			element: link,
			linktext: "Project",
			sourcePath: "Daily/2026-06-02.md",
		});
	});
});

test("markdown internal link info ignores incomplete or non-link targets", () => {
	withDomGlobals(() => {
		const missingSource = new TestElement("a", {
			cls: "internal-link",
			attr: { href: "Project" },
		});
		const emptyHref = new TestElement("a", {
			cls: "internal-link",
			attr: {
				href: "",
				"data-knomo-source-path": "Daily/2026-06-02.md",
			},
		});
		const regularElement = new TestElement("span");

		assert.equal(getMarkdownInternalLinkInfo(null), null);
		assert.equal(getMarkdownInternalLinkInfo(missingSource.asEventTarget()), null);
		assert.equal(getMarkdownInternalLinkInfo(emptyHref.asEventTarget()), null);
		assert.equal(getMarkdownInternalLinkInfo(regularElement.asEventTarget()), null);
	});
});

function toPlainInfo(info: ReturnType<typeof getMarkdownInternalLinkInfo>): {
	element: TestElement;
	linktext: string;
	sourcePath: string;
} | null {
	if (info === null) {
		return null;
	}
	return {
		element: info.element as unknown as TestElement,
		linktext: info.linktext,
		sourcePath: info.sourcePath,
	};
}

function withDomGlobals(callback: () => void): void {
	const globals = globalThis as unknown as {
		Element?: unknown;
		HTMLAnchorElement?: unknown;
	};
	const previousElement = globals.Element;
	const previousAnchor = globals.HTMLAnchorElement;
	globals.Element = TestElement;
	globals.HTMLAnchorElement = TestElement;
	try {
		callback();
	} finally {
		globals.Element = previousElement;
		globals.HTMLAnchorElement = previousAnchor;
	}
}

interface CreateElementOptions {
	cls?: string;
	attr?: Record<string, string>;
}

class TestElement {
	private readonly children: TestElement[] = [];
	private readonly classes = new Set<string>();
	private readonly attrs = new Map<string, string>();

	constructor(
		private readonly tagName: string,
		options: CreateElementOptions = {},
		private readonly parent: TestElement | null = null,
	) {
		if (options.cls !== undefined) {
			for (const cls of options.cls.split(/\s+/)) {
				if (cls.length > 0) {
					this.classes.add(cls);
				}
			}
		}
		for (const [key, value] of Object.entries(options.attr ?? {})) {
			this.attrs.set(key, value);
		}
	}

	asEventTarget(): EventTarget {
		return this as unknown as EventTarget;
	}

	createSpan(options: CreateElementOptions = {}): TestElement {
		const child = new TestElement("span", options, this);
		this.children.push(child);
		return child;
	}

	closest(selector: string): TestElement | null {
		let current: TestElement | null = this;
		while (current !== null) {
			if (current.matches(selector)) {
				return current;
			}
			current = current.parent;
		}
		return null;
	}

	instanceOf<T>(constructor: abstract new (...args: never[]) => T): this is T {
		return this instanceof constructor;
	}

	getAttribute(key: string): string | null {
		return this.attrs.get(key) ?? null;
	}

	getAttr(key: string): string | null {
		return this.attrs.get(key) ?? null;
	}

	private matches(selector: string): boolean {
		const tagClassMatch = selector.match(/^([a-z]+)\.([a-z0-9-]+)$/i);
		if (tagClassMatch !== null) {
			return this.tagName === tagClassMatch[1] && this.classes.has(tagClassMatch[2]);
		}
		return false;
	}
}
