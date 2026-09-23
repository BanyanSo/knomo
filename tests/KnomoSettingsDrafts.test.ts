import test from "node:test";
import assert from "node:assert/strict";
import { ensureObsidianStub } from "./helpers/obsidianStub";

test("invalid and failed text drafts survive rerender; valid blur draft saves once", async () => {
	await ensureObsidianStub();
	const { KnomoSettingTab } = await import("../src/ui/KnomoSettingTab");
	const tab = Object.create(KnomoSettingTab.prototype) as InstanceType<typeof KnomoSettingTab>;
	const pending = new Map<string, string>();
	let saved = "Original";
	let failSave = false;
	const saves: string[] = [];
	Object.assign(tab, {
		pendingSettingDrafts: pending,
		latestSettingNoticeValues: new Map(),
		delayedSettingNotices: new Map(),
		containerEl: { win: { setTimeout: () => 1, clearTimeout: () => undefined } },
		settingsService: {
			getSettings: () => ({ dailyHeading: saved }),
			validateDailyHeading: (value: string) => value.length > 0 && value !== "bad",
			updateSettings: async ({ dailyHeading }: { dailyHeading: string }) => {
				saves.push(dailyHeading);
				if (failSave) throw new Error("save failed");
				saved = dailyHeading;
			},
		},
		refreshCurrentConfiguration: async () => undefined,
	});
	const render = () => {
		let value = "";
		let change: (next: string) => void = () => undefined;
		let blur: () => void = () => undefined;
		let message = "";
		const setting = {
			infoEl: { createDiv: () => ({
				setText: (next: string) => { message = next; },
				toggleClass: () => undefined,
			}) },
			addText: (configure: (text: unknown) => void) => {
				configure({
					inputEl: { dataset: {}, addEventListener: (_event: string, handler: () => void) => { blur = handler; } },
					setPlaceholder: () => undefined,
					setValue: (next: string) => { value = next; },
					onChange: (handler: (next: string) => void) => { change = handler; },
				});
			},
		};
		(tab as unknown as { renderDailyHeadingSetting(setting: unknown): void }).renderDailyHeadingSetting(setting);
		return { get value() { return value; }, get message() { return message; }, change, blur };
	};
	const first = render();
	assert.equal(first.value, "Original");
	first.change("bad");
	assert.equal(pending.get("dailyHeading"), "bad");
	const invalid = render();
	assert.equal(invalid.value, "bad");
	assert.ok(invalid.message.length > 0);
	invalid.blur();
	await Promise.resolve();
	assert.deepEqual(saves, []);
	invalid.change("New heading");
	const restored = render();
	assert.equal(restored.value, "New heading");
	restored.blur();
	await new Promise(resolve => setImmediate(resolve));
	assert.deepEqual(saves, ["New heading"]);
	assert.equal(pending.has("dailyHeading"), false);

	failSave = true;
	restored.change("Later heading");
	await (tab as unknown as { commitDailyHeadingDraft(): Promise<void> }).commitDailyHeadingDraft();
	assert.equal(pending.get("dailyHeading"), "Later heading");
	assert.equal(render().value, "Later heading");
});
