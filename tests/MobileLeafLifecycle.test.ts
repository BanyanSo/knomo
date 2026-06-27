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
	assert.match(
		method,
		/const leaf = existingLeaves\[0\];\s*await this\.app\.workspace\.revealLeaf\(leaf\);\s*this\.app\.workspace\.setActiveLeaf\(leaf, \{ focus: true \}\);\s*this\.requestMobileNavbarSync\(leaf\);\s*return;/,
	);
	assert.doesNotMatch(method, /Platform\.isMobile|\.detach\(\)/);
});

test("requests mobile navbar sync after revealing Knomo", async () => {
	const mainSource = await readFile(resolve(process.cwd(), "src/main.ts"), "utf8");
	const viewSource = await readFile(resolve(process.cwd(), "src/ui/KnomoView.ts"), "utf8");
	const controllerSource = await readFile(resolve(process.cwd(), "src/ui/MobileNavbarCompactController.ts"), "utf8");
	const activateMethod = getMethodSource(mainSource, "activateView");
	const requestMainMethod = getMethodSource(mainSource, "requestMobileNavbarSync");
	const requestViewMethod = getMethodSource(viewSource, "requestMobileNavbarSync");
	const requestControllerMethod = getMethodSource(controllerSource, "requestSync");
	const syncControllerMethod = getMethodSource(controllerSource, "sync");
	const navbarTargetMethod = getMethodSource(viewSource, "isMobileNavbarSyncTarget");

	assert.match(activateMethod, /await this\.app\.workspace\.revealLeaf\(leaf\);\s*this\.app\.workspace\.setActiveLeaf\(leaf, \{ focus: true \}\);\s*this\.requestMobileNavbarSync\(leaf\);/);
	assert.match(requestMainMethod, /Platform\.isMobile && leaf\.view instanceof KnomoView/);
	assert.match(viewSource, /isActive: \(\) => this\.isMobileNavbarSyncTarget\(\)/);
	assert.match(navbarTargetMethod, /this\.app\.workspace\.getActiveViewOfType\(KnomoView\) === this/);
	assert.match(navbarTargetMethod, /Platform\.isMobile && this\.containerEl\.isShown\(\)/);
	assert.match(requestViewMethod, /this\.mobileNavbarCompactController\?\.requestSync\(\);/);
	assert.ok(requestControllerMethod.indexOf("this.clearSyncThrottle();") < requestControllerMethod.indexOf("this.queueSyncCycle();"));
	assert.match(syncControllerMethod, /if \(!this\.shouldEnable\(\)\) \{\s*this\.disconnectObserver\(\);\s*this\.cleanupRenderedState\(\);\s*return;/);
	assert.doesNotMatch(syncControllerMethod, /if \(!this\.shouldEnable\(\)\) \{\s*this\.disable\(\);/);
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
	const start = getMethodStart(source, methodName);
	if (start === -1) {
		throw new Error(`Expected method ${methodName}`);
	}
	const nextPrivateMethod = source.indexOf("\n\tprivate ", start + 1);
	return nextPrivateMethod === -1 ? source.slice(start) : source.slice(start, nextPrivateMethod);
}

function getMethodStart(source: string, methodName: string): number {
	for (const prefix of ["async ", "private ", "private async ", ""]) {
		const start = source.indexOf(`\n\t${prefix}${methodName}(`);
		if (start !== -1) {
			return start;
		}
	}
	return -1;
}
