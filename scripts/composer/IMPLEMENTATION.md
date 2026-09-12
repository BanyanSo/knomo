# Composer Live Markdown 与 Toolbar 实施交付

日期：2026-09-12。范围：本次 Composer 产品方案与开发计划；用户已将真实设备验证移至最后。

## 实现与入口

| 范围 | 实现入口 | 行为 |
| --- | --- | --- |
| 单一 Markdown 编辑状态 | `src/ui/ComposerEditor.ts` | 独立 CodeMirror EditorView；原文、选区、历史、禁用、坐标、composition 与会话失效 |
| 原 Composer 接入 | `src/ui/KnomoComposer.ts`、`src/ui/KnomoView.ts` | Draft、编辑、引用、保存、取消、输入续行、移动浮层与资源释放 |
| 显示与源码范围 | `src/utils/composerSyntax.ts` | 仅 Task、UL、OL、Bold、Highlight、普通 Wiki Link；代码屏障、转义与交错内容保留源码 |
| 文本命令 | `src/utils/composerCommands.ts` | 文本与选区一起返回；区分修改、无变化、不适用；格式取消、多行转换和连续操作 |
| Suggest | `src/ui/KnomoTagSuggest.ts`、`src/ui/KnomoWikiLinkSuggest.ts` | 复用候选和替换规则，坐标改为编辑器源码位置；独立消费候选键，保留保存快捷键优先级 |
| Toolbar 偏好 | `src/settings/composerToolbar.ts`、`SettingsService`、`KnomoSettingTab` | 九项完整顺序、默认显隐、标准化、恢复默认、两套设置界面；写入插件 data.json，随插件配置同步 |
| Toolbar 手势 | `src/ui/ComposerToolGesture.ts` | Tap 一次执行，Swipe 不执行，保存/取消独立于工具横向滚动 |
| 异步与保存 | `KnomoView`、`NativeImagePickerController` | 原 observation 不换取；Daily 提交后清理仍核对会话与正文版本；图片返回绑定发起会话与插入选区 |

活动正文没有隐藏 textarea 或第二份可编辑文本。`draftContent` 是生命周期快照。
`ComposerInput` 上的正文/选区访问器直接访问同一个 EditorState；程序化编辑经 `applyComposerEdit` 或 `ComposerEditor.apply` 一次提交。
会话切换使用 `reset` 清空历史；会话、文本 revision 仅为临时 UI 状态，不持久化为身份协议。

显示解析在正文变化时更新；移动光标不重新解析 Markdown。composition 期间仅映射既有装饰，避免重建正在使用的输入 DOM。
原 Task/List 续行函数仍作为事实基线（包括 `2)` 续行使用 `3.`）；旧 textarea 原生补偿不再与 CM 输入并行执行。
编辑器只接入标准文本键位与历史，不接入移动/复制整行、注释、语法选择等完整代码编辑器快捷键；Shift-Enter 保持原样换行。
普通 Wiki Link 空插入为 `[[]]`，光标位于内部；方案中的 `[[|]]` 按光标位置示意处理，不生成 alias 分隔符。

正式构建仅将 `obsidian`、`@codemirror/state`、`@codemirror/view` 作为相关宿主依赖；commands、Markdown 解析器及其余依赖随插件打包。
没有改动 Catalog、Monthly、迁移或 Task 持久化模型。没有运行 lint、提交、发布或向实际 Vault 安装插件。

## 自动化证据

- 工作区完整 `npm run test:all`：1019 项通过，0 失败、0 跳过。
- 完整套件之后补充收紧水平分隔线、超长编号和歧义高亮的显示识别；`composerCommands`、真实 `ComposerEditor` 共 15 项定向检查通过；最后将键位限制为标准文本操作，8 项 EditorView 集成检查及构建通过。
- `npm run typecheck`、`npm run build`、`npm run check:i18n`、`npm run composer:probe`、`git diff --check` 通过。
- 无本地资料副本由本地 Git clone 后覆盖本次 diff 和新增源文件建立，没有 `docs/`、`architecture/` 或预先复制的 `node_modules`。
  `npm ci` 后 typecheck、build、i18n、probe 构建通过；更新到最后的语法范围与异步焦点改动后，完整 1019 项测试和构建再次通过。
  标准文本键位的最终调整另行补跑 8 项 EditorView 集成检查与构建。
- 新增测试覆盖真实 CM state/history/EditorView，而非自制历史模拟；DOM 环境为 jsdom，不作为真实设备输入证明。

主要新增回归：`ComposerEditor.test.ts`、`composerCommands.test.ts`、`ComposerKernelProbe.test.ts`。
保留并适配原输入、Wiki Suggest、Draft、保存、图片与设置断言；增加同文新会话、失败保存、异步上下文与焦点、工具栏配置写入失败场景。

## 仍需正式验收

真实 Obsidian 和设备验证按用户要求暂缓，因此不标记为产品正式验收完成：

- Obsidian 1.11.0 与当前版本的 Windows、Android、iPhone 实际依赖加载。
- 中文/英文输入法候选、自动纠错、系统选区与剪贴板、鼠标定位与拖选、Undo/Redo。
- 真实移动浮层中的键盘高度、Tap/Swipe、屏幕旋转、长文本滚动、暗色/浅色与窄窗口视觉。
- 长内容的输入延迟、显露切换与光标位置，需要实际宿主测量。

独立宿主验证插件及步骤见 [README.md](README.md)。正式产品验收应使用本次构建的 Knomo，不能仅以诊断 Modal 代替真实 Composer。

## Review 入口

当前工作区未提交 diff 与新增文件。建议按编辑状态/历史 → 文本命令/语法范围 → Suggest/IME → 保存/图片会话 → 共享工具栏设置/手势的顺序检查。
这是交付导航，不表示已执行独立 Stage Review。

## 本轮桌面反馈改进（2026-09-12）

- Toolbar 改用现有插件 data.json 设置路径，沿用外部设置重读和 onChanged 通知。未发布的设备本地 Toolbar 值不再参与读取；尚未保存共享配置时使用默认值。
- 声明式设置复用同一行时，先移除自身拥有的 Toolbar 容器，再创建新容器；重复渲染六次仍只保留一份，保留宿主标题和描述。
- 编辑器通过 EditorView.editorAttributes 声明样式类，修复聚焦后类名丢失。回归测试在修复前明确失败，修复后通过。
- 保留 Live Markdown 效果，编辑器字体使用 Obsidian --font-text；桌面正文 15px / 1.7 行距对齐卡片，移动端保留 16px 输入字号。
- 输入区继续随内容增高，到原有高度上限后滚动；移除 CodeMirror 默认聚焦虚线。Bold / Highlight / 内部链接分别使用 setIcon 的 bold / highlighter / brackets。
- 本轮完整测试：1021 项全部通过；build（含 typecheck）、check:i18n、git diff --check 通过。未运行 lint。
- 浏览器真实布局验证：桌面一行 48px、八行 204px；移动容器一行 150px、八行约 218px；两种布局聚焦后 outline 均为 none，继承所配置的正文变量字体。验证页使用正式 ComposerEditor 与 styles.css，不替代 Obsidian / Android / iPhone 真机验收。
- 已更新指定 Composer Toolbar 开发测试库中的 main.js、styles.css，并核对文件哈希；旧产物保留在 .tmp/composer-before-improvement。未改动该库 data.json、笔记或原版本对照测试库。需在 Obsidian 重载插件后验收。

## Live Markdown 显示对齐（2026-09-12）

- 任务标记由 Unicode 字符替换为原生 input[type=checkbox]，复用 task-list-item-checkbox 和主题完成态变量；保留点击显露源码、不独立切换任务的行为。
- Bold / Highlight / Wiki Link 装饰改用 strong / mark / a.internal-link；使用 Obsidian 粗体、链接及高亮主题变量。链接不带导航 href，仍用于编辑。
- 列表标记增加固定标记区与换行悬挂缩进；较长编号按字符数留出空间，右括号编号显示为卡片式句点，原文保持不变。
- 修改作用于桌面和移动端共用编辑器；不改变原方案的语法范围、保存路径或正文事实。
- 本轮定向测试 17 项通过，覆盖原生复选框状态、点击源码显露、语义 DOM、选区、撤销及原文不变；build（含 typecheck）和 diff 检查通过。
- 浏览器桌面与移动容器截图检查通过；未宣称完整 Obsidian 主题或移动真机验收。已更新 Composer Toolbar 开发测试库产物，需重载插件。

## 原生列表标记修复（2026-09-12）

- 将剩余的字符圆点和编号替换为 ul / ol > li 的原生 ::marker。通过 ol.start 保留原编号显示，正文不变。
- 17 项定向测试通过，build（含 typecheck）、diff 检查通过。浏览器桌面与移动布局确认 disc / decimal 原生标记正常显示。
- 已备份并更新 Composer Toolbar 开发测试库的 main.js 和 styles.css，哈希验证一致；实际 Obsidian 主题和移动真机效果仍需重载验收。
