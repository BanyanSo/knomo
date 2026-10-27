export type ShareCardTemplateId = "paper" | "editorial" | "nocturne";

export const SHARE_CARD_TEMPLATES = [
	{ id: "paper", background: "#F6F2E8", foreground: "#302820", muted: "#766B5D", accent: "#63503C", line: "#D9D1C2", serif: true, lineHeight: 1.75, fontSize: 19 },
	{ id: "editorial", background: "#F7F7F3", foreground: "#292D30", muted: "#62686B", accent: "#496579", line: "#DFE1DE", serif: false, lineHeight: 1.7, fontSize: 18 },
	{ id: "nocturne", background: "#252628", foreground: "#EEE3CC", muted: "#B7AC98", accent: "#E7CFA2", line: "#60594F", serif: true, lineHeight: 1.75, fontSize: 19 },
] as const;

// 分享画布独立于宿主主题；这些规则只装入本次会话的隔离文档。
export function shareCardStyles(id: ShareCardTemplateId): string {
	const t = SHARE_CARD_TEMPLATES.find(template => template.id === id)!;
	return `
* { box-sizing:border-box; }
html, body { margin:0; padding:0; width:390px; }
.share-card { width:390px; padding:36px 32px; background:${t.background}; color:${t.foreground};
 font:${t.fontSize}px/${t.lineHeight} ${t.serif ? '"Songti SC", "Noto Serif CJK SC", "SimSun", serif' : '-apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei", sans-serif'};
 overflow-wrap:anywhere; line-break:strict; }
p, ul, ol, blockquote, pre, table, hr { margin:0 0 18px; }
.content > :last-child, li > :last-child, blockquote > :last-child { margin-bottom:0; }
p { white-space:pre-wrap; }
h1,h2,h3,h4,h5,h6 { margin:24px 0 16px; line-height:1.4; }
h1 { font-size:1.6em; } h2 { font-size:1.4em; } h3 { font-size:1.2em; } h4,h5,h6 { font-size:1em; }
.content > :first-child { margin-top:0; }
ul,ol { padding-left:1.5em; } li { margin:6px 0; }
blockquote { margin-left:0; margin-right:0; padding:8px 0 8px 16px; border-left:3px solid ${t.line}; }
.callout { padding:14px; background:${id === "nocturne" ? "#303134" : "#ECEBE4"}; border-color:${t.accent}; }
.callout-title { font-weight:600; margin-bottom:8px; }
.link { color:${t.accent}; text-decoration:underline; text-decoration-thickness:1px; }
mark { color:inherit; background:${id === "nocturne" ? "#60513B" : "#E8DDBB"}; }
pre,code { font-family:ui-monospace, "SFMono-Regular", Consolas, monospace; font-size:.82em; white-space:pre-wrap; overflow-wrap:anywhere; word-break:break-word; }
pre { padding:14px; background:${id === "nocturne" ? "#303134" : "#ECEBE4"}; } pre code { font-size:inherit; }
table { width:100%; border-collapse:collapse; table-layout:fixed; font-size:15px; }
th,td { border:1px solid ${t.line}; padding:7px; text-align:left; overflow-wrap:anywhere; }
img { display:block; max-width:100%; height:auto; margin:18px auto; object-fit:contain; }
.hero { display:block; width:390px; max-width:none; margin:-36px -32px 30px; }
.meta { font:13px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; color:${t.muted}; }
.share-brand { margin-top:24px; text-align:center; font:400 12px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; color:${t.muted}; }
.paper-time { margin-bottom:28px; }
.editorial-time { border-top:1px solid ${t.line}; margin-top:24px; padding-top:14px; }
.source { margin-top:24px; }
.date-head { text-align:center; margin-bottom:28px; color:${t.accent}; }
.date-day { font-size:76px; line-height:1; }
.date-month { font-size:18px; margin-top:10px; }
.date-detail { margin-top:6px; }
.date-head:after { content:""; display:block; width:48px; height:1px; background:${t.line}; margin:24px auto 0; }
.task { font-family:-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; margin-right:8px; }
hr { border:0; border-top:1px solid ${t.line}; }
`;
}
