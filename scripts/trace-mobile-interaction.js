// 在移动端 WebView 的远程调试控制台执行；不写 Vault，也不收集正文。
(() => {
	window.knomoInteractionTrace?.stop();
	const rows = [];
	const describe = el => el instanceof Element ? `${el.tagName.toLowerCase()}.${[...el.classList].join(".")}` : String(el);
	const sample = (phase, event) => {
		const touch = event?.changedTouches?.[0];
		const x = touch?.clientX ?? event?.clientX, y = touch?.clientY ?? event?.clientY;
		rows.push({ at: Math.round(performance.now()), phase, type: event?.type, trusted: event?.isTrusted,
			detail: event?.detail, pointerType: event?.pointerType, prevented: event?.defaultPrevented,
			target: describe(event?.target), focused: document.hasFocus(), active: describe(document.activeElement),
			hit: Number.isFinite(x) ? describe(document.elementFromPoint(x, y)) : undefined,
			overlays: [...document.querySelectorAll(".modal-container,.menu,.suggestion-bg")].filter(el => el.getClientRects().length).map(describe),
			template: document.querySelector('.knomo-share-templates [aria-pressed="true"]')?.getAttribute("data-template"),
			outputBusy: document.querySelector(".knomo-share-actions")?.getAttribute("aria-busy") });
		if (rows.length > 200) rows.shift();
	};
	const capture = event => sample("capture", event), bubble = event => sample("bubble", event);
	const types = ["pointerdown", "pointerup", "pointercancel", "touchstart", "touchend", "touchcancel", "click", "focus", "blur", "focusin", "focusout", "keydown", "keyboardDidHide", "visibilitychange"];
	const stop = () => {
		clearTimeout(deadline);
		for (const type of types) { window.removeEventListener(type, capture, true); window.removeEventListener(type, bubble); }
	};
	for (const type of types) { window.addEventListener(type, capture, { capture: true, passive: true }); window.addEventListener(type, bubble, { passive: true }); }
	const deadline = setTimeout(stop, 20000);
	window.knomoInteractionTrace = { rows, stop, mark: label => sample(label), print: () => console.table(rows) };
	sample("trace-start");
})();
