# Knomo

Knomo 是一个本地优先的 Obsidian memo 插件，用来在插件视图里快速记录 memo，并把正文写入当天日记文件，同时自动生成按月归档的 memo 文件。

## 核心能力

- 在 Knomo 视图中快速创建、编辑、删除和恢复 memo。
- 将 memo 正文写入当天 Obsidian 日记文件，默认写入 `## Memos` 标题下。
- 自动维护月度归档文件，默认路径为 `Knomo/Memos-YYYY-MM.md`。
- 使用内部稳定 `memoId` 维护日记 block 与月度归档 block 的对应关系。
- 支持 Obsidian 原生 block reference，便于从 memo 反查原始日记内容。
- 所有数据保存在用户自己的 vault 中，不需要账号、云服务、数据库或 Web 服务端。

## 截图

截图文件建议放在 `docs/screenshots/`，后续按下面位置补充即可。

### 快速记录 memo

<!-- 后续替换为：![快速记录 memo](docs/screenshots/quick-capture.png) -->

截图待补充：展示 Knomo 输入区、发送按钮和新 memo 创建后的列表效果。

### Memo 列表与标签筛选

<!-- 后续替换为：![Memo 列表与标签筛选](docs/screenshots/memo-list-tags.png) -->

截图待补充：展示 memo 列表、标签导航、搜索或筛选状态。

### 月度归档与块引用

<!-- 后续替换为：![月度归档与块引用](docs/screenshots/monthly-archive-reference.png) -->

截图待补充：展示日记 block、月度归档 block 和 Obsidian block reference 的对应关系。

### 设置与数据维护

<!-- 后续替换为：![设置与数据维护](docs/screenshots/settings-maintenance.png) -->

截图待补充：展示月度归档设置、导入旧日记 Memos 和修复 Knomo 数据等设置项。

## 要求

- Obsidian `1.11.0` 或更高版本。
- Node.js 和 npm，用于本地开发与构建。

## 本地开发

```bash
npm install
npm run typecheck
npm test
npm run build
```

`npm run build` 会生成发布用的 `main.js`。测试会把临时编译结果写入 `/private/tmp/knomo-tests`。

## 手动安装

当前仓库包含 Obsidian 插件所需的核心发布文件：

- `manifest.json`
- `main.js`
- `styles.css`

手动安装时，将这些文件复制到目标 vault 的插件目录，例如：

```text
<vault>/.obsidian/plugins/knomo/
```

然后在 Obsidian 的社区插件设置中启用 Knomo。

## 数据说明

Knomo 会在用户 vault 内写入：

- 当天日记文件中的 memo 正文。
- 月度 memo 归档文件。
- Knomo 管理的内部索引文件，用于同步日记 block 与月度归档 block。

Knomo 不会把数据发送到外部服务。

## License

MIT
