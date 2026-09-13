# Composer 编辑内核接入验证（开发计划步骤 1）

这是独立验证插件，不替换正式 Composer，不读取或写入 Daily，不提供完整 Toolbar 或 Live Markdown。
目标是先验证候选内核的宿主加载、文本事务、历史、选区和一种 marker 显露。

## 构建与依赖边界

```sh
npm ci
npm run composer:probe
npm run test:file -- ComposerKernelProbe.test.ts composerInput.test.ts ComposerListEnterState.test.ts ComposerDraft.test.ts ComposerSaveShortcutController.test.ts
```

输出在 `.tmp/knomo-composer-probe/`。将其中 `main.js` 和 `manifest.json` 复制到测试 Vault 的
`.obsidian/plugins/knomo-composer-probe/`，启用 **Knomo Composer Probe**，运行命令“打开 Composer 内核验证”。
验证插件使用独立 ID；不要覆盖正式 Knomo。关闭窗口会销毁编辑器，重新打开从新会话开始。

编译显式锁定 `@codemirror/state` 6.5.0、`@codemirror/view` 6.38.6（与当前 Obsidian 类型依赖一致）、
`@codemirror/commands` 6.8.1。宿主只提供 state、view、obsidian；commands 及其依赖打包到验证产物。
构建检查实际 external imports，`dependencies.json` 记录打包模块。正式构建也只 external state、view，
commands、Markdown 解析器及其余依赖随插件打包。
这只是候选组合：不能由 npm 依赖树推断 Obsidian 1.11.0 或各移动宿主的实际版本与兼容性。

实现参考：[CodeMirror 最小编辑器](https://codemirror.net/examples/basic/)、
[显示装饰](https://codemirror.net/examples/decoration/)。未使用 Obsidian 私有编辑器接口。

## 现有输入基线

| 行为 | 已有回归来源 | 验证面边界 |
| --- | --- | --- |
| Task、UL、OL 续行，空项退出，嵌套及有序 Task | `composerInput.test.ts` | 调用原 `getListEnterPatch`，不接默认 Markdown keymap |
| 原生换行、候选确认与换行同次输入、marker 空格补偿 | `composerInput.test.ts`、`ComposerListEnterState.test.ts` | 旧测试保留；CM 原生事件是否需要补偿待设备验证 |
| 草稿、引用、编辑与保存文本 | `ComposerDraft.test.ts` | 仍由正式 Composer 处理，验证面不保存 |
| 保存快捷键及重复按键 | `ComposerSaveShortcutController.test.ts` | 原断言保留；验证面不提供保存命令 |
| 原始文本、反向选区、一次撤销重做、新会话历史隔离 | `ComposerKernelProbe.test.ts` | 运行真实 CM state/history，非 DOM 模拟历史 |

Tag/Wiki Suggest、图片、浮标和移动浮层接入属于后续输入迁移，本验证窗口不能证明它们已经兼容。

## 实际环境操作清单

分别记录 Windows、Android、iPhone 的系统、Obsidian 版本、输入法与结果。
最低 Obsidian 1.11.0 和当前使用版本都需要宿主加载证据。

1. 启用验证插件，打开窗口，确认没有缺失模块或重复 state 实例错误。
2. 输入中文、英文、候选词、emoji、多行文本；测试候选确认 Enter，不应额外续行。
3. 输入 `- item`、`2) item`、`- [x] 完成`，Enter 应保留原规则；空 `- ` 退出列表。
4. 选择中文正文，点击“选区加粗”，一次 Undo 恢复正文和选区，Redo 恢复结果。
   此按钮仅验证事务，不是产品 Bold 的最终语义；不验收 toggle 或多行格式化。
5. 首行 `- [ ] ` 在光标远离时显示装饰 checkbox；点击 marker 或将光标移入前缀应显露源码。
   编辑正文、拖选、全选和复制，核对下方只读原文/选区。测试从正文边界向左移动和删除。
   显露判断仅针对首行确定前缀，不是语法解析器，不支持正式嵌套或代码屏障。
6. 移动端测试中文候选、自动纠错、长按、选区手柄、软键盘、旋转和长文滚动。
   若 Modal 测试通过，还须在步骤 2 的真实移动浮层重复这些检查。
7. 关闭再打开，确认旧文本、历史和编辑器监听没有跨会话残留。

## 当前验收边界

自动化可以证明 state/history 和旧纯文本基线，不能证明实际 IME、系统剪贴板、光标视觉位置、
Modal/移动浮层软键盘与宿主版本兼容性。真实平台结果尚待记录。用户已明确将真机验证移至最后，
正式 Composer 的输入迁移、Toolbar、显示与插件持久设置已继续实施；独立验证插件仍只用于宿主诊断。
