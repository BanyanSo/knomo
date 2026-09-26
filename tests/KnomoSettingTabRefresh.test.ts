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
