import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

test("reuses an existing Knomo leaf on desktop and mobile", async () => {
	const source = await readFile(resolve(process.cwd(), "src/main.ts"), "utf8");
	const method = getMethodSource(source, "activateView");
	const reuseIndex = method.indexOf("if (existingLeaves.length > 0)");
	const createIndex = method.indexOf('getLeaf("tab")');

	assert.notEqual(reuseIndex, -1);
	assert.equal(reuseIndex < createIndex, true);
	assert.match(method, /await this\.app\.workspace\.revealLeaf\(existingLeaves\[0\]\);\s*return;/);
	assert.doesNotMatch(method, /Platform\.isMobile|\.detach\(\)/);
});

test("restores mobile composer focus only after an image picker returns no files", async () => {
	const source = await readFile(resolve(process.cwd(), "src/ui/KnomoView.ts"), "utf8");
	const finishMethod = getMethodSource(source, "finishMobileImagePickerFocusGuard");
	const pickerMethod = getMethodSource(source, "openNativeImagePicker");

	assert.match(
		finishMethod,
		/!shouldRestoreFocus \|\| this\.currentLayout !== "mobile" \|\| !this\.composerOpen/,
	);
	assert.match(finishMethod, /input === null \|\| !input\.isConnected \|\| input\.disabled/);
	assert.match(
		pickerMethod,
		/const files = input\.files;\s*if \(files === null \|\| files\.length === 0\) \{\s*finishWithoutFiles\(\);\s*return;/,
	);
	assert.match(
		pickerMethod,
		/handledChange = true;\s*this\.finishMobileImagePickerFocusGuard\(false\);\s*void this\.insertImageFiles\(files\)\.finally\(cleanup\);/,
	);
	assert.match(pickerMethod, /this\.registerDomEvent\(input, "cancel", \(\) => \{\s*finishWithoutFiles\(\);/);
});

function getMethodSource(source: string, methodName: string): string {
	const start = source.indexOf(`\n\tasync ${methodName}(`) !== -1
		? source.indexOf(`\n\tasync ${methodName}(`)
		: source.indexOf(`\n\tprivate ${methodName}(`);
	if (start === -1) {
		throw new Error(`Expected method ${methodName}`);
	}
	const nextPrivateMethod = source.indexOf("\n\tprivate ", start + 1);
	return nextPrivateMethod === -1 ? source.slice(start) : source.slice(start, nextPrivateMethod);
}
