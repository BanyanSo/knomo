import test from "node:test";
import assert from "node:assert/strict";
import { ensureObsidianStub } from "./helpers/obsidianStub";

test("about groups expose updates, text contacts and two bundled reward codes", async () => {
	await ensureObsidianStub();
	const { Setting } = await import("obsidian");
	const { KnomoSettingTab, DEVELOPER_CONTACTS } = await import("../src/ui/KnomoSettingTab");
	const { t } = await import("../src/i18n");
	const names: string[] = [];
	const links: Record<string, string>[] = [];
	const images: Record<string, string>[] = [];
	const actions: (() => void)[] = [];
	const tabs: string[] = [];
	const node = {
		addClass() {},
		createDiv() { return node; },
		createEl(tag: string, options: { text?: string; attr?: Record<string, string> }) {
			if (tag === "a") links.push({ text: options.text ?? "", ...options.attr });
			if (tag === "img") images.push(options.attr ?? {});
			return node;
		},
	};
	const originals = { setName: Setting.prototype.setName, addButton: Setting.prototype.addButton };
	const descriptors = ["controlEl", "settingEl"].map(key => [key, Object.getOwnPropertyDescriptor(Setting.prototype, key)] as const);
	Setting.prototype.setName = function (name) { names.push(String(name)); return this; };
	Setting.prototype.addButton = function (configure) {
		configure({ setButtonText() { return this; }, onClick(callback: () => void) { actions.push(callback); return this; } } as never);
		return this;
	};
	for (const [key] of descriptors) Object.defineProperty(Setting.prototype, key, { configurable: true, get: () => node });
	DEVELOPER_CONTACTS.push({ id: "extra", labelKey: "settings.about.github", value: "Extra", href: "https://example.com/extra" });
	try {
		const tab = Object.create(KnomoSettingTab.prototype);
		Object.assign(tab, { pluginVersion: "9.8.7", app: { setting: { openTabById: (id: string) => tabs.push(id) } } });
		tab.renderAboutSettings(node);
		assert.equal(names[1], t("settings.about.currentVersion") + " 9.8.7");
		actions[0]();
		assert.deepEqual(tabs, ["community-plugins"]);
		assert.ok(links.some(link => link.href === "https://github.com/BanyanSo/knomo/issues/new"));
		assert.ok(links.some(link => link.href === "mailto:rongshuso@gmail.com" && link.text === "rongshuso@gmail.com"));
		assert.ok(links.some(link => link.href === "https://x.com/Banyansu"));
		assert.ok(links.some(link => link.text === "@Knomo笔记"));
		assert.ok(links.some(link => link.href === "https://example.com/extra"));
		assert.ok(!links.some(link => link.text === "rongshuso"));
		assert.equal(images.length, 2);
		for (const image of images) assert.match(image.src, /^data:image\/png;base64,/u);
		assert.ok(links.some(link => link.href === "https://www.buymeacoffee.com/banyanso"));
		assert.equal(names.at(-1), t("settings.about.privacyHeading"));
	} finally {
		DEVELOPER_CONTACTS.pop();
		Object.assign(Setting.prototype, originals);
		for (const [key, descriptor] of descriptors) {
			if (descriptor) Object.defineProperty(Setting.prototype, key, descriptor);
			else Reflect.deleteProperty(Setting.prototype, key);
		}
	}
});
