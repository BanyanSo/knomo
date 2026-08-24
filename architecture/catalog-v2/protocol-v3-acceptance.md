# Catalog V2 Markdown-first Protocol V3 验收矩阵

## 0. 使用范围

本矩阵是 Protocol V3 的规范性验收依据。第 0 步只要求文档与决策完整；后续实现测试应引用稳定的场景 ID。当前文档存在不表示运行时已经通过这些场景。

## 1. 协议与分层验收

| ID | 场景 | 必须结果 |
| --- | --- | --- |
| V3-DOC-001 | 检查协议版本 | 新持久化语义使用 Protocol V3；不得修改 V2 schema 承载 V3 语义 |
| V3-DOC-002 | 发现既有 V2 工件 | 仅作为冻结的只读兼容输入；导入过程不覆盖、追加或删除 V2 工件 |
| V3-DOC-003 | 只有 Daily，没有 Catalog、Identity Ledger、bootstrap 或本机 IDB | 已扫描 memo 可显示、复制并打开 Daily；安全正文操作不等待 identity readiness |
| V3-LAYER-001 | Daily 与 Identity Ledger 对同一 memo 的存在状态不一致 | Daily 决定正文是否存在；identity tombstone 不隐藏真实 observation，孤立 identity 不显示幽灵 memo |
| V3-LAYER-002 | 删除 Catalog 后重启 | 从 Daily 重建；不产生共享 Vault 写，不改变 identity 或 Monthly 字节 |
| V3-LAYER-003 | 删除 Monthly 后重建 | 直接读取实际 Daily；不读取 Catalog 子集或 Identity Ledger |
| V3-LAYER-004 | observation 的 source revision 已变化 | 旧 handle stale；mutation 拒绝并刷新，不按行号、hash 或 tuple 猜测目标 |
| V3-LAYER-005 | Identity Ledger 晚于 Daily 到达 | 同一 observation 原地获得 `memoId`，不新增第二张正文卡片 |
| V3-LAYER-006 | Identity Ledger 早于 Daily 到达 | 保留待匹配身份事件，但不显示幽灵 memo |

### 1.0.1 V2/legacy 只读兼容验收

| ID | 场景 | 必须结果 |
| --- | --- | --- |
| V3-COMPAT-001 | 当前配置 `knomoDataRoot=A`，其他目录存在旧协议或备份 | 只读取 A 对应的旧目录；旧 bootstrap 只有在其 Catalog root 严格等于 A 的规范路径时可用；不扫描其他目录 |
| V3-COMPAT-002 | 对同一组已验证旧工件重复或重启执行 importer | Identity Ledger event 不重复；已确认 memoId、binding、relation、review 与可恢复删除 payload/commit 一致 |
| V3-COMPAT-003 | 旧工件缺失、摘要失败、分叉或无法唯一匹配 Daily | 只产生局部诊断并跳过不确定记录；Daily observation 继续完整显示和安全编辑 |
| V3-COMPAT-004 | 新安装或兼容导入后的正式运行时 | 不创建或写入 V2 bootstrap、generation、writer journal、mutation、migration 或 control artifact |
| V3-COMPAT-005 | 旧 `CatalogV2InstallMode` 为任意值或旧 bootstrap 不存在 | 不改变 Catalog 展示状态，不成为 Markdown mutation 准入条件 |
| V3-COMPAT-006 | 用户尚未显式授权清理旧数据 | 不覆盖、追加、移动或删除任何旧协议文件；物理清理不可达 |

### 1.1 Knomo Data Root 与迁移验收

| ID | 场景 | 必须结果 |
| --- | --- | --- |
| V3-ROOT-001 | 用户配置 `knomoDataRoot=A`，Vault 中另有 B、备份或 clone 副本 | 启动只精确读取 `A/_knomo-data/identity/v3`；不得扫描或采用其他目录 |
| V3-ROOT-002 | 已配置的数据目录或 Identity Ledger root 缺失 | identity=`missing/pending`；提示用户配置路径缺失；不得创建替代 root 或自动恢复 |
| V3-ROOT-003 | V3-ROOT-002 下浏览、create、edit、task、copy 等普通 Markdown 操作 | Daily 正常扫描、展示和安全编辑；Identity follow-up 可 pending，不得进入 Vault initialization 门禁 |
| V3-ROOT-004 | 用户手动把 A 移到 B，但尚未修改配置 | 仍只读取 A 并报告 missing；明确选择 B 且验证前不搜索、不切换 |
| V3-ROOT-005 | 新安装或旧设置尚未配置 Knomo Data Root 时启用插件 | 使用本机根目录或默认 `Knomo` 创建 `<root>/_knomo-data/identity/v3/writers`，持久化数据根并发布 `schema/config/v1`；不创建固定 Vault root、全局 events 或 catalog；失败不阻塞 Daily 且下次启用可重试 |
| V3-ROOT-006 | 用户从设置将 A 改为 B | 暂停本机 identity 写入，按 `copy -> verify -> update config` 执行；所有 event 字节与 reducer 结果一致后才切换，旧根保留 |
| V3-ROOT-007 | V3-ROOT-006 成功后重启 | 全部 `memoId`、binding、relation 和 review 不变；只读取 B |
| V3-ROOT-008 | 迁移复制、碰撞或验证失败 | 配置保持 A，A 不删除，Daily 字节与可用性不受影响；允许对相同 A/B 显式重试 |
| V3-ROOT-009 | 删除 Catalog 或 Monthly | 两者分别从 Daily 重建；Identity Ledger 不写入 Daily，Knomo Data Root 不参与 Vault identity/bootstrap 判断 |

### 1.2 共享配置与 Monthly 验收

| ID | 场景 | 必须结果 |
| --- | --- | --- |
| V3-CONFIG-001 | 共享配置缺失，本机 Daily Notes 和 Knomo 设置可用 | 启用时发布本机默认配置；已有配置不覆盖。发布失败时继续输入、扫描和浏览，本地扫描完成态与共享范围不完整分别报告 |
| V3-CONFIG-002 | 同一有效配置同步到另一设备 | Daily 定位、heading aliases 和 Monthly renderer 设置采用同步配置，不读取 V2 contract/control plane |
| V3-CONFIG-003 | 配置晚到或更新 | 按新 fingerprint 替换文件 partition；同一 observation 不重复，identity 不重新生成 |
| V3-CONFIG-004 | 两设备基于同一 base 并发写入相同配置 | reducer 得到同一语义配置；到达顺序不影响结果 |
| V3-CONFIG-005 | 两设备基于同一 base 并发写入不同配置 | 保留多个 active heads，config=`conflicted`；Daily 继续，Catalog partial，Monthly 不写 |
| V3-CONFIG-006 | 用户显式采用本机配置处理冲突 | 新 event 覆盖全部 active heads；各设备收敛，随后才恢复 Monthly |
| V3-CONFIG-007 | 未知 schema、坏 digest/path 或 eventId 碰撞 | 只隔离配置工件；Daily 使用本机 fallback，Monthly 不覆盖旧输出，identity 不进入 attention |
| V3-CONFIG-008 | 相同 Daily bytes、有效配置与 renderer version | 独立设备输出 byte-identical Monthly；Monthly 输入只来自实际 Daily |
| V3-CONFIG-009 | 显式迁移 Knomo Data Root | 共享配置 immutable bytes 与 Identity events 一并 copy/verify 后才切换；旧根保留 |

## 2. Identity 持久化失败下的操作矩阵

以下每行都必须分别在 identity 未同步、root 不可读、root 不可写和相关 memo identity conflicted 的适用状态下验证。

| ID | 操作 | Daily 预期 | Identity 预期 | 对用户的结果 |
| --- | --- | --- | --- | --- |
| V3-OP-001 | 查看、复制文本、打开 Daily | 不修改 | 不要求 | 成功 |
| V3-OP-002 | create，`create_intent` 写失败 | 新 memo 正常提交 | 记录 `identityPending`，不得伪造 durable intent | `committed_identity_pending`，正文保存成功 |
| V3-OP-003 | create，intent 成功而 Daily 写失败 | Daily 不出现新 memo | intent 未绑定且不可见，可供诊断/续跑 | `rejected_no_daily_change` |
| V3-OP-004 | edit/task/标签/图片/链接修改 | 通过 observation revision 校验后提交 | rebind/enrichment 失败仅 pending | Daily commit 后必须报告正文成功 |
| V3-OP-005 | copy 为新 memo | 完整 Markdown 结构提交到目标 Daily | 新身份或 source relation 可 pending | Daily commit 后成功，不因 relation 失败回滚 |
| V3-OP-006 | move，来源删除或 identity rebind 失败 | 来源删除失败时精确回滚未被并发修改的目标；回滚不安全时保留两份正文并报告 content pending，始终至少保留一份正文 | 只有内容层 move 完成后才追加 rebind；失败则 pending | 仅在内容层 move 完成后报告成功 |
| V3-OP-007 | 永久删除，identity 不可写 | 用户明确选择后删除 Daily block | 清理/事件可 pending | 成功，但明确不可从 Knomo 废纸篓恢复 |
| V3-OP-008 | 可恢复删除，`delete_payload` 写失败 | Daily 逐字节不变 | 不得产生“已入废纸篓”状态 | `identity_failed_no_daily_change` |
| V3-OP-009 | 可恢复删除，payload durable 后 Daily 删除失败 | Daily 仍保留正文 | payload 保留为未完成记录且不得产生 `delete_commit`；tombstone 不得隐藏正文 | `rejected_no_daily_change` |
| V3-OP-010 | restore 的 Daily 写失败 | Daily 不新增正文 | deleted payload 继续可恢复，不标记 restore 完成 | `rejected_no_daily_change` |
| V3-OP-011 | relation/review/adoption/merge/repair 持久化失败 | Daily 不变 | 操作不提交，不降级为 observation 猜测 | `identity_failed_no_daily_change` |
| V3-OP-012 | 用户显式创建 Obsidian block reference | 作为正文提交 | block ID 不进入内部 identity 判断 | Daily commit 后成功 |

## 3. 必须覆盖的故障矩阵

| ID | 故障 | 必须结果 |
| --- | --- | --- |
| V3-FAIL-001 | Catalog IndexedDB 丢失、delete 或 eviction | 切换 partial/rebuilding，从 Daily 重建；已扫描内容可浏览；不得写共享 Vault |
| V3-FAIL-002 | Identity snapshot/state/transaction IndexedDB 丢失 | Daily 内容能力继续；从外部 Identity Ledger 恢复；本机缓存不得充当身份主数据 |
| V3-FAIL-003 | 所有本机 IndexedDB 同时丢失 | Daily 字节不变；内容可重新扫描；Identity 未恢复前只降级身份能力 |
| V3-FAIL-004 | Identity Ledger 未同步 | observation 立即显示；create/edit/task/copy 不阻塞；不自动认领或生成第二个 `memoId` |
| V3-FAIL-005 | Identity Ledger 暂时不可写 | 普通正文以 Daily commit 成功并报告 identity pending；纯身份操作失败且 Daily 不变 |
| V3-FAIL-006 | 外部 Identity Ledger 及备份彻底丢失 | 正文、Catalog、Monthly 可恢复；明确告知原 `memoId`、关系、review 和 trash 历史不保证恢复 |
| V3-FAIL-007 | 共享配置缺失 | 使用本机可用设置继续输入和扫描；coverage 明确可能不完整；不阻塞已观察 memo |
| V3-FAIL-008 | 共享配置并发冲突 | 已观察 memo 继续显示和安全编辑；Monthly 暂停；不得升级为全 Vault identity attention |
| V3-FAIL-009 | parser/renderer 配置版本不支持 | 只隔离不能安全解释的范围；已观察内容继续；Monthly 不覆盖旧输出 |
| V3-FAIL-010 | Monthly 读取、渲染或写入失败 | projection 标记 stale/failed 并可独立重试；Daily 保存结果与 identity 不变 |
| V3-FAIL-011 | Daily create/edit/task/copy 写失败 | 返回失败，Daily 保持原状态；Catalog/Monthly 不采用预期内容；intent 不产生可见 memo |
| V3-FAIL-012 | Daily permanent/recoverable delete 写失败 | observation 继续显示；identity tombstone 不得隐藏它；可恢复 payload 保留有效 |
| V3-FAIL-013 | 单 memo 出现多个 identity successor | 仅该 memo 的身份为 conflicted；当前 observation 与无关 memo 的内容能力继续；不得静默任选 |
| V3-FAIL-014 | 本地 Catalog 扫描仍为 partial | 已覆盖 memo 可浏览；完整统计、全量随机池等能力不得伪装 complete。仅共享配置缺失而本地扫描已完成时，本地功能可用但必须提示范围可能不完整 |

## 4. 创建与乱序验收

| ID | 到达或失败顺序 | 必须结果 |
| --- | --- | --- |
| V3-ORDER-001 | `create_intent` -> Daily -> claim | 一张可见 memo，最终获得原 `memoId` |
| V3-ORDER-002 | `create_intent` -> 同步到另一设备，Daily 尚未到达 | 不显示幽灵 memo；intent 保持待匹配 |
| V3-ORDER-003 | Daily -> 另一设备，claim 后到 | Daily 到达即显示 observation；claim 后原地增强，不重复卡片 |
| V3-ORDER-004 | intent durable -> Daily 写失败 | 无可见 memo；intent 不得单独决定内容存在 |
| V3-ORDER-005 | intent 写失败 -> Daily 成功 | memo 可见且可编辑，标记 identity pending；不得把保存报告为失败 |
| V3-ORDER-006 | 同一分钟创建两条相同正文 | 两个 observation 都存在；身份可用时生成两个不同随机 `memoId` |
| V3-ORDER-007 | identity follow-up 超时后用户刷新或重启 | 不重复 Daily mutation；从 Daily 显示一条 observation，再续跑幂等 identity follow-up |

## 5. 身份协调、局部冲突与 repair 验收

| ID | 场景 | 必须结果 |
| --- | --- | --- |
| V3-COORD-001 | Knomo 内部 edit/task/显式 block reference 或完整 move 成功 | Daily commit 后追加基于旧 active binding 的 `rebind`；follow-up 失败只 pending；move 源删除未完成时不提前 rebind |
| V3-COORD-002 | 用户直接编辑 Daily，Catalog 持有完整 before revision | 只在唯一锚点或唯一 `1 -> 1` 区间自动续接；重启并同步后仍得到原 `memoId` |
| V3-COORD-003 | 一个已识别 predecessor 在 after revision 中出现多个候选 | 为同一 base 保留多个 successor；只把该 memo 标为 conflicted，候选 observation 仍可查看和编辑 |
| V3-COORD-004 | 两设备从同一 base 产生相同 successor | reducer 折叠为一个语义 active binding，事件到达顺序不影响结果 |
| V3-COORD-005 | 两设备从同一 base 产生不同 successor | 保留多个 active heads；不得按最后写入者、时间戳、writer 或到达顺序静默选择 |
| V3-COORD-006 | 一个 memo conflicted，另一个 memo 已识别 | 无关 memo 的 edit、relation、review 和 cross-device identity 保持 ready |
| V3-COORD-007 | 用户对当前候选完成显式 repair | repair 只写 Identity Ledger；所有设备收敛到同一 active binding；Daily 前后逐字节一致 |
| V3-COORD-008 | 当前历史 observation 没有身份 | 可显式 adoption 建立随机 `memoId`；普通 Markdown edit 不要求先 adoption；adoption 失败时 Daily 不变 |
| V3-COORD-009 | delete payload 或 tombstone 已存在，但 Daily observation 仍存在 | observation 继续显示；identity 状态不能把它隐藏 |

## 6. 永久删除与可恢复删除验收

| ID | 场景 | 必须结果 |
| --- | --- | --- |
| V3-DELETE-001 | Identity 不可用，用户选择可恢复删除 | 拒绝，Daily 逐字节不变，并明确说明暂时无法保证恢复 |
| V3-DELETE-002 | Identity 不可用，用户明确改选永久删除 | 允许按 Daily revision 校验后删除，明确不提供 Knomo restore |
| V3-DELETE-003 | payload 已 durable，Daily 删除成功，后续 `delete_commit` 失败 | 正文删除成功；保留 pending；仅在源 Daily 精确命中预期删除后 revision 时续跑，不把正文操作报为失败 |
| V3-DELETE-004 | payload 已 durable，Daily 删除失败 | 正文仍显示；payload 不得令正文消失，也不得显示为已完成删除 |
| V3-DELETE-005 | restore 写回 Daily 成功，identity finalize 失败 | 正文恢复成功且可见；identity 状态 pending，不重复写正文 |
| V3-DELETE-006 | 只有 tombstone/delete event，Daily block 仍存在 | observation 仍显示；身份状态可以提示冲突，但不能覆盖内容真相 |
| V3-DELETE-007 | 只有 `delete_payload`，没有 `delete_commit` | 不进入用户废纸篓；作为 pending 保留，restore 不可见 |

## 7. Vault clone 与身份验收

| ID | 场景 | 必须结果 |
| --- | --- | --- |
| V3-CLONE-001 | 完整 clone Daily、配置和 Identity Ledger | 保留全部已有 `memoId` 与关系；新设备生成新 `writerId`，不 rekey memo |
| V3-CLONE-002 | 只 clone Daily | 正文立即可见；原 `memoId` 不保证恢复；不得从路径、正文或 hash 猜回 |
| V3-CLONE-003 | clone 后 Vault 路径或名称变化 | 不触发 identity reset，不改变已有 `memoId` |
| V3-CLONE-004 | 两份 clone 的文件集合或配置不同 | 不自动判断“不同数据库”，不生成新的 Vault 身份来改写 memoId |
| V3-CLONE-005 | `vaultInstanceId` 或 `contractDigest` 缺失/变化 | 不影响随机 `memoId` 的生成与保留，也不阻塞普通 Markdown 操作 |

## 8. 内容纯净与依赖守卫

| ID | 检查 | 必须结果 |
| --- | --- | --- |
| V3-PURITY-001 | create/edit/task/copy/move/remove/restore 前后比较 Daily | 除用户请求的正文变化外，不新增内部 ID、block ID、HTML comment、frontmatter 或隐藏字符 |
| V3-PURITY-002 | 用户显式 block reference | 可保留为用户内容，但不得被 Identity Ledger 当作唯一身份依据 |
| V3-GUARD-001 | 普通正文 mutation 的公共接口 | 不要求 bootstrap、install mode、authority、StateGeneration、`memoId` 或 IdentityHandle |
| V3-GUARD-002 | Memo 视图模型 | observation 必须存在；`memoId` 可以为空或后到 |
| V3-GUARD-003 | UI 空态与错误态 | identity absent/syncing/conflicted 不得覆盖已存在的 Markdown 列表或切换到阻塞式 onboarding |
| V3-GUARD-004 | Monthly 输入路径 | 只从实际 Daily 和有效 projection 配置读取，不从 Catalog/Identity 子集读取 |
| V3-GUARD-005 | `memoId` 生成实现 | 使用 UUIDv7 或等价随机 ID；输入中不包含 `vaultInstanceId + contractDigest`、observationKey 或正文 evidence |

## 9. 第 0 步退出条件

- [x] 新建 Markdown-first Protocol V3 文档。
- [x] 新建独立验收矩阵，并为后续测试提供稳定场景 ID。
- [x] 明确 V2 是冻结的只读兼容协议。
- [x] 定义 Daily、Observation、Catalog、Identity Ledger、Monthly 五层的事实归属和失败边界。
- [x] 定义 identity 持久化失败时各类操作的成功、pending 与拒绝语义。
- [x] 区分永久删除与可恢复删除，并规定后者必须先 durable deleted payload。
- [x] 覆盖 IDB 丢失、identity 未同步、配置冲突、Monthly 失败与 Daily 写失败。
- [x] 接受 Identity Ledger 彻底丢失时原 `memoId` 不保证恢复。
- [x] 规定 Vault clone 默认保留已复制的 `memoId`，不自动判断“同一数据库”。
- [x] 规定 `memoId` 不依赖 `vaultInstanceId + contractDigest`。
- [x] 冻结用户配置 Knomo Data Root 下的 Identity Ledger 位置、缺失降级和显式验证迁移语义。

第 0 步只冻结上述文档。运行时通过本矩阵的声明必须等待后续阶段逐项实现和测试，不能因本清单勾选而提前宣称完成 P0。

## 10. 第 8 步发布门槛状态（2026-08-22）

- [x] 最近 Daily 优先、历史后台分片、checkpoint 续跑与移动端暂停/恢复有自动化覆盖。
- [x] 有界内存 fallback 正确报告 partial；Catalog IDB blocked、abort、versionchange、delete、eviction 与事务失败有故障注入。
- [x] Vault 事件只增量替换单文件 partition；30k Node 诊断验证 observation 总数、单 partition 内容更新与 Daily SHA 不变。
- [x] Identity 先/后于 Daily、离线双设备、并发 rebind、配置冲突、Monthly 失败、重启恢复和局部 repair 有确定性测试。
- [x] 扫描、查询、Catalog rebuild 与 identity reducer 不写 Daily、Monthly 或其他共享 Vault 数据。
- [x] V3 schema/example 已版本化；缺失、额外字段或内部 identity 字段都会使测试失败，不能 skip。
- [x] 本地 `npm run verify` 通过：915/915 测试，typecheck、i18n、生产 build、diff 与源码守卫全部通过。
- [ ] 使用同一冻结 fixture 和同一提交采集真实 Desktop、iOS、Android trace，并通过样本数量、P95、后台中断和强杀恢复门槛。
- [ ] 形成提交后，在干净 clone 中重新运行全量测试、typecheck、build 与发布门禁。

因此，本清单当前只证明第 8 步的代码与本地自动化部分完成；真实设备与干净 clone 两项补齐前，不得宣称第 8 步全部通过或进入发布候选。
