import test from "node:test";
import assert from "node:assert/strict";

import {
	ComposerSaveShortcutController,
	isComposerSaveShortcut,
} from "../src/ui/ComposerSaveShortcutController";

test("composer save shortcut handles Mod+Enter from the input", () => {
	const controller = new ComposerSaveShortcutController();
	const inputEl = {} as HTMLTextAreaElement;
	const event = createKeyboardEvent({ key: "Enter", code: "Enter", metaKey: true, target: inputEl });
	let saveCount = 0;

	const handled = controller.handleKeydown(event, {
		inputEl,
		activeElement: null,
		isSaving: false,
		saveInput: () => {
			saveCount += 1;
		},
	});

	assert.equal(handled, true);
	assert.equal(saveCount, 1);
	assert.equal(event.defaultPrevented, true);
	assert.equal(event.propagationStopped, true);
	assert.equal(event.immediatePropagationStopped, true);
});

test("composer save shortcut accepts active input even when the event target differs", () => {
	const controller = new ComposerSaveShortcutController();
	const inputEl = {} as HTMLTextAreaElement;
	let saveCount = 0;

	const handled = controller.handleKeydown(createKeyboardEvent({ key: "Enter", code: "Enter", ctrlKey: true }), {
		inputEl,
		activeElement: inputEl,
		isSaving: false,
		saveInput: () => {
			saveCount += 1;
		},
	});

	assert.equal(handled, true);
	assert.equal(saveCount, 1);
});

test("composer save shortcut blocks repeated keydown until keyup releases it", () => {
	const controller = new ComposerSaveShortcutController();
	const inputEl = {} as HTMLTextAreaElement;
	let saveCount = 0;
	const request = {
		inputEl,
		activeElement: inputEl,
		isSaving: false,
		saveInput: () => {
			saveCount += 1;
		},
	};

	controller.handleKeydown(createKeyboardEvent({ key: "Enter", code: "Enter", metaKey: true }), request);
	controller.handleKeydown(createKeyboardEvent({ key: "Enter", code: "Enter", metaKey: true }), request);
	controller.handleKeyup(createKeyboardEvent({ key: "Enter", code: "Enter", metaKey: true }));
	controller.handleKeydown(createKeyboardEvent({ key: "Enter", code: "Enter", metaKey: true }), request);

	assert.equal(saveCount, 2);
});

test("composer save shortcut reset clears repeated keydown protection", () => {
	const controller = new ComposerSaveShortcutController();
	const inputEl = {} as HTMLTextAreaElement;
	let saveCount = 0;
	const request = {
		inputEl,
		activeElement: inputEl,
		isSaving: false,
		saveInput: () => {
			saveCount += 1;
		},
	};

	controller.handleKeydown(createKeyboardEvent({ key: "Enter", code: "Enter", ctrlKey: true }), request);
	controller.reset();
	controller.handleKeydown(createKeyboardEvent({ key: "Enter", code: "Enter", ctrlKey: true }), request);

	assert.equal(saveCount, 2);
});

test("composer save shortcut suppresses saving while save is already running", () => {
	const controller = new ComposerSaveShortcutController();
	const inputEl = {} as HTMLTextAreaElement;
	let saveCount = 0;

	const handled = controller.handleKeydown(createKeyboardEvent({ key: "Enter", code: "Enter", ctrlKey: true }), {
		inputEl,
		activeElement: inputEl,
		isSaving: true,
		saveInput: () => {
			saveCount += 1;
		},
	});
	controller.handleKeydown(createKeyboardEvent({ key: "Enter", code: "Enter", ctrlKey: true }), {
		inputEl,
		activeElement: inputEl,
		isSaving: false,
		saveInput: () => {
			saveCount += 1;
		},
	});

	assert.equal(handled, true);
	assert.equal(saveCount, 1);
});

test("composer save shortcut ignores non-composer or non-save key events", () => {
	const controller = new ComposerSaveShortcutController();
	const inputEl = {} as HTMLTextAreaElement;
	const outsideTarget = {} as Element;
	let saveCount = 0;

	const outsideHandled = controller.handleKeydown(createKeyboardEvent({ key: "Enter", code: "Enter", metaKey: true, target: outsideTarget }), {
		inputEl,
		activeElement: null,
		isSaving: false,
		saveInput: () => {
			saveCount += 1;
		},
	});
	const noModHandled = controller.handleKeydown(createKeyboardEvent({ key: "Enter", code: "Enter", target: inputEl }), {
		inputEl,
		activeElement: inputEl,
		isSaving: false,
		saveInput: () => {
			saveCount += 1;
		},
	});
	const wrongKeyHandled = controller.handleKeydown(createKeyboardEvent({ key: "a", code: "KeyA", metaKey: true, target: inputEl }), {
		inputEl,
		activeElement: inputEl,
		isSaving: false,
		saveInput: () => {
			saveCount += 1;
		},
	});

	assert.equal(outsideHandled, false);
	assert.equal(noModHandled, false);
	assert.equal(wrongKeyHandled, false);
	assert.equal(saveCount, 0);
});

test("isComposerSaveShortcut accepts Enter code variants with a modifier", () => {
	assert.equal(isComposerSaveShortcut(createKeyboardEvent({ key: "", code: "NumpadEnter", ctrlKey: true })), true);
	assert.equal(isComposerSaveShortcut(createKeyboardEvent({ key: "Enter", code: "", metaKey: true })), true);
	assert.equal(isComposerSaveShortcut(createKeyboardEvent({ key: "Enter", code: "Enter" })), false);
});

interface FakeKeyboardEventOptions {
	key: string;
	code: string;
	ctrlKey?: boolean;
	metaKey?: boolean;
	target?: EventTarget | null;
}

function createKeyboardEvent(options: FakeKeyboardEventOptions): KeyboardEvent & {
	defaultPrevented: boolean;
	propagationStopped: boolean;
	immediatePropagationStopped: boolean;
} {
	const event = {
		key: options.key,
		code: options.code,
		ctrlKey: options.ctrlKey ?? false,
		metaKey: options.metaKey ?? false,
		target: options.target ?? null,
		defaultPrevented: false,
		propagationStopped: false,
		immediatePropagationStopped: false,
		preventDefault() {
			event.defaultPrevented = true;
		},
		stopPropagation() {
			event.propagationStopped = true;
		},
		stopImmediatePropagation() {
			event.immediatePropagationStopped = true;
		},
	};
	return event as KeyboardEvent & {
		defaultPrevented: boolean;
		propagationStopped: boolean;
		immediatePropagationStopped: boolean;
	};
}
