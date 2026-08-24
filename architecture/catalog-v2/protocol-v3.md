# Catalog V2 Markdown-first Protocol V3

## 0. 文档状态

本文件是 Markdown-first 目标协议，协议版本为 `3`。本文中的“必须”“不得”和“仅”均为规范性要求。2026-08-24 开发期修订在尚未对外发布的 V3 中补齐 `delete_commit`，明确 payload 与已完成删除的边界；该修订不改变 Daily-first 原则，因此不建立 Protocol V4。

本文首先冻结架构边界、成功边界和失败语义。到 2026-08-22，第 1～7 步已实现类型拆分、observation-first 读取、独立 Markdown mutation、Identity Ledger、配置/Monthly 协调和 V2 只读兼容导入；第 8 步性能、故障注入与发布门禁仍须独立验证。后续实现可以补充 wire schema 和内部算法，但不得改变本文的不变量；需要改变时必须建立新的协议版本并显式迁移。

## 1. Protocol V2 的处置

Protocol V2 被定义为**冻结的只读兼容协议**，不是可继续演进的草案。

- V2 的 bootstrap、contract、control generation、writer journal、state generation、mutation 和 migration 工件保持原字节语义，V3 不得宽松解释或原地升级它们。
- V3 兼容导入器只读取并校验 V2 工件；已验证的 `memoId`、binding、relation、review 和 deleted payload 应尽量保留。
- V3 完成兼容切换后，不再新建、覆盖、追加或删除 V2 工件。旧工件的清理必须是未来独立且经用户明确授权的操作。
- 2026-08-22 的第 7 步完成后，正式入口不再实例化 V2 写运行时、初始化或 authority 控制命令；V2 代码只可由只读兼容源调用。保留在仓库中的旧模块不构成可达运行时，也不得重新接回生产入口。
- 任何 V3 持久化工件必须使用新的协议或 schema 标识，不能伪装成 V2 工件。

## 2. 核心决策

1. Daily Markdown 决定当前 memo 是否存在以及正文是什么。
2. Identity Ledger 是需要同步与备份的持久用户元数据，但它只增强 Markdown observation，不是正文准入系统。
3. 普通正文操作以 Daily commit 为成功边界。commit 后的 Catalog、Identity 或 Monthly 失败只能产生独立的 pending/degraded 状态，不能把已保存正文报告为失败。
4. Daily 中只允许用户内容和用户显式创建的 Obsidian block reference。Knomo 不得为身份识别写入 block ID、HTML comment、frontmatter、可见 ID、隐藏标记或任何其他内部字符。
5. `memoId` 是唯一稳定身份；位置、行号、时间、正文 hash、block ID、observationKey 和 Catalog key 都不是 memo identity。
6. Identity 缺失、同步中或冲突时，已观察到的 Markdown 仍可显示，并可执行基于当前 observation 的安全正文操作。
7. Identity 冲突只限制相关 memo 的身份能力，不得形成全 Vault 的查看或编辑门禁。
8. Catalog 和 Monthly 都是可重建的派生数据。Catalog 不得成为 Monthly 的正向数据源。

## 3. 五个独立层

| 层 | 负责的事实 | 持久性与恢复 | 失败影响 | 明确不负责 |
| --- | --- | --- | --- | --- |
| Daily | memo 当前是否存在、正文、任务、标签、图片、链接及用户显式 block reference | 用户 Markdown，正文真相；依靠 Vault 本身同步与备份 | 目标 Daily 不可读时该文件内容不可用；写失败时本次正文操作失败 | `memoId`、关系、review、内部删除记录、Catalog 状态 |
| Observation | 某个 Daily revision 中一个 memo block 的定位证据 | 从实际 Daily 字节解析；revision 改变后重新生成 | stale 或不唯一时拒绝本次 mutation 并刷新 | 稳定身份、跨 revision 关系、持久业务关系 |
| Catalog | observation 的本机查询索引、分页、搜索、筛选、统计覆盖信息 | 可删除；从 Daily 重建；允许明确标记 partial | 已索引内容可浏览，完整查询能力降级 | 正文真相、身份真相、Monthly 输入、共享授权 |
| Identity Ledger | `memoId`、binding、relation、review、可恢复删除 payload/commit、restore/repair 历史 | 外部持久用户元数据；必须同步和备份；本机 snapshot 只用于加速 | 身份增强变为 pending/absent/conflicted；正文仍工作 | 决定 Markdown 是否存在、隐藏仍在 Daily 的 observation、授权普通正文操作 |
| Monthly | 月度浏览文件 | 由实际 Daily、有效配置和 renderer 确定性重建 | stale/failed，可重试；不回滚 Daily | 身份真相、Daily 写入授权、Catalog 完整性判断 |

### 3.1 依赖方向

```text
Daily -> Observation -> Memo UI / Markdown mutation
                    -> Local Catalog

Daily + projection config -> Monthly

Identity Ledger -> 给 Observation 附加可选 IdentityHandle
```

禁止反向依赖：Identity Ledger、Catalog 或 Monthly 的状态不得决定一个真实 Daily observation 是否可见；identity tombstone 也不得隐藏仍存在于 Daily 的正文。

### 3.2 Observation 语义

Observation 是针对当前文件 revision 的定位证据，至少表达 `sourcePath`、`sourceRevision`、`startLine`、`endLine` 和 `rawBlockHash`。具体 TypeScript 接口由第 1 步落地。

- observationKey 只能用于当前 observation 的渲染、去重或短期定位。
- observationKey 不得写入 Identity Ledger 的持久关系，不得作为 `memoId`，也不得在 revision 之间假装稳定。
- mutation 前必须在原子 Daily 写入边界内重新解析并验证 revision 与目标唯一性。stale 或多候选时拒绝本次写入，不能猜测目标。

### 3.3 Catalog 语义

Catalog 的 IndexedDB 和内存实现都只是本机缓存。删除、阻塞、事务失败或 eviction 后应以 `partial` / `rebuilding` / `degraded` 暴露真实 coverage，并从 Daily 重建。

Catalog 重建、查询和缓存恢复本身不得写入 Daily、Identity Ledger、Monthly 或任何共享协议工件。

### 3.4 Identity Ledger 语义

Identity Ledger 不是可丢弃的 Catalog。它保存无法从 Markdown 完整推导的用户元数据；其持久事件是主数据，本机 IndexedDB snapshot、materialized state 和 pending cache 均不是主数据。

Identity Ledger 不具备以下权力：

- 阻止真实 Daily observation 被显示、复制或打开；
- 要求 Vault bootstrap、authority、genesis 或 StateGeneration ready 后才允许普通正文操作；
- 用 tombstone、缺失 binding 或冲突状态覆盖 Daily 的存在事实；
- 在没有唯一证据时把 observationKey、tuple、正文 hash 或位置提升成稳定身份。

### 3.5 Monthly 语义

Monthly 必须直接读取目标月份的实际 Daily 字节。相同 Daily 字节、相同有效配置与相同 renderer version 必须产生 byte-identical 输出。

Monthly 写入失败仅改变 projection 状态为 `stale` 或 `failed`，不得回滚、重试或重复已经成功的 Daily mutation。

## 4. `memoId`、身份丢失与 Vault clone

### 4.1 `memoId`

- `memoId` 使用 UUIDv7 或具备等价全局唯一性的随机 ID，由创建端生成。
- `memoId` 的生成不得要求或派生自 `vaultInstanceId`、`contractDigest`、Vault 路径、Daily 路径、时间文本、正文、observation evidence 或其组合。
- `vaultInstanceId + contractDigest` 不再是 `memoId` 的必要组成，也不得作为创建和查看 Markdown 的门禁。
- 已绑定 observation 的 `memoId` 只能从 Identity Ledger 的有效事件恢复；无法恢复时不得根据内容猜回原 ID。

### 4.2 不可回避的降级

如果外部 Identity Ledger 及其备份彻底丢失，Daily 可以恢复正文和 observation，Catalog 与 Monthly 可以重建，但原 `memoId`、关系、review、可恢复删除历史不保证恢复。系统必须明确报告身份元数据缺失，不能伪造“已恢复原身份”。

### 4.3 Vault clone

Vault clone 的默认语义是复制用户选择复制的全部数据：若 clone 包含 Identity Ledger，则保留其中的原 `memoId` 和关系；新设备只生成新的随机 `writerId`，不会为已有 memo 自动换 ID。

运行时不再自动判断两个目录“是不是同一个数据库”，也不得根据 Vault 路径、文件集合、bootstrap、`vaultInstanceId`、`contractDigest` 或本机历史自动 reset/rekey。用户若需要有意分叉或重新生成身份，必须通过未来独立、显式且可审计的操作完成。

- 只复制 Daily、未复制 Identity Ledger：正文立即可见，observation 处于未绑定状态，原 `memoId` 不保证恢复。
- 只先同步 Identity Ledger、Daily 尚未到达：保留身份事件但不显示幽灵 memo。
- Daily 后到或 identity 后到：都必须增强同一个 observation，不生成第二张正文卡片。

## 5. 操作结果与成功边界

V3 使用以下结果语义：

- `committed`：所需主数据已经持久化，操作成功。
- `committed_identity_pending`：Daily 已成功，正文操作成功；身份 follow-up 尚未持久化或同步。
- `rejected_no_daily_change`：前置条件或 Daily commit 失败，Daily 保持操作前状态。
- `identity_failed_no_daily_change`：纯身份操作或可恢复删除的身份前置写失败，Daily 未改变。

不得在 Daily commit 已发生后向用户返回普通的 `saveFailed` 并诱导重试正文。重试只能针对可幂等的 follow-up；否则可能产生重复 memo 或重复 mutation。

## 6. Identity 持久化失败时的操作语义

| 操作 | Identity 不可写、未同步或相关 identity conflicted 时 | 成功边界 |
| --- | --- | --- |
| 查看、复制文本、打开 Daily | 继续；直接使用 observation | 已取得当前 Daily observation |
| create | 先生成随机 `memoId` 并尽力持久化自包含 `create_intent`；intent 失败仍允许写 Daily，结果为 `committed_identity_pending` | Daily commit |
| edit、task、正文标签/图片/链接修改 | 继续；identity rebind 或增强作为 follow-up，失败时 pending | Daily commit |
| copy 为新 memo | 继续复制完整 Markdown 结构；新身份与 source relation 可以 pending | 目标 Daily commit |
| move | 只要 Markdown 层的内容恢复机制可用就可继续；identity rebind 失败时 pending。目标写入后若来源删除失败，先按目标 observation 精确回滚；目标已并发变化而无法回滚时保留两份正文并报告 content pending。任一 Daily 写失败不得造成正文丢失或伪装完整成功 | 内容层 move commit |
| 永久删除 | 经用户明确选择后可删除当前 Daily block；不承诺可恢复，identity 清理失败时只报告 pending | Daily commit |
| 可恢复删除 / 移入废纸篓 | 必须先持久化足够恢复正文的 `delete_payload`；该写入失败时返回 `identity_failed_no_daily_change` | durable payload 后提交 Daily，成功后追加 `delete_commit`；commit 失败只进入 pending |
| restore | 必须已有可验证的 durable delete payload；Daily 写失败时 payload 继续保留，不得标记已恢复 | Daily commit，随后 identity restore follow-up |
| relation、review、merge、repair、adoption | 不降级为正文猜测；持久化失败则操作失败，Daily 不变 | Identity Ledger durable commit |
| 用户显式创建 block reference | 作为用户正文操作继续；该 block ID 不能成为内部 identity | Daily commit |

### 6.1 create 的顺序

1. 生成与 Vault/contract 无关的随机 `memoId`。
2. 尽力写入自包含、无需 bootstrap 才能解释的 durable `create_intent`。
3. 写 Daily。
4. 从实际 Daily revision 解析 observation。
5. 追加 claim/binding。

`create_intent` 先到时不能产生可见 memo；Daily 先到时 observation 立即可见。intent 成功而 Daily 失败时，intent 保持未绑定且不可见。intent 失败而 Daily 成功时，memo 正文仍算保存成功并进入 `identityPending`。

### 6.2 永久删除与可恢复删除

两者是不同的用户承诺，不能共用含糊的“删除成功”：

- **永久删除**只承诺从当前 Daily 删除正文，不承诺 trash/restore。它可以在 Identity Ledger 不可用时执行，但必须由 UI 明确标识为不可恢复操作。
- **可恢复删除**承诺可从 Knomo 废纸篓恢复，因此必须先把完整 deleted payload、预期删除后 Daily revision 和所需身份信息持久化到 Identity Ledger。前置写失败时 Daily 必须逐字节保持不变。
- `delete_payload` 只表示恢复材料已持久化，不能单独进入废纸篓。Daily 精确删除成功后追加 `delete_commit`；commit 失败时 payload 保持 pending，并且只允许在源 Daily revision 精确等于 payload 记录的删除后 revision 时自动续跑。
- identity tombstone 或 delete event 不能单独让仍在 Daily 的 observation 消失；Daily 删除失败时仍按现存正文显示。

### 6.3 身份协调、局部冲突与 repair

文件级协调必须读取同一路径的完整 before revision 和完整 after revision。只允许以下自动续接：完整 block evidence 在两端都是唯一的不变锚点，或两个唯一锚点之间只剩一个 predecessor 与一个 successor。首次扫描没有 before revision、多个 predecessor 无法唯一分配，或跨文件手工移动缺少完整内容事务时，不得猜测身份。

一个已识别 predecessor 对应多个 successor 时，可以为每个候选追加基于同一 `baseBindingId` 的 `rebind`，但该 memo 必须进入局部 `conflicted`：所有真实 observation 继续显示并保留 Markdown 能力，relation/review 等受影响身份操作暂停，显式 repair 可用；无关 memo 不降级。

binding reducer 使用可合并图语义：

- 同一 `baseBindingId`、同一 successor evidence 的并发事件折叠为一个语义 successor；
- 同一 `baseBindingId`、不同 successor evidence 保持多个 active heads，不使用最后写入者、最大时间戳或 writer 优先级；
- repair 基于该分叉的公共 base，显式选择当前 observation。相同 repair 可折叠，不同 repair 继续保持冲突；
- repair、adoption、relation 和 review 的成功边界都是 Identity Ledger durable commit，且不得修改 Daily；
- adoption 只用于给当前无身份的历史 observation 建立随机 `memoId` 和 claim，不是 edit/task/move 等 Markdown 操作的前置条件。

Knomo 内部 edit、task、显式 block reference 和完整 move 在 Daily commit 后追加 rebind。Identity follow-up 失败只产生 pending；move 尚未完成源 block 删除时不得提前把身份从现存 predecessor 移走。delete payload 或 tombstone 仍不能覆盖 Daily 的内容存在事实。

## 7. 故障语义

| 故障 | 内容结果 | 身份结果 | Catalog / Monthly 结果 | 禁止行为 |
| --- | --- | --- | --- | --- |
| 全部或任一本机 IndexedDB 丢失、删除、blocked、abort、versionchange、eviction | Daily 仍可读取和执行安全正文操作 | 从外部 Identity Ledger 恢复；未恢复前为 absent/syncing/pending | Catalog 从 Daily 重建并报告 partial；Monthly 不受 IDB 完整性支配 | 因恢复本机缓存而写共享 Vault；把本机缓存当身份主数据 |
| Identity Ledger 未同步、不可读或暂不可写 | observation 立即显示；create/edit/task/copy 等按第 6 节降级 | 身份能力 pending/不可用；不得自动生成第二个 ID | Catalog 继续；Monthly 继续按 Daily | 显示 onboarding 覆盖正文；阻止普通 Markdown 操作 |
| 单 memo identity 冲突 | 当前 observation 仍可查看，并可做通过 revision 校验的安全正文编辑 | 只阻塞该 memo 的 relation/review/repair 以外的受影响身份操作，等待显式 repair | 无关 memo 正常 | 升级为全 Vault attention；任选一个候选 |
| 共享配置缺失 | 使用本机当前可用设置扫描和输入，明确 coverage 可能不完整 | 不改变已恢复 identity | Catalog 可 partial；Monthly 可 stale | 阻止输入或隐藏已观察 memo |
| 共享配置冲突或版本不支持 | 已观察 memo 继续显示和编辑；隔离不能安全解释的新增范围 | 不改变无关 identity | 暂停 Monthly 写入，Catalog 标记 coverage/config degraded | 用任一配置覆盖 Monthly；进入全 Vault identity attention |
| Monthly 读取、渲染或写入失败 | 已完成和后续 Daily 保存均不回滚 | 不受影响 | projection=`stale/failed`，可独立重试 | 报告 Daily 保存失败；从 Catalog 子集覆盖 Monthly |
| Daily 写失败 | 本次 create/edit/task/copy/remove/restore 不成功；Daily 保持底层原子写保证的旧状态 | 已写 intent/payload 保持未绑定或待处理，不得假装对应正文已提交 | 不用预期内容更新 Catalog/Monthly | 返回成功；创建幽灵 memo；把 intent 当正文存在证据 |
| observation stale 或目标不唯一 | 拒绝 mutation，重新解析并刷新 | 不自动 rebind 或认领 | Catalog 更新到新 revision 后再试 | 按旧行号、hash 或 tuple 猜测并修改 block |
| Identity Ledger 及备份彻底丢失 | 从 Daily 恢复正文 | 原 memoId 与身份元数据不保证恢复 | Catalog/Monthly 可从 Daily 重建 | 声称从 Markdown 确定性恢复原 memoId |

任何一个维度失败都只能影响其拥有的事实。状态展示必须能够独立表达 content、catalog、identity、projection 和 config，而不是折叠成一个阻塞所有能力的全局 install/readiness 状态。

## 8. 配置边界

Daily 定位规则、heading aliases、Monthly 输出设置、parser version 和 renderer version 属于独立配置层，不属于 Identity Ledger，也不参与 `memoId` 生成。

- 配置存在且有效时，各设备按同步配置扫描与投影。
- 配置缺失时，设备使用本机可用设置继续输入与扫描，并明确 coverage 可能不完整。
- 配置冲突时，已观察正文继续工作；Monthly 暂停，等待显式解决。
- 配置变更可以触发重扫，但不得为相同 observation 创建新的 identity。

### 8.1 V3 共享配置事件

V3 共享配置只位于用户当前配置的 Knomo Data Root：

```text
<knomoDataRoot>/_knomo-data/schema/config/v1/
└── writers/
    └── <writerId>/segments/*.jsonl
```

- 每个 `set_config` 是 immutable、canonical JSONL event，包含 `eventId`、`writerId`、`baseEventIds`、时间和完整配置；不使用 bootstrap、genesis、authority、writer registration、global generation 或 Vault identity。
- 配置包含 Daily folder/date format、主 heading 与 aliases，以及 Monthly folder/file format/date heading/date order/renderer version。heading 数组首项仍是新 memo 的目标 heading。
- reducer 只按 `baseEventIds` 形成 DAG。并发 head 的配置字节相同可视为同一有效配置；配置不同则状态为 `conflicted`，不得按时间、writer 或到达顺序任选。
- 显式冲突处理以当前所有 active heads 为 base 追加一个新 event；普通设置更新在已有冲突时不得暗中充当 resolution。
- 插件启用后若共享配置为 `missing`，使用本机可用设置发布首个配置事件；发布失败时继续使用本机设置，Catalog 的本地扫描完成态与共享范围可信度必须分别报告，Monthly 可按本机配置重建。`conflicted`、`unsupported` 或不可安全读取时不得自动覆盖，继续使用本机配置服务 Daily，并暂停 Monthly 写入。
- 未知 schema、非 canonical bytes、digest/path 不匹配或 eventId 碰撞只隔离共享配置范围；不得改变 Identity 状态，不得隐藏或阻止现有 Daily observation。
- 插件启用时允许在当前配置根下补齐 `_knomo-data` 并发布缺失的默认共享配置；已有共享配置只读取，不追加或覆盖，冲突仍需用户明确解决。迁移 Knomo Data Root 时配置 event bytes 与 Identity events 一并复制、验证，旧根仍保留。

### 8.2 Knomo Data Root 与 Identity Ledger 位置

`knomoDataRoot` 是用户可配置的 **Knomo 增强数据存储位置**，默认值为 `Knomo`。它不是 Vault identity，不是 Memo 可用性判断依据，也不是 bootstrap source。禁止形成“Knomo Data Root 缺失 -> Vault initialization -> 阻止 Markdown”的依赖链。

V3 Identity Ledger 的唯一配置内位置是：

```text
<knomoDataRoot>/_knomo-data/identity/v3/
└── writers/
    └── <writerId>/segments/*.jsonl
```

- Monthly 派生 Markdown 仍直接写在 `<knomoDataRoot>`，文件名由 Monthly 设置决定；不新增固定的 `Monthly/` 子目录。
- 默认启用流程只创建最小 Identity Ledger root 与 `schema/config/v1`，不创建全局 `events/` 或 `_knomo-data/catalog`。所有 durable identity events 仍只存在于 per-writer immutable JSONL segments。
- 启动只精确读取配置指向的一个 Identity Ledger root。不得扫描 Vault 或其他数据目录寻找 identity、catalog、旧备份或冲突副本。
- 新安装或尚未配置数据根的旧库在插件启用时，以本机根目录或默认 `Knomo` 自动创建一次最小 Identity Ledger root 并持久化配置。普通扫描和 Markdown mutation 本身仍不得创建或替换 root。
- 已配置 root 缺失时，identity 为 `missing/pending`。Daily 继续扫描、显示和编辑；不得新建替代 root，也不得自动采用其他副本。
- 手动移动目录但未更新配置时，运行时仍只访问旧配置路径。只有用户显式选择新路径并验证通过后，配置才能切换。
- 数据目录迁移使用明确的旧根和新根，顺序固定为 `copy -> verify immutable bytes and reducer result -> update config`。旧根保留；自动删除不属于本协议。
- 迁移验证必须保持全部 event、`memoId`、binding、relation 和 review。迁移期间本机 identity 写入暂停；跨设备迁移要求用户先让其他写入设备静止并完成同步。
- Catalog 与 Monthly 是派生数据，允许从 Daily 重建；Identity Ledger 不得写入 Daily Markdown。

## 9. 协议不变量

1. 只有 Daily、没有 `_knomo-data`、Identity Ledger 或任一本机数据库时，已扫描 memo 仍可见。
2. Identity 未完成不能成为“不可显示/不可编辑 Markdown”的理由。
3. 普通正文 mutation 不要求 bootstrap、genesis、authority、StateGeneration、install mode、`memoId` 或 IdentityHandle。
4. Daily commit 后的 follow-up 失败不改变正文成功结果。
5. 可恢复删除的 payload 未 durable 前，Daily 不得改变。
6. identity tombstone 不得隐藏仍存在于 Daily 的 observation。
7. Catalog 删除后可从 Daily 重建；重建不产生共享 Vault 写。
8. Monthly 删除后可直接从 Daily 重建，不读取 Identity Ledger 或 Catalog 子集。
9. 外部身份数据彻底丢失时，正文可恢复，但原 `memoId` 不保证恢复。
10. `memoId` 不依赖 `vaultInstanceId + contractDigest` 或 observation evidence。
11. Vault clone 默认保留已复制的 `memoId`；运行时不自动判断或重置所谓“数据库身份”。
12. 全局协议、配置或 identity 冲突不得让无关 observation 停止显示或安全编辑。
13. Knomo Data Root 的存在、路径或迁移状态不得参与 Vault identity、bootstrap 或 Markdown 准入判断。
14. 除首次启用的默认初始化、显式设置或迁移流程外，Identity Ledger root 不得被自动创建、搜索或恢复；已配置 root 丢失时不得自动创建替代 Ledger。

## 10. 本阶段未冻结的实现细节

以下内容留给后续阶段，但其设计必须满足本文：

- Identity Ledger snapshot、增量索引和 compaction 细节；当前开发期冻结的 root、九种基础事件、canonical bytes 与 per-writer segment 布局不得被这些实现改变；
- `ObservationHandle` / `IdentityHandle` 的最终 TypeScript 声明；
- move 的具体内容恢复日志格式；
- V2/legacy 物理清理的未来独立授权协议；
- 各状态的最终 UI 文案与重试交互。

这些未冻结项不能被用来重新引入 identity readiness 对 Markdown 的全局门禁。

## 11. 第 8 步 schema 与发布证据约束

V3 Identity Ledger event 与共享配置 event 的规范性机器可读文件位于：

```text
docs/architecture/catalog-v3/
├── schemas/
│   ├── identity-ledger-event.schema.json
│   └── shared-config-event.schema.json
└── examples/
    ├── identity-ledger-claim.valid.json
    └── shared-config-set.valid.json
```

这些文件是发布测试的必需输入，缺失时必须失败，不能按环境 skip。schema 与运行时校验都拒绝未冻结字段，尤其不得通过 observation evidence、block ID、HTML comment、frontmatter 或其他 Daily 字符恢复内部 identity。

Node 30k 基准只用于确定性回归和定位，不能替代真实 Obsidian Desktop、iOS 与 Android 采样。真实设备 trace 必须来自相同冻结 fixture 和相同提交；三平台任一缺失、样本不足、P95 超限或移动端后台/强杀覆盖不足，都必须让发布门禁失败。工作区形成提交后还必须在干净 clone 中复跑测试、typecheck 与生产构建，之后才能宣称第 8 步全部通过。
