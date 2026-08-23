# Catalog V2 Protocol V2 验收矩阵

> 状态：仅用于验证冻结的 V2 兼容读取与迁移输入，不是 Markdown-first Protocol V3 的运行时验收标准。V3 的规范性验收要求见 `protocol-v3-acceptance.md`。

## P0 阻断项

| 场景 | 必须结果 |
| --- | --- |
| 空设备、无 bootstrap | `uninitialized` 或 `joining`；不自动创建 genesis |
| Daily 先于 bootstrap/state 到达 | 可读；无共享 prepare 时不可新建，已有 observation 不自动认领 |
| state 先于 Daily 到达 | identity 保留但无正文写能力；不能将 R2 反向 rebind 到暂时可见的 R1 |
| 整个 writer registration/head 缺失 | `awaiting_data`，声明 memo/writer scope；不得判完整 |
| parent generation 缺失 | 子 generation 不得 verified |
| 已见最新 generation tip 暂时消失 | 保留现有本机状态并阻断写；不得回退到旧 tip |
| 子 generation 删除 parent writer 或回退 head | `invalid/attention` |
| 两个 bootstrap / Vault ID | `attention`，不得任选其一 |
| contract 不一致 | `attention`，不得用本机设置覆盖 |
| contract 声明未知 parser/renderer version | `attention`，不得用当前实现猜测执行 |
| 不同 migration commit 的真实 fork | 阻断；不得任选 |
| 同语义 migration commit、writer/time 不同 | 按 migration generation digest 合流 |
| 未被 generation 绑定的 migration package | 仅隔离校验，不进入 materialized state |
| package 嵌套字段或 commit domain counts 伪造 | `invalid/attention`，不得 verified |
| 目标月份 Catalog 为 partial | Monthly 仍直接解析该月全部实际 Daily，不得用 Catalog 子集覆盖 |
| 两设备的 Daily/settings/rendererVersion 相同 | 生成 byte-identical Monthly，不需要 authority/receipt/generation |
| transaction IndexedDB 写失败 | Daily 字节不变；本机缓存不能作为共享 intent 的替代 |
| shared prepare 写入后、Daily commit 前 transaction store 失效 | 拒绝本机写 Daily；另一设备可从共享 prepare 确定性续跑或隔离 |
| Catalog IndexedDB open/blocked/abort/versionchange/delete/eviction | lifecycle 可见，降级为 partial/rebuilding 内存缓存，从 Daily 重建；不产生共享 Vault 写 |
| Catalog coverage 为 partial/rebuilding | 已 hydrate Memo 可浏览；完整 Stats/Shuffle/Random/Time Buoy 不得伪装 complete |
| 降级内存缓存超过容量 | 显式保持 partial，`coveredFromDate/coveredFileCount/pendingFileCount` 反映实际留存分区 |
| 普通 edit/task 的 Daily commit 已成功 | 后续 Catalog/state/materialization 失败只为 pending，不报 saveFailed，不重复正文 |
| 非 authority 设备提交普通正文 mutation | 以 Daily commit 为边界，不需要 shared prepare 或控制权转移 |
| 非 authority 尝试 adoption/manual repair | 无 control permit 或非当前 authority 时拒绝 |
| prepare 已同步且本机 transaction IndexedDB 被清空 | 另一设备按 Daily before/after revision 完成或隔离，不生成第二个 memoId |
| commit 引用的 prepare 尚未同步 | generation 为 `awaiting_data`，prepare 到齐后才 verified |
| 同一 prepare 同时出现 commit 与 abandon | generation 为 `invalid/attention`，不得应用 effects |

## 身份矩阵

| 场景 | 必须结果 |
| --- | --- |
| 同 memo 的历史 binding 再次出现 | 不重新成为 active binding |
| 同 parent 两个不同 rebind | `identity_ambiguous` |
| 同 parent 两个内容相同的重复 rebind | 确定性折叠为一个 active target |
| 两文件出现相同 block ID / tuple | 不得把同一 memo 同时标为 identified |
| create intent 已 flush 后重启/换设备 | 完整 evidence 可从共享 state 恢复 |
| 手工编辑正文后重启 | 唯一 successor 保持原 memoId；外部 rebind 可重建 |
| 手工编辑后复制/移动形成多候选 | 保持 ambiguous，不创建新 memoId |
| legacy preserved memo 显式接管 | 必须通过当前 generation/contract/source permit |
| 其它 memo 插入/删除导致行号移动 | 仅凭 revision transition 中的一对一 preserved evidence 延续身份 |
| transition 只有 revision、没有该 memo 的 evidence 映射 | 保持只读 ambiguous，不凭相同 tuple 自动授予写能力 |

## 双设备与乱序矩阵

每个场景使用两个独立 IndexedDB 和两个可控 Replica Vault，至少覆盖以下投递顺序：

1. bootstrap -> Daily -> registration -> head -> generation；
2. bootstrap -> generation -> head/segment -> Daily；
3. generation -> parent generation；
4. generation -> writer registration；
5. generation -> migration commit -> migration package；
6. A/B 独立 writer tip -> 任意顺序互传 -> merge；
7. A/B 等价 migration commit -> 任意顺序互传 -> merge；
8. A/B 从相同 Daily 独立 projection -> Monthly 字节一致，无 shared receipt；
9. 手工编辑 -> 重启 -> 另一设备接收 rebind；
10. Catalog IndexedDB `versionchange/delete/eviction` -> partial/rebuilding -> 从 Daily 恢复 complete，Vault 共享字节不变。
11. 启动时无 bootstrap -> 不同 `catalogDataRoot` 的 bootstrap 晚到 -> 重绑所有 root-bound store、冻结共享 contract 并按 contract 重扫；
12. migration package 先到 -> 未绑定时忽略 -> commit/generation 到齐后一次生效。
13. A 写 mutation prepare -> Daily 到达 after revision -> 清空 A 的本机 transaction/state IDB -> B 提交 commit/generation；
14. generation/commit 先到 -> prepare 后到 -> 从 `awaiting_data` 转为 verified；
15. authority epoch 1 的旧分支与 epoch 2 transfer 分支乱序互传 -> epoch 2 唯一胜出，旧 authority 的受控操作被 fencing；
16. 同一 Daily revision transition 中在目标 memo 前插入/删除其它 memo -> preserved evidence 随行号变化仍唯一解析。

## 共享字节不变性

分别清空以下本机数据库，然后只执行启动、扫描、查询与恢复：

- Memo Catalog IndexedDB；
- Catalog V2 state IndexedDB；
- Catalog V2 transaction IndexedDB；
- 三者同时清空。

除非存在用户已授权且 durable 的 identity-sensitive operation，以上操作前后的所有 Daily、月度 Markdown、bootstrap、contract、writer、generation 和 migration 字节必须完全相同。Catalog 扫描/重建不再承担 Monthly invalidation；Monthly 由 Daily 事件与自身 stale 检测独立触发。

## 发布门槛

- TypeScript typecheck 通过；
- production build 通过；
- 全量测试通过；
- architecture guard 确认 main 不实例化旧 state transport、shared compaction 或 legacy cleanup；
- protocol guard 确认冻结的 bootstrap/control/state schema 不再包含 Monthly authority、`monthly_projection`、projection receipt 或 period control field；
- 不运行或修改 lint，除非单独授权；
- 人工检查 Daily mutation 测试，确认没有新增身份字符。
