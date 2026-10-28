# Kal 输入会话与主题前端实施记录

> 2026-10-15 的历史实施记录，文中的待验证状态和实现步骤用于追溯当时工作。最新功能与验证范围以 [README](../README.md) 和 [v0.1.3 发行说明](RELEASE_NOTES_0.1.3.md) 为准。

日期：2026-10-15。范围为 P0 输入/命中与 P1 主题前端。未启动 DesktopCal，未读写生产数据库，未构建或启动 Kal GUI。后端主题和性能工作由其他文件所有者负责。

## 做了什么

先在 `tools/ui-check.mjs` 为 `month_events` 加入可控 350 ms 延迟。确认首条写入成功清空后，使用 CDP `Input.insertText` 输入下一条；原代码在读取结束后再次清空，回归首次结果为 15 通过 / 1 失败，失败值为空。删除异步刷新后的第二清空，清空只由提交快照确认负责，回归随后通过。

新增 `ui/src/input-session.js`：草稿仅驻留内存，以来源日期/事项、会话 ID、修订号管理。提交捕获不可变快照；旧响应只能确认匹配的会话和修订。快速新增切换日期后恢复各日草稿，旧日期提交不能清空新日期文本。内联草稿跨切日、刷新保留，保留编辑起点的 expected 快照，失败/取消确认不丢草稿；完成确认后的旧 DOM blur 不会重新创建已结束草稿。

内联编辑支持文字双击，或 Tab 聚焦文字后 Enter/F2 进入；Enter/显式保存提交，Esc/取消恢复原文。blur 仅保留草稿。空内容显示错误和 aria-invalid，允许移焦，不强制 focus 回拉。Ctrl+F 保持全日期搜索，关闭搜索恢复尚存的原输入节点及选区；搜索跳日期仍保留内存草稿。

新增共享 compositionstart/end、isComposing、229 与候选确认按键释放守卫，覆盖快速新增 submit/keydown、内联编辑保存/取消、搜索和本机倒计时。待确认写入结果不主动抢走焦点。Windows 原生输入法候选系统仍需真实验收，脚本合成事件和 CDP 插字不算原生 IME 证据。

完成控件改为原生 button，提供 aria-pressed 与任务名称；28 CSS px 最小宽高独立占据布局空间，视觉仍为 6 px 圆点。删除/内联保存取消至少 28 CSS px。完成态移除整行透明度，使用 done 语义色和删除线。danger/dangerFg/focus/selectedBg/selectedFg 实际消费到错误、危险按钮、焦点及选日；保留独立今日环线与节日颜色。

主题库消费后端五套只读内置预设和 default 兜底；标注内置/我的主题，提供色卡与复制并编辑。预览仅合并配色和材质，保留字体、字宽、字号、布局、倍率和输入草稿。设置打开时保存完整快照，关闭/重置恢复；保存成功更新快照，失败保留草稿。载入/生成/导入和私有字体选择有过期响应保护。色彩/材质变更直接更新 CSS，只有结构签名变更重建 DOM。

保存改用 `bridge.themeCommit(theme)` → `theme_commit({theme})` → 完整 Theme；导出用 `bridge.themeExportDraft(theme,path)` → `theme_export_draft({theme,path})`，不隐式保存或激活。保留旧桥接口供既有调用者兼容。未来 schema 主版本拒绝预览和自动重存；旧 v1 缺失语义角色从本主题已有颜色回退，避免继承上一套预设。

字体仍复用按需加载器，新增中文、英文、标点、数字、emoji 和扩展汉字预览及缺字/字宽说明；数字继续 tabular-nums。没有改已有用户主题字号，也没有引入 npm 或前端构建器。

新增 `tools/run-native-check.ps1`：只接受项目 `_fixture/calendar.db`；每次新建 runtime-native-GUID APPDATA，准备一项本机倒计时和系统 Segoe UI 的隔离字体副本；拒绝已有 Kal 进程，启动失败明确报错。结束只关闭/终止本次创建 PID，保留隔离产物，不按进程名结束其他进程。`-ThemeChecks` 启用新主题真实 IPC 检查。`native-check.mjs` 使用包装器指定的可执行文件，并新增真实 WebView 坐标打开设置与显示参数记录。

## 针对性验证

- `node ui/_selftest.mjs`：100/100 通过。
- `node ui/_input-selftest.mjs`：通过；覆盖修订、跨日、新会话复用同文、单次确认及候选按键释放。
- `node ui/_themes-selftest.mjs`：通过；覆盖仅配色合并、不可变预设、旧字段/未来版本、语义字段、提交/导出 IPC 和五个后端预设 JSON。
- `node ui/_fonts-selftest.mjs`：11/11 通过。
- `node ui/_productivity-selftest.mjs`：16 项通过。
- `node tools/ui-check.mjs`：27/27 通过。覆盖原 15 项及延迟清空、跨日旧提交、F2/Ctrl+F/Esc、编辑刷新/校验、四条输入链的合成守卫、真实坐标热区和主题事务/过期响应/语义角色消费。
- CDP 对完成按钮测得 28×28 CSS px；中心和四边内侧 elementFromPoint 均命中 button，与文字矩形不重叠；实际边缘 mousePressed/released 只发一次 item_toggle_done。
- `node --check tools/native-check.mjs` 及 PowerShell AST 解析 `tools/run-native-check.ps1`：通过。

五套语义角色检查在真实 Edge DOM 上检查计算样式；测试探针关闭 CSS 过渡后采集终态，避免把 120 ms 的中间过渡值误判为角色未生效。色对计算与许可证记录由主题后端报告负责，此处不把 CSS 消费测试升级为完整对比度或设备可读性验收。

## 遗留什么

尚未执行 `pwsh -NoProfile -File tools/run-native-check.ps1 -ThemeChecks`，因为旧可执行文件用于并行性能基线，尚未取得 Kal GUI 租约或重新构建。原生主题 IPC/FontFace/窗口焦点的本轮改版联调仍待该入口验证。Windows 微软拼音真实候选确认、取消候选、外部窗口切换、热键收起呼出；100%/150%/200% 和混合缩放双屏仍未测。真实原生点击/IME的完整 P0-B 门槛未宣称完成。

真实 DesktopCal 写入、确认和多端同步不在本轮前端测试证据内；Mock IPC 成功不代表宿主写入成功。未修改原生失焦策略，没有未经复现而加永久置顶或抢焦点逻辑。

## 设计偏差

P0-B 的真实 IME 和跨屏设备门槛保留为未验收；前端可控测试与 P1 实现已先完成，以便后续统一构建联调。五套色卡 JSON 由后端静态资源作为唯一配色真值，浏览器演示桥仍只提供会话内用户主题，桌面主题库提供五套内置；不在前端复制另一份色盘。原有危险提示借用节日色的路径已改为专用语义角色。
