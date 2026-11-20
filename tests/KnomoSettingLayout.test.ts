import test from "node:test";
import assert from "node:assert/strict";

// 由真实设置渲染器生成页面，只替换宿主组件；不手写待测设置行。
import { renderSettings } from "./helpers/renderSettingsFixture";

test("real settings renderers retain all controls and separate the Monthly retry from its toggle", async () => {
	await renderSettings("zh-CN");
	await renderSettings("en");
});

// 可选真实浏览器检查：指定已安装的 Playwright 模块路径，无需给插件添加运行时依赖。
