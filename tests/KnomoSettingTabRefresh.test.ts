import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { ensureObsidianStub } from "./helpers/obsidianStub";

function setupDom() {
	const dom = new JSDOM("<div id='settings'></div>");
	const proto = dom.window.HTMLElement.prototype;
	Object.assign(proto, {
		createEl(this: HTMLElement, tag: string, options?: { text?: string; cls?: string; attr?: Record<string, string> }) {
			const child = this.ownerDocument.createElement(tag);
			if (options?.text) child.textContent = options.text;
			if (options?.cls) child.className = options.cls;
			for (const [name, value] of Object.entries(options?.attr ?? {})) child.setAttribute(name, value);
			this.appendChild(child);
			return child;
		},
		createDiv(this: HTMLElement, options?: { cls?: string; attr?: Record<string, string> }) {
			return (this as HTMLElement & { createEl(tag: string, options?: unknown): HTMLElement }).createEl("div", options);
		},
		empty(this: HTMLElement) { this.replaceChildren(); },
		addClass(this: HTMLElement, ...names: string[]) { this.classList.add(...names); },
	});
	return dom;
}

test("legacy and declarative entry points render the same three-tab page", async () => {
	await ensureObsidianStub();
	const { KnomoSettingTab } = await import("../src/ui/KnomoSettingTab");
	for (const declarative of [false, true]) {
		const dom = setupDom();
		const container = dom.window.document.getElementById("settings")!;
		const tab = Object.create(KnomoSettingTab.prototype) as InstanceType<typeof KnomoSettingTab>;
		Object.assign(tab, {
			containerEl: container, selectedTab: "record", settingsVisible: false,
			renderRecordSettings: (el: HTMLElement) => { el.textContent = "record content"; },
			renderArchiveSettings: (el: HTMLElement) => { el.textContent = "archive content"; },
			renderAboutSettings: (el: HTMLElement) => { el.textContent = "about content"; },
			getAttentionKinds: () => [],
		});
		if (declarative) {
			const definition = tab.getSettingDefinitions()[0] as unknown as { render(setting: { settingEl: HTMLElement }): void };
			definition.render({ settingEl: container });
		} else tab.display();
		assert.equal(container.querySelectorAll('[role="tab"]').length, 3);
		assert.equal(container.querySelectorAll('[role="tabpanel"]').length, 3);
		assert.ok(container.querySelector(".knomo-settings-navigation [role='tablist']"));
		assert.equal(container.querySelector('[role="tab"][aria-selected="true"]')?.textContent?.length !== 0, true);
		assert.equal(container.querySelectorAll('[role="tabpanel"]:not([hidden])').length, 1);
		assert.equal(container.querySelector(".knomo-settings-attention")?.hasAttribute("hidden"), true);
		dom.window.close();
	}
});

test("manual tab navigation keeps panels mounted and hides inactive controls", async () => {
	await ensureObsidianStub();
	const { KnomoSettingTab } = await import("../src/ui/KnomoSettingTab");
	const dom = setupDom();
	const container = dom.window.document.getElementById("settings")!;
	const tab = Object.create(KnomoSettingTab.prototype) as InstanceType<typeof KnomoSettingTab>;
	Object.assign(tab, {
		containerEl: container, selectedTab: "record", settingsVisible: false,
		renderRecordSettings: (el: HTMLElement) => { el.innerHTML = "<input data-knomo-setting-input='dailyHeading' value='draft'>"; },
		renderArchiveSettings: (el: HTMLElement) => { el.textContent = "archive content"; },
		renderAboutSettings: (el: HTMLElement) => { el.textContent = "about content"; },
		getAttentionKinds: () => [],
	});
	tab.display();
	const buttons = Array.from(container.querySelectorAll<HTMLButtonElement>('[role="tab"]'));
	const input = container.querySelector("input")!;
	input.value = "unsaved";
	buttons[0].focus();
	buttons[0].dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
	assert.equal(dom.window.document.activeElement, buttons[1]);
	assert.equal(buttons[0].getAttribute("aria-selected"), "true");
	buttons[1].click();
	assert.equal(buttons[1].getAttribute("aria-selected"), "true");
	assert.equal(buttons[1].tabIndex, 0);
	assert.equal(buttons[0].tabIndex, -1);
	assert.equal(input.closest('[role="tabpanel"]')?.hasAttribute("hidden"), true);
	buttons[0].click();
	assert.equal(container.querySelector("input"), input);
	assert.equal(input.value, "unsaved");
	input.focus();
	input.setSelectionRange(1, 3);
	(tab as unknown as { refreshSettingTab(): void }).refreshSettingTab();
	const restored = container.querySelector("input")!;
	assert.equal(dom.window.document.activeElement, restored);
	assert.equal(restored.selectionStart, 1);
	assert.equal(restored.selectionEnd, 3);
	dom.window.close();
});

test("page refresh restores ancestor scroll positions after content collapses", async () => {
	await ensureObsidianStub();
	const { KnomoSettingTab } = await import("../src/ui/KnomoSettingTab");
	const dom = setupDom();
	const container = dom.window.document.getElementById("settings")!;
	const tab = Object.create(KnomoSettingTab.prototype) as InstanceType<typeof KnomoSettingTab>;
	Object.assign(tab, {
		containerEl: container, selectedTab: "archive-data", settingsVisible: false,
		renderRecordSettings: () => undefined,
		renderArchiveSettings: (el: HTMLElement) => { el.textContent = "file location controls"; },
		renderAboutSettings: () => undefined,
		getAttentionKinds: () => [],
	});
	tab.display();
	container.scrollTop = 480;
	dom.window.document.body.scrollTop = 120;
	const page = container.querySelector<HTMLElement>(".knomo-settings-page")!;
	const remove = page.remove.bind(page);
	// jsdom 不计算布局，显式模拟移除内容时浏览器收缩滚动范围。
	page.remove = () => {
		remove();
		container.scrollTop = 0;
		dom.window.document.body.scrollTop = 0;
	};
	(tab as unknown as { refreshSettingTab(): void }).refreshSettingTab();
	assert.equal(container.scrollTop, 480);
	assert.equal(dom.window.document.body.scrollTop, 120);
	assert.equal(container.querySelector('[role="tab"][aria-selected="true"]')?.id,
		"knomo-settings-tab-archive-data");
	dom.window.close();
});

test("attention refresh preserves the active tab and its input", async () => {
	await ensureObsidianStub();
	const { KnomoSettingTab } = await import("../src/ui/KnomoSettingTab");
	const dom = setupDom();
	const container = dom.window.document.getElementById("settings")!;
	let attention = false;
	const tab = Object.create(KnomoSettingTab.prototype) as InstanceType<typeof KnomoSettingTab>;
	Object.assign(tab, {
		containerEl: container, selectedTab: "record", settingsVisible: false,
		renderRecordSettings: (el: HTMLElement) => { el.innerHTML = "<input value='draft'>"; },
		renderArchiveSettings: () => undefined, renderAboutSettings: () => undefined,
		getAttentionKinds: () => attention ? ["catalog"] : [],
		renderAttentionSetting: (_kind: string, setting: { containerEl: HTMLElement }) => {
			setting.containerEl.textContent = "needs attention";
		},
	});
	tab.display();
	const input = container.querySelector("input")!;
	input.value = "unsaved";
	attention = true;
	tab.refreshAttentionIfVisible();
	assert.equal(container.querySelector("input"), input);
	assert.equal(input.value, "unsaved");
	assert.equal(container.querySelector(".knomo-settings-attention")?.hasAttribute("hidden"), false);
	attention = false;
	Object.assign(tab, { runtimeRetryRunning: true });
	tab.refreshAttentionIfVisible();
	assert.equal(container.querySelector(".knomo-settings-attention")?.hasAttribute("hidden"), false);
	Object.assign(tab, { runtimeRetryRunning: false });
	tab.refreshAttentionIfVisible();
	assert.equal(container.querySelector(".knomo-settings-attention")?.hasAttribute("hidden"), true);
	dom.window.close();
});

test("closing settings saves automatic drafts while explicit-apply fields remain unapplied", async () => {
	await ensureObsidianStub();
	const { KnomoSettingTab } = await import("../src/ui/KnomoSettingTab");
	const dom = setupDom();
	const persisted = { dailyHeading: "Memos", monthlyDateHeadingFormat: "## DD" };
	const updates: Partial<typeof persisted>[] = [];
	const tab = Object.create(KnomoSettingTab.prototype) as InstanceType<typeof KnomoSettingTab>;
	Object.assign(tab, {
		containerEl: dom.window.document.getElementById("settings"), settingsVisible: true,
		pendingSettingDrafts: new Map(), latestSettingNoticeValues: new Map(), delayedSettingNotices: new Map(),
		settingsService: {
			getSettings: () => ({ ...persisted }), validateDailyHeading: () => true, validateMarkdownHeading: () => true,
			updateSettings: async (patch: Partial<typeof persisted>) => { updates.push(patch); Object.assign(persisted, patch); },
		},
		refreshCurrentConfiguration: async () => {},
	});
	const internal = tab as unknown as {
		pendingSettingDrafts: Map<string, string>;
		updateTextSettingDraft(key: string, value: string, validate: (value: string) => boolean, message: string): void;
		commitAllPendingSettingDrafts(notice: boolean): Promise<void>;
	};
	internal.updateTextSettingDraft("dailyHeading", "Captured", () => true, "");
	internal.updateTextSettingDraft("monthlyDateHeadingFormat", "## YYYY-MM-DD", () => true, "");
	internal.pendingSettingDrafts.set("monthlyMemoFileFormat", "pending-explicit-format");
	let completion: Promise<void> | undefined;
	const commit = internal.commitAllPendingSettingDrafts.bind(internal);
	internal.commitAllPendingSettingDrafts = notice => completion = commit(notice);
	try {
		tab.hide();
		assert.ok(completion);
		await completion;
		assert.deepEqual(persisted, { dailyHeading: "Captured", monthlyDateHeadingFormat: "## YYYY-MM-DD" });
		assert.deepEqual(updates, [{ dailyHeading: "Captured" }, { monthlyDateHeadingFormat: "## YYYY-MM-DD" }]);
		assert.equal(internal.pendingSettingDrafts.size, 0);
	} finally { dom.window.close(); }
});

test("a close batch cannot overwrite a newer setting after reopening during a delayed save", async () => {
	await ensureObsidianStub();
	const { KnomoSettingTab } = await import("../src/ui/KnomoSettingTab");
	const dom = setupDom();
	const persisted = { dailyHeading: "Memos", monthlyDateHeadingFormat: "## DD" };
	const updates: Partial<typeof persisted>[] = [];
	let releaseDaily: (() => void) | undefined;
	const dailyGate = new Promise<void>(resolve => { releaseDaily = resolve; });
	let writes = Promise.resolve();
	const tab = Object.create(KnomoSettingTab.prototype) as InstanceType<typeof KnomoSettingTab>;
	Object.assign(tab, {
		containerEl: dom.window.document.getElementById("settings"), settingsVisible: true,
		pendingSettingDrafts: new Map(), latestSettingNoticeValues: new Map(), delayedSettingNotices: new Map(),
		settingsService: {
			getSettings: () => ({ ...persisted }), validateDailyHeading: () => true, validateMarkdownHeading: () => true,
			updateSettings: (patch: Partial<typeof persisted>) => {
				writes = writes.then(async () => {
					if (patch.dailyHeading !== undefined) await dailyGate;
					updates.push(patch); Object.assign(persisted, patch);
				});
				return writes;
			},
		},
		refreshCurrentConfiguration: async () => {},
	});
	const internal = tab as unknown as {
		updateTextSettingDraft(key: string, value: string, validate: (value: string) => boolean, message: string): void;
		commitAllPendingSettingDrafts(notice: boolean): Promise<void>;
		commitMonthlyDateHeadingFormatDraft(): Promise<void>;
	};
	internal.updateTextSettingDraft("dailyHeading", "Captured", () => true, "");
	internal.updateTextSettingDraft("monthlyDateHeadingFormat", "## MMMM DD", () => true, "");
	let completion: Promise<void> | undefined;
	const commit = internal.commitAllPendingSettingDrafts.bind(internal);
	internal.commitAllPendingSettingDrafts = notice => completion = commit(notice);
	try {
		tab.hide();
		assert.ok(completion);
		Object.assign(tab, { settingsVisible: true });
		const input = dom.window.document.createElement("input");
		input.value = "## YYYY-MM-DD";
		dom.window.document.getElementById("settings")!.appendChild(input);
		input.focus();
		internal.updateTextSettingDraft("monthlyDateHeadingFormat", input.value, () => true, "");
		const newest = internal.commitMonthlyDateHeadingFormatDraft();
		assert.ok(releaseDaily);
		releaseDaily();
		await Promise.all([completion, newest]);
		assert.equal(persisted.monthlyDateHeadingFormat, "## YYYY-MM-DD");
		assert.deepEqual(updates, [{ dailyHeading: "Captured" }, { monthlyDateHeadingFormat: "## YYYY-MM-DD" }]);
		assert.equal(input.value, "## YYYY-MM-DD");
		assert.equal(dom.window.document.activeElement, input);
	} finally { releaseDaily?.(); dom.window.close(); }
});
