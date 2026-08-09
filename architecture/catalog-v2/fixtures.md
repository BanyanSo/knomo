# Catalog v2 fixture 目录

## 1. 目的与形式

阶段 0 冻结 fixture 的场景、输入结构和必须证明的不变量。小型 fixture 在对应实现阶段提交为可读文件；30k memo fixture 使用固定种子按需生成，避免提交大量重复 Markdown。

机器可读目录见 [fixtures/catalog-v2-fixtures.v1.json](fixtures/catalog-v2-fixtures.v1.json)。实现阶段不得删除场景来让 gate 通过；若场景确实不再适用，必须先更新协议和阶段 0 评审记录。

每个可执行 fixture 使用统一结构：

```text
tests/fixtures/catalog-v2/<fixture-id>/
  input/
    vault/...
    plugin-data.json
    device-state-a.json
    device-state-b.json
    delivery-order.json
  expected/
    daily-sha256.json
    observations.json
    migration-summary.json
    materialized-state.json
    assertions.json
```

不是每个场景都需要所有文件；缺失文件表示该领域不参与该场景。`daily-sha256.json` 对所有含 Daily 的场景都是必需项。

## 2. 历史版本基线

历史 fixture 必须从对应 Git tag 的真实类型和写入格式构造，不得只用当前类型伪装旧版本。

| fixture | 来源 | 必须覆盖 |
|---|---|---|
| `LEG-111-BASE` | tag `1.1.1` | schema v2 memo-index、active/deleted、root 与 heading memo、多月份、恢复字段 |
| `LEG-117-CONFLICT` | tag `1.1.7` | canonical + 两个冲突 index、重复 Daily 指向、recoverable memoId、不同 digest provenance |
| `LEG-120-TIME-BUOY` | tag `1.2.0` | Time Buoy shard/state、正文 `@date`、派生索引不迁移且可重建 |
| `LEG-125-STATE` | tag `1.2.5` | `sourceMemoId`、Random Reunion review、pending create、deleted payload 所需正文 |
| `LEG-129-CUSTOM` | tag `1.2.9` | 自定义 Daily 目录/日期格式、Monthly 文件和日期 heading、引用兼容、root memo |

1.1.x 至少执行 `1.1.1` 与 `1.1.7`；1.2.x 至少执行 `1.2.0`、`1.2.5` 和 `1.2.9`。每个历史 fixture 都要证明原 memoId 逐字保留。

## 3. Markdown 解析矩阵

| fixture | 输入重点 | 必须断言 |
|---|---|---|
| `PARSE-CUSTOM-ROOT` | 自定义目录、locale 日期格式、heading 与 root 混合 | logicalDate、section 和行号正确；非 memo 内容忽略 |
| `PARSE-DUPLICATE-TIME-CONTENT` | 同文件同时间、同正文、同时间+不同正文、跨文件同正文 | observations 全部保留；不因 hash 相同自动共用 memoId |
| `PARSE-MULTILINE-TASK` | 多行、嵌套列表、多个 task marker | content/line range/taskIndex 稳定；checkbox 只改目标任务 |
| `PARSE-MEDIA-LINKS` | Obsidian embed、Markdown image、WikiLink、Markdown link、URL | image/link 元数据正确且不读取图片 blob |
| `PARSE-CODE-FENCES` | fenced code 内伪 memo、task、link、`@date` | 代码块内容不被索引为 memo/task/link/Time Buoy |
| `PARSE-EXISTING-BLOCK-ID` | 单行和多行 memo 已有 block ID | 读取 existingBlockId；扫描前后 Daily SHA-256 相同；不新增或移动 ID |
| `PARSE-LINE-ENDINGS` | LF、CRLF、BOM、末尾无换行、Unicode | sourceRevision 区分原字节；contentHash 规范稳定；文件保持原字节 |

## 4. 领域状态矩阵

| fixture | 必须覆盖 |
|---|---|
| `STATE-DELETED-VERSIONS` | 同 memo 多次 delete/restore、不同 delete payload、purge 指向明确版本 |
| `STATE-SOURCE-RELATION` | 相同 source 幂等、并发不同 source 进入 attention、显式 clear |
| `STATE-REVIEW-ORDINALS` | 旧 reviewCount 累计快照取最大 ordinal 覆盖，v2 review opId 做集合并集 |
| `STATE-PENDING-RECOVERY` | Daily 已写/未写/写入歧义三类旧 pending；不丢仅存于 pending 的正文 |
| `STATE-REDIRECT` | 无环 redirect、同来源不同目标、环检测和 quarantine |
| `STATE-SNAPSHOT-COMPACTION` | 连续 segment 确定性 snapshot、opId digest/tombstone 保留、冷启动和受控退场 |

## 5. Legacy artifact 与故障矩阵

| fixture | 输入/故障 | 必须结果 |
|---|---|---|
| `LEGACY-MULTI-CONFLICT` | canonical + 多个冲突副本，含相同/不同 digest | 相同 digest 只生成一个 package；不同 digest 分别保留 provenance |
| `LEGACY-PARTIAL-JSON` | JSON 截断、单字段类型错误、合法记录与错误并存 | 不伪报 complete；可恢复内容有 receipt；原文件不清理 |
| `MIGRATION-PACKAGE-WRITE-FAIL` | package 写入失败或中断 | 可重入；无 commit；Daily 未改；旧 artifact 保留 |
| `MIGRATION-COMMIT-WRITE-FAIL` | required artifacts 完整但 commit 失败 | v2_ready 可继续；不进入 settlement；重试产生相同 generation |
| `MIGRATION-COMMIT-THEN-EXIT` | commit 写完立即终止 | 冷启动重新验 required set；不提前清理 |
| `MIGRATION-REQUIRED-MISSING` | commit 先到、package/payload 缺失或 hash 错 | awaiting_data；现有内容可见；不新建旧 memoId |
| `CLEANUP-PARTIAL-FAIL` | trash 某个文件失败、进程中止 | 成功项有 retired receipt；失败项保留并重试；无宽泛目录删除 |
| `CLEANUP-LATE-LEGACY` | settlement 内/后晚到旧 index 或冲突副本 | 新 digest 增量导入、新 generation、quiet window 重置、再次精确退场 |

## 6. Daily 变化与 Catalog 失效矩阵

| fixture | 事件 | 必须结果 |
|---|---|---|
| `DAILY-RENAME` | 插件关闭期间 rename 后启动 | 新 path observation 生效；旧 path 分区删除；memoId 唯一 rebind |
| `DAILY-MOVE` | 跨自定义 Daily 目录移动 | 当前设置与连续证据共同解析；不生成第二 memoId |
| `DAILY-MANUAL-EDIT` | 时间不变正文改变、正文不变移动、section 改变 | 以文件 revision 一对一解析；唯一时 rebind，非唯一时 ambiguous |
| `DAILY-DELETE-ARRIVAL` | Daily 暂时删除后恢复、同步 rename 顺序颠倒 | 缺失不产生 delete；恢复后 observation 回归 |
| `CATALOG-OFFLINE-CHANGES` | 插件关闭期间 create/modify/rename/delete | inventory diff 精确失效；无幽灵 memo；不全库重建不相关文件 |

## 7. 两端事件乱序与并发矩阵

所有双端场景至少执行顺序本身及其逆序，并对 operation 集合做 100 个固定种子 permutation。

| fixture | 必须覆盖 |
|---|---|
| `SYNC-DAILY-IDENTITY-ORDER` | Daily→identity、identity→Daily |
| `SYNC-COMMIT-PACKAGE-DELETE-ORDER` | commit/package/deleted payload/旧 index 删除的主要排列 |
| `SYNC-WRITER-FORK` | writerId 被复制，sequence 分叉；本机自动换 writerId，旧分支都保留 |
| `SYNC-OPID-COLLISION` | 同 opId 同内容、同 opId 不同内容 |
| `SYNC-COMPACTION-ORDER` | compaction commit、snapshot、covered segment 删除的不同到达顺序 |
| `SYNC-CREATE-CREATE` | 两端离线分别创建同时间同正文；高熵 memoId 不碰撞 |
| `SYNC-EDIT-EDIT` | 同一 base revision 两端编辑；不由 state 覆盖 Daily 冲突 |
| `SYNC-EDIT-DELETE` | 一端 edit、一端 delete；进入 lifecycle conflict |
| `SYNC-RESTORE-RESTORE` | 相同 delete 版本相同/不同正文恢复 |
| `SYNC-RELATION-CONFLICT` | 两端设置不兼容 sourceMemoId |
| `SYNC-MONTHLY-CONFLICT` | 相同输入确定性输出；不同 Daily 输入不反向覆盖正文 |

## 8. 移动端、IndexedDB 与大 Vault

| fixture | 必须覆盖 |
|---|---|
| `IDB-DELETE-REBUILD` | 删除本机数据库后最近优先重建，memoId 和 Daily 不变 |
| `IDB-BLOCKED` | 数据库被另一连接阻塞；使用有界内存降级 |
| `IDB-UPGRADE-ABORT` | transaction abort/升级中断；丢弃本机缓存后续跑 |
| `MOBILE-BACKGROUND-RESUME` | 每批 checkpoint 后进入后台、恢复、强制结束再启动 |
| `PERF-30K` | 1500 Daily、30000 memo、多个内容维度和历史版本状态 |

## 9. 通用断言

每个适用 fixture 都必须执行：

- Daily 二进制 SHA-256 在只读阶段前后完全相同。
- 既有 memoId 的集合和值完全不变。
- active、deleted、relation、review ordinal、pending 逐领域对账。
- 一个当前 observation 最多绑定一个 canonical memoId。
- ambiguous 不触发自动编辑、删除、合并、覆盖或 adoption。
- 缺失/损坏状态不隐藏 Daily 内容。
- Catalog 删除和重建不改变身份、同步状态、Daily 或 Monthly。
- Monthly 删除可由 Daily 重建，且不得成为正文或身份来源。
- importer 不调用 Daily/Monthly 写 API；cleanup 只作用于精确 allowlist receipt。
- 任何失败都保持可重入，未完成步骤不得标记完成。
