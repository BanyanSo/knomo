import assert from "node:assert/strict";
import test from "node:test";
import { DelayedLoadingIndicator } from "../src/ui/DelayedLoadingIndicator";

test("加载反馈只在持续等待 250ms 后出现，重绘不推迟起点", () => {
	const tasks = new Map<number, () => void>();
	let nextId = 0, reveals = 0;
	const indicator = new DelayedLoadingIndicator({
		scheduleTask: (callback, delay) => { assert.equal(delay, 250); tasks.set(++nextId, callback); return nextId; },
		cancelTask: id => { tasks.delete(id); },
	});
	assert.equal(indicator.pending("first", () => { reveals++; }), false);
	assert.equal(indicator.pending("first", () => { reveals++; }), false);
	assert.equal(tasks.size, 1);
	tasks.get(1)!();
	assert.equal(reveals, 1);
	assert.equal(indicator.pending("first", () => { reveals++; }), true);
	assert.equal(reveals, 1);
});

test("快速完成、取消和切换范围后旧回调不能显示提示", () => {
	const callbacks: Array<() => void> = [];
	let reveals = 0, cancelled = 0;
	const indicator = new DelayedLoadingIndicator({
		scheduleTask: callback => { callbacks.push(callback); return callbacks.length; },
		cancelTask: () => { cancelled++; },
	});
	indicator.pending("first", () => { reveals++; });
	indicator.clear();
	callbacks[0]!();
	assert.equal(reveals, 0);
	indicator.pending("second", () => { reveals++; });
	assert.equal(indicator.pending("third", () => { reveals++; }), false);
	callbacks[1]!();
	assert.equal(reveals, 0);
	callbacks[2]!();
	assert.equal(reveals, 1);
	assert.equal(cancelled, 2);
});
