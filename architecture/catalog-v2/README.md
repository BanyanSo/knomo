# Catalog v2 阶段 0 冻结说明

状态：`frozen-v1`

冻结日期：2026-08-09

代码基线：本地 `dev@7e1c53f0aec0e41309ba161e8b8cbb6f4fc6250e`

## 结论

阶段 0 只冻结协议、用户旅程和后续验收门槛，不实现或接入运行时代码。阶段 1 开始前，本文档集是 Catalog v2 的规范来源；如果实现与规范冲突，应先更新规范并重新通过阶段 0 gate，不能在代码中静默改变协议。

本次冻结接受以下边界：

- 同一 Vault 的各终端使用同一版本 Knomo；不支持长期跨版本共存。
- Daily Markdown 是活动正文唯一事实源，扫描和重建不得修改其任何字节。
- `memoId` 是唯一持久身份；路径、标题、行号、时间、正文哈希和既有 block ID 都只是证据。
- 不得为身份识别向 Daily、memo block、frontmatter 或 HTML 注释增加任何 ID、标记或字符。
- Catalog 只存在于设备本地，可删除、可重建，不同步且不拥有事实。
- 旧 index 只读导入；结构与语义校验、冷启动验证和沉降窗口完成后，按精确 allowlist 自动移入 Obsidian 回收站。
- Daily 写入成功就是正文保存成功；同步状态、Catalog 或 Monthly 失败不得把正文显示为保存失败。
- 同步状态缺失或身份歧义只限制对应 memo 的身份操作，不得隐藏当前 Daily 内容。

## 阶段 0 资产

| 资产 | 内容 |
|---|---|
| [protocol-v1.md](protocol-v1.md) | 数据所有权、Observation/ResolvedMemo/StateOperation 契约、序列化和合并语义 |
| [migration-and-cleanup.md](migration-and-cleanup.md) | 升级状态机、迁移提交、不变量和自动清理 allowlist |
| [schemas/migration-package.schema.json](schemas/migration-package.schema.json) | 确定性 migration package 的 JSON Schema |
| [schemas/migration-commit.schema.json](schemas/migration-commit.schema.json) | writer 分离 commit manifest 的 JSON Schema |
| [examples/migration-package.valid.json](examples/migration-package.valid.json) | migration package 有效示例 |
| [examples/migration-commit.valid.json](examples/migration-commit.valid.json) | commit manifest 有效示例 |
| [user-journeys.md](user-journeys.md) | 用户可见状态、文案、交互和无障碍约束 |
| [fixtures.md](fixtures.md) | 历史版本、故障、多端乱序和 30k memo fixture 目录 |
| [performance-benchmark.md](performance-benchmark.md) | 基准数据生成、采样方法、输出和发布门槛 |
| [acceptance-checklist.md](acceptance-checklist.md) | 数据不变量、功能矩阵和阶段 1–6 验收清单 |

## 冻结时补齐的方案空白

优化方案中的方向保持不变，阶段 0 对以下细节作出确定选择：

1. `MemoObservation` 增加任务索引，因为任务 checkbox 是既有功能且任务信息可从 Daily 重建。
2. `awaiting_data` 和 `affected_artifact_attention` 是升级阶段上的正交状态，不会覆盖主阶段。
3. migration package 是源文件内容的确定性函数，不包含源路径、mtime、设备 ID 或生成时间。
4. 同步 segment 在 384 KiB 后轮换，512 KiB 为硬上限；deleted 正文使用独立不可变 payload。
5. 新 `memoId`、`writerId` 和 `opId` 使用至少 128 bit 密码学随机熵；旧 `memoId` 原样接受和保留。
6. 24 小时 quiet window 固定为 v1 初始沉降门槛；它是内部安全门槛，不是用户设置。
7. 30k memo fixture 由固定种子按需生成，不提交 30k 条静态正文，避免仓库膨胀并保证可重复。
8. 自动清理必须以“精确路径 + 当前内容 digest + 已提交 receipt + 编译期分类”四项同时匹配为前提。
9. migration package 文件名同时包含 `artifactKind` 与源 digest，避免不同领域的相同字节竞争同一路径。
10. 同步日志以 32 个 sealed segment 或 16 MiB 为 compaction 触发点；旧 segment 只有在 snapshot 冷启动、hash 和 quiet-window gate 后才可精确退场。

## 阶段 0 gate

- [x] 数据所有权和不可破坏约束已冻结。
- [x] Observation、ResolvedMemo、capabilities 和 StateOperation 已冻结。
- [x] migration package 与 commit manifest Schema 已冻结并提供有效示例。
- [x] 合并语义、升级状态机和同步乱序行为已冻结。
- [x] 自动清理 allowlist 与 denylist 已冻结。
- [x] 用户旅程、中英文文案和无障碍要求已冻结。
- [x] fixture 覆盖与 30k 数据生成规格已冻结。
- [x] 性能采样设计和发布阈值已冻结。
- [x] 当前功能影响矩阵已转为可勾选验收项。
- [x] 阶段 0 未修改 `src/`、`tests/`、`main.js`、`styles.css` 或任何 Daily/Monthly 文件。

阶段 0 完成不代表阶段 1–6 的验收项已经通过；这些条目只在对应实现和真实设备验证完成后勾选。
