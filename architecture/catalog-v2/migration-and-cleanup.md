# Catalog v2 迁移、提交与清理协议

## 1. 原则

1. 旧 index 从新版本第一次启动起只读，不再接受任何写入。
2. 不做 dual write，不存在长期 compatibility mode。
3. 每个旧 artifact 独立 inventory、导入、校验和退场；一个损坏月份不阻塞其他月份。
4. migration package 是旧 artifact 内容的确定性函数，同一字节输入在任意设备产生相同字节输出。
5. 运行时切换与旧文件清理是两个独立 gate；切到 v2 不代表已经允许清理。
6. 用户只看到内容可用性和具体记录动作，不看到内部文件、Schema 或迁移术语。

## 2. 状态模型

主阶段是单向状态机：

```text
legacy_detected
  → importing
  → v2_ready
  → verifying
  → committed
  → settlement
  → legacy_retired
```

`awaiting_data` 和 `affected_artifact_attention` 不是会覆盖主阶段的节点，而是正交状态：

```ts
type UpgradePhase =
  | "legacy_detected"
  | "importing"
  | "v2_ready"
  | "verifying"
  | "committed"
  | "settlement"
  | "legacy_retired";

interface UpgradeStatus {
  phase: UpgradePhase;
  availability: "ready" | "awaiting_data";
  attentionArtifactDigests: string[];
}
```

这样可以表达“当前已经 committed，但某个晚到 generation 仍 awaiting_data”或“其他月份已退场，但一个损坏 artifact 仍需关注”，不会丢失已经完成的阶段信息。

| 主阶段 | 进入条件 | 允许行为 |
|---|---|---|
| `legacy_detected` | 找到 legacy，旧 writer 已冻结 | inventory；最近内容继续从稳定路径或 observation 显示 |
| `importing` | inventory 已创建 | 只读生成 package、deleted payload 或 quarantine receipt |
| `v2_ready` | 当前 inventory 的结构对账通过 | 新写入只走 v2；旧 index 不再是生产读源 |
| `verifying` | v2 materialized view 可用 | 最近优先扫描 Daily，逐文件语义核验 |
| `committed` | manifest 的全部结构、运行时和 Catalog gate 通过 | 只依赖 v2 冷启动；仍不得清理 |
| `settlement` | commit 再次验 hash 且本机冷启动通过 | 观察 quiet window，吸收晚到旧 artifact |
| `legacy_retired` | settlement gate 通过并完成所有可清理 artifact 的 trash receipt | 生产路径只读 v2；unsafe artifact 可带 attention 保留但不得成为读源 |

`availability = awaiting_data` 的进入条件包括：

- 已看到 commit，但任一 required artifact 尚未到达。
- required artifact hash 不匹配或 segment sequence 有缺口。
- Daily 先到但相关 migration/state inventory 尚未追平。

缺片到齐并验 hash 后自动回到 `ready`。`attentionArtifactDigests` 只有在对应文件完成无损导入或用户处理后才能移除。

## 3. Vault 分类

初始化必须区分：

| 分类 | 判定 |
|---|---|
| 新 Vault | 无 legacy、无 v2 commit、无历史 Daily 等待关联的证据 |
| 待升级 Vault | 有 legacy，尚无完整可验证 v2 commit |
| 已升级 Vault | 至少一个 required set 完整且 hash 全通过的 commit |
| 同步等待 Vault | 有历史 Daily 或 commit，但所需 v2 artifact 未到齐 |
| 异常 Vault | legacy/v2 文件不可读、hash 不匹配、同 opId 异内容或存在多个 systemDataRoot |

不得仅凭“旧 index 不存在”将 Vault 判定为新安装。

## 4. Legacy inventory

只读 inventory 至少枚举：

- canonical `indexes/memo-index-YYYY-MM.json`；
- 文件名含明确同步冲突标志的 memo-index 副本；
- `pending-memo-creates.json`；
- memo-index 中 active、deleted、`sourceMemoId`、references 和修复状态；
- plugin data 中 Random Reunion review state；
- `indexes/time-buoy/time-buoy-YYYY-MM.json` 和 `time-buoy-state.json`；
- 旧 repair/candidate 状态与仅由 Knomo 生成的临时文件。

每个 inventory receipt 保存于本机 Catalog，字段固定为：

```ts
interface LegacyArtifactReceipt {
  path: string;
  artifactKind: LegacyArtifactKind;
  byteLength: number;
  mtime: number;
  sha256: string;
  legacySchemaVersion: number | null;
  readableRecordCount: number;
  disposition: "pending" | "imported" | "quarantined" | "retired";
  requiredArtifact: ArtifactRef | null;
  errorCode: string | null;
}
```

`path` 和 `mtime` 只用于本机 inventory 与清理复核，不进入确定性 migration package，也不参与 generation 胜负。

## 5. Migration package

package 必须通过 [migration-package.schema.json](schemas/migration-package.schema.json)，并遵守：

- 文件路径为 `migrations/imports/<artifactKind>-<legacyArtifactDigest>.json`；`artifactKind` 防止两个不同领域的相同原始字节竞争同一路径。
- `(artifactKind, source digest)` 相同但路径不同的副本只生成一个相同 package；inventory 可保留多个 path receipt。
- active/error record 只复制原 `memoId`、legacy record digest 和 last-known evidence，不复制活动正文、标签、图片、统计或 MonthlyRef。
- deleted record 的正文进入独立 deleted payload；package 只保存生命周期摘要和 payload ref。
- relation 只保存显式 `sourceMemoId`。
- legacy review 保存 `reviewCount` 和 `lastReviewedAt`；reducer 将其解释为 `(memoId, ordinal 1..reviewCount)` 的确定性集合，因此多个累计快照合并后取最大覆盖而不是重复相加。
- pending 只保留完成或隔离事务所需的 raw block、Daily 写入 hash 和关系；不迁移 Monthly prepared write。
- Time Buoy、标签、链接、图片、任务、统计和 query 数据不迁移，从 Daily 重建。
- 所有数组按 Schema 规定的 key 排序；package 不包含任何设备或时间相关字段。

部分损坏、无法满足 Schema 或无法证明字段完整的 artifact 不产生伪“成功” package，而在 `migrations/quarantine/<artifactKind>-<legacyArtifactDigest>.json` 产生 quarantine receipt：

```ts
interface QuarantineReceipt {
  kind: "knomo.catalog-v2.quarantine-receipt";
  schemaVersion: 1;
  artifactDigest: string;
  artifactKind: LegacyArtifactKind;
  byteLength: number;
  errorCode: string;
  recoverableRecordCount: number;
  preservedRecordDigests: string[];
}
```

quarantine receipt 允许其他 artifact 继续提交，但不授权清理原文件。

## 6. 结构校验

进入 `v2_ready` 前必须逐 artifact 证明：

- 所有可读旧 `memoId` 在 package 中逐字存在一次。
- package 的 `artifactKind` 与 source digest 分别和 inventory 分类、当前原始字节 SHA-256 一致。
- active/error、deleted、relation、review ordinal、pending 和 diagnostic 数量可对账。
- deleted payload 存在、不可变、可读取且 digest/byteLength 匹配。
- `sourceMemoId` 未丢失。
- pending 已映射为可续跑事务或带明确 quarantine reason。
- 没有即将清理但尚未复制的不可重建字段。
- importer 未写 legacy path，未修改 Daily 或 Monthly。

同一 artifact 在两个设备导入后，package 文件字节和 SHA-256 必须完全相同。

## 7. Daily 语义核验

进入 `verifying` 后最近优先、按 checkpoint 扫描：

1. active legacy `memoId` 能否唯一绑定当前 observation。
2. 是否存在一个 observation 被多个 memoId claim，或一个 memoId 对应多个当前 observation。
3. orphan 是否只是文件尚未同步、rename 或 coverage 未完成。
4. deleted record 是否仍有 Daily block；若有，进入 lifecycle conflict 而非静默隐藏。
5. relation/review 是否能按 memoId 查询。
6. 禁用所有旧 index 读取后，功能 gate 是否仍工作。
7. 扫描前后每个 Daily 的二进制 SHA-256 是否完全一致。

歧义不等于整体失败。只要旧证据和原 memoId 已无损保存，具体 observation 可以保持 ambiguous，原 artifact 仍可在其他清理条件满足后退场。

## 8. Commit manifest

manifest 必须通过 [migration-commit.schema.json](schemas/migration-commit.schema.json)。每个 writer 写自己的不可变文件：

```text
migrations/commits/commit-<generationDigest>-<writerId>.json
```

### 8.1 Generation descriptor

`generationDigest` 的输入固定为：

```ts
interface GenerationDescriptor {
  schemaVersion: 1;
  importerVersion: 1;
  legacySources: Array<{
    artifactDigest: string;
    artifactKind: string;
    disposition: "imported" | "quarantined";
    receiptSha256: string;
  }>;
  requiredArtifacts: Array<{
    artifactKind: string;
    path: string;
    sha256: string;
    byteLength: number;
  }>;
  domainCounts: DomainCounts;
}
```

排序规则：

- `legacySources` 按 `artifactDigest + artifactKind + disposition + receiptSha256` 升序。
- `requiredArtifacts` 按 `path + artifactKind + sha256` 升序。
- 使用 [protocol-v1.md](protocol-v1.md) 的 canonical JSON，不加末尾 LF 后计算 SHA-256。
- `writerId`、`committedAt` 和 `verification` 不参与 digest。

不同设备对相同 required set 得到相同 generationDigest，但可以各自写包含本机验证证明的 commit。晚到未见 artifact 必须生成包含旧输入并集的新 generation，不能覆盖旧 commit。

### 8.2 Commit gate

只有同时满足以下条件才能写 commit：

- 当前 inventory 每个 legacy artifact 都有 import receipt 或明确 quarantine receipt。
- 所有 required artifacts 存在且 path、sha256、byteLength 全匹配。
- active identity、deleted、relation、review ordinal、pending、diagnostic 数量通过。
- `MemoIndexStore` 读取被测试 gate 禁用时，当前阶段已切功能仍通过。
- 当前设备完成一次只依赖 v2 的冷启动。
- 当前 Catalog coverage 为 complete；每个 failed path 有明确 attention disposition。
- 旧 index writer 已从生产路径移除。
- Daily hash 守卫无变化。

commit 必须最后写入；禁止使用独立 `completed: true` 替代以上证明。

### 8.3 Commit 选择

设备只承认 required set 完整且全部验 hash 的 generation。不得按文件名、mtime 或 `committedAt` 选择“最新”。多个完整 generation 同时存在时：

1. source key 定义为 `(artifactKind, artifactDigest)`；只考虑 source key 集合是另一集合严格超集的 generation。
2. 存在唯一最大完整超集时选择它。
3. 存在不可比较的完整集合时合并 inventory，生成并验证新 generation。
4. 任一 required artifact 缺失时保持现有完整 generation 可读，并对新增 generation 标记 `awaiting_data`。
5. source key 集合相同但 receipt/package hash 不同表示 importer 或同步完整性冲突；两个 generation 都不得自动胜出，必须 quarantine 并重新确定性导入。

## 9. Settlement

进入 `settlement` 后，当前设备必须同时满足：

- 至少完成一次只依赖 v2 的冷启动。
- 当前 generation 的 required artifacts 再次验 hash 通过。
- 本机 outbox 和 migration queue 为空。
- 没有会授权错误清理的未处理 attention。
- inventory 中所有可清理 legacy path 在连续 24 小时内未新增、未改动且 digest 未变化。

24 小时从本机最后一次观察到 legacy inventory 变化后重新计算，不依赖跨设备时钟，也不表示全局同步完成。窗口内发现晚到 artifact 时：

1. 重新读取并计算 digest。
2. 已有相同 `(artifactKind, digest)` receipt 时幂等关联该 path。
3. 新 digest 生成 package 或 quarantine receipt。
4. 重新结构/语义校验并写新 generation commit。
5. 重置 quiet window。

## 10. 自动清理 allowlist

清理器不得接收任意 path 或 glob。调用方只能传递编译期 `LegacyCleanupClass` 和已经验证的 `LegacyArtifactReceipt`。

每次 trash 前必须重新满足四项：

1. receipt 中是精确 Vault path，不是目录扫描结果的宽泛模式。
2. 当前文件重新读取后的 SHA-256 与 receipt 完全一致。
3. receipt 引用的 package/commit 已完整、已验 hash，且该 artifact disposition 为 imported。
4. path 与以下 allowlist 分类的 parent、文件名和类型全部匹配。

| 分类 | 精确 parent | 文件名规则 | 附加条件 |
|---|---|---|---|
| `legacy_memo_index` | `<systemDataRoot>/indexes` | `^memo-index-\d{4}-\d{2}\.json$` | schema/period 可读并已导入 |
| `legacy_memo_index_conflict` | `<systemDataRoot>/indexes` | `memo-index-YYYY-MM` 前缀、`.json` 后缀且文件名含 `conflict`、`conflicted`、`sync-conflict` 或 `冲突` | 每个副本有独立 path+digest receipt；不能用宽泛 suffix |
| `legacy_time_buoy_shard` | `<systemDataRoot>/indexes/time-buoy` | `^time-buoy-\d{4}-\d{2}\.json$` | 已确认纯派生，可从 Daily 重建 |
| `legacy_time_buoy_state` | `<systemDataRoot>/indexes/time-buoy` | `^time-buoy-state\.json$` | 已确认纯派生 |
| `legacy_time_buoy_conflict` | `<systemDataRoot>/indexes/time-buoy` | 合法 shard/state 前缀、`.json` 后缀且含明确冲突标志 | 已 inventory；不作为事实导入 |
| `legacy_pending_create` | `<systemDataRoot>` | `^pending-memo-creates\.json$` | 每条 pending 已完成、转入 outbox 或隔离；无未保存正文 |
| `v2_migration_temp` | `<systemDataRoot>/v2/tmp/migration-<runId>` | 仅本次运行 creation receipt 中的精确文件 | generation 已 committed；这不是 legacy backup |

清理动作固定使用 `FileManager.trashFile()`。文件成功移入 Obsidian 回收站后写本机 retired receipt；失败保留原 receipt 并重试，不将阶段伪装成已清理。

### 10.1 永久 denylist

以下对象不论名称如何都不得被自动清理：

- 任意 Daily Markdown；
- 任意 Monthly Markdown；
- 附件或用户内容目录；
- `<systemDataRoot>/v2/state` 中未被完整 compaction commit 精确覆盖的 segment/snapshot、任意未 purge deleted payload，以及 `migrations/imports`/`migrations/commits`；
- `<systemDataRoot>/backups` 及用户自建 backup/copy 文件；
- 未无损导入或 digest 已变化的 legacy artifact；
- 无法证明由 Knomo 创建的文件；
- `systemDataRoot`、Vault 根、Monthly 根或任何宽泛目录。

旧目录为空时，只能按从叶到根的已知精确目录逐个确认空目录后清理；不得递归删除。`_knomo-system` 根和 `backups` 永不由本次清理器删除。

## 11. 多端乱序结果

| 到达顺序 | 必须结果 |
|---|---|
| Daily → identity | 立即显示 observed；不批量新建 memoId；state 到达后补齐 capability |
| identity → Daily | 保留 missing binding；不显示旧正文，不自动 delete |
| commit → package/payload | 新 generation 标为 awaiting_data；只有 required set 齐全后启用 |
| legacy 删除 → migration package | Daily 仍可浏览；既有身份操作暂时受限；package 到达后恢复 |
| purge → deleted payload | tombstone 记录 pending cleanup；payload 晚到立即精确清理 |
| 同一 legacy artifact 多端重复导入 | 相同 package bytes；多个 writer commit 幂等并存 |
| 晚到新 legacy 冲突副本 | 新 digest 进入 inventory，生成新 generation，重置 settlement |

任何乱序都不得生成重复 memoId、修改 Daily、用 Monthly 恢复正文或把缺失状态解释为删除。
