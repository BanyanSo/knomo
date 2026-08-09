# Catalog v2 验收清单

## 1. 使用规则

- 本文件冻结验收目标，不表示未实现功能已经通过。
- 只有自动化测试、可复现 fixture 或真实设备记录提供证据后才能勾选。
- 每个勾选项必须在阶段提交说明中链接测试名、fixture ID 或设备 result JSON。
- 不得通过保留旧 index fallback、dual read 或 dual write 让条目通过。
- 任一 P0/P1 数据完整性问题会使当前阶段和发布 gate 失败。

## 2. 全局数据不变量

- [ ] `INV-01` 只读 parse、Catalog rebuild 和 migration 前后全部 Daily 二进制 SHA-256 相同。
- [ ] `INV-02` 不向 Daily、memo block、frontmatter 或 HTML 注释添加身份字符。
- [ ] `INV-03` 所有既有 memoId 数量和值逐字保留；新 memoId 至少 128 bit 随机熵。
- [ ] `INV-04` active、deleted、relation、review ordinal、pending 逐项对账。
- [ ] `INV-05` 一个当前 observation 最多绑定一个 canonical memoId；非一对一结果为 ambiguous。
- [ ] `INV-06` ambiguous 不触发自动编辑、删除、恢复、purge、引用、review、合并或覆盖。
- [ ] `INV-07` Catalog 删除、损坏和重建不改变 Daily、memoId、同步状态或 Monthly。
- [ ] `INV-08` 旧 index 缺失或不可读时，已切换的生产功能继续工作。
- [ ] `INV-09` Monthly 删除可由 Daily 重建，且 Monthly 从不成为正文或身份来源。
- [ ] `INV-10` state segment 缺失、损坏或乱序不会隐藏 Daily 内容。
- [ ] `INV-11` 文件暂时缺失、rename 或 coverage partial 不产生隐式 delete。
- [ ] `INV-12` Daily 成功后，state/Catalog/Monthly 失败不显示正文保存失败。
- [ ] `INV-13` snapshot/compaction 不丢 opId digest、tombstone、冲突证据或不可重建状态；segment 乱序退场只降低 capability。

## 3. 每个功能的通用上下文

第 4–7 节每个功能至少在适用时覆盖：

- [ ] 新 Vault。
- [ ] 老 Vault 首次启动。
- [ ] `v2_ready` 且 Catalog partial。
- [ ] `committed`。
- [ ] `legacy_retired`。
- [ ] identity `awaiting_data`。
- [ ] 单条 ambiguous。
- [ ] Desktop 键盘路径。
- [ ] 移动端窄屏、触摸与键盘路径。

## 4. 核心记录与卡片

### `FEAT-01` 快速新建

- [ ] 输入框不等待全历史，可按当前稳定交互提交。
- [ ] 两端并发同时间同正文使用不同高熵 memoId。
- [ ] 只重解析当前 Daily；不加载全库。
- [ ] Pending/create-intent 失败仍可保存正文并显示 observed。
- [ ] Daily 成功、Monthly/state 失败显示“正文已保存，月度归档稍后更新。”。
- [ ] 不写旧 index，不向正文添加身份标记。

### `FEAT-02` 首页最近流

- [ ] 数据来自 Catalog `byCreatedAt`，正文来自当前 Daily observation。
- [ ] identified、observed、ambiguous 在同一稳定顺序 feed。
- [ ] Daily 先到时 observed 立即显示，identity 到达只更新 capability，不改变顺序。
- [ ] 最近 7/30 天优先，每页 30–50 条，不全量水合。
- [ ] 暖/冷启动达到 [performance-benchmark.md](performance-benchmark.md) 门槛。

### `FEAT-03` 打开 Daily

- [ ] 使用当前 observation path、line 和 revision，O(1) 查询。
- [ ] rename/move 后能打开正确文件和位置。
- [ ] stale revision 先重解析，不跳到错误 block。
- [ ] observed/ambiguous 也可打开。

### `FEAT-04` 编辑

- [ ] 使用 durable handle 和 source revision；活动文件走 Editor API，后台文件走 `Vault.process()`。
- [ ] stale revision 重新解析；非唯一时 ambiguous，不静默覆盖。
- [ ] 只读写一个 Daily 文件；旧 index 缺失仍可编辑。
- [ ] observed 只在安全 adoption 后重试；awaiting/ambiguous 不修改正文。
- [ ] edit/edit 冲突不由 state 日志覆盖 Daily。

### `FEAT-05` 任务 checkbox

- [ ] 与编辑共享 handle/revision 约束，只改目标 task marker。
- [ ] 不刷新全 feed、不重扫全库，DOM 立即反馈与失败回滚正确。
- [ ] fenced code 中 task-like 文本不可被勾选。
- [ ] 并发任务变化按 Daily 冲突处理。

### `FEAT-06` 复制、链接与图片入口

- [ ] 只读 observation 正文和派生引用，不依赖 memoId。
- [ ] observed/ambiguous/awaiting_data 均可复制、打开链接和预览图片。
- [ ] 图片延迟加载、有限并发，离开视口释放 UI 资源。

## 5. 搜索、筛选与浏览

### `FEAT-07` 关键词搜索

- [ ] 使用 IndexedDB normalized text/token 索引和 cursor，不扫描全部 partition。
- [ ] 输入 debounce；Query API 首批 P95 达标。
- [ ] coverage partial 显示冻结文案并返回已知结果，不伪造 complete/空结果。
- [ ] snapshot 失效后透明续接，不重复或漏掉稳定结果。

### `FEAT-08` 标签与置顶标签

- [ ] 使用 `byTag` 和 display map，tag count 增量维护。
- [ ] 不反序列化全部 memo；置顶标签设置保持现有语义。
- [ ] Unicode、大小写与 display candidate 结果保持稳定版兼容。

### `FEAT-09` 无标签、链接、图片筛选

- [ ] 使用布尔/多值索引，不加载图片 blob。
- [ ] fenced code 中伪 link/image 不进入结果。
- [ ] 单文件变更只更新该文件记录和计数。

### `FEAT-10` 日期范围与纪念日

- [ ] 使用 `byCreatedAt`/logicalDate range cursor。
- [ ] 自定义 Daily 日期格式、locale 和时区保持当前 logical date 语义。
- [ ] 同时间/同正文记录均保留，稳定 tie-break 不依赖 identity 状态。

### `FEAT-11` 无限滚动

- [ ] 使用 query snapshot + stable cursor，每页有固定上限。
- [ ] UI 常驻对象不超过当前页及前后各一页。
- [ ] 数据变化导致 snapshot 失效时透明续接，不返回假空页。

### `FEAT-12` 移动端搜索页

- [ ] 与 Desktop 共享 Query API，不通过 `MobileMemoHydrator` 全量加载 period。
- [ ] 页面关闭释放结果、渲染队列和图片资源。
- [ ] 搜索、筛选、关闭和分页可用键盘/读屏完成。

## 6. 回看与统计

### `FEAT-13` 记录统计

- [ ] 使用 per-day/per-file incremental aggregate，不构造 30k `MemoRecord[]`。
- [ ] 修改一个 Daily 只重算该日/文件。
- [ ] 统计可从 observations 重建，不同步统计结果。

### `FEAT-14` 统计下钻

- [ ] 与首页共享 Query snapshot，趋势/时段/标签点击直接分页查询。
- [ ] coverage 状态与统计汇总一致，不把 partial 数值显示为完整总量。

### `FEAT-15` Random Reunion

- [ ] 从 Catalog 候选索引抽样，不先 `loadAll()`。
- [ ] v2 review opId 集合并集；旧 review ordinal 无损导入。
- [ ] reviewCount 为唯一事件数，lastReviewedAt 取最大有效时间。
- [ ] observed/ambiguous 可浏览；只有 durable identity 能记录 review。

### `FEAT-16` 往日漫游 / Shuffle Day

- [ ] 使用 logicalDate/day aggregate 按天选择，不加载全库。
- [ ] 抽取历史保持设备本地，不要求多端一致。
- [ ] 当天统计增量读取，历史 coverage partial 有明确状态。

### `FEAT-17` Time Buoy

- [ ] 事实来自 Daily `@date` 标记，本机日期索引可删除重建。
- [ ] 旧 Time Buoy JSON 不迁移，退场后结果一致。
- [ ] 今日优先、重建可取消/续跑；移动端 onload 不全量重建。
- [ ] fenced code、路径、URL、邮箱和文件名中的伪日期保持现有排除语义。

## 7. 生命周期、引用与维护

### `FEAT-18` 删除

- [ ] 先写并验 hash deleted payload，再改 Daily，最后写 delete event。
- [ ] payload 失败不删除正文；Daily 失败不伪报删除成功。
- [ ] delete/edit 并发进入 lifecycle conflict，不按时钟覆盖。
- [ ] 旧 index 不存在仍可删除。

### `FEAT-19` 回收站

- [ ] 数据来自 Lifecycle materialized view，分页读取，不构造旧 MemoRecord 列表。
- [ ] 每个 delete payload 按 deleteOpId 独立保留并可识别版本。
- [ ] payload 缺失显示受影响记录，不显示旧正文快照。

### `FEAT-20` 恢复

- [ ] 用户选择明确 delete 版本，正文写回 Daily 后 rebind 同一 memoId。
- [ ] 同一恢复幂等；不同正文版本要求选择。
- [ ] Monthly 异步更新，失败不回滚已恢复 Daily。

### `FEAT-21` 永久删除

- [ ] 显式 purge 只引用一个 deleteOpId。
- [ ] purge 先到或 payload 晚到最终精确清理。
- [ ] 显示同步服务/回收站可能保留历史版本的冻结文案。
- [ ] 不影响同 memo 的其他 delete 版本或当前 active observation。

### `FEAT-22` 引用卡片

- [ ] 保持当前 Markdown 引用格式和解析兼容，不引入新公开格式。
- [ ] `sourceMemoId` 保存在外部 relation state。
- [ ] 创建引用不得为身份识别修改 Daily 或添加 marker。
- [ ] 并发不兼容 source 进入 attention，不猜测。

### `FEAT-23` 手写、移动、重命名 Daily

- [ ] FileWatch 合并同 path 连续事件，只重解析受影响文件。
- [ ] 内容立即可见；唯一时 rebind，非唯一时 ambiguous。
- [ ] 缺失不自动 delete，rename 后无旧 path 幽灵 memo。

### `FEAT-24` Monthly

- [ ] 每设备同 path 串行，受影响 period 增量投影。
- [ ] 相同输入逐字节相同且有稳定 semantic hash；相同 hash 不写文件。
- [ ] coverage incomplete 不全量覆盖月份。
- [ ] 冲突副本只由完整 Daily 月 snapshot 收敛，不反向改变 Daily/identity/lifecycle。
- [ ] Daily 保存不等待 Monthly；移动端 onload 不重建历史 Monthly。

### `FEAT-25` 旧 Daily 内容导入

- [ ] 与旧 index 升级完全分离，保留现有预览/确认旅程。
- [ ] 通过统一 Daily write gateway 写入并生成 v2 状态。
- [ ] 不因内容导入重新启用 legacy runtime。

### `FEAT-26` 重建本机历史

- [ ] 只删除/重建本机 Catalog，不修改 Daily、memoId、同步 state 或 Monthly。
- [ ] 不重建或重新创建旧 index。
- [ ] 过程中快速记录和最近范围可用，支持暂停/续跑。

### `FEAT-27` 设置变更

- [ ] parser/settings fingerprint 精确失效受影响 partition。
- [ ] Daily 路径/heading 变化不全库盲扫无关文件。
- [ ] systemDataRoot 不随 Monthly 文件夹隐式移动。
- [ ] 多候选 systemDataRoot 进入诊断，不创建第二身份域。

## 8. 升级与故障注入

- [ ] `UP-01` 同一 legacy artifact 两设备独立导入产生相同 package bytes/hash。
- [ ] `UP-02` canonical 与多个冲突副本逐 digest inventory，不先选“最新”。
- [ ] `UP-03` 局部损坏 JSON 产生 attention/quarantine，不伪报 complete、不提前清理。
- [ ] `UP-04` package 写失败可重入，不写 commit。
- [ ] `UP-05` commit 写失败可重入，generationDigest 稳定。
- [ ] `UP-06` commit 后立即退出，冷启动重新验 required set。
- [ ] `UP-07` commit 先到/required 后到保持 awaiting_data，内容可见。
- [ ] `UP-08` 旧 index 删除先到/package 后到不产生重复 memoId。
- [ ] `UP-09` 晚到旧 artifact 形成输入并集的新 generation 并重置 quiet window。
- [ ] `UP-10` 24 小时 settlement 期间 outbox/queue 为空且 required hash 再验通过。
- [ ] `UP-11` cleanup 每个文件使用精确 path+digest+receipt+class，并调用 `FileManager.trashFile()`。
- [ ] `UP-12` cleanup 中断/单文件失败只重试未完成项，不递归删除目录。
- [ ] `UP-13` 回收站恢复旧 index 只触发幂等 inventory/退场，不恢复旧 runtime。
- [ ] `UP-14` 旧 index 自动退场前后全部功能结果一致。
- [ ] `UP-15` compaction commit/snapshot/segment 删除任意乱序都可恢复；缺片不重建 memoId。

每个故障注入还必须证明：Daily 未改、已完成步骤可重入、未完成步骤未标记完成、用户仍能记录和查看当前内容、未生成重复 memoId。

## 9. 架构守卫

- [ ] `GUARD-01` v2 production modules 禁止 import `MemoIndexStore`。
- [ ] `GUARD-02` legacy importer 禁止调用 legacy path 写 API。
- [ ] `GUARD-03` Catalog builder 禁止调用 Editor、`Vault.modify/process` 或文件删除 API。
- [ ] `GUARD-04` Monthly projector 禁止成为正文或身份读源。
- [ ] `GUARD-05` 用户文案禁止内部术语，并校验中英文 key parity。
- [ ] `GUARD-06` cleanup 只接受编译期 allowlist class 和 verified receipt。
- [ ] `GUARD-07` query/performance path 禁止 `loadAll()` 或等价全库数组。
- [ ] `GUARD-08` ID、segment、package 和 commit 遵守协议格式与 digest 规则。
- [ ] `GUARD-09` icon button、键盘、焦点、44px touch target 和 popout window 兼容通过。
- [ ] `GUARD-10` compaction 只覆盖连续、无冲突 segment，并在冷启动、hash 和 quiet-window gate 后精确 trash。

## 10. 阶段 gates

### 阶段 0

- [x] 协议、状态机、Schema、allowlist、文案、fixture、性能设计和验收矩阵已冻结。
- [x] 未实现运行时代码，未修改基线业务文件。

### 阶段 1：只读 Parser 与 Local Catalog shadow

- [ ] `PARSE-*`、`DAILY-RENAME/MOVE`、`CATALOG-OFFLINE-CHANGES`、`IDB-*`、`MOBILE-BACKGROUND-RESUME` 通过。
- [ ] 扫描前后 Daily 字节完全一致，IndexedDB 可删除/损坏重建。
- [ ] 最近首屏、query、分页和 PERF-30K 达标；shadow off 时稳定行为零变化。

### 阶段 2：v2 state 与 Legacy importer

- [ ] `LEG-*`、`LEGACY-*`、`STATE-REVIEW/PENDING/SNAPSHOT`、`SYNC-WRITER/OPID/COMPACTION` 通过。
- [ ] package/manifest Schema、自定义不变量和确定性字节测试通过。
- [ ] 原 memoId 与不可重建字段全部对账；3 万身份启动只增量回放。

### 阶段 3：Resolver 与生命周期

- [ ] `STATE-*`、`SYNC-DAILY/CREATE/EDIT/RESTORE/RELATION` 通过。
- [ ] create/edit/task/delete/restore/purge 的 Daily 成功边界通过。
- [ ] ambiguous 和 awaiting_data 不误改正文，outbox 重启续跑。

### 阶段 4：功能查询切换

- [ ] `FEAT-01` 至 `FEAT-27` 按既定顺序逐项完成 gate。
- [ ] 每个已切功能只有一个生产读取源，不适配回旧全能 MemoRecord。
- [ ] 旧 index 缺失、coverage/degraded 和移动端专项回归通过。

### 阶段 5：Monthly 与迁移提交

- [ ] `SYNC-MONTHLY-CONFLICT`、`MIGRATION-*`、`CLEANUP-*` 和 `UP-*` 通过。
- [ ] commit/package/delete 乱序、多端确定性输出、冷启动和 settlement 通过。
- [ ] 自动清理前后功能一致，晚到旧文件可再次幂等退场。

### 阶段 6：发布级验收

- [ ] Desktop + Desktop。
- [ ] Desktop + iOS。
- [ ] Desktop + Android。
- [ ] iOS + Android。
- [ ] 在线交错、短时离线、并发写、同步乱序、冲突副本、后台挂起和强制结束通过。
- [ ] 老 Vault 一步升级、旧 index 退场后 soak、真实设备 PERF-30K 通过。

## 11. 公开发布 gate

- [ ] 老用户核心旅程无需升级操作。
- [ ] 所有功能在旧 index 不存在时通过。
- [ ] 30k memo 发布阈值全部通过并保留 raw results。
- [ ] 没有 Daily 内容字节迁移或身份 marker。
- [ ] 没有生产 dual write/dual read。
- [ ] 没有用户可见底层数据术语。
- [ ] 没有 P0/P1 数据完整性问题。
