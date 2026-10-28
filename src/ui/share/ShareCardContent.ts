import MarkdownIt from "markdown-it";
import type { Token } from "markdown-it";
import { parseMarkdownImages } from "../../utils/markdownImages";
import { getMemoDisplayContent, isCjkMemoContent } from "../KnomoCardMetadata";
import type { MemoViewItem } from "../../types/memoView";
import type { ShareCardTemplateId } from "./ShareCardTemplates";

export class ShareCardError extends Error {
	constructor(readonly reason: "unsupported" | "image" | "limit" | "generation" | "stale" | "font" | "cover", readonly kind: "embed" | "html" | "dynamic" | "math" | "footnote" | "format" = "format") { super(reason); }
}

export interface ShareCardSnapshot {
	readonly body: readonly Token[];
	readonly isCjkContent: boolean;
	readonly date: string;
	readonly time: string;
	readonly month: string;
	readonly weekday: string;
	readonly sourcePath: string;
}

const markdown = new MarkdownIt({ html: true, breaks: true, linkify: false, typographer: false });
// 只扩展宿主常用的静态语法；不执行 Markdown post processor 或第三方查询。
markdown.inline.ruler.before("image", "share_wiki", (state, silent) => {
	const rest = state.src.slice(state.pos);
	const match = /^(!?)\[\[([^\]\n]+)\]\]/u.exec(rest);
	if (!match) return false;
	if (!silent) {
		const token = state.push(match[1] ? "image" : "text", match[1] ? "img" : "", 0);
		if (match[1]) {
			const image = parseMarkdownImages(match[0])[0];
			if (!image) throw new ShareCardError("unsupported");
			token.attrSet("src", image.path);
			token.content = image.altText;
		} else {
			const [target, ...alias] = match[2].split("|");
			token.content = alias.length ? alias.join("|") : target;
		}
	}
	state.pos += match[0].length;
	return true;
});
markdown.inline.ruler.before("emphasis", "share_mark", (state, silent) => {
	if (state.src.slice(state.pos, state.pos + 2) !== "==") return false;
	const end = state.src.indexOf("==", state.pos + 2);
	if (end < 0) return false;
	if (!silent) {
		state.push("mark_open", "mark", 1);
		const inline = state.push("inline", "", 0);
		inline.children = [];
		markdown.inline.parse(state.src.slice(state.pos + 2, end), markdown, state.env, inline.children);
		state.push("mark_close", "mark", -1);
	}
	state.pos = end + 2;
	return true;
});

// 转义字符仍是独立 token 时检查公式，避免将普通美元文本重新解释为公式。
markdown.core.ruler.before("text_join", "share_math", state => {
	const check = (tokens: readonly Token[]): void => {
		let text = "";
		const flush = (): void => {
			if (/\$\$|\$(?!\s)[^$\n]*\S\$/u.test(text)) throw new ShareCardError("unsupported", "math");
			text = "";
		};
		for (const token of tokens) {
			if (token.type === "text" || token.type === "text_special") {
				// 转义和实体产生的美元符号是普通字符，其余文本仍可组成完整公式。
				text += token.type === "text" ? token.content : token.content.replace(/\$/gu, "＄");
			} else flush();
			if (token.children) check(token.children);
		}
		flush();
	};
	check(state.tokens);
});

export function shareCardTokens(text: string): Token[] {
	const environment: MarkdownIt.Env = {};
	const tokens = markdown.parse(text, environment);
	if (Object.keys(environment.references ?? {}).some(key => key.startsWith("^"))) throw new ShareCardError("unsupported", "footnote");
	const check = (items: readonly Token[]): void => {
		for (const token of items) {
			if (token.type === "html_block" || token.type === "html_inline") throw new ShareCardError("unsupported", "html");
			if (token.type === "fence" && /^(?:dataview\w*|query|mermaid|tasks|chart|embed)$/iu.test(token.info.trim().split(/\s/u)[0])) throw new ShareCardError("unsupported", "dynamic");
			if (token.type === "text" && /%%/u.test(token.content)) throw new ShareCardError("unsupported");
			if (token.children) check(token.children);
		}
	};
	check(tokens);
	return tokens;
}

export function createShareCardSnapshot(memo: MemoViewItem, locale: string): ShareCardSnapshot {
	const timestamp = /^(\d{4}-\d{2}-\d{2})T((?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?)$/u.exec(memo.createdAt);
	if (!timestamp) throw new ShareCardError("stale");
	const date = new Date(timestamp[1] + "T12:00:00Z");
	if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== timestamp[1]) throw new ShareCardError("stale");
	return Object.freeze({ body: shareCardTokens(getMemoDisplayContent(memo)), isCjkContent: isCjkMemoContent(memo.contentSnapshot),
		date: timestamp[1], time: timestamp[2], sourcePath: memo.dailyRef.path,
		month: new Intl.DateTimeFormat(locale, { year: "numeric", month: "long", timeZone: "UTC" }).format(date),
		weekday: new Intl.DateTimeFormat(locale, { weekday: "long", timeZone: "UTC" }).format(date) });
}

export function getShareCardImagePaths(snapshot: ShareCardSnapshot): string[] {
	const paths: string[] = [];
	const visit = (tokens: readonly Token[]): void => { for (const token of tokens) {
		if (token.type === "image") paths.push(String(token.attrGet("src") ?? ""));
		else if (token.children) visit(token.children);
	} };
	visit(snapshot.body);
	return paths;
}

// 从解析后的安全 token 构造 DOM，不将用户 Markdown 作为 HTML 注入。
export function renderShareCard(doc: Document, snapshot: ShareCardSnapshot, template: ShareCardTemplateId, images: ReadonlyMap<string, string>, cover?: string): HTMLElement {
	const card = doc.createElement("article"); card.className = "share-card";
	if (snapshot.isCjkContent) card.classList.add("is-cjk-content");
	const add = (parent: HTMLElement, tag: string, cls: string, text: string): HTMLElement => {
		const el = doc.createElement(tag); el.className = cls; el.textContent = text; parent.append(el); return el;
	};
	if (template === "reflection") {
		if (!cover) throw new ShareCardError("cover");
		const image = doc.createElement("img"); image.className = "hero"; image.src = cover; image.alt = ""; card.append(image);
	}
	if (template === "paper" || template === "midnight") add(card, "div", `meta ${template}-time`, snapshot.date.replace(/-/gu, "/"));
	if (template === "daybook") {
		const head = add(card, "header", "date-head", "");
		add(head, "div", "date-day", snapshot.date.slice(8)); add(head, "div", "date-month", snapshot.month);
		add(head, "div", "meta date-detail", snapshot.weekday);
	}
	const content = add(card, "div", "content", ""); renderTokens(content, snapshot.body, images);
	if (template === "reflection") {
		add(card, "div", "meta reflection-time", snapshot.date.replace(/-/gu, "/"));
	}
	add(card, "footer", "share-brand", "Knomo");
	return card;
}

function renderTokens(parent: HTMLElement, tokens: readonly Token[], images: ReadonlyMap<string, string>): void {
	const doc = parent.ownerDocument;
	const stack = [parent];
	const tags = new Set(["p", "h1", "h2", "h3", "h4", "h5", "h6", "ul", "ol", "li", "blockquote", "strong", "em", "s", "mark", "table", "thead", "tbody", "tr", "th", "td"]);
	for (const token of tokens) {
		const target = stack[stack.length - 1];
		if (token.nesting === -1) { stack.pop(); continue; }
		if (token.type === "inline") { renderTokens(target, token.children ?? [], images); continue; }
		if (token.type === "text") {
			const callout = target.tagName === "P" && target.parentElement?.tagName === "BLOCKQUOTE" && target.parentElement.firstChild === target && !target.hasChildNodes()
				? /^\[![\w-]+\][+-]?(?:\s+(.*))?$/u.exec(token.content.split("\n")[0]) : null;
			if (callout) { target.parentElement!.classList.add("callout"); target.className = "callout-title"; target.textContent = callout[1] ?? token.content.match(/\[!([^\]]+)/u)![1]; }
			else {
				const task = target.tagName === "P" && target.parentElement?.tagName === "LI" && !target.hasChildNodes() ? /^\[([ xX])\]\s/u.exec(token.content) : null;
				if (task) { const mark = doc.createElement("span"); mark.className = "task"; mark.textContent = task[1] === " " ? "☐" : "☑"; target.append(mark); }
				target.append(doc.createTextNode(task ? token.content.slice(task[0].length) : token.content));
			}
			continue;
		}
		if (token.type === "image") {
			const src = images.get(String(token.attrGet("src") ?? "")); if (!src) throw new ShareCardError("image");
			const image = doc.createElement("img"); image.src = src; image.alt = token.content; target.append(image); continue;
		}
		if (token.type === "code_inline" || token.type === "fence" || token.type === "code_block") {
			const code = doc.createElement("code"); code.textContent = token.content;
			if (token.type === "code_inline") target.append(code);
			else { const pre = doc.createElement("pre"); pre.append(code); target.append(pre); }
			continue;
		}
		if (token.type === "softbreak" || token.type === "hardbreak" || token.type === "hr") {
			if (token.type !== "hr" && target.classList.contains("callout-title")) {
				const body = doc.createElement("p"); target.after(body); stack[stack.length - 1] = body;
			} else target.append(doc.createElement(token.type === "hr" ? "hr" : "br"));
			continue;
		}
		if (token.nesting === 1) {
			const tag = token.type === "link_open" ? "span" : token.tag;
			if (tag !== "span" && !tags.has(tag)) throw new ShareCardError("unsupported");
			const el = doc.createElement(tag); if (tag === "span") el.className = "link";
			if (tag === "ol" && token.attrGet("start")) el.setAttribute("start", String(token.attrGet("start")));
			target.append(el); stack.push(el); continue;
		}
		throw new ShareCardError("unsupported");
	}
}
