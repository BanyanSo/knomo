import type { ShareCardTypography } from "./ShareCardTypography";

export type ShareCardTemplateId = "paper" | "calendar" | "editorial" | "ink";

export const SHARE_CARD_TEMPLATES = [
	{ id: "paper", background: "#F6F2E8", foreground: "#302820", muted: "#766B5D", brand: "#A69E91", accent: "#63503C", line: "#D9D1C2" },
	{ id: "calendar", background: "#F3F0E5", foreground: "#2C1D0E", muted: "#786D60", brand: "#A69E91", accent: "#2C1D0E", line: "#D6CFC1" },
	{ id: "editorial", background: "#FAFAF8", foreground: "#252B33", muted: "#62686B", brand: "#A0A4A5", accent: "#496579", line: "#DFE1DE" },
	{ id: "ink", background: "#1B1D1F", foreground: "#EDE1C4", muted: "#B7AC98", brand: "#77756F", accent: "#E7CFA2", line: "#60594F" },
] as const;

// 分享画布独立于宿主主题；这些规则只装入本次会话的隔离文档。
export function shareCardStyles(id: ShareCardTemplateId, typography: ShareCardTypography): string {
	const t = SHARE_CARD_TEMPLATES.find(template => template.id === id)!;
	return `
* { box-sizing:border-box; }
html, body { margin:0; padding:0; width:390px; }
.share-card { width:390px; padding:36px 32px; background:${t.background}; color:${t.foreground};
 font:${typography.size}px/1.85 ${typography.text};
 overflow-wrap:anywhere; line-break:strict; }
p, ul, ol, blockquote, pre, table, hr { margin:0 0 1em; }
.content { text-align:start; }
.is-cjk-content .content { text-align:justify; text-align-last:start; }
.is-cjk-content .content :is(h1,h2,h3,h4,h5,h6,pre,code,table) { text-align:start; }
.content > :last-child, li > :last-child, blockquote > :last-child { margin-bottom:0; }
p { white-space:pre-wrap; }
h1,h2,h3,h4,h5,h6 { margin:24px 0 16px; line-height:1.4; }
h1 { font-size:1.6em; } h2 { font-size:1.4em; } h3 { font-size:1.2em; } h4,h5,h6 { font-size:1em; }
.content > :first-child { margin-top:0; }
ul,ol { padding-left:1.5em; } li { margin:6px 0; }
blockquote { margin-left:0; margin-right:0; padding:8px 0 8px 16px; border-left:3px solid ${t.line}; }
.callout { padding:14px; background:${id === "ink" ? "#303134" : "#ECEBE4"}; border-color:${t.accent}; }
.callout-title { font-weight:600; margin-bottom:8px; }
.link { color:${t.accent}; text-decoration:underline; text-decoration-thickness:1px; }
mark { color:inherit; background:${id === "ink" ? "#60513B" : "#E8DDBB"}; }
pre,code { font-family:${typography.mono}; font-size:.82em; white-space:pre-wrap; overflow-wrap:anywhere; word-break:break-word; }
pre { padding:14px; background:${id === "ink" ? "#303134" : "#ECEBE4"}; } pre code { font-size:inherit; }
table { width:100%; border-collapse:collapse; table-layout:fixed; font-size:.85em; }
th,td { border:1px solid ${t.line}; padding:7px; text-align:left; overflow-wrap:anywhere; }
img { display:block; max-width:100%; height:auto; margin:18px auto; object-fit:contain; }
.hero { display:block; width:390px; max-width:none; height:205px; object-fit:cover; margin:-36px -32px 30px; }
.meta { font:${typography.size * .75}px/1.6 ${typography.ui}; color:${t.muted}; }
.share-brand { margin-top:24px; text-align:center; font:400 12px/1.5 ${typography.ui}; color:${t.brand}; }
.paper-time { margin-bottom:28px; }
.editorial-time { border-top:1px solid ${t.line}; margin-top:24px; padding-top:14px; }
.date-head { text-align:center; margin-bottom:28px; color:${t.accent}; font-family:${typography.ui}; }
.date-day { font-size:92px; font-weight:600; line-height:1; }
.date-month { font-size:21px; margin-top:10px; }
.date-detail { margin-top:6px; }
.date-head:after { content:""; display:block; width:48px; height:1px; background:${t.line}; margin:24px auto 0; }
.task { font-family:${typography.ui}; margin-right:8px; }
hr { border:0; border-top:1px solid ${t.line}; }
`;
}
