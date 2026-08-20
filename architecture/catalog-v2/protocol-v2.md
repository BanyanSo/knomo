# Catalog V2 Protocol V2

## 1. 结论与边界

Catalog V2 采用“每台设备独立重建本机 Catalog”的方向，本机 Catalog 仅是可丢弃的查询缓存。清空任意设备的 IndexedDB 后，共享 Vault 字节必须保持不变：Catalog 从 Daily 重建，稳定 identity 从 `_knomo-data` 的共享协议工件恢复。

以下操作不得以“本机扫描完成”为授权依据：

- 为已有 Daily observation 创建或改绑 `memoId`；
- 删除、压缩或替换任何共享协议工件；
- 清理 legacy 数据。

Daily 正文只保存用户内容和用户显式创建的 Obsidian block reference。`memoId`、claim、rebind、review、relation、delete 等信息全部位于 Daily 外部；不得写入可见 ID、HTML comment、frontmatter 或其他身份标记。

## 2. Vault 启动协议

唯一 bootstrap locator 是 Vault 根目录下的 `_knomo-data/manifest.json`。bootstrap 为不可变工件，包含：

- `vaultInstanceId`；
- `protocolVersion = 2`；
- `initializationMode`（`native` 或 `legacy_upgrade`）；
- 共享 `catalogDataRoot`；
- content-addressed parser/render contract 引用；
- initial writer；
- 创建时间。

bootstrap 同时引用不可变 `control-generation` genesis。控制面每次提交都带 parent、单调递增的 `controlSequence`、`authorityEpoch`、当前 authority、共享 contract、已验证 StateGeneration anchor，以及完整 writer frontier。设备只接受唯一的最高 authority epoch；同 epoch 分叉进入 `attention`，旧 epoch 分支被 fencing。authority 只能通过目标 writer 的不可变 transfer request 和当前 authority 的显式批准转移，不使用静默期、设备在线时间或“最后写入者”选主。

bootstrap 缺失时不得根据本机当前文件集合推断“全新 Vault”。运行时只能进入：

- `uninitialized`：本机没有任何可证明的既有 Vault 数据，仍须用户显式初始化；
- `joining`：看到 Markdown、本机旧配置或其他加入既有 Vault 的迹象，但 bootstrap 尚未同步；
- `legacy_upgrade`：发现真实 legacy 输入；
- `existing_v2`：bootstrap 与 contract 均完整验证；
- `attention`：多 bootstrap、Vault 身份冲突、contract 冲突或无效协议工件。

只有用户命令可以创建 genesis bootstrap。未发布的中间 V2 布局不迁移、不兼容，也不得覆盖到新 root。

## 3. 共享 parser/render contract

所有设备从不可变 contract 读取以下配置：

- Daily folder、date format、Knomo/legacy headings 与 root memo 规则；
- monthly folder、file format、date heading format、排序、新行与 renderer version；
- parser version。

本机设置只用于首次显式初始化 contract；bootstrap 存在后，本机差异不得改变扫描集合或月度渲染结果。contract 不一致进入 `attention`，不做自动转换。

设备只接受自己明确实现的 parser/renderer version；未来版本不能按“正整数”宽松接受。版本不受支持时进入 `attention`，不得用旧实现继续扫描或投影。

## 4. 不可变 writer journal

每个 writer 仅写自己的不可变工件：

1. `writer-registration`：绑定 `vaultInstanceId + writerId`；
2. `state-segment`：连续 sequence、previous head digest 与 operations；
3. `writer-head`：引用 sealed segment、previous head、sequence 范围和累计 `affectedMemoIds`；
4. `state-generation`：引用完整 writer 集及各 writer committed head。

禁止可变 active segment、同路径替换和本机推断的尾部。operation 先落本机 durable outbox，再追加不可变 journal；同步失败只保留 outbox，不得伪装成功。

## 5. StateGeneration 完整性

一个 generation 仅在以下条件全部满足时为 verified：

- Vault 与 contract 匹配 bootstrap；
- generation 的每个 parent 均完整 verified，且 parent graph 无环；
- parent 中的 writer 不得被子 generation 删除，registration 不得改变；
- 每个 child head 必须是 parent head 的 hash-chain 后继；
- segment/head digest、previous head、writer、sequence 与 `affectedMemoIds` 全部一致；
- migration generation digest、commit、package、quarantine receipt、deleted payload 与 memo scope 完整匹配；package 嵌套字段、source/receipt 映射及 domain counts 必须从实际工件重新计算通过；
- 当前协议不允许 writer retirement，也不允许物理 GC。

同步乱序时，缺失 parent、registration、head、segment 或 migration artifact 均为 `awaiting_data`，不能把“没看到”解释为删除。若缺失工件声明了精确 writer/memo scope，已验证 base generation 中不受影响的 memo 可以继续由不受影响的 writer 追加；新 generation 到齐后再合流。身份认领、repair 与 migration finalization 在无法验证其输入时禁止。Monthly 不依赖 StateGeneration readiness。

设备在本机保存“最后已见 verified generation”水位。后续只接受该水位本身或其 DAG 后继；已见 tip 暂时消失时保留现有 materialized state 并降为不可写，不能回退到旧 generation。该水位只是一道本机防回退闸门，删除它不会授权任何共享写，也不替代 Vault 协议真相。

多个独立 writer tip 自动生成带全部 parent 的 merge generation。同 writer 的真实 fork、不同 migration generation 或无法证明单调继承时进入 attention。语义相同但 writer/time 不同的 migration commit 通过 `migrationGenerationDigest` 确定性收敛。

## 6. 身份协议

`memoId` 是唯一 memo 身份。物理位置、时间、正文 hash、行号和 block ID 都只是 evidence，不是身份键。

- reducer 只暴露 active binding tip；历史 claim/rebind 不参与当前匹配；
- rebind/delete/restore 必须携带 `baseBindingId`，同一 parent 的不同后继保持歧义；
- tuple、block ID 与进程内 continuity 只能生成候选，不能授予写能力；
- create intent 保存完整 evidence，并且必须先写不可变共享 mutation prepare，之后才能写 Daily；`memoId` 由 `vaultInstanceId + contractDigest + observation evidence` 确定性派生，另一设备恢复时不会生成第二个身份；
- bootstrap/state 暂不可用时不得写 provisional Daily memo；本机 transaction IndexedDB 只加速恢复，不能成为 memoId 或 intent 的唯一主存；
- 已有 observation 只允许用户显式 adoption，并使用绑定 Vault、contract、generation、source revision 与 observation digest 的 permit；
- legacy memo 的显式保留身份也走同一 permit，不得绕过 readiness；
- 用户直接编辑 Daily 后，只有同一文件旧、新完整 revision 形成唯一一对一对应时，才写外部 `identity.rebind`；每个已提交 mutation 保存有方向的 `beforeRevision -> afterRevision` 以及变化 memo、未变化 memo 的一对一 evidence 映射；重启、跨设备沿这条共享链解析；不唯一时保持 ambiguous，不生成新身份。

Daily mutation 分为两类：

- ordinary content mutation（正文、task、标签、图片、链接和 Time Buoy 文本标记）以 `Vault.process(Daily) -> Daily commit -> parse changed file -> replace Catalog observations` 为完整边界，不写 shared prepare，不持久化 `beforeRawBlock/afterRawBlock`；Daily commit 后的 Catalog 或 state 刷新失败只产生 follow-up pending，不得将已保存正文报为失败。
- identity-sensitive mutation（create、adoption、explicit rebind、identity repair/merge）可保留恢复 identity 安全所必需的 shared intent/evidence/permit。create 必须先持久化可恢复 intent，再提交 Daily；adoption/repair 不能绕过 control permit 与实际 Daily 字节校验。

delete/restore/move/copy 的现有 lifecycle recovery 不能被普通 edit/task 复用，也不能将 IndexedDB pending 当作 shared truth。

## 7. 月度投影

月度 Memos 是从实际 Daily Markdown 单向重建的 materialized view，不参与 identity 或 Daily correctness。

- 完整输入必须由共享 Diary parser 直接读取目标月份实际 Daily 文件；Catalog、state.memos 和 durable binding 不是正向数据源；
- 相同 Daily 字节、contract settings 和 rendererVersion 必须生成 byte-identical 输出；
- projection metadata 只包含本机 `rendererVersion/sourceDigest/outputHash`，仅用于 stale/no-op 判断；
- 写入使用 `Vault.process`、output hash compare 和 self-write filtering；失败只标记 Monthly stale/projection failed；
- Monthly 不写 Daily，不要求 projection authority、control action、StateGeneration、shared receipt 或 distributed lock。

## 8. 本机存储失败

- Catalog Store 显式暴露 `opening/ready/degraded/retrying/read-only/rebuilding`。IndexedDB open、blocked upgrade、transaction abort、`versionchange`、运行期删除或 storage eviction 失败时，切换为不截断的可写内存缓存，coverage 为 `partial/rebuilding`，并触发从 Daily 重建；
- coverage 只有 `complete/partial/rebuilding`。partial 允许浏览已 hydrate Memo，但完整统计、完整 Shuffle Day pool、完整 Random Reunion pool 和全量 Time Buoy 索引必须显式报告不完整或拒绝；
- 启动按最近 Daily 优先 hydrate，历史文件后台分片扫描。mtime/size 只是快速启动线索，full audit 与 identity-sensitive shared mutation 必须读取实际字节；
- state/transaction IndexedDB 在 `versionchange` 后关闭并自动重开；未恢复 authoritative 状态前禁止共享 mutation；
- transaction store 不使用不可恢复的内存写 fallback；
- identity-sensitive mutation 的本机 durable pending transaction 仅用于本设备快速续跑，不代替共享 intent/evidence；
- 清空 Catalog/state/transaction 任一 IndexedDB 不得直接触发共享 Markdown、身份或协议工件写入。

## 9. Legacy 与清理

legacy importer 是只读的，迁移 package/commit 为不可变共享工件。Vault 中尚未被 StateGeneration 引用的 package 只作为隔离候选，不参与当前 materialized state。只有 migration commit 已通过本机 cold-start parity、完整 artifact 验证，并绑定到 verified StateGeneration 后，迁移身份才生效。

完整 artifact 验证同时校验 canonical bytes、digest/length、package 内部 records/counts、legacy source 与 receipt 对应关系、deleted payload 所属关系，以及 commit domain counts 的独立重算；不能只相信 commit 中的 `verification=true`。

本版本仅做逻辑接管：

- 不自动删除 `_knomo-system`；
- 不 trash state segment；
- 不执行共享 compaction；
- 不根据 quiet window、本机 hash 或本机 IndexedDB verification 做物理 GC。

未来若增加 GC，必须使用共享 tombstone、generation 引用闭包和显式多设备确认；这不属于 protocol-v2 第一版。

## 10. 核心不变量

1. 删除全部本机 IndexedDB 后，共享 Vault bytes 不变。
2. Daily 先到、state 后到时，不会自动创建第二个 `memoId`。
3. state 先到、Daily 后到时，不会把 identity 当成已绑定正文。
4. 整个 writer 或尾部缺失时，不会被解释为完整状态。
5. 两台设备配置不同仍按共享 contract 扫描与渲染。
6. Monthly 可从 Daily 完整重建，失败或短暂多端不一致不影响 Daily/Catalog/Identity。
7. 直接编辑 Daily 后仅唯一 revision successor 自动 rebind。
8. 无 verified generation 时，不 adoption、不 cleanup；Monthly projection 不依赖 generation。
9. 清空 transaction/state/Catalog IndexedDB 后，只靠共享 prepare、Daily revision 和 generation 仍能确定性完成或隔离 mutation。
10. 普通 Daily 内容 mutation 不需要 authority；adoption、manual repair、migration finalization、contract change 或 authority transfer 仍受 control permit 限制。

## 11. Protocol V2 冻结点

2026-08-20 起，当前 `protocolVersion = 2` / `schemaVersion = 2` 进入冻结：

- 冻结 bootstrap locator `_knomo-data/manifest.json`、content-addressed contract/control/state/writer/mutation/migration/deleted-payload 命名规则；
- 冻结 `memoId` 唯一 identity、create intent 可跨设备恢复、R2 不得因只看到 R1 而反向 rebind 的语义；
- 冻结 `CATALOG_PARSER_VERSION` 与 Monthly rendererVersion 的 exact-version contract；
- Monthly projection authority、`monthly_projection` control action、projection receipt 与 generation-bound projection input 不属于冻结 schema，也不提供中间 V2 兼容 reader；
- 任何后续 schema 改动必须使用新 protocol/schema version 和显式 migration，不得对 V2 工件宽松接受。
