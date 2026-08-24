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

## 6. 配置、投影与重建

| ID | 场景 | 必须结果 |
| --- | --- | --- |
| CAT-CONFIG-001 | 共享配置缺失 | 使用本机 fallback，明确共享范围不完整 |
| CAT-CONFIG-002 | 两设备并发写入不同配置 | 保留冲突，Daily 继续，Monthly 暂停 |
| CAT-PROJ-001 | 重建 Monthly | 正文只从实际 Daily 读取 |
| CAT-PROJ-002 | Monthly 写入失败 | 投影独立失败，不改变 Daily 与 identity |
| CAT-STORE-001 | IndexedDB 丢失或不可用 | 使用内存 fallback 并从 Daily 渐进重建 |
| CAT-ROOT-001 | 用户显式迁移数据根 | copy、verify 成功后才更新设置，旧根保留 |

## 7. 发布门禁

- 架构守卫扫描生产源码，拒绝开发阶段编号重新进入 Catalog 名称和路径；
- 1.2.9 直接迁移、数字 `memoId`、幂等与内容纯净测试必须通过；
- Catalog 读取、创建、删除、恢复、共享配置、数据根迁移和 Monthly 投影测试必须通过；
- 完成全量测试、TypeScript 类型检查、生产构建与项目 verify。
