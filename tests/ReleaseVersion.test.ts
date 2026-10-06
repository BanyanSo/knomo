import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { JSDOM } from "jsdom";

const script = path.resolve("scripts/check-release-version.mjs");
const tag = "1.12.5";

function runCheck(change: (directory: string) => void = () => {}, releaseTag: string | undefined = tag) {
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), "knomo-release-version-"));
	try {
		const files = {
			"manifest.json": { version: tag, minAppVersion: "1.11.0" },
			"package.json": { version: tag },
			"package-lock.json": { version: tag, packages: { "": { version: tag }, dependency: { version: "9.0.0" } } },
			"versions.json": { "1.0.0": "1.0.0", [tag]: "1.11.0" },
		};
		for (const [file, contents] of Object.entries(files)) {
			fs.writeFileSync(path.join(directory, file), JSON.stringify(contents));
		}
		change(directory);
		const env = { ...process.env };
		delete env.GITHUB_REF_NAME;
		if (releaseTag !== undefined) env.GITHUB_REF_NAME = releaseTag;
		return spawnSync(process.execPath, [script], { cwd: directory, env, encoding: "utf8" });
	} finally {
		fs.rmSync(directory, { recursive: true, force: true });
	}
}

test("release version CLI accepts consistent metadata and ignores dependency versions", () => {
	const result = runCheck();
	assert.equal(result.status, 0, result.stderr);
	assert.match(result.stdout, /passed: 1\.12\.5/u);
});

for (const releaseTag of ["", "v1.12.5", "01.12.5", "1.12", "1.12.5-beta", "1.12.6"]) {
	test(`release version CLI rejects invalid or mismatched tag ${JSON.stringify(releaseTag)}`, () => {
		const result = runCheck(() => {}, releaseTag);
		assert.equal(result.status, 1);
		assert.match(result.stderr, releaseTag === "1.12.6" ? /manifest\.json\.version/u : /GITHUB_REF_NAME/u);
	});
}

const mismatches: [string, unknown, string][] = [
	["manifest.json", { version: "1.12.4", minAppVersion: "1.11.0" }, "manifest.json.version"],
	["package.json", { version: "1.12.4" }, "package.json.version"],
	["package.json", {}, "package.json.version"],
	["package.json", { version: 1125 }, "package.json.version"],
	["package-lock.json", { version: "1.12.4", packages: { "": { version: tag } } }, "package-lock.json.version"],
	["package-lock.json", { version: tag, packages: { "": { version: "1.12.4" } } }, 'package-lock.json.packages[""].version'],
	["package-lock.json", { version: tag }, 'package-lock.json.packages[""].version'],
	["versions.json", { [tag]: "1.10.0" }, `versions.json["${tag}"]`],
	["versions.json", { "1.12.4": "1.11.0" }, `versions.json["${tag}"]`],
	["manifest.json", { version: tag }, "manifest.json.minAppVersion"],
	["manifest.json", { version: tag, minAppVersion: "invalid" }, "manifest.json.minAppVersion"],
];
for (const [file, contents, field] of mismatches) {
	test(`release version CLI rejects ${field}: ${JSON.stringify(contents)}`, () => {
		const result = runCheck((directory) => {
			fs.writeFileSync(path.join(directory, file), JSON.stringify(contents));
		});
		assert.equal(result.status, 1);
		assert.ok(result.stderr.includes(field), result.stderr);
		assert.ok(result.stderr.includes("expected"), result.stderr);
	});
}

for (const file of ["manifest.json", "package.json", "package-lock.json", "versions.json"]) {
	for (const contents of [undefined, "{invalid", "null", "[]"]) {
		test(`release version CLI rejects unreadable or non-object ${file}: ${contents}`, () => {
			const result = runCheck((directory) => {
				if (contents === undefined) fs.unlinkSync(path.join(directory, file));
				else fs.writeFileSync(path.join(directory, file), contents);
			});
			assert.equal(result.status, 1);
			assert.ok(result.stderr.includes(`${file}:`), result.stderr);
		});
	}
}

test("release version CLI reports all inconsistent fields together", () => {
	const result = runCheck(() => {}, "2.0.0");
	for (const field of ["manifest.json.version", "package.json.version", "package-lock.json.version",
		'package-lock.json.packages[""].version', 'versions.json["2.0.0"]']) {
		assert.ok(result.stderr.includes(field), result.stderr);
	}
	assert.equal(result.status, 1);
});

test("release workflow gates dependency installation and publication on the version check", () => {
	const workflow = fs.readFileSync(".github/workflows/release.yml", "utf8");
	const check = workflow.indexOf("run: node scripts/check-release-version.mjs");
	assert.ok(check > workflow.indexOf("uses: actions/setup-node@"));
	for (const step of ["run: npm ci", "run: npm run build", "gh release create"]) {
		assert.ok(workflow.indexOf(step) > check, `${step} must follow validation`);
	}
	assert.doesNotMatch(workflow, /continue-on-error: true|if:.*always\(/u);
});

test("production assets preserve JS and manifest and compress CSS without changing source or styles", async () => {
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), "knomo-release-assets-"));
	const css = "/* readable source */\n.knomo-button { display: flex; gap: 12px; color: #ffffff; padding: 4px 8px; }\n";
	const main = Buffer.from([0, 1, 2, 255]);
	const manifest = '{"id":"knomo"}\n';
	try {
		fs.writeFileSync(path.join(directory, "main.js"), main);
		fs.writeFileSync(path.join(directory, "manifest.json"), manifest);
		fs.writeFileSync(path.join(directory, "styles.css"), css);
		const importModule = new Function("specifier", "return import(specifier)") as (specifier: string) => Promise<{ prepareReleaseAssets(root: string): Promise<void> }>;
		const { prepareReleaseAssets } = await importModule(pathToFileURL(path.resolve("scripts/prepare-release-assets.mjs")).href);
		await prepareReleaseAssets(directory);
		const destination = path.join(directory, "dist");
		assert.deepEqual(fs.readdirSync(destination).sort(), ["main.js", "manifest.json", "styles.css"]);
		assert.deepEqual(fs.readFileSync(path.join(destination, "main.js")), main);
		assert.equal(fs.readFileSync(path.join(destination, "manifest.json"), "utf8"), manifest);
		assert.equal(fs.readFileSync(path.join(directory, "styles.css"), "utf8"), css);
		const compressed = fs.readFileSync(path.join(destination, "styles.css"), "utf8");
		assert.ok(Buffer.byteLength(compressed) < Buffer.byteLength(css));
		const computed = (styles: string) => {
			const dom = new JSDOM(`<style>${styles}</style><button class="knomo-button"></button>`);
			try {
				const style = dom.window.getComputedStyle(dom.window.document.querySelector("button")!);
				return [style.display, style.gap, style.color, style.padding];
			} finally { dom.window.close(); }
		};
		assert.deepEqual(computed(compressed), computed(css));
	} finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
