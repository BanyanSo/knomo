# Catalog v2 用户旅程与文案

## 1. 展示原则

- 正常升级不展示向导、确认卡或完成卡，用户打开 Knomo 后直接记录和浏览。
- 首页最近内容、输入框和保存操作不等待全历史准备。
- 后台状态只在用户请求尚未覆盖的历史范围时轻量出现。
- 只有具体 memo 的身份或来源存在歧义时，才限制该条记录的身份操作。
- 技术详情只进入开发诊断，不进入 Notice、设置、按钮、空状态或错误文案。
- 文案不得要求用户确认其他设备版本，不提供“是否清理旧数据”选择。
- 英文 UI 使用 sentence case。

用户可见文案不得出现以下词语：

- `index`
- `JSON`
- `Catalog`
- `Identity`
- `migration package`
- `compatibility mode`
- “请确认所有设备已升级”
- “是否清理旧数据”

## 2. 冻结文案

| key | 使用条件 | 中文 | English |
|---|---|---|---|
| `history.preparing` | 用户进入尚未完整覆盖的历史页面 | 正在准备历史记录 | Preparing history |
| `history.partial` | 搜索、统计或回看结果 coverage 不完整 | 历史记录正在准备，当前显示已可用的内容。 | History is still being prepared. Available entries are shown. |
| `history.awaitingSync` | 所需状态或历史分片未到齐 | 历史记录尚未全部同步 | Some history has not synced yet |
| `memo.awaitingDetails` | 用户对受影响 memo 执行身份操作 | 正在同步这条记录的关联信息，请稍后重试。 | Details for this entry are still syncing. Try again shortly. |
| `memo.sourceAttentionTitle` | 单条 memo ambiguous | 这条记录的来源需要确认 | This entry's source needs confirmation |
| `memo.sourceAttentionBody` | ambiguous 详情 | 正文仍可查看，但编辑、删除、引用和回顾暂不可用。 | You can still view this entry, but editing, deleting, referencing, and review are temporarily unavailable. |
| `save.dailySucceededMonthlyPending` | Daily 成功，Monthly 失败或排队 | 正文已保存，月度归档稍后更新。 | Your entry is saved. The monthly archive will update later. |
| `history.unavailable` | IndexedDB 不可用且当前操作需要历史 | 历史记录暂不可用 | History is temporarily unavailable |
| `history.unavailableBody` | 上述状态解释 | 你仍可以记录和查看当前日记，历史功能会在本机数据恢复后可用。 | You can still capture and view the current daily note. History will return after local data is rebuilt. |
| `history.rebuildLocal` | 设置中的安全动作 | 重建本机历史 | Rebuild history on this device |
| `history.viewAffected` | 存在具体 attention 记录 | 查看受影响的记录 | View affected entries |
| `monthly.retry` | Monthly 有明确失败 | 重试月度归档 | Retry monthly archive |
| `purge.disclosure` | 永久删除确认 | 此操作会从 Knomo 中永久删除这条记录；同步服务或回收站仍可能保留历史版本。 | This permanently removes the entry from Knomo. Your sync service or trash may still retain earlier versions. |

当历史准备完成、同步分片到齐、ambiguous 被解决或 Monthly 重试成功时，不显示“升级完成”消息；对应轻量状态直接消失。

## 3. 老 Vault 首次打开

### 前置

- 存在旧 index 和多年 Daily。
- 尚无完整 v2 本地历史。

### 必须旅程

1. Knomo 先注册轻量事件、打开本机缓存并加载最近可用 observations。
2. 输入框立即可用；不弹迁移向导或清理确认。
3. 最近 feed 中 identified、observed 和 ambiguous 保持同一 createdAt 顺序。
4. 用户停留首页时不主动展示内部准备状态。
5. 用户进入超出 coverage 的搜索、统计或回看页面时，页面内显示 `history.preparing`/`history.partial`，已找到结果仍可交互。
6. 后台工作被挂起或应用退出后，下次从 checkpoint 继续，不重新阻塞首页。

## 4. 准备期间快速记录

1. 用户提交正文。
2. 本机 Pending 和 create intent 都是尽力写入，不得阻止 Daily。
3. Daily 成功并重新解析后，立即显示新卡片并反馈保存成功。
4. identity 或 Monthly 暂未 durable 时，新卡片仍可查看、复制和打开 Daily。
5. Monthly 失败只显示 `save.dailySucceededMonthlyPending`，不得显示保存失败。
6. outbox 在后台和重启后续跑；identity durable 后自动开放引用、删除和 review。

## 5. 手写 Daily memo

1. 文件事件只重解析该 Daily，正文立即以 observed 卡片显示。
2. 浏览、搜索、统计、复制、打开 Daily 和打开链接保持可用。
3. 如果用户首次执行编辑、任务勾选、删除、引用或 review，系统先重读当前 Daily 与 state。
4. 满足唯一、安全 adoption 条件时，内部创建 memoId 后继续原动作；用户不需要单独确认技术概念。
5. 仍在等待相关数据时，保留正文并显示 `memo.awaitingDetails`。
6. 历史扫描发现的未绑定内容不批量 adoption。

## 6. 单条来源歧义

1. ambiguous 卡片保持在原 feed 位置，正文和图片正常显示。
2. 非身份动作继续可用。
3. 身份动作显示 `memo.sourceAttentionTitle` 与 `memo.sourceAttentionBody`，焦点移动到解释区域或明确操作。
4. “查看受影响的记录”只列出具体记录，不展示内部文件路径。
5. 解决动作只允许绑定一个候选、将两个 observation 拆分为不同 memo，或保持只读；不得提供“按最新时间自动覆盖”。
6. 解决前不得编辑、删除、恢复、purge、创建引用或写 review event。

## 7. 同步等待

### Daily 先到

- 内容先以 observed 显示。
- 首页不显示全局错误。
- 用户触发身份动作时显示 `memo.awaitingDetails`。
- state 到达后自动升级为 identified，不改变卡片顺序或正文。

### State 先到

- 只保存 missing binding，不显示旧正文，不自动删除。
- Daily 到达并唯一匹配后自动补齐卡片。

### Commit 先到

- 已有完整 generation 继续可用。
- 新 generation 保持等待，不显示内部缺片名称。
- 只有用户请求受影响历史或动作时显示 `history.awaitingSync`。

## 8. 本机历史不可用

1. IndexedDB blocked、损坏或打开失败时，输入框、当前 Daily 与最近有界内存范围继续可用。
2. 不回退旧 index，不加载全历史到内存，不写 Daily 或同步状态。
3. 需要完整历史的页面显示 `history.unavailable` 和 `history.unavailableBody`。
4. 设置中仅提供 `history.rebuildLocal`；动作只删除/重建本机 Catalog，不改变 Daily、memoId、同步状态或 Monthly。
5. 重建期间沿用“老 Vault 首次打开”旅程。

## 9. 删除、恢复与永久删除

### 删除

1. 先持久化并验 hash 删除 payload。
2. 再修改当前 Daily block。
3. 最后提交 delete event 和异步 Monthly 更新。
4. payload 失败时不得删除 Daily；Daily 失败时保留 payload 供重试或精确清理。
5. edit/delete 并发进入单条 lifecycle conflict，不按设备时间决定。

### 恢复

1. 用户选择一个明确 delete 版本。
2. 恢复正文写回 Daily 并重新解析。
3. 使用同一 memoId 写 restore/rebind。
4. 重复同一恢复幂等；不同正文版本要求选择。

### 永久删除

1. 确认框展示 `purge.disclosure`。
2. purge 只指向一个明确 `deleteOpId`。
3. 当前和晚到 payload 最终都被精确清理。
4. 不承诺删除同步服务或 Obsidian 回收站的历史版本。

## 10. 设置与维护入口

设置中只保留面向结果的动作：

- `重建本机历史`
- `查看受影响的记录`
- `重试月度归档`
- 具体已删除 memo 的恢复或永久删除
- 具体 ambiguous memo 的绑定或拆分

以下旧入口必须在对应功能切换完成后移除：

- 旧 memo-index 修复或全量重建
- 手动清理旧 index
- “完成升级并保留原样”
- Catalog 整理完成状态
- 要求用户判断底层文件的错误提示

## 11. 无障碍与窗口兼容

- 所有交互元素可通过键盘到达；icon button 必须有 `aria-label` 和 tooltip。
- 动态状态用适当的 live region 宣布，但后台进度不得高频播报；同一文案变化至少去重。
- ambiguous 解释区使用可感知标题，并把被禁用动作的原因关联到按钮。
- focus 不得因 observed 自动升级 identified 而丢失或跳回页面顶部。
- 按钮和可点击目标至少 44×44px，并保留 `:focus-visible`。
- DOM 事件通过 owning component/plugin 的 `registerDomEvent()` 注册。
- popout window 中使用元素的 `ownerDocument` 或 `activeDocument`/`activeWindow`，不得依赖全局 `document`/`window`。
- 设置窗口若需更新主 workspace，使用 `this.app.workspace.containerEl.ownerDocument`。
