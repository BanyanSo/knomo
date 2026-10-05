# Knomo

[English](README.md) | 简体中文

> Obsidian 里的本地优先 Memos 入口：快速记录，日记留痕，月度归集，卡片回看，移动端友好输入。

Knomo 是一个为 Obsidian 打造的 memo-first 记录插件。它帮助你更快写下碎片想法，同时让内容继续保存在自己的 Vault 里，以普通 Markdown 文件的形式存在，离开插件也能阅读、编辑和迁移。

Knomo 的核心思路很简单：

- 先快速记录，不必一开始就决定最终笔记结构；
- 通过 Daily Notes 保留每条 memo 发生的日期上下文；
- 自动生成和维护月度 Memos Markdown 文件，方便集中浏览和回看；
- 通过卡片、筛选、搜索、引用、图片、任务和统计，让写下的内容重新被看见和复用；
- 坚持本地优先，不破坏原有 Markdown 工作流。

Knomo 不试图取代 Obsidian 的文件、文件夹、标签、链接、反向链接或 Daily Notes。它只是给 Obsidian 的 Markdown 工作流增加一个更轻、更顺手的记录入口。

---

## 截图

### 桌面端

![](./screenshots/desktop-cn-1.png)

![](./screenshots/desktop-cn-2.png)

![](./screenshots/desktop-cn-3.png)

### 移动端

![](./screenshots/mobile-cn.png)


---

## 为什么需要 Knomo？

Obsidian 很适合长期知识管理，但很多想法并不是以完整笔记的形态出现的。它们更常见的形态是碎片：阅读时的一句话、会议里的一个点子、一个待办、一张截图、一个链接、一句判断、一个感受，或者一个还没成形的连接。

如果每个碎片都要先打开正确文件、找到正确标题、选择正确文件夹、判断最终结构，很多内容就不会被写下来。

Knomo 给这些碎片一个低摩擦入口：

1. **先记录**：打开 Knomo，写下 memo，保存。
2. **保留日记上下文**：memo 自动写入当天 Daily Note。
3. **按月归集**：Knomo 自动维护月度 Memos Markdown 文件。
4. **用卡片回看**：通过卡片流、筛选、搜索和统计重新浏览内容。
5. **回到 Markdown**：每条 memo 仍然属于你的 Obsidian 本地 Markdown 工作流。

---

## 核心理念

### Memo-first

Knomo 把 memo 作为第一记录单元。你可以先捕捉想法，再在之后连接、打标签、搜索、引用、展开或移动到更大的笔记中。

### Daily Note + Monthly Memos

Knomo 的核心工作流由两层 Markdown 组成：

- **Daily Note**：保留 memo 发生的日期和当天上下文；
- **Monthly Memos 文件**：把 memo 归集成月度信息流，方便集中浏览和回看。

Daily Note 回答：**今天发生了什么？**

Monthly Memos 回答：**这个月我写下了什么？**

### Local-first

memo 内容保存在你的 Obsidian Vault 中。Knomo 不要求账号，不依赖外部服务器，也不会主动上传你的笔记。

### Markdown-friendly

Knomo 尽量支持并保留常见的 Obsidian / Markdown 语法，包括标签、内部链接、Markdown 链接、URL、图片、列表、任务列表、块引用、引用块、标题和代码块。

### Non-destructive

Knomo 不会把你的 Daily Note 改造成插件私有数据库。它写入的是可读的 memo 形态 Markdown，并尽量保持原文可见、可编辑、可迁移。

### Mobile-friendly

Knomo 不把 Obsidian 移动端当作桌面端的缩小窗口。输入框、键盘行为、触控区域、侧边栏、搜索和卡片浏览都会围绕手机上的真实记录场景优化。

---

## 功能亮点

### 快速记录

你可以直接在 Knomo 视图里写 memo，不需要先打开某个 Markdown 文件。

适合记录：

- 碎片想法；
- 阅读摘录；
- 项目灵感；
- 会议记录；
- 工作备忘；
- 每日复盘素材；
- 临时待整理内容。

---

### 快捷命令

在 Obsidian 命令面板中搜索 Knomo，即可执行 **新建 Memo**、**随机重逢**、**往日漫游**、**时光浮标**、**记录统计** 和 **那年今日**。你也可以在 Obsidian 的 **快捷键** 设置中为它们绑定按键。

命令会复用已打开的 Knomo 视图，必要时自动打开视图。**新建 Memo** 会保留当前草稿；使用 **时光浮标** 前需要先在 Knomo 设置中启用该功能。

---

### Markdown 编辑与草稿

Composer 会展示 Markdown 格式，并在编辑时展开相关源码。你可以编写列表、链接、引用和代码，也可以直接切换草稿中受支持的勾选项，并使用撤销与重做。

在同一个打开的 Knomo 视图内，关闭并重新打开 Composer 会保留草稿。编辑已有 memo 时，会暂存新建草稿；保存或取消编辑后，恢复草稿正文、引用、选区和滚动位置。保存失败时也会保留编辑内容。草稿不保证在关闭视图或重启 Obsidian 后保留。

---

### 写入 Daily Note

Knomo 依赖 Obsidian 核心插件 **Daily Notes（日记）**。

新 memo 会写入当天 Daily Note 中配置好的标题下。默认标题是：

```md
## Memos
```

示例：

```md
## Memos

- 18:30:12 今天想到一个新的产品点子 #idea
- 21:10:03 书里这段话值得之后再看 #reading
```

你可以在 Knomo 设置中配置写入标题、插入位置和时间格式。

---

### 月度 Memos 文件

除了写入 Daily Note，Knomo 也会自动维护月度 Memos Markdown 文件。

默认结构示例：

```md
# Knomo/Memos-2026-06.md

## [[2026-06-21]]

- 09:20:10 一个不应该丢掉的小产品想法 #idea
- 22:15:42 复盘记录：这个之后可以整理成项目 brief #review

## [[2026-06-20]]

- 16:42:03 阅读时看到的一句有用的话 #reading
```

月度文件让你可以集中浏览长期 memo 流，同时不丢失 Daily Note 的原始日期上下文。

---

### 卡片式浏览

Knomo 用卡片流展示 memo，而不是要求你一直阅读原始 Markdown 信息流。

卡片适合：

- 快速浏览最近记录；
- 在移动端阅读；
- 查看搜索结果；
- 按标签、链接、图片或日期范围筛选；
- 打开来源 Daily Note；
- 复制文本或链接；
- 编辑、删除、恢复或引用某条 memo。

---

### 筛选与搜索

Knomo 支持多种方式缩小 memo 范围：

- 全部笔记；
- **勾事记**：包含 Markdown 勾选项的 memo；
- 无标签 memo；
- 有链接 memo；
- 有图片 memo；
- 今日回顾 / 同日回顾；
- 本周、本月、最近 7 天、最近 30 天、上周、上月等时间范围；
- 标签筛选；
- 关键词搜索；
- 统计页联动筛选。

Knomo 使用可重建的本地 Catalog 完成历史查询、筛选和统计，并分页加载 memo 卡片。每台设备根据 Daily Notes 建立自己的 Catalog，无需同步索引本身。

---

### 标签、链接与 Obsidian 友好 Markdown

Knomo 会识别 memo 里的标签和链接。

```md
- 16:20:00 改进移动端 composer 的间距 #knomo #interaction
- 19:05:00 这个想法可以连接到 [[产品设计]] 和 [[移动端体验]]
- 20:10:00 参考资料：https://obsidian.md
```

Knomo 会保留原始 Markdown，而不是替换成插件私有格式。

---

### 引用卡片

当一条 memo 需要回应、延展或引用另一条 memo 时，可以从卡片操作菜单创建引用。

适合这些场景：

- 继续一个旧想法；
- 在新 memo 中引用旧 memo；
- 把分散在不同日期的碎片连接起来；
- 保留原始 memo 的来源痕迹。

引用使用 Obsidian 友好的链接或块引用形式，因此离开 Knomo 后仍然有意义。

---

### 图片插入与预览

可以直接向 Composer 粘贴截图、剪贴板图片，也可以通过图片选择器插入。图片粘贴支持 PNG、JPEG、GIF 和 WebP，适用于剪贴板提供图片数据且不附带文本或 HTML 的情况。移动端剪贴板支持取决于系统和输入方式，仍可使用图片选择器。

图片会按 Obsidian 的附件位置与链接格式设置保存到 Vault，并以 Markdown 嵌入链接插入草稿。Knomo 会保留可用的原始文件名、调整不安全名称，并避免覆盖已有附件。处理图片期间可以继续输入，处理完成后再发送 memo。取消插入或撤销嵌入链接不会删除已经保存到 Vault 的附件。

Knomo 支持在 memo 卡片中显示轻量图片预览。

支持的场景包括：

- Obsidian 本地图片嵌入，例如 `![[image.png]]`；
- 普通 Markdown 图片，例如 `![alt](image.png)`；
- 一条 memo 内包含多张图片；
- 从卡片中打开更大的图片预览；
- 在预览中切换上一张 / 下一张图片。

双击图片后可以拖动查看细节。移动端支持双击和双指缩放；放大后的平移不会切换图片。再次双击恢复完整预览，也可以双指收拢缩小。加载失败时可以在预览中直接重试。

Knomo 的目标不是做图片管理器，而是让带图片的 memo 也能在卡片流里清晰、轻量地浏览。

---

### 任务列表与 checkbox

Knomo 支持 memo 中的 Markdown 任务列表。

示例：

```md
- 09:30:00
	- [ ] 发出项目记录
	- [x] 检查昨天的会议 memo
```

你可以在卡片视图中更新任务状态，并同步回源 Markdown 内容。

从侧边栏或视图切换菜单打开 **勾事记**，可以集中查看包含受支持勾选项的 memo，涵盖已完成与未完成项目。它支持组合标签、关键词和日期筛选，移动端搜索也会保留勾事记范围。结果展示完整 memo，全部勾选完成后仍会保留在勾事记中；代码示例中的勾选项文本不计入筛选。

---

### 记录统计

Knomo 增加了记录统计视图，用来理解自己的记录习惯和回看节奏。

可以展示：

- 全部笔记数；
- 全部字数；
- 记录天数；
- 有标签笔记；
- 无标签笔记；
- 有图片笔记；
- 被引用笔记；
- 单日笔记数最多的日期；
- 单日字数最多的日期；
- 周、月、年的记录趋势；
- 记录时段分布；
- 常用标签。

统计的目的不是把写作变成生产力打卡，而是帮助你发现记录节奏，并快速跳回相关 memo 卡片。

---

### 随机重逢与回顾

Knomo 提供随机重逢、日期回顾等轻量回看入口。它们不依赖 AI，也不依赖外部服务，只是帮助旧碎片重新遇到现在的你。

随机重逢每组最多展示 10 条合格 Memo，包括纯图片和纯链接记录。在当前视图会话内，优先选择最近三批之外的内容。稳定候选至少 20 条时，相邻两批完整结果不重叠；候选较少时只进行必要的重复。展示卡片不会标记已回看，成功打开或显式标记后才记录回看，并在接下来三个日历日内降低抽中权重。

一条 memo 不一定要立刻有用。有时它的价值是在另一个时间、另一个上下文里重新出现。

---

### 往日漫游

往日漫游会从至少 7 天前的历史记录中带回一个完整日期，并按时间顺序展示当天的 Memos。选择日期时会尽量保持时间跨度的多样性，并避免立即重复最近出现过的日期。

漫游先从仍有候选的年代段中选择，再在段内选择日期，对内容较丰富的日期给予适度偏好。返回这两个回看页面会保留当前结果，点击“换一批／换一天”才重新选择。回顾历史保存失败时，仍可查看已选日期的内容，并会收到提示。

除了当天的 Memo 卡片，还会汇总笔记数、字数、标签、图片和链接。整个选择过程只使用本地 memo 索引，不依赖 AI 或外部服务。

---

### 时光浮标

在 memo 中加入 `@YYYY-MM-DD`，就可以让它在指定日期重新浮现。你可以直接输入日期标记，也可以使用输入框中的日期选择器，并在时光浮标的“今日”“待浮现”“往日”视图中集中回看。

日期标记会保留在 memo 的 Markdown 正文中。Knomo 只建立可删除、可重建的本地索引来加速查询；索引不会替代或改写 Daily Note 中的 memo 原文。

---

### 回收站、恢复与修复

Knomo 提供更安全的日常维护流程：

- 删除后的 memo 可以进入回收站；
- 能恢复的 memo 可以尝试恢复；
- 永久删除需要单独操作；
- 可以从 Markdown 来源修复 / 重建 memo 索引；
- 配置范围内 Daily Notes 中已有的 `- HH:mm` 和 `- HH:mm:ss` memo 会自动识别，无需单独手动导入。

Markdown 始终是长期可信来源。插件索引用于提升浏览、筛选、统计和同步体验。

---

### 桌面端响应式布局

Knomo 根据自身分栏宽度适配布局，方便与其他笔记并排使用。宽度达到 780px 时使用桌面侧边栏布局，更窄时切换为紧凑标题栏与侧边栏抽屉，抽屉限制在所属分栏内。可以通过关闭按钮或 Escape 收起抽屉。

调整分栏宽度时，会保留草稿、搜索状态以及侧边栏宽度和折叠偏好。

---

### 移动端输入体验

Knomo 针对移动端做了专门优化：

- 更适合触控的快速新建入口；
- 面向手机输入的底部 composer；
- 与系统键盘更好协同；
- 长内容输入时的高度和滚动控制；
- 更大的触控区域；
- 移动端搜索页；
- 移动端侧边栏抽屉；
- 移动端友好的图片预览；
- 适配安全区域和 Obsidian 移动端导航栏。

Knomo 的移动端目标不是“能打开”，而是让快速记录在 Obsidian mobile 中也足够自然。

---

### 主题兼容

Knomo 尽量使用 Obsidian 主题变量，并对 Minimal 等社区主题做了兼容处理。

如果你使用其他主题时遇到间距、颜色、对比度或移动端布局问题，欢迎反馈。

---

## 安装

### 从 Obsidian 社区插件市场安装

打开 [Knomo 社区插件页面](https://community.obsidian.md/plugins/knomo)，点击 **Add to Obsidian**，然后在 Obsidian 中点击 **安装**并**启用**。

也可以从 Obsidian 设置中安装：

1. 打开 Obsidian 设置；
2. 进入 **第三方插件 / Community plugins**；
3. 如有需要，关闭受限模式（Restricted Mode），启用第三方插件；
4. 点击**浏览 / Browse**，搜索 `Knomo` 并打开插件页面；
5. 安装并启用插件。

### 手动安装

1. 从同一个[最新 Release](https://github.com/BanyanSo/knomo/releases/latest) 下载以下三个文件：
   - `main.js`
   - `manifest.json`
   - `styles.css`
2. 在你的 Vault 中创建目录：

```text
.obsidian/plugins/knomo/
```

如果 Vault 使用了自定义配置文件夹，请将 `.obsidian` 替换为该文件夹。

3. 将三个文件放入该目录；
4. 重启 Obsidian；
5. 在 **第三方插件 / Community plugins** 中启用 Knomo；
6. 使用命令面板运行 `Open Knomo`。

---

## 快速开始

### 1. 启用 Daily Notes

Knomo 需要 Obsidian 核心插件 **Daily Notes（日记）**。

使用前请确认：

- Daily Notes 已启用；
- 日记文件夹路径已配置；
- 日期格式已配置；
- Obsidian 可以正常创建 Daily Note 文件。

### 2. 打开 Knomo

你可以通过以下方式打开 Knomo：

- 点击左侧 Ribbon 图标；
- 在命令面板运行 `Open Knomo`；
- 将 Knomo 视图固定到工作区。

### 3. 创建第一条 memo

写下：

```text
今天开始用 Knomo 记录碎片想法 #knomo
```

保存后，这条 memo 会出现在卡片流中，并写入对应 Markdown 文件。

### 4. 回看与连接

写一段时间后，可以尝试：

- 按标签筛选；
- 搜索关键词；
- 查看有链接 / 有图片的 memo；
- 使用随机重逢；
- 查看记录统计；
- 创建新 memo 时引用旧 memo。

---

## Obsidian URL 快捷指令

可通过 Obsidian 原生 URL 从 iOS「快捷指令」或其他应用打开 Knomo。请先在目标 Vault 中启用 Knomo，并将下列示例 Vault ID 替换为自己的 ID：

```text
obsidian://knomo?vault=ef6ca3e3b524d22f&command=open-view
obsidian://knomo?vault=ef6ca3e3b524d22f&command=new-memo
obsidian://knomo?vault=ef6ca3e3b524d22f&command=random-revisit
obsidian://knomo?vault=ef6ca3e3b524d22f&command=shuffle-day
obsidian://knomo?vault=ef6ca3e3b524d22f&command=time-buoy
obsidian://knomo?vault=ef6ca3e3b524d22f&command=record-stats
obsidian://knomo?vault=ef6ca3e3b524d22f&command=on-this-day
```

| command | 行为 |
| --- | --- |
| `open-view` | 仅打开或切换到 Knomo，复用已有视图 |
| `new-memo` | 打开新建 Memo 输入界面，保留已有草稿 |
| `random-revisit` | 随机重逢 |
| `shuffle-day` | 往日漫游 |
| `time-buoy` | 时光浮标，需先启用该功能 |
| `record-stats` | 记录统计 |
| `on-this-day` | 那年今日 |

在 iOS「快捷指令」中添加「URL」操作，填入所需链接，再添加「打开 URL」操作。`new-memo` 只打开输入界面，不会自动保存 Memo；所有命令均不支持通过 URL 传入 Memo 正文。缺失、空值或未知的 `command` 不执行功能，也不创建 Knomo 视图。

Obsidian 先选择目标 Vault，再分发自定义 action。`vault` 支持 Vault 名称或 ID；优先使用 ID，避免重命名或同名 Vault 带来的问题。在 Vault 切换器中打开目标 Vault 的上下文菜单，选择「复制 Vault ID」。ID 属于设备本地的 Vault 注册信息：不同设备应分别获取，移除并重新添加 Vault 后也应重新核对。参见 [Obsidian URI 官方说明](https://help.obsidian.md/uri)。

名称含空格、中文时，请将参数值 URL 编码一次。例如 `工作 笔记` 对应 `obsidian://knomo?vault=%E5%B7%A5%E4%BD%9C%20%E7%AC%94%E8%AE%B0&command=open-view`。不传 `vault` 时，例如 `obsidian://knomo?command=new-memo`，在 Obsidian 实际打开的 Vault 中执行。Knomo 不另行选择 Vault、不跨 Vault 转发，也不会在目标插件不可用时回退到另一实例。请仅使用这里列出的参数；Obsidian 会在 Knomo 收到请求之前处理其自身的路由参数。

实现使用官方 `registerObsidianProtocolHandler` API（自 Obsidian 0.11.0 提供），因此 `minAppVersion` 保持 1.11.0。公开回调 API 不承诺保留 `vault` 参数；本机 Obsidian Desktop 1.13.7 的实现检查确认，宿主先按名称或 ID 选库，再移除 `vault` 后分发。Knomo 因此复用原生路由，不将 ID 与 Vault 名称比较，也不读取私有 Vault 注册表。命令等待工作区布局恢复后，进入已有视图打开逻辑或 Quick Command Controller。

## Markdown 格式

Knomo 使用简单、可读、离开插件也能理解的 Markdown 格式。

### 单行 memo

```md
- 18:30:12 这是 memo 内容
```

### 多行 memo

```md
- 18:30:12 第一行内容
	第二行内容
	第三行内容
```

### 带标签的 memo

```md
- 18:30:12 今天读到一个很好的观点 #reading #product
```

### 带链接的 memo

```md
- 18:30:12 这个想法可以连接到 [[产品设计]] 和 https://obsidian.md
```

### 带图片的 memo

```md
- 18:30:12 这是一张灵感截图 ![[image.png]]
```

### 带任务列表的 memo

```md
- 09:30:00
	- [ ] 跟进项目负责人
	- [x] 检查昨天的 memo
```

### 带引用块的 memo

```md
- 20:15:00
	> 一条小记录，可能会在合适的时候重新变得有用。
```

### 月度归档中的 memo

```md
## [[2026-06-21]]

- 18:30:12 这是 memo 内容
```

---

## 设置概览

Knomo 设置包括：

- Daily Note 写入标题；
- 新 memo 插入位置；
- memo 时间格式；
- 月度 Memos 文件夹；
- 月度 Memos 文件名格式；
- 月度文件中的日期标题格式；
- 月度日期排序方式；
- 可选：将月度 Memos 文件从 Obsidian 搜索 / 图谱 / 统计中排除；
- 固定标签；
- 数据修复与重建工具。

---

## 数据与隐私

Knomo 的核心原则是：**数据属于你**。

- memo 内容保存在你的 Obsidian Vault 中；
- Daily Notes 和月度 Memos 文件都是普通 Markdown 文件；
- Markdown 文件可以直接阅读、备份、同步和迁移；
- 插件索引用于提升浏览、筛选、统计和同步体验；
- Daily Notes 是活动 memo 的事实来源，本地 Catalog 与月度文件可从中重建；
- Knomo 不要求注册账号；
- Knomo 不依赖外部服务器；
- Knomo 不会主动上传你的笔记。

---

## 数据安全说明

Knomo 会写入 Markdown 文件。为了降低风险：

- 首次使用前请备份 Vault；
- 确认 Obsidian Sync、Git 或其他同步工具状态正常；
- 迁移旧版 Knomo 数据前请先备份；
- 如果卡片流与 Markdown 看起来不一致，优先检查原始 Markdown；
- 如果索引过期，可以使用修复 / 重建工具；
- 长期可信来源始终是 Markdown 文件。

Knomo 的目标不是隐藏 Markdown，而是让 Markdown 更容易被快速记录、浏览和复用。

---

## 推荐工作流

### 日常碎片记录

把 Knomo 当作 Obsidian 里的快速输入框。先写下来，之后再整理。

### 阅读摘录

```md
- 10:32:00 重点不是功能数量，而是用户完成目标时走过的路径。 #reading #product
```

### 项目灵感池

```md
- 16:20:00 移动端输入框应该像一个安静地浮在键盘上方的面板。 #knomo #interaction
```

### 任务捕捉

```md
- 09:30:00
	- [ ] 写 release note 草稿
	- [ ] Review 移动端卡片布局
```

### 图片灵感

```md
- 18:30:12 紧凑卡片布局参考 ![[card-layout-reference.png]] #design
```

### 回看与复用

通过标签、搜索、随机重逢、记录统计和引用，让旧的碎片重新进入当前工作。

---

## Knomo 不是什么

Knomo 不是：

- Obsidian 文件和文件夹系统的替代品；
- 云端 memo 服务；
- AI 笔记整理器；
- 完整任务管理器；
- 图片管理器；
- 把内容锁住的私有数据库。

Knomo 是 Obsidian Markdown 的本地 memo-first 记录与回看层。

---

## 与其他工具的区别

### Knomo 和 flomo 有什么区别？

flomo 是独立的 Memos 产品。Knomo 是 Obsidian 插件。

Knomo 更适合希望把碎片记录保存在自己 Vault 中，并继续使用 Obsidian 标签、链接、搜索、反向链接、Daily Notes 和 Markdown 工作流的用户。

### Knomo 和 Thino 有什么区别？

Thino 是成熟的 Obsidian Memos 插件。

Knomo 更聚焦：

- Daily Note 联动；
- 月度 Markdown 自动归集；
- 本地优先的 memo 存储；
- 移动端输入体验；
- 轻量卡片回看；
- 低打扰的个人记录流程。

如果你需要成熟、完整、功能丰富的 Memos 插件，Thino 可能更适合。如果你想要一个贴近日记和本地 Markdown 的轻量记录入口，可以试试 Knomo。

---

## 常见问题

### Knomo 会不会把数据锁在插件里？

不会。核心 memo 内容会写入 Markdown 文件。索引用于提升体验，但 Markdown 才是长期可信来源。

### 是否必须启用 Daily Notes？

是的。Knomo 的主要写入流程围绕 Obsidian 核心插件 Daily Notes 展开。

### Knomo 会上传我的笔记吗？

不会。Knomo 不依赖外部服务器，也不会主动上传你的笔记。

### 是否支持移动端？

支持。移动端是 Knomo 的重点优化方向之一。Knomo 包括移动端 composer、键盘适配、移动搜索、触控友好控件、安全区域处理、移动端侧边栏和卡片浏览等优化。

### 为什么卡片流和 Markdown 文件看起来不一致？

可能是索引尚未刷新，或者 Markdown 文件被外部编辑后还没有重新同步。

可以尝试：

1. 检查原始 Markdown 文件；
2. 刷新 Knomo；
3. 使用修复 / 重建工具；
4. 如果问题仍然存在，提交带复现步骤的 issue。

### 可以手动编辑 Markdown 文件吗？

可以。Knomo 的设计目标就是让内容保持 Markdown 可读。如果你手动编辑文件后卡片流没有及时更新，可以刷新或重建索引。

---

## 开发验证

按修改范围和风险选择验证。纯文档只核对内容、引用和 diff；低风险局部修改运行相关测试，可一次传入多个文件：

```bash
npm run test:file -- tests/<Name>.test.ts
```

`npm test` / `npm run test:quiet` 运行产品行为、数据安全、同步 acceptance 及架构/产品契约测试。`npm run test:tooling` 运行测试 runner、验证工具和 benchmark trace validator 测试。`npm run test:all` 运行两者的完整集合；CI、发布检查和 `npm run verify` 使用全量集合。测试目录不变，新文件默认进入产品集合，`test:file` 可选择任一集合的文件。合成 trace 测试不替代真实设备性能验收。

persistence、migration、identity、数据安全及跨服务语义修改须先补有效回归，再运行 `npm run test:quiet` 和 `npm run typecheck`。需要验证构建产物时运行 `npm run build`。仅因新增修改、失败或未解决风险扩大或重复检查；未执行的检查单独说明。

`npm run build` 将发布用的 `main.js`、`manifest.json` 和压缩后的 `styles.css` 输出到 `dist/`。本地安装或发布请使用该目录下的三个文件；根目录的 `styles.css` 保留为可读源码。

`npm run verify` 是综合检查入口，不是每次交付的默认要求：它包含类型检查、全量测试、生产构建、i18n、diff 空白、禁用源码模式及尾随空白扫描，仅在需要这些完整检查时运行。未经要求不运行 lint。同一工作树的测试命令共用编译目录，应串行协调。

当前任务包含设备验证时，选择受影响的场景；完整设备矩阵属于对应 Stage/Beta/Release 范围。本地可选的[移动 QA 清单](./docs/mobile-qa-checklist.md)仅作辅助，不是 test/build 前提。

---

## 反馈与贡献

欢迎反馈，尤其是：

- Bug 报告；
- 移动端体验问题；
- 主题兼容问题；
- Markdown 解析边界；
- 数据同步 / 索引修复问题；
- UI / UX 建议；
- 文档改进。

反馈移动端问题时，建议附上设备型号、系统版本、Obsidian 版本、主题和复现步骤。

---

## License

### Knomo 适用于 Obsidian 桌面端和移动端

从 Knomo 1.10.0 的本次许可变更起，Knomo 原创内容采用 **GNU GPL 第 3 版且仅限该版（GPL-3.0-only），附 Knomo Obsidian 宿主附加许可**。请一起阅读 [许可说明](./LICENSING.md)、[GPLv3 标准全文](./LICENSE)和[宿主附加许可](./OBSIDIAN-EXCEPTION.txt)。

你可以依照这些条款使用、修改和商业分发 Knomo。分发受覆盖的 fork，或抽取的代码、样式、组件和工具函数时，应履行适用的 GPL 义务，包括对应源码及必要声明。宿主附加许可允许与独立取得的 Obsidian 进行必要结合，不免除 Knomo 的 GPL 义务，也不授权分发 Obsidian。在法律允许的范围内，本软件不提供担保。

历史 MIT 授权继续有效，之前按 MIT 提供的内容仍可按原条款使用。[历史 MIT 声明](./LICENSES/Knomo-historical-MIT.txt)完整保留，但不为新贡献授予 MIT 许可。第三方内容保留各自许可和[必要声明](./THIRD-PARTY-NOTICES.txt)。你的笔记不会仅因使用 Knomo 而变为 GPL 内容。

[品牌政策](./BRANDING.md)将代码许可与官方身份分开。软件许可允许 fork 和商业使用，但不得造成官方背书的误解。欢迎保留原项目或 [Buy me a coffee](https://www.buymeacoffee.com/banyanso) 链接，这不是许可条件。新贡献的许可见 [CONTRIBUTING.md](./CONTRIBUTING.md)。

开发源码位于[本仓库](https://github.com/BanyanSo/knomo)。每次 GPL 二进制分发都必须明确提供取得完整对应源码的方式。本次许可文件修改尚未实现发行打包与源码交付，正式发布前仍需完成[发行要求](./LICENSING.md#source-and-distribution-release-work-still-required)。
