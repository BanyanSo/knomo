# 移动端关联详情与分享面板交接

本轮自动化验证的是真实控制器、DOM 与已知失焦事件时序的模拟；没有 iOS / Android Obsidian 实机轨迹，首击中断层尚未确认。以下流程须分别在 iOS、Android 执行，并记录 Obsidian、系统、输入方式及主题版本。

## 先确定首击断点

通过 WebView 远程调试控制台执行 `scripts/trace-mobile-interaction.js` 的内容，然后在 20 秒内打开关联详情或分享面板并进行第一次操作。执行 `knomoInteractionTrace.stop()` 停止，`knomoInteractionTrace.print()` 查看最多 200 条结构化记录；不采集 Memo 正文，不写 Vault。每个独立流程重新启动记录。

记录包含捕获与冒泡阶段的触摸、指针、click、窗口及元素焦点、命中元素、可见遮罩、选中模板和输出忙状态。使用调试器 Logpoint 在 `MemoRelationsPage.open/back`、`KnomoShareCardModal.select/output` 入口及各提前返回处调用 `knomoInteractionTrace.mark('函数及分支名')`，确认处理函数和状态拒绝分支。Logpoint 仅在调试器配置，不加入运行时代码。

判读：touchend 后无 click，且窗口在稍后才恢复焦点，才属于现有缺失 click 补偿路径；捕获有 click 而冒泡缺失须检查宿主监听器、遮罩和停止传播；函数已进入但状态拒绝须对照 closed、outputBusy、stale、file 等实际状态。不要从模拟测试反推实机根因。系统分享的调用断点还要记录 `navigator.userActivation.isActive`，不能通过延时合成 click 验证用户激活。

## 流程验收

- 冷启动首次点击卡片左上角时间，直接打开对应日记；返回后的正常点击及键盘激活仍正常，迟到兼容 click 不重复跳转。
- 冷启动首次进入关联详情，返回后再次进入；原列表有无元素焦点都只操作一次。指针进入、逐层返回和最终返回保留实际焦点且无额外焦点环；切到外接键盘后立即出现清晰焦点提示。
- A→B→C 逐层返回、A→B→A 成环导航；异步加载期间操作其他按钮、打开输入框或新弹窗，旧恢复不能抢焦点。
- 分享面板连续关闭／重开至少三次，每次首击关闭和模板切换执行一次；正常 click 与补偿后的迟到 click 都不重复，也不穿透下层。
- 系统分享首次操作、取消返回及成功返回，随后切换模板和关闭；分享必须在原生用户激活栈内调用。复制、保存和写入 Vault 不走延时 click 补偿。
- 收起软键盘后首击、快速切页和切换弹窗、长按、拖动、滚动、多指及手势取消；旧动作不执行。确认弹窗和图片预览等相似入口只记录实机结果，未经确认不扩改。
- iOS VoiceOver、Android TalkBack 激活及外接键盘 Enter／Space／Tab／Escape；确认桌面鼠标与键盘的进入、返回、分享操作保持正常。

执行结果分别标记“通过／失败／未执行”，附短事件链；浏览器模拟通过不能填写为实机通过。
