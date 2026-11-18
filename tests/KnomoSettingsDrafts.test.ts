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
			settingEl: { addClass: () => undefined },
			infoEl: { createDiv: () => ({
				setAttrs: () => undefined,
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

test("文件夹设置区分部分搬迁、原位置重试和无法确认保存", async context => {
	await ensureObsidianStub();
	const { KnomoSettingTab } = await import("../src/ui/KnomoSettingTab");
	const confirmation = await import("../src/ui/KnomoConfirmModal");
	const { KnomoError } = await import("../src/types/serviceError");
	const { Notice } = await import("obsidian");
	const { t } = await import("../src/i18n");
	const confirm = context.mock.method(confirmation, "showKnomoConfirmModal",
		async (..._args: Parameters<typeof confirmation.showKnomoConfirmModal>) => true);
	const notices: string[] = Reflect.get(Notice, "messages");
	const start = notices.length;
	const tab = Object.create(KnomoSettingTab.prototype);
	let unchanged = false, failure: Error | undefined;
	Object.assign(tab, {
		settingsService: {
			planMonthlyMemoFolderMigration: async () => {
				if (failure instanceof KnomoError) throw failure;
				return { status: unchanged ? "unchanged" : "planned", oldMonthlyMemoFolder: "Old", newMonthlyMemoFolder: "New" };
			},
			migrateMonthlyMemoFolder: async () => {
				if (failure) throw failure;
				return unchanged ? { status: "unchanged" } : { status: "migrated", trashError: "raw Trash error", favoriteError: "raw Favorites error" };
			},
		},
		refreshCurrentConfiguration: async () => {},
	});
	const button = { setDisabled() {}, setButtonText() {} };
	try {
		assert.equal(await tab.saveMonthlyFolder("New", button), true);
		assert.equal(notices.length - start, 1);
		assert.deepEqual(notices.at(-1)?.split("\n"), [
			t("settings.monthlyFolder.applied"), t("settings.monthlyFolder.trashFailed"),
			t("settings.monthlyFolder.favoriteFailed", { change: t("settings.monthlyFolder.change"), apply: t("settings.monthlyFolder.apply") }),
		]);
		assert.equal(confirm.mock.calls[0]?.arguments[1].confirmLabel, t("settings.monthlyFolder.confirmButton"));
		assert.match(confirm.mock.calls[0]?.arguments[1].message ?? "", /Old.*New/u);

		unchanged = true;
		assert.equal(await tab.saveMonthlyFolder("New", button), true);
		assert.equal(confirm.mock.callCount(), 1);
		assert.equal(notices.at(-1), t("settings.monthlyFolder.favoriteChecked"));

		failure = new Error("raw settings save error");
		assert.equal(await tab.saveMonthlyFolder("New", button), false);
		assert.equal(notices.at(-1), t("settings.monthlyFolder.saveFailed"));
		failure = new KnomoError("monthly_folder_invalid_path");
		assert.equal(await tab.saveMonthlyFolder("New", button), false);
		assert.equal(notices.at(-1), t("settings.monthlyFolder.invalidPath"));
	} finally { notices.length = start; }
});
