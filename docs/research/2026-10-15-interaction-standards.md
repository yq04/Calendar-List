# 交互、显示与可读性参考依据

访问日期：2026-10-15。通过 agent-reach 的网页路由 / Jina Reader 获取公开官方资料。原始抓取保存在操作系统临时目录；本文件仅保存归纳，不修改业务实现。

## 已核实的规范事实

W3C WCAG 2.2 的 Target Size (Minimum) 2.5.8 要求指针目标至少容纳 24×24 CSS px 的区域，并存在间距、等价控件、行内文字、浏览器原生控件和必要呈现等例外。更大热区是易用性建议；不能把视觉上的小圆点尺寸直接当最终命中区，也不能把 44 px 笼统说成所有控件的 AA 强制要求。应测 getBoundingClientRect、elementFromPoint 和实际 pointer 输入。

来源：<https://www.w3.org/WAI/WCAG22/Understanding/target-size-minimum.html>。正文已访问，包含正式条款及例外。

W3C Contrast (Minimum) 1.4.3 对一般正文要求至少 4.5:1，大字等存在 3:1 及其他例外；小号辅助信息仍是文字，不能仅因颜色角色叫 muted 而降为 3:1。规范还指出应看用户代理或样式中定义的前景/背景色，而非直接用抗锯齿字缘像素计算比值；细字重的实际观感也要单独检查。

来源：<https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum.html>。Jina 抓取遇到 500，已用 curl 直接读取 W3C 正文确认条款；未把失败响应当作证据。

MDN 的 KeyboardEvent.isComposing 说明该布尔值表示事件处于 compositionstart 与 compositionend 之间。代码有 isComposing 检查不等于全部输入路径安全：真实中文输入法的候选确认 Enter、表单 submit、blur、Esc 和异步返回后输入清理仍需逐路径检查。脚本派发 CompositionEvent 只能证明合成事件路径，不能替代 Windows 原生 IME 验收。

来源：<https://developer.mozilla.org/en-US/docs/Web/API/KeyboardEvent/isComposing>。定义正文已访问。

MDN 的 Window.devicePixelRatio 定义为物理像素与 CSS 像素之比。需要区分 DOM CSS 像素、原生物理坐标、系统缩放与项目自己的 kalScale；移动到其他显示器后也需要刷新相应显示信息。该定义不能单独证明现有代码发生双重缩放，必须测量渲染后的物理尺寸。

来源：<https://developer.mozilla.org/en-US/docs/Web/API/Window/devicePixelRatio>。正文与 HiDPI 示例已访问。尝试的 Microsoft WebView2 concepts/device-pixel-ratio 地址返回 404，未用该地址支持结论。

## 结合 Kal 的建议，尚未实施

- 默认操作控件建议采用至少 28–32 CSS px 的实际热区，保留精细视觉符号；紧凑布局也不靠只有数像素的命中点。触控模式可提供更大目标，作为产品选择单独说明。
- 完成/删除使用真实 button、清晰 focus-visible 和键盘语义；扩大热区时同步处理与任务编辑及格子选择的重叠/冒泡。
- 将提交会话与草稿版本绑定；完成旧请求不能清空用户新输入。IME 合成状态覆盖快速新增、内联编辑、搜索和倒计时输入。
- 按静态实体表面验收配色，再验证半透明与壁纸合成背景；不要把 OKLab 算法的目标值当成任何壁纸下的实测结果。
- 用固定环境与真实 Release 版本测点击反馈、月切换、搜索、启动时间及整个 WebView2 进程树资源。目标预算与测量结果分开记录。

## 本地已观察事实与待核实项

`src-tauri/src/display.rs:167` 将 PPI/96 限制在 0.85–1.40；交接文档省略了 clamp，不能照抄为无界公式。缺少跨屏动态刷新是否真实影响字号的本轮复现，留给后续兼容性验收。

既有 `docs/desktop-productivity-verification.md` 记录 GUI 隔离测试通过；真实宿主写入、全屏/跨屏兼容性、总进程树内存仍未验收。本轮不重复跑全部测试，也不升级历史记录的证据范围。

## 候选色板的有限算术检查

本轮将十六进制 sRGB 通道线性化，按相对亮度 `0.2126 R + 0.7152 G + 0.0722 B` 和 `(L亮+0.05)/(L暗+0.05)` 计算下列不透明色对。仅是方案筛选，不包括透明/模糊/壁纸合成，不是产品运行时可读性验收；显示数值为展示而四舍五入，阈值判断不能靠进位。

- 天枢暖纸正文 `#172648 / #fbf6ec` 约 13.854；辅助 `#536389 / #fbf6ec` 约 5.548。
- 天枢深海正文 `#e6f0ff / #071428` 约 16.032，辅助 `#a5bbdb / #071428` 约 9.415。
- Catppuccin Mocha 正文 `#cdd6f4 / #1e1e2e` 约 11.341，辅助 `#a6adc8 / #1e1e2e` 约 7.367。
- Nord 正文 `#eceff4 / #2e3440` 约 10.836，但原红 `#bf616a / #3b4252` 约 2.460，不宜原样用作该表面上的小号错误文字。
- Rosé Pine Dawn 候选辅助 `#797593 / #faf4ed` 约 4.024，Love `#b4637a / #fffaf3` 约 4.039；这两个角色仍需调整。
- Everforest 浅色候选辅助 `#829181 / #fdf6e3` 约 3.082，不能把 3:1 当作一般小号信息文字的验收线。

结论：成熟色板可以作为灵感与来源，Kal 的任务、辅助文字、错误、焦点环、今日和完成态需按用途重新映射。不能从仓库名称或单一正文对比度推定整套主题达标。
