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
		setText(this: HTMLElement, text: string) { this.textContent = text; },
		setAttr(this: HTMLElement, name: string, value: string) { this.setAttribute(name, value); },
		setAttrs(this: HTMLElement, attributes: Record<string, string>) { for (const [name, value] of Object.entries(attributes)) this.setAttribute(name, value); },
		toggleClass(this: HTMLElement, name: string, value: boolean) { this.classList.toggle(name, value); },
	});
	return dom;
}

test("实际 Monthly 文件名设置流程只在全部完成时提示成功，失败或待处理保留已保存配置", async context => {
	await ensureObsidianStub();
	const { KnomoSettingTab } = await import("../src/ui/KnomoSettingTab");
	const confirm = await import("../src/ui/KnomoConfirmModal");
	context.mock.method(confirm, "showKnomoConfirmModal", async () => true);
	const { Notice } = await import("obsidian");
	const notices = (Notice as unknown as { messages: string[] }).messages;
	for (const mode of ["ready", "failed", "stale", "save-failed", "rebuild-threw", "refresh-failed", "empty"] as const) {
		let format = "Memos-YYYY-MM.md";
		const periods: string[] = [];
		const tab = Object.create(KnomoSettingTab.prototype) as unknown as { saveMonthlyMemoFileFormat(value: string): Promise<boolean> };
		Object.assign(tab, { latestSettingNoticeValues: new Map(), settingsService: {
			getSettings: () => ({ monthlyMemoFileFormat: format }), validateMonthlyMemoFileFormat: () => true,
			planMonthlyMemoFileFormatMigration: async (_format: string, sourcePeriods: string[]) => ({ oldFormat: format, newFormat: "Archive-YYYY-MM.md", periods: sourcePeriods }),
			updateSettings: async () => { if (mode === "save-failed") throw new Error("save failed"); format = "Archive-YYYY-MM.md"; },
		}, refreshCurrentConfiguration: async () => { if (mode === "refresh-failed") throw new Error("configuration refresh failed"); }, monthlyProjectionCoordinator: {
			listPeriods: async () => mode === "empty" ? [] : ["2026-07", "2026-08"],
			rebuildPeriod: async (period: string) => { periods.push(period); if (mode === "rebuild-threw") throw new Error("projection failed"); return { projected: mode === "ready" ? 1 : 0, failed: mode === "failed" ? 1 : 0 }; },
			getProjectionState: () => mode === "stale" || mode === "empty" ? "stale" : "ready",
		} });
		notices.length = 0;
		assert.equal(await tab.saveMonthlyMemoFileFormat("Archive-YYYY-MM.md"), mode === "ready" || mode === "empty", mode);
		assert.equal(format, mode === "save-failed" ? "Memos-YYYY-MM.md" : "Archive-YYYY-MM.md");
		assert.deepEqual(periods, mode === "save-failed" || mode === "refresh-failed" || mode === "empty" ? [] : mode === "rebuild-threw" ? ["2026-07"] : ["2026-07", "2026-08"]);
		assert.equal(notices.length, 1);
		if (mode === "ready" || mode === "empty") assert.match(notices[0], new RegExp(`${periods.length} months regenerated`, "i"));
		else assert.doesNotMatch(notices[0], /months regenerated|previous setting is still in use/i);
		if (mode === "rebuild-threw") assert.match(notices[0], /projection failed/);
		if (mode === "refresh-failed") assert.match(notices[0], /configuration refresh failed/);
	}
});

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

test("标题成功在当前行持续显示影响范围，无延迟或重复通知", async () => {
	await ensureObsidianStub();
	const { KnomoSettingTab } = await import("../src/ui/KnomoSettingTab");
	const { Notice } = await import("obsidian"); const notices = (Notice as unknown as { messages: string[] }).messages; notices.length = 0;
	const dom = setupDom(); const root = dom.window.document.getElementById("settings")!;
	const status = root.createDiv(); let heading = "Old";
	const tab = Object.create(KnomoSettingTab.prototype) as unknown as { saveDailyHeading(value: string): Promise<boolean> };
	Object.assign(tab, { dailyHeadingStatusEl: status, latestSettingNoticeValues: new Map(), settingsVisible: true,
		settingsService: { getSettings: () => ({ dailyHeading: heading }), validateDailyHeading: () => true,
			updateSettings: async (patch: { dailyHeading: string }) => { heading = patch.dailyHeading; } },
		refreshCurrentConfiguration: async () => {},
		containerEl: { win: { setTimeout: () => { throw new Error("No delayed feedback"); } } },
	});
	await tab.saveDailyHeading("New");
	assert.equal(heading, "New"); assert.match(status.textContent!, /only affects new memos/i);
	assert.equal(status.getAttribute("role"), "status"); assert.deepEqual(notices, []);
	dom.window.close();
});

test("浮标设置保存与查询结果分开，就地说明保留启用事实且只有一个结果渠道", async () => {
	await ensureObsidianStub();
	const { KnomoSettingTab } = await import("../src/ui/KnomoSettingTab");
	const { Notice } = await import("obsidian"); const notices = (Notice as unknown as { messages: string[] }).messages;
	for (const mode of ["ready", "query-failed", "save-failed"] as const) {
		const dom = setupDom(); const root = dom.window.document.getElementById("settings")!; const status = root.createDiv();
		let enabled = false, disabled = false, refreshes = 0;
		const toggle = { setDisabled: (value: boolean) => { disabled = value; }, setValue: (value: boolean) => { assert.equal(value, enabled); } };
		const tab = Object.create(KnomoSettingTab.prototype) as unknown as { toggleTimeBuoy(value: boolean, control: unknown, status: HTMLElement): Promise<void> };
		Object.assign(tab, { settingsVisible: true, settingsSession: 0,
			settingsService: { getSettings: () => ({ timeBuoyEnabled: enabled }), updateSettings: async () => {
				if (mode === "save-failed") throw new Error("settings storage unavailable"); enabled = true;
			} },
			catalogReadService: { queryTimeBuoysForDate: async () => { if (mode === "query-failed") throw new Error("index unavailable"); } },
			refreshOpenKnomoViews: async () => { refreshes++; },
		});
		notices.length = 0; await tab.toggleTimeBuoy(true, toggle, status);
		assert.equal(disabled, false); assert.equal(enabled, mode !== "save-failed");
		assert.equal(refreshes, mode === "save-failed" ? 0 : 1, "配置已保存时，索引查询失败也必须将新开关状态应用到视图");
		assert.ok(status.textContent?.length); assert.equal(status.getAttribute("role"), "status");
		if (mode !== "save-failed") assert.match(status.textContent!, /enabled/i);
		if (mode === "query-failed") assert.match(status.textContent!, /could not be prepared/i);
		if (mode === "save-failed") assert.match(status.textContent!, /storage unavailable/i);
		assert.deepEqual(notices, []); dom.window.close();
	}
});

test("重建与 Monthly 重试结果在需要处理区域消失及重绘后仍可见，后处理失败不追加通知", async () => {
	await ensureObsidianStub();
	const { KnomoSettingTab } = await import("../src/ui/KnomoSettingTab");
	const { Notice } = await import("obsidian"); const notices = (Notice as unknown as { messages: string[] }).messages;
	for (const action of ["rebuild", "rebuild-incomplete", "monthly", "monthly-failed", "legacy", "legacy-partial", "legacy-failed"] as const) {
		const dom = setupDom(); const root = dom.window.document.getElementById("settings")!;
		const tab = Object.create(KnomoSettingTab.prototype) as InstanceType<typeof KnomoSettingTab>;
		Object.assign(tab, { containerEl: root, settingsSession: 0, selectedTab: "record", getAttentionKinds: () => [],
			renderRecordSettings: () => {}, renderArchiveSettings: () => {}, renderAboutSettings: () => {},
			memoCommandService: { rebuildLocalCatalog: async () => {} },
			catalogReadService: { getLibraryIndexes: async () => ({ complete: action !== "rebuild-incomplete", invalidated: false }) },
			monthlyProjectionCoordinator: { run: async () => ({ failed: action === "monthly-failed" ? 1 : 0 }), getProjectionState: () => "ready" },
			legacyTrashMigrationService: { run: async (mode: string) => { assert.equal(mode, "manual"); }, getReport: () => ({ status: action === "legacy-failed" ? "recovery_required" : "ready",
				cleanupCandidate: action === "legacy-partial" ? { legacySystemRoot: "Old/_knomo-system" } : null, diagnostics: [] }) },
			refreshOpenKnomoViews: async () => { throw new Error("view render unavailable"); },
		});
		tab.display(); const button = { setDisabled: () => {}, setButtonText: () => {} };
		const internal = tab as unknown as { runRebuildIndex(button: object): Promise<void>; runMonthlyRetry(button: object): Promise<void>; runLegacyMigration(button: object): Promise<void>; refreshSettingTab(): void };
		notices.length = 0;
		if (action.startsWith("rebuild")) await internal.runRebuildIndex(button);
		else if (action.startsWith("legacy")) await internal.runLegacyMigration(button);
		else await internal.runMonthlyRetry(button);
		internal.refreshSettingTab();
		const result = root.querySelector<HTMLElement>(".knomo-setting-operation-result")!;
		assert.equal(result.hidden, false); assert.equal(result.getAttribute("role"), "status");
		assert.equal(result.getAttribute("aria-live"), "off", "相同结果重绘不再次播报");
		assert.ok(result.textContent?.length); assert.equal(result.classList.contains("is-error"), ["monthly-failed", "rebuild-incomplete", "legacy-partial", "legacy-failed"].includes(action));
		assert.equal(root.querySelector<HTMLElement>(".knomo-settings-attention")?.hidden, true);
		assert.deepEqual(notices, []); dom.window.close();
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
		pendingSettingDrafts: new Map(), latestSettingNoticeValues: new Map(),
		settingsService: {
			getSettings: () => ({ ...persisted }), validateDailyHeading: () => true, validateMarkdownHeading: () => true,
			updateSettings: async (patch: Partial<typeof persisted>) => { updates.push(patch); Object.assign(persisted, patch); },
		},
		refreshCurrentConfiguration: async () => {},
	});
	const internal = tab as unknown as {
		pendingSettingDrafts: Map<string, string>;
		updateTextSettingDraft(key: string, value: string): void;
		commitAllPendingSettingDrafts(notice: boolean): Promise<void>;
	};
	internal.updateTextSettingDraft("dailyHeading", "Captured");
	internal.updateTextSettingDraft("monthlyDateHeadingFormat", "## YYYY-MM-DD");
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
		pendingSettingDrafts: new Map(), latestSettingNoticeValues: new Map(),
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
		updateTextSettingDraft(key: string, value: string): void;
		commitAllPendingSettingDrafts(notice: boolean): Promise<void>;
		commitMonthlyDateHeadingFormatDraft(): Promise<void>;
	};
	internal.updateTextSettingDraft("dailyHeading", "Captured");
	internal.updateTextSettingDraft("monthlyDateHeadingFormat", "## MMMM DD");
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
		internal.updateTextSettingDraft("monthlyDateHeadingFormat", input.value);
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
