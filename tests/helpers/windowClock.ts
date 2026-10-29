// 仅控制指定窗口，保留其他窗口和真实编辑器的全局调度。
export function controlWindowClock(win: Window) {
	let now = 0, nextId = 0;
	const timers = new Map<number, { at: number; run: () => void }>();
	const originals = { setTimeout: win.setTimeout, clearTimeout: win.clearTimeout,
		requestAnimationFrame: win.requestAnimationFrame, cancelAnimationFrame: win.cancelAnimationFrame,
		now: win.performance.now };
	win.setTimeout = ((run: TimerHandler, delay = 0, ...args: unknown[]) => {
		if (typeof run !== "function") throw new Error("测试时钟只接受函数回调");
		timers.set(++nextId, { at: now + Math.max(0, delay), run: () => run(...args) });
		return nextId;
	}) as typeof win.setTimeout;
	win.clearTimeout = id => { if (id !== undefined) timers.delete(id); };
	win.requestAnimationFrame = run => win.setTimeout(() => run(now), 16);
	win.cancelAnimationFrame = id => win.clearTimeout(id);
	win.performance.now = () => now;
	return {
		async advance(ms: number) {
			const end = now + ms;
			for (let steps = 0; ; steps++) {
				const next = [...timers].filter(([, timer]) => timer.at <= end)
					.sort(([a, left], [b, right]) => left.at - right.at || a - b)[0];
				if (!next) break;
				if (steps >= 10000) throw new Error("测试计时器无法收敛");
				now = next[1].at; timers.delete(next[0]); next[1].run();
				await Promise.resolve();
			}
			now = end;
			await Promise.resolve();
		},
		restore() { timers.clear(); Object.assign(win, { setTimeout: originals.setTimeout, clearTimeout: originals.clearTimeout,
			requestAnimationFrame: originals.requestAnimationFrame, cancelAnimationFrame: originals.cancelAnimationFrame });
			win.performance.now = originals.now;
		},
	};
}
