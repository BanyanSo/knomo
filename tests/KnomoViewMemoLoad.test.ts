import test from "node:test";
import assert from "node:assert/strict";

import type { MemoDataRequirement } from "../src/ui/viewFilters";
import { ensureObsidianStub } from "./helpers/obsidianStub";

interface TestableKnomoView {
	memoLoadingPromise: Promise<boolean> | null;
	mobileMemoHydrator: {
		getSnapshot: () => {
			allMemosLoaded: boolean;
			loadedMemoPeriods: ReadonlySet<string>;
		};
		start: () => Promise<boolean>;
		ensurePeriods: (periods: readonly string[]) => Promise<boolean>;
	};
	ensureMobileMemoDataRequirement: (getRequirement: () => MemoDataRequirement) => Promise<boolean>;
}

test("upgrades a pending history load to an all-active request", async () => {
	const view = await createTestView();
	const loadedPeriods = new Set<string>(["2026-06"]);
	let allMemosLoaded = false;
	let startCalls = 0;
	let resolveHistoryLoad: (loaded: boolean) => void;
	const historyLoad = new Promise<boolean>((resolve) => {
		resolveHistoryLoad = resolve;
	});
	view.memoLoadingPromise = historyLoad;
	view.mobileMemoHydrator = {
		getSnapshot: () => ({ allMemosLoaded, loadedMemoPeriods: loadedPeriods }),
		start: async () => {
			startCalls += 1;
			allMemosLoaded = true;
			return true;
		},
		ensurePeriods: async () => true,
	};

	const ensured = view.ensureMobileMemoDataRequirement(() => ({ kind: "all-active" }));
	loadedPeriods.add("2026-05");
	view.memoLoadingPromise = null;
	resolveHistoryLoad!(true);

	assert.equal(await ensured, true);
	assert.equal(startCalls, 1);
	assert.equal(allMemosLoaded, true);
});

test("re-evaluates the current period requirement after a pending load", async () => {
	const view = await createTestView();
	const loadedPeriods = new Set<string>(["2026-06"]);
	let requirement: MemoDataRequirement = { kind: "periods", periods: ["2026-05"] };
	let resolveInitialLoad: (loaded: boolean) => void;
	const initialLoad = new Promise<boolean>((resolve) => {
		resolveInitialLoad = resolve;
	});
	const requestedPeriods: string[][] = [];
	view.memoLoadingPromise = initialLoad;
	view.mobileMemoHydrator = {
		getSnapshot: () => ({ allMemosLoaded: false, loadedMemoPeriods: loadedPeriods }),
		start: async () => true,
		ensurePeriods: async (periods) => {
			requestedPeriods.push([...periods]);
			for (const period of periods) {
				loadedPeriods.add(period);
			}
			return true;
		},
	};

	const ensured = view.ensureMobileMemoDataRequirement(() => requirement);
	requirement = { kind: "periods", periods: ["2026-04"] };
	loadedPeriods.add("2026-05");
	view.memoLoadingPromise = null;
	resolveInitialLoad!(true);

	assert.equal(await ensured, true);
	assert.deepEqual(requestedPeriods, [["2026-04"]]);
});

async function createTestView(): Promise<TestableKnomoView> {
	await ensureObsidianStub();
	const { KnomoView } = await import("../src/ui/KnomoView");
	return Object.create(KnomoView.prototype) as TestableKnomoView;
}
