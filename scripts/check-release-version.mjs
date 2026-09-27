import fs from "node:fs";

const tag = process.env.GITHUB_REF_NAME;
const versionPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u;
const errors = [];

function readJson(file) {
	try {
		const value = JSON.parse(fs.readFileSync(file, "utf8"));
		if (value === null || typeof value !== "object" || Array.isArray(value)) {
			throw new Error("expected a JSON object");
		}
		return value;
	} catch (error) {
		errors.push(`${file}: ${error.message}`);
		return {};
	}
}

function expectEqual(field, actual, expected) {
	if (typeof actual !== "string" || actual !== expected) {
		errors.push(`${field}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual) ?? "<missing>"}`);
	}
}

if (typeof tag !== "string" || !versionPattern.test(tag)) {
	errors.push(`GITHUB_REF_NAME: expected X.Y.Z without a v prefix or leading zeros, got ${JSON.stringify(tag) ?? "<missing>"}`);
}

const manifest = readJson("manifest.json");
const pkg = readJson("package.json");
const lock = readJson("package-lock.json");
const versions = readJson("versions.json");

expectEqual("manifest.json.version", manifest.version, tag);
expectEqual("package.json.version", pkg.version, tag);
expectEqual("package-lock.json.version", lock.version, tag);
expectEqual('package-lock.json.packages[""].version', lock.packages?.[""]?.version, tag);
if (typeof manifest.minAppVersion !== "string" || !versionPattern.test(manifest.minAppVersion)) {
	errors.push(`manifest.json.minAppVersion: expected X.Y.Z, got ${JSON.stringify(manifest.minAppVersion) ?? "<missing>"}`);
}
expectEqual(`versions.json[${JSON.stringify(tag)}]`, versions[tag], manifest.minAppVersion);

if (errors.length > 0) {
	console.error(`Release version check failed:\n${errors.map((error) => `- ${error}`).join("\n")}`);
	process.exitCode = 1;
} else {
	console.log(`Release version check passed: ${tag} (Obsidian >= ${manifest.minAppVersion}).`);
}
