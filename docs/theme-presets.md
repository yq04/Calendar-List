# Kal 静态主题预设

2026-10-15。五套主题是独立的 Kal 角色适配，完整 JSON 静态编入程序，不联网、不加载背景动画，也不捆绑字体。默认 `bgAlpha=surfaceAlpha=surfaceHoverAlpha=todayBgAlpha=1`、`blur=0`、无阴影。

星港素纸（`builtin-starport-paper`，浅色）参考天枢 whale 浅色：背景 `#FBF6EC`、表面 `#FFFDF7`、正文 `#172648`、辅助 `#536389`、强调 `#2649A0`、今日底色 `#E2E9F7`、错误 `#A3314B`。

深海夜航（`builtin-deep-ocean`，深色）参考天枢 whale 深色：背景 `#071428`、表面 `#0E2140`、正文 `#E6F0FF`、辅助 `#A5BBDB`、强调 `#7FC4FF`、今日底色 `#173A66`、错误 `#FF9FB4`。

摩卡紫蓝（`builtin-mocha`，深色）参考 Catppuccin Mocha：背景 `#1E1E2E`、表面与今日底色 `#313244`、正文 `#CDD6F4`、辅助 `#A6ADC8`、强调 `#89B4FA`、错误 `#F38BA8`。

极地霜夜（`builtin-nord`，深色）参考 Nord：背景 `#2E3440`、表面 `#3B4252`、正文 `#ECEFF4`、辅助 `#D8DEE9`、今日与悬停底色 `#434C5E`。原候选强调 `#88C0D0` 和错误 `#FF9DA7` 在该底色上不足 4.5:1；Kal 校正为 `#8CC4D4`、`#FFA2AC`。它们属于 Kal 适配值。

松影晨纸（`builtin-rose-dawn`，浅色）参考 Rosé Pine Dawn：背景 `#FAF4ED`、表面 `#FFFAF3`、正文 `#464261`、辅助 `#645F7B`、强调 `#286983`、今日底色 `#F2E9E1`、错误 `#9E4961`。辅助与错误使用方案的校正值。

每套都明确包含 `fg/fgMuted/fgDim/fgWeekend/fgHoliday/fgOtherMonth/accent/accentFg/danger/dangerFg/focus/done/selectedBg/selectedFg/todayRing/surfaceHover`。小号信息文字的 dim、otherMonth、done 使用可读的辅助色，不能再通过整行 opacity 降低它们。装饰 line 不承担信息边界保证。

主题测试分别比较上述十个文字角色与背景、表面、悬停、今日、选中五种底色，全部至少 4.5:1；强调和错误填充文字也至少 4.5:1；focus、todayRing 对五种底色分别至少 3:1。五套最弱文字色对依次约 4.904、5.853、4.875、4.503、4.721:1。所有比值是对不透明 sRGB 数据的计算，未声称经过全设备真实窗口、透明壁纸或实际字形的视觉验收。

预设包含完整默认排版和布局，以便独立导入或初次使用。前端选择预设时默认只合并 `color` 与 `shape` 材质，保留当前 `type/layout/scale/scaleMode`；同时应用排版建议必须是独立选项。完整预设沿用现有默认字号，用户字号不会因默认配色选择被重置。

只读 ID 包含上述五个及 `default` 兜底。主题库返回五个内置条目和有效用户主题；`ThemeRef` 为 `id/name/mode/source/created/builtin`。磁盘中同名保留 ID 文件不能遮盖内置主题，也不会被自动删除。用户可复制内置草稿，通过 `theme_commit` 保存为新用户版本。

许可和锁定来源见 [third-party-themes.md](third-party-themes.md)。中文样例可用“项目讨论：确认第 2 版，周五 14:30；中文标点、ABC 0123456789、🙂、𠮷”，实际缺字由系统回退字体处理。
