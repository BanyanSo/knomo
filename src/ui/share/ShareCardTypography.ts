import { createShareCardElement } from "./ShareCardDom";
import { ShareCardError } from "./ShareCardContent";

export interface ShareCardTypography {
	readonly text: string;
	readonly ui: string;
	readonly mono: string;
	readonly size: number;
}

interface FontRule { family: string; css: string; base: string; unicodeRange?: string }
export interface ShareCardFontInput { typography: ShareCardTypography; rules: readonly FontRule[]; unavailable: boolean }

const familyName = (value: string): string => value.trim().replace(/^["']|["']$/gu, "").toLowerCase();

// 在所属窗口解析 CSS 变量，避免从标题或缩小后的元信息采样字号。
export function captureShareCardFonts(host: HTMLElement): ShareCardFontInput {
	const doc = host.ownerDocument;
	const probe = createShareCardElement(doc, "span");
	probe.className = "knomo-share-font-probe";
	host.append(probe);
	try {
		const style = doc.defaultView!.getComputedStyle(probe);
		const text = style.fontFamily; const size = parseFloat(style.fontSize);
		probe.classList.add("knomo-share-font-probe-ui");
		const ui = doc.defaultView!.getComputedStyle(probe).fontFamily;
		probe.classList.replace("knomo-share-font-probe-ui", "knomo-share-font-probe-mono");
		const mono = doc.defaultView!.getComputedStyle(probe).fontFamily;
		const families = new Set([text, ui, mono].flatMap(stack => stack.split(",").map(familyName)));
		const rules: FontRule[] = [];
		const visited = new Set<CSSStyleSheet>();
		const visitSheet = (sheet: CSSStyleSheet): void => {
			if (visited.has(sheet)) return;
			visited.add(sheet);
			try { visit(sheet.cssRules, sheet.href ?? doc.baseURI); }
			catch { /* 不可读字体在画布实际使用时报告，未使用的候补字体不阻断生成。 */ }
		};
		const visit = (items: CSSRuleList, base: string): void => {
			for (const rule of Array.from(items)) {
				if (rule.type === 5) {
					const face = rule as CSSFontFaceRule;
					const family = familyName(face.style.getPropertyValue("font-family"));
					if (families.has(family)) rules.push({ family, css: face.cssText, base, unicodeRange: face.style.getPropertyValue("unicode-range") });
				} else if (rule.type === 3) {
					const imported = (rule as CSSImportRule).styleSheet;
					if (imported) visitSheet(imported);
				} else if ("cssRules" in rule) visit((rule as CSSGroupingRule).cssRules, base);
			}
		};
		for (const sheet of Array.from(doc.styleSheets)) visitSheet(sheet);
		doc.fonts?.forEach(face => {
			const family = familyName(face.family);
			if (families.has(family) && !rules.some(rule => rule.family === family)) {
				// 保留不可读取字体的匹配范围，让画布按真实排版决定是否需要报错。
				rules.push({ family, base: doc.baseURI, unicodeRange: face.unicodeRange, css: `@font-face{font-family:${face.family};font-style:${face.style};font-weight:${face.weight};font-stretch:${face.stretch};unicode-range:${face.unicodeRange};src:url("data:font/woff2;base64,AA==")}` });
			}
		});
		return { typography: Object.freeze({ text, ui, mono, size }), rules, unavailable: !Number.isFinite(size) || size <= 0 };
	} finally { probe.remove(); }
}

// 只嵌入本地可读取字体；不为分享图片下载远程字体或复制整份主题 CSS。
export async function embedShareCardFonts(input: ShareCardFontInput, signal: AbortSignal, text?: string): Promise<string> {
	if (input.unavailable) throw new ShareCardError("font");
	try {
		signal.throwIfAborted();
		const points = text === undefined ? null : new Set(Array.from(text, char => char.codePointAt(0)!));
		const embedded: string[] = [];
		// 缓存仅属于本次嵌入；相同字源跨字重、子集或候补规则只读取一次。
		const resources = new Map<string, Promise<string>>();
		const read = (url: string): Promise<string> => {
			let resource = resources.get(url);
			if (!resource) {
				resource = (async () => {
					const response = await fetch(url, { signal });
					if (!response.ok) throw new ShareCardError("font");
					const blob = await response.blob();
					return new Promise<string>((resolve, reject) => {
						const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = reject; reader.readAsDataURL(blob);
					});
				})();
				resources.set(url, resource);
			}
			return resource;
		};
		for (const rule of input.rules) {
			signal.throwIfAborted();
			const needed = !points || usesFontCharacters(rule.unicodeRange, points);
			let css = rule.css;
			const urls = /url\(\s*(?:"([^"]*)"|'([^']*)'|([^)]*))\s*\)/gu;
			let match: RegExpExecArray | null;
			while ((match = urls.exec(rule.css)) !== null) {
				// 不可用字源替换为本地失败占位；保留 local() 和其他字源的原有选择顺序。
				let data = "data:font/woff2;base64,AA==";
				try {
					const url = new URL((match[1] ?? match[2] ?? match[3]).trim(), rule.base);
					if (needed && url.protocol === "data:") data = url.href;
					else if (needed && ["blob:", "app:", "file:", "capacitor:"].includes(url.protocol)) data = await read(url.href);
				} catch { signal.throwIfAborted(); }
				css = css.replace(match[0], `url("${data}")`);
			}
			embedded.push(css);
		}
		signal.throwIfAborted();
		return embedded.join("\n");
	} catch { signal.throwIfAborted(); throw new ShareCardError("font"); }
}

function usesFontCharacters(range: string | undefined, points: ReadonlySet<number>): boolean {
	if (!range) return true;
	const intervals: Array<readonly [number, number]> = [];
	for (const part of range.split(",")) {
		const match = /^\s*U\+([\da-f?]{1,6})(?:-([\da-f]{1,6}))?\s*$/iu.exec(part);
		// 无法确认范围时保留字源，不猜测缺字回退。
		if (!match) return true;
		intervals.push([parseInt(match[1].replace(/\?/gu, "0"), 16), parseInt(match[2] ?? match[1].replace(/\?/gu, "f"), 16)]);
	}
	return [...points].some(point => intervals.some(([from, to]) => point >= from && point <= to));
}
