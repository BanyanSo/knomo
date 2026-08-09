# Catalog v2 性能基准脚本设计

## 1. 目标

基准必须回答四个问题：

1. 最近内容是否在大 Vault 中仍可快速打开和记录。
2. 搜索、分页和统计是否走真实索引而不是全库数组扫描。
3. 移动端后台构建是否可暂停、可续跑且没有明显长任务。
4. v2 写入和同步日志是否避免整库重写。

Node 基准用于可重复回归和定位，不替代真实 Obsidian Desktop、iOS 和 Android 发布采样。

## 2. 计划中的脚本边界

阶段 1 实现以下脚本；阶段 0 只冻结输入、输出和测量方法：

```text
scripts/catalog-v2/generate-benchmark-vault.ts
scripts/catalog-v2/run-node-benchmarks.ts
scripts/catalog-v2/summarize-device-traces.ts
```

预期命令接口：

```text
npm run benchmark:catalog:generate -- --profile perf-30k --output <temp-path>
npm run benchmark:catalog:node -- --vault <temp-path> --output <result.json>
npm run benchmark:catalog:summarize -- --input <trace-directory> --output <summary.json>
```

脚本只可写用户明确传入的临时输出目录，不得默认写 Vault、`src/` 或 fixture 源。生成目录必须含 marker 文件，清理脚本只能清理带该 marker 的精确目录。

## 3. `PERF-30K` 确定性数据

### 3.1 固定参数

| 参数 | 值 |
|---|---:|
| seed | `knomo-catalog-v2-30k-v1` |
| Daily 数量 | 1500 |
| 每个 Daily memo 数量 | 20 |
| active observations | 30000 |
| logical date 起点 | `2022-07-01` |
| 默认 Daily 目录 | `Journal/Daily` |
| 默认日期格式 | `YYYY/MM/YYYY-MM-DD` |
| 默认 heading | `## Memos` |
| 首页 page size | 50 |
| query prefetch window | 当前页前后各 1 页 |

另生成 1000 条不计入 30000 active observations 的同步状态：400 deleted、200 relation、300 review、100 pending/attention，用于状态回放和迁移压力。

### 3.2 内容分布

以下维度可重叠，并由 seed 决定：

| 维度 | 比例/数量 |
|---|---:|
| 单行纯文本 | 至少 40% |
| 多行/嵌套列表 | 20% |
| task memo | 15% |
| 标签 | 35% |
| WikiLink/Markdown link/URL | 25% |
| 图片引用 | 10% |
| Time Buoy `@date` | 8% |
| fenced code | 5% |
| 已有 Obsidian block ID | 5% |
| 同一 Daily 同时间 | 每日 2 对 |
| 同正文不同时间 | 每月 10 组 |
| 同时间同正文 | 每月 5 组 |
| root memo | 5% |
| CRLF 文件 | 10% |

图片只生成引用，不复制图片二进制。代码块中必须包含 task、link、image、Time Buoy 和伪 memo 文本，用于验证索引排除。

### 3.3 历史状态

- 旧 index 输入按 `1.1.1`、`1.2.0` 和 `1.2.9` 三个真实 tag 的格式分片。
- 至少 10 个 period 同时存在 canonical 和 2 个不同 digest 的冲突副本。
- 5 个 artifact 含可恢复的记录级错误，2 个 artifact 为截断 JSON。
- 两个 device delivery schedule 使用相同 operation 集合的不同固定 permutation。
- 生成前后输出一个 manifest，记录 seed、生成器版本、文件数、memo 数、状态数和全部 Daily SHA-256。

## 4. 测量点

所有计时使用 monotonic clock；设备时间只写诊断元数据。

| metric key | 起点 | 终点 |
|---|---|---|
| `startup.warm.firstInteractiveMs` | 插件 `onload` 开始 | 输入框可聚焦、首屏 30–50 卡片可滚动且点击有效 |
| `startup.coldRecent.firstInteractiveMs` | 删除本机 Catalog 后 `onload` 开始 | 最近首屏可操作，不等待历史 |
| `save.dailyFeedbackMs` | 用户 submit handler 进入 | Daily 成功、当前 observation 更新并显示保存反馈 |
| `search.firstBatchMs` | debounce 完成后 Query API 收到请求 | 第一批稳定 query snapshot 提交 UI |
| `search.userVisibleMs` | 最后一次输入事件 | 第一批稳定结果提交 UI，单独记录 debounce |
| `query.nextPageMs` | 请求下一 cursor | 下一页结果提交 UI |
| `stats.firstViewMs` | 打开统计页 | aggregate 首屏可交互 |
| `background.sliceMs` | 单个 scheduler slice 开始 | checkpoint 前让出主线程 |
| `journal.incrementalReplayMs` | 打开 checkpoint 后 | 消费新增/变化 segment 完成 |
| `monthly.affectedPeriodMs` | 受影响月份任务开始 | 相同语义 hash 跳过或完成单 period 写入 |

同时记录：

- 启动期间读取的 Daily path 数量和是否属于最近范围。
- 每个 query 的 IndexedDB cursor 数、反序列化 observation 数和返回数。
- UI 常驻 observation/ResolvedMemo 对象峰值。
- segment 写入前后字节数与轮换次数。
- 50ms 以上 long task 的数量和最长时长。
- 每个后台 checkpoint 的文件计数与恢复位置。

## 5. 采样协议

### 5.1 Node 回归

- 生成 fixture 后校验 manifest 和 Daily SHA-256。
- parser、索引写入、query、分页、aggregate、checkpoint 和 journal replay 各预热 5 次，正式 30 次。
- search 使用 20 个固定 query，每个重复 5 次；query 包含中文、英文、标签、链接、无结果和高命中词。
- 分页连续读取至少 50 页，并在中途修改一个非当前页 Daily，验证 snapshot 失效续接。
- 结果输出 raw samples、P50、P95、max、读取数量和环境信息。

### 5.2 Desktop

- debug/release-like 构建关闭无关开发日志。
- 暖启动 30 次；冷缓存最近首屏 20 次；保存 50 次；search query 共 100 次；翻页 50 次。
- 每组前 3 次只用于预热，不计入分位数。
- 与同机、本地 `dev@7e1c53f`、相同 Vault 的保存反馈对比。

### 5.3 iOS 与 Android

- 各至少选择一台发布支持范围内的真实设备；记录设备型号、OS、Obsidian 版本、Knomo commit、Vault 同步方式和电源状态。
- 暖启动 20 次、冷缓存 10 次、保存 30 次、search 50 次、分页 30 次。
- 至少 5 次在后台批次中途切后台，3 次强制结束应用后重启。
- 禁止用模拟器或 Node 数字替代发布 gate；模拟器结果只作诊断。

P95 使用 nearest-rank 法。任何样本发生功能错误、结果不完整或触发全库 fallback，都记为失败样本，不得从统计中删除。

## 6. 发布阈值

| 指标 | 移动端 | Desktop |
|---|---:|---:|
| 暖缓存打开到首屏可操作 P95 | `< 800ms` | `< 500ms` |
| 冷缓存最近首屏 P95 | `< 1.5s` | `< 1.0s` |
| 保存正文反馈 P95 | 不劣于稳定 dev 10% | 不劣于稳定 dev 10% |
| Query API 搜索首批 P95 | `< 300ms` | `< 200ms` |
| 翻页 P95 | `< 150ms` | `< 100ms` |
| 后台同步 long task | `0` 个 `>50ms` | `0` 个 `>50ms` |
| 启动全历史 Daily 扫描 | `0` | `0` |
| UI 常驻 memo 对象 | `≤150` | `≤150` |

后台 slice 的调度目标是 8–12ms；单次超过 12ms 记录 warning，超过 50ms 直接失败。Desktop parse concurrency 初始为 2，移动端固定为 1；只有实测显示收益且不破坏长任务门槛时才允许提高 Desktop 并发。

## 7. 防作弊断言

基准失败条件包括：

- search/page/统计通过 `loadAll()` 或等价方式构造 30k 全库数组。
- 预先在计时外全量水合数据，再只测内存过滤。
- 冷缓存启动扫描全部 Daily 或重放全部历史 journal。
- 为达到阈值跳过 tags、links、images、tasks、Time Buoy 或 aggregate 建立。
- 只返回部分结果却标记 coverage complete。
- 删除失败样本、只报告最快设备或混合不同 commit 的样本。
- 基准修改任一 Daily、Monthly 或同步状态。

## 8. 输出格式

每次运行输出一个 JSON result，至少包含：

```ts
interface CatalogBenchmarkResult {
  schemaVersion: 1;
  commit: string;
  fixtureSeed: string;
  fixtureManifestSha256: string;
  platform: "node" | "desktop" | "ios" | "android";
  device: Record<string, string>;
  samples: Record<string, number[]>;
  summary: Record<string, { p50: number; p95: number; max: number }>;
  counters: Record<string, number>;
  failures: Array<{ metric: string; reason: string }>;
}
```

发布记录必须保留 raw result、summary、fixture manifest 和对应 commit；只保留截图或手工抄写 P95 不算通过。
