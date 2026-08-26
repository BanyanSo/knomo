# Catalog 验收矩阵

本矩阵验证当前唯一 Catalog 架构。场景 ID 是需求编号，不代表协议版本。

## 1. 命名与入口

| ID | 场景 | 必须结果 |
| --- | --- | --- |
| CAT-NAME-001 | 扫描生产源码 | 只存在无版本 Catalog 业务模块、类型和配置键 |
| CAT-NAME-002 | 创建本机 IndexedDB | 数据库名使用 `knomo-catalog-<device-local-hash>` |
| CAT-NAME-003 | 创建增强数据目录 | 只使用 `_knomo-data/identity` 和 `_knomo-data/config` |
| CAT-ENTRY-001 | 检查 `main.ts` | 正式入口只装配 Catalog、Identity Ledger、Monthly 和旧 Index 直接迁移服务 |

## 2. 1.2.9 升级

| ID | 场景 | 必须结果 |
| --- | --- | --- |
| CAT-MIG-001 | 当前根存在 1.2.9 Memo Index | 直接生成可验证的 Identity Ledger claim、relation、review 和 delete 事件 |
| CAT-MIG-002 | 旧记录使用 16 位数字 `memoId` | 原值保留；新 memo 仍生成 UUIDv7 |
| CAT-MIG-003 | 对相同旧数据重复迁移或重启 | 不重复追加语义相同的身份事件 |
| CAT-MIG-004 | 同一旧 `memoId` 存在不一致同步副本 | 只报告 attention，不猜测绑定 |
| CAT-MIG-005 | 迁移前后比较源文件 | Daily、`_knomo-system` 和旧插件数据逐字节不变 |
| CAT-MIG-006 | 旧记录无法唯一匹配当前 Daily | 跳过该记录，其他 observation 继续显示和编辑 |
| CAT-MIG-007 | 可迁移数据已落盘、重启验证通过且无待处理冲突 | 提示“`_knomo-system` 已迁移，原文件夹可删除” |
| CAT-MIG-008 | 迁移未完成、验证失败或仍有冲突 | 不显示可删除提示，保留可诊断状态 |
| CAT-MIG-009 | 同一迁移来源修订多次启动 | 可删除提示最多显示一次 |
| CAT-MIG-010 | 完成迁移后继续使用插件 | 不自动删除或修改旧 `_knomo-system` 与旧 Monthly 文件 |

## 3. 内容与身份

| ID | 场景 | 必须结果 |
| --- | --- | --- |
| CAT-CONTENT-001 | 只有 Daily，没有 Identity Ledger | Catalog observation 可浏览、搜索、复制和编辑 |
| CAT-CONTENT-002 | Identity claim 晚于 Daily 到达 | 原 observation 原地获得 `memoId`，不重复卡片 |
| CAT-CONTENT-003 | Identity 事件早于 Daily 到达 | 不显示幽灵 memo |
| CAT-CONTENT-004 | 单 memo 出现多个 identity successor | 只降级相关 memo，其他内容能力不受影响 |
| CAT-CONTENT-005 | 删除本机 Catalog | 从 Daily 重建，不写共享 Vault 数据 |
| CAT-PURITY-001 | 普通正文操作前后检查 Daily | 不新增内部 ID、注释、frontmatter 或隐藏字符 |

## 4. 写入与故障顺序

| ID | 场景 | 必须结果 |
| --- | --- | --- |
| CAT-CREATE-001 | 正常创建 | 顺序为 intent、Daily、claim |
| CAT-CREATE-002 | intent 写失败 | Daily 正常保存，结果标记 identity pending |
| CAT-CREATE-003 | Daily 写失败 | 不写 claim，不产生可见 memo |
| CAT-CREATE-004 | claim 写失败 | Daily 保存成功，后续只续写 identity |
| CAT-WRITE-001 | stale observation handle | 拒绝写入并刷新 Catalog，不按旧行号或内容猜测 |
| CAT-WRITE-002 | edit/task/move 正文成功、rebind 失败 | 正文保持成功，结果标记 identity pending |
| CAT-WRITE-003 | move 来源删除失败 | 安全回滚目标；并发导致无法回滚时至少保留一份正文 |

## 5. 删除与恢复

| ID | 场景 | 必须结果 |
| --- | --- | --- |
| CAT-DELETE-001 | 可恢复删除 | 先持久化 payload，再删除 Daily，最后提交 delete commit |
| CAT-DELETE-002 | payload 写失败 | Daily 逐字节不变 |
| CAT-DELETE-003 | Daily 删除失败 | payload 保持 pending，不进入废纸篓 |
| CAT-DELETE-004 | delete commit 失败 | 正文删除成功，后续不得重复删除 Daily |
| CAT-RESTORE-001 | 正常恢复 | 先写回 Daily，再提交 identity restore |
| CAT-RESTORE-002 | identity restore 失败 | 正文保持已恢复，结果标记 pending |
| CAT-PURGE-001 | 用户在废纸篓确认永久清理 | purge 成功后记录从废纸篓消失且不可恢复 |
| CAT-PURGE-002 | purge 事件持久化失败 | 记录仍留在废纸篓并保持可恢复 |
| CAT-PURGE-003 | 对同一 `memoId` 重复永久清理 | 结果幂等，不产生新的可见状态或重复修改 Daily |
| CAT-PURGE-004 | 清理完成后检查 Daily | 不执行第二次正文删除，也不改写其他 Daily 字节 |
| CAT-PURGE-005 | 永久清理确认文案 | 明确说明 Knomo 不再可恢复，但不承诺清除同步历史和用户备份 |

## 6. 配置、投影与重建

| ID | 场景 | 必须结果 |
| --- | --- | --- |
| CAT-CONFIG-001 | 共享配置缺失 | Catalog 使用本机 fallback 并明确共享范围不完整；Monthly 不按设备 locale 覆盖 |
| CAT-CONFIG-002 | 两设备并发写入不同配置 | 保留冲突，Daily 继续，Monthly 暂停 |
| CAT-LOCALE-001 | 首台设备初始化 Monthly locale | 将 locale 写入共享配置后再生成 locale 相关标题 |
| CAT-LOCALE-002 | 不同系统 locale 的第二台设备打开同一 Vault | 使用共享 locale，生成与首台设备一致的 Monthly |
| CAT-LOCALE-003 | 共享 locale 冲突 | Daily 与 Catalog 继续，Monthly 暂停覆盖并提示解决冲突 |
| CAT-EXCLUDE-001 | 新用户或从未设置 Monthly 排除规则的用户升级 | 默认初始化为开启 |
| CAT-EXCLUDE-002 | 用户已显式关闭 Monthly 排除规则 | 升级不得改回开启 |
| CAT-PROJ-001 | 重建 Monthly | 正文只从实际 Daily 读取 |
| CAT-PROJ-002 | Monthly 写入失败 | 投影独立失败，不改变 Daily 与 identity |
| CAT-STORE-001 | IndexedDB 丢失或不可用 | 使用内存 fallback 并从 Daily 渐进重建 |
| CAT-ROOT-001 | 用户显式迁移数据根 | copy、verify 成功后才更新设置，旧根保留 |

## 7. 查询、筛选与分页

| ID | 场景 | 必须结果 |
| --- | --- | --- |
| CAT-QUERY-001 | 输入中文、英文或数字片段 | 按 `1.2.9` 子串语义返回完整匹配，不要求词首或完整词 |
| CAT-QUERY-002 | 快速连续提交慢查询 A 和快查询 B | 只有最后发起的 B 可以更新结果、空态和统计 |
| CAT-TAG-001 | 选择父标签 `project` | 同时包含 `project` 与 `project/...` 的嵌套标签记录 |
| CAT-TAG-002 | 统计标签总数和使用次数 | 基于完整 Catalog 结果，不依赖当前列表页 |
| CAT-PAGE-001 | 在固定查询下连续翻页 | 不重复、不漏项，排序稳定 |
| CAT-PAGE-002 | 翻页期间查询条件或 Catalog revision 改变 | 旧页结果不得混入；重置游标并明确刷新状态 |
| CAT-PAGE-003 | 从筛选或钻取结果返回 | 恢复原查询、筛选、排序和滚动上下文 |

## 8. 全库功能与交互

| ID | 场景 | 必须结果 |
| --- | --- | --- |
| CAT-SUMMARY-001 | 首页存在多页 memo | 总数、标签数、图片数和其他摘要基于完整 Catalog，不随已加载页变化 |
| CAT-REVIEW-001 | 打开某日“往日回顾” | 使用完整已覆盖历史范围，排除今天和已删除记录 |
| CAT-RANDOM-001 | 随机重逢卡片成功打开并展示 | 自动为对应 `memoId` 记一次已回顾，无需手动按钮 |
| CAT-RANDOM-002 | 同一次打开流程因重渲染或重试重复回调 | review 只记录一次 |
| CAT-STATS-001 | 从全部记录统计点击有标签、无标签、有图片、任务或引用 | 每个钻取返回完整且口径一致的结果集 |
| CAT-RANGE-001 | Catalog 尚在渐进扫描时查看全库统计或回顾 | 显示覆盖范围或未完成状态，不把部分数据标成全库 |
| CAT-TIMEBUOY-001 | 打开时光浮标 | 从统一 Catalog 与 Daily 派生，无专属手动重建入口 |
| CAT-TIMEBUOY-002 | Catalog 失效后恢复时光浮标 | 通过统一重扫和状态提示恢复，不引入第二套索引 |
| CAT-A11Y-001 | 仅使用键盘操作搜索、筛选、翻页、回顾、废纸篓和确认框 | 控件可达、焦点可见、名称可读，关闭弹层后焦点回到触发点 |
| CAT-LIFECYCLE-001 | 反复打开和关闭视图 | 事件监听、定时器和订阅被释放，不产生重复响应 |

## 9. 1.2.9 行为基线 fixture

`tests/fixtures/catalog/compat-1.2.9.json` 是用户可感知行为的最小固定样本，至少覆盖：

- 中文、英文、数字子串搜索；
- 父子标签；
- Obsidian 引用、图片和任务；
- active、recoverable deleted 和 review 状态；
- 同日多条记录、历史同月日回顾和今日排除；
- 全库摘要与统计钻取。

fixture 只定义输入和期望集合，不复制生产实现。已确认的新产品决策作为有意差异单独验收：共享 Monthly locale、打开即回顾、废纸篓永久清理、Monthly 默认排除开启、无时光浮标手动重建入口，以及仅提示用户自行清理旧文件。

## 10. 发布门禁

- 架构守卫扫描生产源码，拒绝开发阶段编号重新进入 Catalog 名称和路径；
- 1.2.9 fixture 契约、直接迁移、数字 `memoId`、幂等与内容纯净测试必须通过；
- Catalog 读取、查询竞态、分页、全库聚合、创建、删除、恢复、永久清理、共享配置、数据根迁移和 Monthly 投影测试必须通过；
- 完成全量测试、TypeScript 类型检查、生产构建与项目 verify。
