# Memo 时间前缀与 Markdown 语义样例

`history.ts` 冻结两个独立提交的 writer 及该提交依赖的实际输出，每个提交包含 25 类正文及有／无主 ID 两种 raw，共 100 份。来源为已发布 `06fd44f564b2e9ada0c0e9e5f857146e12c050cf` 和实施前基线 `74aa77c8cafedd4259fab282695a446922dbbe07`；测试不调用 Git、历史 writer 或本地设计资料来重新生成历史字节。

`targets.ts` 是逐项核对后固定的本轮目标 raw，category 与 history 一一对应。读取正文仍为 history 中的 content，时间精度为 `HH:mm:ss`，主 ID 为 `memo-anchor`。`MemoMarkdownSemantics.test.ts` 检查实际 raw、读取正文、完整范围、ID 源位置和任务源行；既有结构测试、链路测试和固定历史样例分别提供其他证据，HTML 字符串相等不是唯一依据。

| 类别 | 稳定样例名 | 本轮前缀 | 布局／锚点与例外 |
|---|---|---|---|
| 01 | plain | 两列 | 普通正文紧凑；主 ID 在首段末尾 |
| 02 | quote | 两列 | 无新增空行；显式主 ID 在独立时间头 |
| 03 | nested-list | 两列 | 保留列表层级 |
| 04 | tasks | 两列 | 保留 checkbox 实际源行 |
| 05 | atx | 两列 | 标题独立；保留用户已有空行 |
| 06 | fence | 两列 | 围栏内伪时间不成为 Memo |
| 07 | prose-tab | 两列 | 保留普通字面 Tab |
| 08 | literal-tab-fence | 两列 | 保留代码字面 Tab |
| 09 | tab-list | 两列 | 保留结构 Tab 及嵌套 |
| 10 | multiline | 两列 | 主 ID 在原首段末尾；保留两空格及反斜杠换行 |
| 11 | prose-table | 两列 | 复用正文已有段落边界 |
| 12 | table | 四列保留 | markdown-it 无空行也识别表格，Lezer 不识别；Obsidian 1.15.0 实测两列无分隔行不成表格，保留既有表示 |
| 13 | indented-code | 四列保留 | 需要段落边界；新增两列分隔行会成为历史逻辑正文，按默认空白契约暂缓 |
| 14 | setext | 四列保留 | 分开时间和标题；同上历史空白歧义 |
| 15 | ordered-three | 四列保留 | 非 1 起始列表需要边界；同上历史空白歧义 |
| 16 | dash-rule | 四列保留 | 防止时间成为 Setext 标题；同上历史空白歧义 |
| 17 | custom-html | 四列保留 | 独立 HTML 块需要边界；同上历史空白歧义 |
| 18 | anchored-quote | 两列 | 主 ID 在时间头，Callout 原文保留；Desktop 1.15.0 跳转／嵌入范围已验，移动端待验 |
| 19 | anchored-tasks | 两列 | 同上；checkbox 偏移由实际源行验证 |
| 20 | child-anchor | 两列 | 无主 ID 时末项仍是兼容关系入口，ID 留在可见正文；有主 ID 时首段优先 |
| 21 | trailing-spaces | 两列 | 精确移除 ID token 和一个分隔空格，不吞其他空白 |
| 22 | tab-quote-code | 四列保留 | `>\t\tcode` 平移两列时，代码由两个前导空格变为零；真实 Tab 停靠差异 |
| 23 | indented-tab-fence | 四列保留 | 三空格围栏与 Tab 的去缩进结果不同；保留代码字面内容 |
| 24 | leading-blank-table | 两列 | 原有前导空行完整保留，不新增或裁剪 |
| 25 | references | 两列 | 链接、目标 ID、alias 及任务原样保留 |

四列不是 ID 归属协议。13—17 保留四列的原因是本轮明确采用的历史空白兼容契约；语法只要求段落边界，没有要求四列。补充的裸 `^ID`／可见首段 ID 碰撞输入同样采用既有分隔表示，避免把输入内容变成隐式字段。

历史 `- 12:34 body\n\n  outside` 的 occurrence 仍止于 body。已有缩进空行属于原范围；编辑、snapshot-first 删除和 restore 不扩展到 outside，也不通过 Catalog、内存或空白编码新旧布局。

## 宿主与跨版本验收状态

2026-11-08 后续已在指定测试库执行 Obsidian Desktop 1.15.0（installer 1.15.0）、Paper Blue 亮色宿主验证。测试库加载的三份产物与本轮 dist 字节一致；没有修改产品实现。iOS、Android 未执行实机验收。

| 平台 | 阅读视图 | Live Preview | 原生跳转、嵌入覆盖范围、metadata 位置 |
|---|---|---|---|
| Obsidian Desktop 1.15.0 | 25 类已验 | raw 与块组件对照已验；表格编辑待实操 | 25 类 metadata 源范围、4 个跳转、12 组嵌入已验 |
| iOS | 待验 | 待验 | 待验 |
| Android | 待验 | 待验 | 待验 |

宿主验证不是整体通过：时间行末带空格、正文下一行带首段 ID 的旧式布局（固定最小串 `"- 09:00 \n  text ^legacy-leading-space"`）读为前导逻辑空行，但无改动保存被锚点保护拒绝；实际 2025-06 Monthly 因此 failed。Daily 与旧 Monthly 保留，记为 F1 FAIL；本次仅记录，没有新增修复。直接调用活动阅读视图删除还出现落盘未确认，安全失败保留快照，完成路径记为 INCONCLUSIVE。正常 Knomo 活动路径的删除／恢复通过。

有效视图结果来自非空原生渲染；最初单 eval 循环的空 DOM 比较没有计入。详细证据保留在本地 `.tmp/obsidian-prefix-verification-20261108/11-final-host-verification.json`，不作为测试执行依赖。移动端优先核对 12 的表格、18—21 的引用范围、代码／硬换行、重复保存和 Trash 实际落盘。

历史 1.14.5 基线会将新两列独立头的 ID 读入正文；新旧插件混用不具有双向读写兼容保证。本轮验证新实现重新读取两种历史提交的 raw，没有增加迁移、双写或格式标记。
