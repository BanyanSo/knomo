# Catalog v2 协议 v1

本文是 Catalog v2 的规范性协议。文中的“必须”“不得”和“仅”是实现约束，不是建议。

## 1. 数据所有权

| 数据 | 事实所有者 | 物理位置 | 同步 | 可重建 |
|---|---|---|---:|---:|
| 活动正文 | Daily | Daily Markdown | 是 | 否 |
| `memoId` | Synced memo state | writer 分离事件段与迁移包 | 是 | 否 |
| 当前路径、section、行号、revision、hash | Observation | 本机 Catalog | 否 | 是 |
| 标签、链接、图片、任务、Time Buoy | Daily | 本机解析索引 | 否 | 是 |
| 搜索、筛选、分页、统计 | Query | 本机 Catalog | 否 | 是 |
| 删除正文 | Lifecycle | 按 `deleteOpId` 命名的不可变 payload | 是 | 否 |
| `sourceMemoId` | Relation | 同步事件段与迁移包 | 是 | 否 |
| Random Reunion review | Review | 同步事件段与迁移包 | 是 | 否 |
| Shuffle Day history | Device preference | 本机 plugin data | 否 | 可丢失 |
| Monthly | Projection | Monthly Markdown | 是 | 是 |
| Pending/outbox | Transaction recovery | 当前设备本地持久存储 | 否 | 完成后可删 |
| 旧 memo-index | Legacy import source | 旧系统目录 | 临时 | 导入后退场 |

所有实现都必须满足：

1. Daily 正文不得因扫描、迁移、Catalog 重建或身份解析发生任何字节变化。
2. 不得为身份识别新增 block ID、HTML 注释、frontmatter、隐藏字符或其他正文标记。
3. 已存在的 Obsidian block ID 可以作为证据读取，但不得由 Catalog builder 或 Resolver 创建。
4. 页面正文只读当前 `MemoObservation.content`；旧 index 的 `contentSnapshot` 只能由 importer 读取，不能成为页面正文来源。
5. Monthly、Catalog、统计和搜索索引不得拥有 `memoId` 或反向覆盖 Daily。

## 2. 路径与数据根

v1 的同步布局为：

```text
<systemDataRoot>/v2/
  manifest.json
  state/
    writers/<writerId>/segment-000001.jsonl
    snapshots/<sourceWriterId>/snapshot-<firstSequence>-<lastSequence>-<snapshotDigest>.json
    compactions/commit-<snapshotDigest>-<committingWriterId>.json
    deleted/<memoId>/<deleteOpId>.json
  migrations/
    imports/<artifactKind>-<legacyArtifactDigest>.json
    commits/commit-<generationDigest>-<writerId>.json
    quarantine/<artifactKind>-<legacyArtifactDigest>.json
  tmp/
    migration-<runId>/...
```

`systemDataRoot` 遵循以下规则：

- 老 Vault 首次升级时继承当前 legacy `_knomo-system` 所在根目录。
- 新 Vault 从规范化后的当前设置生成一次初始根目录。
- 初始化后将该根写入同步的内部 manifest 并冻结。
- Monthly 输出目录变化只影响 Monthly，不隐式移动 v2 状态。
- 新设备必须先读取同步设置和 v2 manifest；存在多个候选根时进入诊断，不创建第二套身份域。
- 所有 Vault 路径都使用 `/`、移除开头 `/`、拒绝 `.`、`..`、NUL 和反斜杠，并在 Obsidian API 边界调用 `normalizePath()`。

`v2/manifest.json` 是无时间字段的确定性文件：

```ts
interface CatalogV2Manifest {
  kind: "knomo.catalog-v2.manifest";
  schemaVersion: 1;
  protocolVersion: 1;
  systemDataRoot: string;
}
```

相同规范化输入必须产生相同 manifest bytes。manifest 不包含设备 ID、当前时间或 Monthly 输出路径；同一路径出现不同合法 manifest 时进入完整性诊断，不能按 mtime 选择。

## 3. ID、digest 与确定性序列化

### 3.1 ID

- 既有 `memoId` 必须逐字保留；旧 ID 只要求非空、没有路径分隔符或控制字符。
- 新 `memoId` 格式为 `m_<32 lowercase hex>`。
- `writerId` 格式为 `w_<32 lowercase hex>`，只保存在设备本地，不随 plugin settings 同步。
- `opId` 格式为 `o_<32 lowercase hex>`。
- 新 ID 的 32 个 hex 字符必须来自至少 128 bit 的密码学安全随机数；不得使用时间戳加短随机数。
- migration package 中的确定性 entry ID 可以使用 `l_<64 lowercase hex>`，其输入和计算规则必须由对应 importer 版本固定。

### 3.2 Digest

- 所有协议 digest 使用 SHA-256 小写 64 位 hex，不带算法前缀。
- `legacyArtifactDigest` 是旧 artifact 原始字节的 SHA-256；文件名同时携带 `artifactKind` 作为领域分隔。
- `sourceRevision` 是完整 Daily 原始字节的 SHA-256；它只用于并发和失效检测，并覆盖 BOM 与原始换行差异。
- `contentHash` 延续稳定版 `hashMemoContent()` 语义：换行规范为 LF，忽略首行或最后有效行中已存在的 trailing block ID，再计算 `fnv1a-<8 lowercase hex>`。它只是快速匹配证据，不具备防碰撞或身份权威性。
- artifact `sha256` 是最终文件原始字节的 SHA-256。

### 3.3 确定性 JSON

需要跨设备生成相同内容的文件使用以下 canonical JSON：

1. UTF-8，无 BOM。
2. object key 按 Unicode code point 递归升序。
3. array 必须先按各 Schema 规定的业务 key 排序；不得依赖文件枚举顺序。
4. 不输出无意义空白，文件末尾恰好一个 LF。
5. 禁止 `NaN`、`Infinity`、`undefined`、本地绝对路径和 locale-dependent 数字或日期格式。
6. migration package 禁止包含 mtime、源路径、writerId、生成时间和设备名。

`generationDigest` 只覆盖 generation descriptor，排除 `writerId`、`committedAt` 和设备验证耗时；具体计算见 [migration-and-cleanup.md](migration-and-cleanup.md)。

## 4. Observation 契约

```ts
type MemoImageSyntax = "obsidian_embed" | "markdown_image";
type MemoLinkSyntax = "wiki_link" | "markdown_link" | "url";

interface MemoLinkRef {
  target: string;
  displayText: string | null;
  syntax: MemoLinkSyntax;
}

interface MemoImageRef {
  path: string;
  altText: string;
  syntax: MemoImageSyntax;
}

interface MemoTaskRef {
  taskIndex: number;
  lineOffset: number;
  marker: string;
  text: string;
}

interface MemoObservation {
  sourcePath: string;
  sourceRevision: string;
  logicalDate: string;
  section: string | null;
  startLine: number;
  endLine: number;
  time: string;
  content: string;
  contentHash: string;
  existingBlockId: string | null;
  tags: string[];
  links: MemoLinkRef[];
  images: MemoImageRef[];
  tasks: MemoTaskRef[];
  timeBuoyDates: string[];
}
```

字段语义：

- `sourcePath` 是规范化的 Vault 相对路径。
- `logicalDate` 是由 Daily 配置和文件路径解析出的 `YYYY-MM-DD`，不是文件 mtime。
- `section` 为包含 Markdown `#` 前缀的原始 heading 行；root memo 为 `null`。
- `startLine` 与 `endLine` 均为 0-based、inclusive，指向当前 `sourceRevision`。
- `time` 保留 Daily 中解析到的 `HH:mm` 或 `HH:mm:ss` 文本。
- `content` 是去掉 memo 顶层列表标记和时间后的 Markdown 正文，保留内部换行、缩进、任务、代码和已有 block ID。
- `existingBlockId` 只报告正文中已经存在的 Obsidian block ID。
- 派生数组去重并使用稳定源码顺序；它们不写入同步状态。

Observation 没有持久 ID，不跨设备同步。文件 revision 改变时，只替换该文件的 observations 与聚合；rename/delete 必须使旧路径分区失效，不能留下幽灵 memo。

## 5. 页面统一模型与 capabilities

```ts
type IdentityWriteMode =
  | "ready"
  | "adopt_then_retry"
  | "blocked_settling"
  | "blocked_ambiguous";

interface MemoCapabilities {
  view: true;
  copy: true;
  openDaily: true;
  openLinks: true;
  edit: IdentityWriteMode;
  toggleTask: IdentityWriteMode;
  delete: IdentityWriteMode;
  createReference: IdentityWriteMode;
  recordReview: IdentityWriteMode;
}

interface IdentityCandidate {
  memoId: string;
  evidence: IdentityEvidence;
  reasons: string[];
}

type ResolvedMemo =
  | {
      kind: "identified";
      memoId: string;
      observation: MemoObservation;
      capabilities: MemoCapabilities;
    }
  | {
      kind: "observed";
      observation: MemoObservation;
      adoption: "eligible" | "settling" | "historical_readonly";
      capabilities: MemoCapabilities;
    }
  | {
      kind: "ambiguous";
      observation: MemoObservation;
      candidates: IdentityCandidate[];
      capabilities: MemoCapabilities;
    };
```

capability 映射固定为：

| 状态 | 身份写操作 |
|---|---|
| `identified` 且 state 完整 | `ready` |
| `observed` 且 adoption 条件满足 | `adopt_then_retry` |
| `observed` 且相关 state、migration 或 segment 未完成 | `blocked_settling` |
| `observed` 且属于未请求的历史范围 | `blocked_settling`，不得批量 adoption |
| `ambiguous` | `blocked_ambiguous` |

`view`、`copy`、`openDaily` 和 `openLinks` 永远可用。`adopt_then_retry` 执行前必须重读 state、重新解析当前文件、确认 observation 唯一，然后写 claim 并以 durable identity 重试原动作。页面不得把三种状态拆成不同 feed，也不得将 observation 适配回旧的全能 `MemoRecord` 后执行操作。

## 6. Identity evidence

```ts
interface IdentityEvidence {
  sourcePath: string;
  sourceRevision: string;
  logicalDate: string;
  section: string | null;
  startLine: number;
  endLine: number;
  time: string;
  contentHash: string;
  existingBlockId: string | null;
}
```

evidence 是匹配依据，不是第二身份。`sourceRevision` 与行号只有在同一文件 revision 中有效；路径、section、时间、hash 和 block ID 也不能单独证明身份。

## 7. StateOperation 契约

```ts
interface ArtifactRef {
  path: string;
  sha256: string;
  byteLength: number;
}

interface StateOperationBase {
  schemaVersion: 1;
  writerId: string;
  sequence: number;
  opId: string;
  memoId: string;
  occurredAt: string;
}

type StateOperation =
  | StateOperationBase & {
      type: "identity.claim";
      baseEvidence: null;
      payload: {
        evidence: IdentityEvidence;
        origin: "plugin_create" | "manual_adoption";
        createIntentOpId: string | null;
      };
    }
  | StateOperationBase & {
      type: "identity.rebind";
      baseEvidence: IdentityEvidence;
      payload: {
        evidence: IdentityEvidence;
        reason: "edit" | "rename" | "move" | "restore" | "manual_resolution";
      };
    }
  | StateOperationBase & {
      type: "identity.redirect";
      baseEvidence: null;
      payload: {
        toMemoId: string;
        reason: "duplicate_resolution" | "manual_resolution";
      };
    }
  | StateOperationBase & {
      type: "lifecycle.create_intent";
      baseEvidence: null;
      payload: {
        targetPath: string;
        logicalDate: string;
        time: string;
        contentHash: string;
        sourceMemoId: string | null;
      };
    }
  | StateOperationBase & {
      type: "lifecycle.create_abandon";
      baseEvidence: null;
      payload: {
        createIntentOpId: string;
        reason: "daily_write_failed" | "user_cancelled";
      };
    }
  | StateOperationBase & {
      type: "lifecycle.delete";
      baseEvidence: IdentityEvidence;
      payload: {
        deleteOpId: string;
        deletedPayload: ArtifactRef;
      };
    }
  | StateOperationBase & {
      type: "lifecycle.restore";
      baseEvidence: null;
      payload: {
        deleteOpId: string;
        evidence: IdentityEvidence;
      };
    }
  | StateOperationBase & {
      type: "lifecycle.purge";
      baseEvidence: null;
      payload: {
        deleteOpId: string;
      };
    }
  | StateOperationBase & {
      type: "relation.set_source";
      baseEvidence: null;
      payload: {
        sourceMemoId: string | null;
        supersedesRelationIds: string[];
      };
    }
  | StateOperationBase & {
      type: "review.record";
      baseEvidence: null;
      payload: {
        reviewedAt: string;
      };
    };
```

通用约束：

- `sequence` 在一个 writer 分支内从 1 严格递增，只提供缺口检测和该 writer 内顺序，不提供跨 writer 全序。
- `occurredAt` 与 `reviewedAt` 使用 ISO 8601，仅用于诊断、显示和 review 的最大有效时间；不得决定身份或生命周期冲突胜负。
- `identity.claim` 不允许以 `legacy_import` 作为 origin；旧身份只能来自不可变 migration package，避免重复写 state journal。
- 一个正常 delete 事务中 `deleteOpId` 等于该 `lifecycle.delete` 的 `opId`；legacy deleted entry 使用 migration package 自己的确定性 ID。
- `relation.set_source` 的 `supersedesRelationIds` 只能列出当前 materialized view 中已观察到的 relation operation/legacy entry ID。`sourceMemoId = null` 表示显式清除这些已观察关系；未被列出的并发关系继续存在并进入 attention。
- 任何 operation 都不得携带活动正文。

## 8. Deleted payload

deleted payload 是唯一允许保存已从 Daily 移除正文的同步文件，其最小逻辑契约为：

```ts
interface DeletedMemoPayload {
  kind: "knomo.catalog-v2.deleted-payload";
  schemaVersion: 1;
  memoId: string;
  deleteOpId: string;
  deletedAt: string;
  sourcePath: string;
  logicalDate: string;
  section: string | null;
  rawBlock: string;
  contentHash: string;
  sourceMemoId: string | null;
}
```

payload 写入成功并重新读取验 hash 后，才允许修改 Daily。payload 创建后不可改；重复 delete 必须生成新的 `deleteOpId` 和新 payload。Monthly block 不进入 payload。purge tombstone 到达后，当前或晚到的对应 payload 都必须被精确清理；Knomo 不承诺擦除同步服务或 Obsidian 回收站保存的历史版本。

## 9. Writer transport

1. 每台设备只写自己的当前 segment，并通过 `Vault.process()` 串行追加。
2. 当前 segment 达到 384 KiB 后，在下一条 operation 前轮换；任何 segment 不得超过 512 KiB。
3. 单条 operation 若导致超过硬上限，拒绝写 segment 并保留本机 outbox；正文保存边界不因此回滚。
4. 封存 segment 不可修改。快照只能加速物化，必须列出所覆盖 segment 的 path 与 digest，不能据此自动删除原事件。
5. 本机按 path、hash、size 和已消费 sequence 保存 checkpoint，只读取新增或变化的文件。
6. canonical 与所有可能的同步冲突副本都作为输入；不能先选择一个“最新文件”。
7. 同 `opId` 同 canonical 内容幂等去重；同 `opId` 不同内容全部进入 quarantine。
8. 同 `writerId + sequence` 出现不同 operation 表示 writer 分叉：保留两条分支作为输入，本机立即生成新 writerId，不能覆盖任一分支。
9. sequence 缺口只把受影响 materialized view 标为 `awaiting_data`，不得隐藏 Daily observation。
10. 冲突文件名、mtime 和设备时钟只用于 inventory 与诊断，不参与 merge。

### 9.1 Snapshot 与 compaction

checkpoint 解决启动回放，compaction 约束长期增长。任一 writer 累积 32 个未压缩 sealed segment 或 16 MiB sealed bytes 时触发确定性 snapshot 候选：

```text
state/snapshots/<sourceWriterId>/snapshot-<firstSequence>-<lastSequence>-<snapshotDigest>.json
state/compactions/commit-<snapshotDigest>-<committingWriterId>.json
```

规则固定为：

1. 只压缩某个 source writer 的连续 sequence 范围；存在缺口、分叉、opId collision 或未解决 quarantine 时不得压缩该范围。
2. snapshot 必须保存 covered segment 的精确 path/digest、每个 opId 的 canonical operation digest、全部仍影响结果的 claim/rebind/lifecycle/relation/review/redirect 状态和 tombstone；不得保存活动正文或 Catalog 数据。
3. 同一 covered set 在任意设备生成逐字节相同 snapshot；snapshot 文件不可变。
4. compaction commit 引用 snapshot path/hash 和全部 covered segment path/hash。commit 先到但 snapshot 未到时为 `awaiting_data`。
5. 至少一次仅用 snapshot + 后续 segments 的冷启动通过、required hashes 再验通过并经历 24 小时 quiet window 后，才可用 `FileManager.trashFile()` 精确退场 covered segments。
6. segment 删除先到、snapshot 后到时，只降低相关身份 capability；Daily observation 继续显示，禁止重新生成既有 memoId。
7. 新 snapshot 可以覆盖旧 snapshot 与后续连续 segments；旧 snapshot 的退场使用相同 commit、hash 和 quiet-window 规则，不能按文件名保留“最新”。
8. 没有完整 compaction commit 时，snapshot 只能加速本机恢复，不能授权删除任何 segment。

## 10. Merge semantics

| 输入 | reducer 规则 | 冲突结果 |
|---|---|---|
| identity claim | 同 `memoId + evidence` 幂等；以文件 revision 为单位做一对一分配 | 一个 observation 被多个 memoId claim 或一个 memoId 同时绑定多个当前 observation 时为 ambiguous |
| identity rebind | 只在 `baseEvidence` 仍能唯一对应旧 observation 时应用 | 并发 rebind 重新针对当前 Daily 解析，不 LWW |
| identity redirect | 展开 redirect 后不得成环；同来源同目标幂等 | 同来源多个目标或任何环进入 quarantine |
| create intent | 形成 missing binding；不进入活动 feed | Daily 未到达时保留等待；claim 到达后完成 |
| create abandon | 只取消其明确引用且尚未被 claim 的 intent | 与有效 claim 并存时保留 claim 并记录诊断 |
| delete | 记录 delete intent 与 payload；Daily block 仍存在时不得直接隐藏 | 与同一 base revision 的 edit/rebind 并发时为 lifecycle conflict |
| restore | 必须引用一个已知 delete；恢复后以同一 memoId 绑定新 observation | 多个相同 restore 幂等；不同正文版本需要用户选择 |
| purge | 对明确 `deleteOpId` 建立永久 tombstone | 先到或 payload 晚到都最终清理该 payload；不影响其他 delete 版本 |
| review | v2 `opId` 做集合并集；legacy review 用 memoId + ordinal 的确定性集合 | `reviewCount` 为唯一事件数，`lastReviewedAt` 取最大有效值 |
| source relation | 相同值幂等；set/clear 只 supersede 明确列出的已观察 relation ID | 未列出的并发不同非空值继续存在并进入 relation attention，不猜测 |

缺失 state、损坏 segment、未完成 migration 或 reducer attention 都只能降低对应 capability。Daily 中当前可解析的 memo 必须继续以 `observed` 或 `ambiguous` 显示。

## 11. Resolver

Resolver 以一个文件 revision 的全部 observations 为匹配单元，执行一对一分配。证据优先级固定为：

1. 当前设备 outbox 中明确写入意图。
2. 同一文件连续 revision 的 observation 映射。
3. 已存在的 Obsidian block ID。
4. v2 claim/rebind 历史。
5. migration package 的旧 memoId 与 last-known evidence。
6. `logicalDate + time + contentHash`。
7. path、section 和 line proximity 只能增加置信度。

以下规则不可放宽：

- 任一方向不是一对一时进入 ambiguous。
- 文件暂时缺失、rename、同步未完成或 parser coverage 不完整不等于 delete。
- 只有显式 `lifecycle.delete` 才能产生删除状态。
- observation 不得在发现时自动获得 memoId。
- 当前设备 create intent 可立即完成 claim。
- 手写 Daily memo 只有在 state inventory 已追平、无 `awaiting_data`、当前 revision 稳定、无任何候选且该 observation 唯一时，才允许在用户首次身份操作中 adoption。
- 历史扫描不得批量 adoption；必须保留为 observed。用户明确发起身份操作后可以重新执行完整 settlement 检查，满足唯一条件时才转为 `adopt_then_retry`。

## 12. Daily 写入成功边界

创建顺序固定为：

```text
生成高熵 memoId/opId
→ 写设备本地 PendingCreate
→ 尽力追加 create intent
→ 使用 Editor API 或 Vault.process() 写 Daily
→ 重读并解析当前文件，更新本机 Catalog
→ 向用户返回正文已保存
→ outbox 异步提交 identity claim 和 Monthly 投影
```

实现必须遵守：

- 活动编辑器使用 Editor API；后台 Daily 使用 `Vault.process()`。
- 删除文件使用 `FileManager.trashFile()`，不得直接调用 `Vault.delete()`。
- Pending 或 create intent 失败不能阻止正文保存；此时正文作为 observed 显示，稍后安全 adoption。
- Daily 写入失败时追加 abandon；未完成 intent 不进入 feed。
- Daily 成功后，v2 state、Catalog 派生或 Monthly 失败不得返回“正文保存失败”。
- identity 未 durable 时，引用、删除和 review 等身份操作必须等待或明确降级。
- 所有用户路径进入 Obsidian API 前统一 `normalizePath()`。
- 不 dual write 旧 index。

## 13. Monthly 与其他投影

- 同一设备按 Monthly path 串行；多次变化 debounce 后合并。
- 相同 Daily/Catalog 输入必须生成逐字节相同输出和语义 hash。
- 输出不得包含当前时间、writerId、设备名或随机值。
- coverage 不完整时，不得全量覆盖该月份。
- 写入前重新读取并使用 `Vault.process()` 合并。
- 冲突副本出现后，只能以完整 Daily 月份 snapshot 重建 canonical。
- Monthly 冲突、失败或删除不得反向改变 Daily、memoId 或生命周期。
- Time Buoy、统计、标签和查询全部由 Daily observation 重建，不进入同步事实。
