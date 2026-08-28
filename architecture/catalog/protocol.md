# Catalog 架构协议

## 1. 状态与命名

本文件描述 Knomo 当前唯一的 Catalog 架构。对外已发布基线是 `1.2.9`，该版本只有 Daily、Monthly 和 `_knomo-system` 下的旧 Memo Index，不包含 Catalog 协议。

业务模块、类型、配置键和存储目录使用稳定语义名，不使用开发阶段编号：

- `CatalogIndexCoordinator`：维护本机可重建索引；
- `CatalogReadService`：组合 Catalog observation 与 Identity Ledger；
- `MemoCommandService`：协调 Daily 正文与身份增强操作；
- `DailyMemoWriteGateway`：提交带 revision 校验的 Daily 修改；
- `MonthlyProjection`：从 Daily 派生月度投影。

当前 Catalog 新增的 Identity Ledger 与共享配置协议不携带开发期版本字段，也不兼容未发布的开发快照。IndexedDB database version 只用于本机数据库技术升级，不代表共享协议版本。

## 2. 数据边界

### 2.1 Daily 是正文真相

- memo 正文只以 Daily 文件中的 Markdown block 为准；
- 在符合 Daily 路径规则的文件中，根区域及任意 H1～H6 标题下的顶层 `- HH:mm 正文`、`- HH:mm:ss 正文` 都是 memo；最近标题只作为 `section` 保存，不参与识别；
- 时间 memo 可以包含缩进续行，但 YAML frontmatter、fenced code block、嵌套列表、blockquote、task、非法时间和没有正文的空时间行不识别；相同时间或正文的记录不得去重；
- `dailyHeading` 只决定新建与无可用原 section 时的写入位置，修改它不得改变历史 memo 的识别范围或触发全库重扫；
- Catalog、Identity Ledger 或 Monthly 都不能隐藏 Daily 中真实存在的 observation；
- 普通 create、edit、task、copy、move、remove 和 restore 不得写入内部 ID、HTML comment、frontmatter 或隐藏字符；
- 只有用户显式创建 Obsidian block reference 时，才允许把 block ID 作为用户正文写入。

### 2.2 Catalog 是本机派生缓存

- Catalog 存储在本机 IndexedDB，可随时删除并从 Daily 重建；
- Catalog 保存 observation、搜索字段、过滤字段和聚合，不承担 memo 身份；
- observation 以文件 revision、行范围和 raw block hash 形成写入校验句柄；
- Catalog 不向 Vault 写共享状态，也不作为 Monthly 的主数据来源。

### 2.3 Identity Ledger 是可选增强数据

- `memoId` 是唯一 memo 身份；新记录生成 UUIDv7；
- Identity Ledger 只保存 claim、rebind、relation、review、recoverable delete、restore、purge 和 repair 等不可由正文重建的信息；
- identity 缺失或同步中时，已扫描正文仍可查看和安全编辑；
- 局部冲突只降级相关 memo 的身份能力，不阻断其他 observation；
- Identity Ledger 到达后增强原 observation，不创建第二份正文卡片。

### 2.4 Monthly 是派生投影

- Monthly 直接以实际 Daily 与有效共享配置为输入；
- Catalog 只用于发现待投影范围，不得充当正文来源；
- 投影失败独立标记 stale 或 failed，不改变 Daily 保存结果；
- Monthly 标题及其他 locale 相关输出只使用共享配置中的 `locale`，不得读取设备当前 locale 临时决定；
- 共享 `locale` 缺失或冲突时暂停覆盖 Monthly，直到形成有效共享配置；
- 共享配置只接受当前唯一结构；开发期间产生的旧结构不做降级读取或后继迁移；
- locale 首次取自 Obsidian 当前语言并规范化持久化，之后只有用户显式执行“使用当前 Obsidian 语言”才允许改变；
- Monthly 默认排除规则只在用户从未作出选择时初始化为开启，已有显式设置不得被升级覆盖。
- 启动只把当前月份加入候选队列，不立即重算全部历史月份；Daily 文件的存在只表示月份需要扫描，目标文件不存在时，只有实际解析到至少一条 memo 才允许创建 Monthly；
- 配置变化引发的历史全量投影优先从完整 Catalog 发现实际存在 memo 的月份，并合并已有合法 Monthly；Catalog 尚未完整时保留发现任务，在 Catalog settle 后重试，仍不完整则以 Daily inventory 作为低优先级候选范围；
- Monthly 待处理月份、发现状态和完成摘要保存在本地 Catalog metadata 中；中断或重启后继续未完成队列，该本地 checkpoint 不是 Vault 共享协议或 ownership ledger；
- 同路径文件只有在开头带 `knomo:monthly-archive` marker 时才是可维护的 Knomo Monthly；`1.2.9` 多行 marker 与当前单行 marker 均合法，旧 marker 原文必须保留；
- 同路径文件没有 Monthly marker 时直接保留原文并静默跳过，不解析当月 Daily、不覆盖且不进入失败重试；
- 合法 Monthly 在当月已无 memo 时仍可更新为空投影，普通后台 reconcile 不得删除文件；
- 新建 Monthly 使用单行 `<!-- knomo:monthly-archive -->` marker，后跟使用共享 locale 生成的 `<small>` 只读说明；
- Catalog 与 Monthly 复用同一份按月份分组的 Daily inventory；构建一个月份时只能读取该月份的 Daily，不得重新遍历整个 Vault；
- 当前月和实际变更月份优先于配置变化产生的历史月份队列；每完成一个月份必须让出事件循环；
- Catalog 扫描分片、旧版数据升级和 Monthly 单月投影必须经过同一低优先级串行队列，不能并发争抢 Vault、解析器或主线程；
- 只有 Monthly locale、输出目录、文件名格式、日期标题格式、日期顺序或 Daily 路径范围变化才允许批量失效；`dailyHeading` 等写入位置变化不得使历史 Monthly 失效；
- Monthly 不参与 `memoId` 推断，也不随旧版数据升级完成提示自动删除。

### 2.5 Catalog 读取与全库语义

- 普通列表允许分页或虚拟化，但搜索、标签、统计、往日回顾和全部记录钻取都基于完整 Catalog 逻辑结果，不得只计算当前已加载页；
- 文本搜索保留 `1.2.9` 的子串匹配语义，支持中文、英文和数字；
- 选择父标签时包含其嵌套子标签；
- 并发查询只允许最后一次已发起请求更新界面；翻页必须绑定查询条件和 Catalog revision，不得混入其他查询或静默漏项；
- Catalog 渐进扫描时，依赖全量范围的界面必须展示覆盖范围或未完成状态，不得把部分结果呈现为全库结果。
- `coveredFromDate` 表示从该日期到最新 Daily 的连续覆盖；即使全库仍处于 rebuilding，只要目标日期已落入连续覆盖范围，按日期功能即可使用；
- 时光浮标的今日查询按目标日期 coverage 开放，未来与往日列表允许展示已扫描到的部分结果，并明确标记“部分结果”；

### 2.6 用户交互契约

- 随机重逢候选只允许身份稳定且 review 能力 ready 的 memo；卡片的时间按钮和菜单入口统一执行同一个 Daily 打开操作；
- 随机重逢卡片成功打开并展示后，自动为对应 `memoId` 追加一次 review；打开失败不写 review，同一次打开流程的重复触发不得重复计数；
- Daily 已打开但 review 持久化失败时，必须单独提示回顾状态未保存，不得把已成功的打开显示成失败；随机卡片不再提供手动“标记已回顾”，时光浮标保留该操作；
- 时光浮标是从 Catalog 与 Daily 派生的视图，不提供专属手动重建入口；恢复依赖统一的 Catalog 重扫与状态提示；
- 日期范围、标签和统计钻取产生的结果必须可返回原上下文，且不得因分页改变结果口径；
- 交互控件必须支持键盘操作、可见焦点和可读名称；视图卸载时注销事件监听、定时器和订阅。
- 普通刷新必须比较刷新前后的文件 `sourceRevision`，分别报告新增、更新、删除和失败；`coveredFileCount` 只表示覆盖进度，不得冒充新增数量；
- 卡片流只提示用户能够处理的故障；Catalog、Identity、共享配置、Monthly 和“旧版数据升级”的详细只读运行状态统一在设置页查看。

## 3. 稳定存储路径

所有增强数据只位于用户配置的 Knomo Data Root 内：

```text
<knomoDataRoot>/_knomo-data/identity/
<knomoDataRoot>/_knomo-data/config/
```

路径和事件都不携带协议版本。reader 按当前唯一结构严格校验，插件不得扫描其他目录来猜测数据根。

旧版兼容输入只允许来自：

```text
<knomoDataRoot>/_knomo-system/
```

旧目录是只读迁移源；迁移不得覆盖、追加、移动或删除其中的任何字节。

旧 Monthly 文件同样保留。插件不得自动删除旧 `_knomo-system` 或旧 Monthly 文件；带 `<!-- knomo:monthly-archive ... -->` marker 的 `1.2.9` Monthly 视为合法派生投影并继续维护，没有 marker 的同路径文件始终原样保留。

## 4. 旧版数据升级

当前架构唯一的版本兼容边界是读取 Knomo `1.2.9` 的旧 Index 与插件数据；不得为尚未发布的 Catalog、Identity Ledger 或共享配置开发快照增加版本分支。

“旧版数据升级”是该能力唯一的用户可见名称。其兼容边界只包含 `1.2.9`，升级只执行 `Legacy Index -> Identity Ledger`，不存在中间控制面迁移：

1. `LegacyIndexReader` 从升级前的 `monthlyMemoFolder/_knomo-system` 发现来源，不依赖新 Catalog 数据根已经配置；旧目录不存在时状态为 `not_applicable`；
2. Catalog coverage 未 complete 时状态只显示“等待 Daily 扫描完成”，不得读取旧文件正文、获取全量 observation 或开始身份匹配；
3. Catalog complete 后只建立一次 observation 查找索引，分别使用 `sourcePath + rawBlockHash` 与 `sourcePath + logicalDate + section + time + contentHash` 唯一匹配旧记录；
4. `LegacyIndexMigrationService` 只接受能够由当前 Daily observation 唯一验证的关系；
5. 旧的 16 位数字 `memoId` 原样保留，之后新建 memo 继续生成 UUIDv7；
6. 迁移事件 ID 和内容由来源证据确定，相同输入重复执行不会产生重复事件；
7. 同一 `memoId` 出现不一致同步副本、摘要失败或无法唯一匹配时，只记录诊断并跳过；
8. 只导入旧 `memoId`、relation、review 与 recoverable delete；Memo Summary、Time Buoy、同步冲突派生文件和旧版生成的 backups 只识别、审计，不导入 Identity；合法空 Memo Index 与 Pending Journal 视为已识别输入；
9. 迁移事件分批生成、Identity segment 分批持久化，并在批次间主动让出事件循环；
10. 同一 `sourceRevision` 完成后，普通 Catalog settle 不再读取旧记录或 observation；只有旧源事件、完成条件变化或上次升级未完成时才重试；
11. Daily、旧 Index 和旧插件数据全程只读；Time Buoy 与 Monthly 继续从当前数据重建；
12. 旧来源修订只对规范化后的 memo、pending create 与 review 语义计算；当前插件设置、派生文件、备份及本地提示记录变化不得改变来源修订；
13. 升级前完整审计 `_knomo-system` 文件清单；未知文件进入诊断，不能宣称整个目录可删除；
14. 只有旧目录实际存在、Catalog 与共享配置覆盖完整、升级报告为 ready、来源修订非空、无跳过项或诊断、Identity Ledger 无冲突且持久化内容重读一致，并且二次读取旧来源修订未变化时，才形成清理提示凭据；
15. 清理提示只在 Obsidian 布局就绪后显示，并按来源修订最多记录一次；旧来源语义变化后允许再次提示；
16. 提示只说明用户可在确认所有设备均已升级并完成同步后自行删除旧目录；插件不自动删除目录或旧 Monthly 文件，不提供删除按钮，也不调用文件删除 API。

## 5. 写入顺序

### 5.1 创建

```text
create_intent -> Daily commit -> claim
```

- intent 失败：Daily 仍可保存，返回 identity pending；
- Daily 失败：不得写 claim，未绑定 intent 不产生可见 memo；
- claim 失败：正文保存成功，后续按幂等规则续写身份。

### 5.2 编辑、任务和移动

- 先以 observation revision 校验并提交 Daily；
- 内容层成功后再追加 rebind；
- rebind 失败只标记 identity pending，不回滚已成功正文；
- move 的来源删除失败时，只能回滚未被并发修改的目标；无法安全回滚时保留正文并明确报告 content pending。

### 5.3 可恢复删除与恢复

删除顺序：

```text
delete_payload -> Daily remove -> delete_commit
```

恢复顺序：

```text
Daily restore -> identity restore
```

payload 未持久化时不得删除 Daily。只有 `delete_commit` 完成后记录才进入废纸篓。Daily 删除或恢复已经成功时，后续身份失败只能标记 pending，不得重复正文操作。

### 5.4 废纸篓永久清理

永久清理只作用于已经完成 recoverable delete 的 `memoId`：

```text
purge -> trash read model hide -> discard recoverable payload
```

- purge tombstone 不携带正文，只引用一个已经完成 `delete_commit` 的 `deleteEventId`；identity 冲突、未提交删除或已不在废纸篓的记录不得 purge；
- purge 事件持久化成功前，记录仍可恢复；持久化失败时读模型不得提前移除记录；
- purge 之后对应删除记录不再出现在废纸篓或恢复入口，旧 payload 后到也不得重新显示，重复或并发清理必须收敛；
- 永久清理不得再次修改 Daily，也不得复用已清理的 `memoId`；
- 外部同步使同一正文重新出现在 Daily 时，Catalog 仍按 Daily observation 展示，不得用 purge 隐藏正文；
- “永久”表示 Knomo 不再保留可恢复 payload，不承诺擦除文件系统历史、同步服务版本或用户备份中的字节。

## 6. 失败与重建

- IndexedDB 不可用：切换到最多保留 5000 条 observation 的有界内存 Catalog，并从 Daily 渐进扫描；超限时从最旧文件分区开始淘汰，coverage 同步保持 partial；
- Identity Ledger 不可用：正文能力继续，纯身份操作拒绝或 pending；
- 共享配置缺失：Catalog 可使用本机可用配置扫描并明确范围可能不完整；Monthly 不得基于设备 locale 覆盖已有投影；
- 共享配置冲突：Daily 与 Catalog 继续，Monthly 暂停覆盖；
- 数据根迁移：按 `copy -> verify -> update setting` 执行，旧根保留；
- 任一重建或迁移都不得改变 Daily 字节。
- 插件卸载后不得遗留 Catalog 定时器、Vault 事件或继续发起后台 Catalog 写入。

## 7. 机器可读协议

当前事件 schema 与示例位于：

```text
docs/architecture/catalog/
```

生产入口不得重新引入带开发阶段编号的 Catalog 模块、配置键、数据库名或 Vault 路径。
