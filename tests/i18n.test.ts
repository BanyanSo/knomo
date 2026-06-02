import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

test("normalizes Knomo locale to zh-CN or en", async () => {
	const { normalizeKnomoLocale } = await loadLocaleModule();

	assert.equal(normalizeKnomoLocale(null), "en");
	assert.equal(normalizeKnomoLocale(undefined), "en");
	assert.equal(normalizeKnomoLocale(""), "en");
	assert.equal(normalizeKnomoLocale("en"), "en");
	assert.equal(normalizeKnomoLocale("zh"), "zh-CN");
	assert.equal(normalizeKnomoLocale("zh-CN"), "zh-CN");
	assert.equal(normalizeKnomoLocale("zh-Hans-CN"), "zh-CN");
	assert.equal(normalizeKnomoLocale("zh-TW"), "zh-CN");
	assert.equal(normalizeKnomoLocale("zh-Hant"), "zh-CN");
	assert.equal(normalizeKnomoLocale("ja"), "en");
	assert.equal(normalizeKnomoLocale("de-DE"), "en");
});

test("detects Knomo locale from Obsidian language sources in priority order", async () => {
	const { detectKnomoLocale } = await loadLocaleModule();
	const globalObject = globalThis as unknown as {
		window?: { localStorage?: { getItem(key: string): string | null } };
		document?: { documentElement?: { lang?: string } };
	};
	const originalWindow = globalObject.window;
	const originalDocument = globalObject.document;

	try {
		await setObsidianLanguage("zh-Hant");
		await setMomentLocale("en");
		globalObject.window = { localStorage: { getItem: () => "en" } };
		globalObject.document = { documentElement: { lang: "en" } };
		assert.equal(detectKnomoLocale(), "zh-CN");

		await setObsidianLanguage("ja");
		globalObject.window = { localStorage: { getItem: () => "zh-TW" } };
		globalObject.document = { documentElement: { lang: "zh-CN" } };
		assert.equal(detectKnomoLocale(), "en");

		await setObsidianLanguage("");
		globalObject.window = { localStorage: { getItem: () => "ja" } };
		globalObject.document = { documentElement: { lang: "zh-CN" } };
		assert.equal(detectKnomoLocale(), "en");

		await setObsidianLanguage("");
		globalObject.window = { localStorage: { getItem: () => null } };
		globalObject.document = { documentElement: { lang: "zh-HK" } };
		assert.equal(detectKnomoLocale(), "zh-CN");

		await setObsidianLanguage("");
		globalObject.window = { localStorage: { getItem: () => { throw new Error("blocked"); } } };
		globalObject.document = { documentElement: { lang: "" } };
		await setMomentLocale("zh-Hant");
		assert.equal(detectKnomoLocale(), "zh-CN");

		await setObsidianLanguage("");
		globalObject.window = { localStorage: { getItem: () => { throw new Error("blocked"); } } };
		globalObject.document = { documentElement: { lang: "" } };
		await setMomentLocale("");
		assert.equal(detectKnomoLocale(), "en");
	} finally {
		globalObject.window = originalWindow;
		globalObject.document = originalDocument;
	}
});

async function loadLocaleModule(): Promise<typeof import("../src/i18n/locale")> {
	await ensureObsidianStub();
	return import("../src/i18n/locale");
}

async function setObsidianLanguage(locale: string): Promise<void> {
	await ensureObsidianStub();
	const { getLanguage } = await import("obsidian");
	(getLanguage as unknown as { set(value: string): void }).set(locale);
}

async function setMomentLocale(locale: string): Promise<void> {
	await ensureObsidianStub();
	const { moment } = await import("obsidian");
	(moment as unknown as { locale(value?: string): string }).locale(locale);
}

async function ensureObsidianStub(): Promise<void> {
	const stubPath = resolve(__dirname, "../node_modules/obsidian/index.js");
	await mkdir(dirname(stubPath), { recursive: true });
	await writeFile(
		stubPath,
			[
				"class TFile {}",
				"class TFolder {}",
				"const Vault = { recurseChildren(folder, callback) { for (const child of folder.children ?? []) { callback(child); if (child instanceof TFolder) Vault.recurseChildren(child, callback); } } };",
				"const normalizePath = (path) => path.replace(/\\\\+/g, '/').replace(/\\/+/g, '/').replace(/^\\.\\//, '').replace(/\\/\\.\\//g, '/');",
				"let languageValue = 'en';",
				"function getLanguage() { return languageValue; }",
				"getLanguage.set = (value) => { languageValue = value; };",
				"function setIcon(el, icon) { if (el && typeof el.setAttr === 'function') el.setAttr('data-icon', icon); return el; }",
				"function addIcon() {}",
				"let localeValue = 'en';",
				"const moment = (date = new Date()) => ({ format: () => date.toISOString().slice(0, 10) });",
				"moment.locale = (value) => { if (typeof value === 'string') localeValue = value; return localeValue; };",
				"module.exports = { TFile, TFolder, Vault, normalizePath, moment, getLanguage, setIcon, addIcon };",
			].join("\n"),
		);
	}
