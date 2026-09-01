import assert from "node:assert/strict";
import test from "node:test";

import { IdentityRecoveryCoordinator } from "../src/services/IdentityRecoveryCoordinator";
import type { IdentityLedgerAttentionRoute, IdentityLedgerStatus } from "../src/types/identityLedger";

test("健康普通刷新不重读 Ledger，仍执行幂等对账", async () => {
	let reloadCount = 0;
	let reconcileCount = 0;
	const coordinator = createCoordinator({
		reload: async () => { reloadCount += 1; },
		reconcile: async () => { reconcileCount += 1; },
	});

	await coordinator.request({ reload: "if_needed" });

	assert.equal(reloadCount, 0);
	assert.equal(reconcileCount, 1);
});

test("运行中到达的更强请求会合并并补跑", async () => {
	let releaseFirst!: () => void;
	const firstReconcile = new Promise<void>((resolve) => { releaseFirst = resolve; });
	let reloadCount = 0;
	let reconcileCount = 0;
	const coordinator = createCoordinator({
		reload: async () => { reloadCount += 1; },
		reconcile: async () => {
			reconcileCount += 1;
			if (reconcileCount === 1) await firstReconcile;
		},
	});

	const first = coordinator.request();
	const stronger = coordinator.request({ reload: "force" });
	releaseFirst();
	await Promise.all([first, stronger]);

	assert.equal(reloadCount, 1);
	assert.equal(reconcileCount, 2);
});

test("可重试故障重读次数有上限", async () => {
	let reloadCount = 0;
	const coordinator = createCoordinator({
		status: "conflicted",
		attention: "settings_retry",
		reload: async () => { reloadCount += 1; },
	});

	await coordinator.request({ reload: "if_needed" });

	assert.equal(reloadCount, 2);
});

function createCoordinator(overrides: {
	status?: IdentityLedgerStatus;
	attention?: IdentityLedgerAttentionRoute;
	reload?: () => Promise<void>;
	reconcile?: () => Promise<void>;
}): IdentityRecoveryCoordinator {
	return new IdentityRecoveryCoordinator({
		getStatus: () => overrides.status ?? "ready",
		getAttentionRoute: () => overrides.attention ?? null,
		reload: overrides.reload ?? (() => Promise.resolve()),
		reconcile: overrides.reconcile ?? (() => Promise.resolve()),
		maxReloadAttempts: 2,
	});
}
