# 外部主题调研与色盘证据笔记 (2026-10-15)

> 报告类型：外部设计资源调研与工程预设建议方案（Scheme 模式）  
> 调研执行：Codex Theme Research Worker  
> 状态说明：本笔记仅记录实际捕获证据与推荐方案，当前业务代码**未作任何修改**，候选主题仅作为建议预设。

---

## 一、调研背景与方法

本调研针对 Kal 终端/界面设计需求，采集并梳理外部成熟视觉风格。调研分为两部分：
1. 对天枢星港官方站点（https://tianshu.club/）进行实际网络只读探测，抓取其底层真实 CSS 变量与主题定义，彻底杜绝凭空臆测；
2. 检索并解析 GitHub 社区高赞、高可靠且具备明确开源许可（MIT）的官方调色盘仓库，提取原始 Hex 代码并制定适配 Kal 的语义角色方案。

---

## 二、天枢星港官网（tianshu.club）实测调研证据

### 1. 站点连通性与架构事实【事实】
- **访问日期**：2026-10-15
- **HTTP 响应**：200 OK，Server 为 nginx，网关版本标识 x-starport-release: giveaway-87bc8527da85。
- **页面形态**：静态轻量 HTML 挂载模块化前端脚本，采用 CSS 自定义属性（Variables）驱动全局皮肤与共鸣者空间配色。
- **抓取文件路径**：
  * 页面骨架：https://tianshu.club/
  * 全局样式表：https://tianshu.club/__delivery-index.css?v=0756d63e695c
  * 皮肤管理模块：https://tianshu.club/themes.js?v=d7aaecb151b5
  * 个人主页预设：https://tianshu.club/personal-colors.js?v=42cf98d21fef

### 2. 官方主题皮肤实测参数【事实】
在 themes.js 中共声明 5 种社区主题皮肤，默认当前激活皮肤为 whale（鲸鱼娘）：
1. **经典星港 (default)**：纸面浅色 #f7f7f2，夜航深色 #20262b。
2. **鲸鱼娘 (whale, 默认)**：鲸鱼咖啡馆浅色 #fbf6ec，深海深色 #071428。
3. **樱花 (sakura)**：春日和风浅色 #fff7f5，夜樱深色 #1f1519。
4. **薰衣草 (lavender)**：普罗旺斯浅色 #f8f5fd，暮紫星空深色 #151227。
5. **赛博朋克 (cyberpunk)**：强制深色 forceDark: true，底色 #07070d。

### 3. CSS 核心语义色值实测比对表【事实】
从 __delivery-index.css 实测提取的关键变量值如下：
- **经典浅色 (:root / default)**：
  * --bg: #f7f7f2（素净纸面）
  * --surface: #fcfcf8（面板底色）
  * --line: #c9cbc2（边框线）
  * --text: #272e36（主正文炭黑）
  * --muted: #69716f（辅助文字）
  * --accent: #343ac5（靛蓝主色）
  * --cinnabar: #cc5138（朱砂强调）
  * --amber: #97703b（琥珀次色）
- **默认鲸鱼娘浅色 (html[data-skin=whale] body)**：
  * --bg: #fbf6ec（暖米色背景）
  * --surface: #fffdf7
  * --line: #d5dceb
  * --text: #172648（深海绀青色字体）
  * --muted: #536389
  * --accent: #2649a0（经典天枢蓝）
  * --skin-glow: #cfe6ff
- **默认鲸鱼娘深色 (html[data-skin=whale] body.theme-dark)**：
  * --bg: #071428（深潜夜蓝）
  * --surface: #0e2140
  * --line: #2b4a78
  * --text: #e6f0ff（高明度蓝白字体）
  * --muted: #a5bbdb
  * --accent: #7fc4ff（明亮天蓝）
- **共鸣者空间 8 组独立色板 (personal-colors.js)**：
  * 暮色紫 (dusk): #775385 / #f7f0fa / #392d43
  * 玫瑰筝 (rose): #a45670 / #fff3f3 / #432936
  * 苔青 (forest): #477567 / #eef5ef / #233e35
  * 潮汐 (ocean): #397f91 / #edf7f9 / #203b49
  * 琥珀 (amber): #956827 / #fcf5e9 / #443521
  * 星河蓝 (blue): #526ea2 / #edf2fc / #25374f
  * 夜航 (night): #a9bce8 / #101827 / #ecf2ff
  * 石墨 (graphite): #b9bccb / #191a23 / #f2f1f7

### 4. 官网未覆盖特性与限制【未知】
- **动态特效应剥离【建议】**：官网包含落樱、鲸鱼游动及粒子动效脚本（themes-whale-live.js, themes-fx.js）；Kal 的静态预设不依赖这些特效。
- **站点许可【未知】**：尚未核实官网脚本、图像或字体的可再分发许可。只提炼配色参考并独立实现 Kal 语义主题，不复制其脚本、插画或字体；下述 GitHub 仓库的 MIT 不自动适用于该网站。
- **持久化契约**：当前社区端仅在 localStorage 中保存 starport-community-skin，未观察到服务端同步协议。

---

## 三、GitHub 优质开源调色盘实测证据

### 1. Catppuccin 调色盘【事实】
- **仓库与许可**：https://github.com/catppuccin/palette (MIT License)
- **实测文件**：palette.json，LICENSE
- **原始色板摘录**：
  * **Latte (浅色)**：Base #eff1f5, Mantle #e6e9ef, Surface0 #ccd0da, Text #4c4f69, Subtext0 #6c6f85, Blue #1e66f5, Lavender #7287fd, Red #d20f39.
  * **Mocha (深色)**：Base #1e1e2e, Mantle #181825, Surface0 #313244, Text #cdd6f4, Subtext0 #a6adc8, Blue #89b4fa, Mauve #cba6f7, Red #f38ba8.

### 2. Nord 调色盘【事实】
- **仓库与许可**：https://github.com/nordtheme/nord (MIT License)
- **实测文件**：src/nord.css，license
- **原始色板摘录**（16 色严谨极地体系）：
  * **Polar Night (暗底)**：--nord0: #2e3440, --nord1: #3b4252, --nord2: #434c5e, --nord3: #4c566a
  * **Snow Storm (浅亮)**：--nord4: #d8dee9, --nord5: #e5e9f0, --nord6: #eceff4
  * **Frost (冰川强调)**：--nord7: #8fbcbb, --nord8: #88c0d0, --nord9: #81a1c1, --nord10: #5e81ac
  * **Aurora (语义告警)**：--nord11: #bf616a (红), --nord12: #d08770 (橙), --nord13: #ebcb8b (黄), --nord14: #a3be8c (绿), --nord15: #b48ead (紫)

### 3. Rosé Pine 调色盘【事实】
- **仓库与许可**：https://github.com/rose-pine/palette (MIT License)
- **实测文件**：palette.json，LICENSE
- **原始色板摘录**：
  * **Dawn (浅色暖调)**：Base #faf4ed, Surface #fffaf3, Overlay #f2e9e1, Text #464261, Muted #9893a5, Pine #286983, Love #b4637a, Gold #ea9d34.
  * **Main (深色低眩)**：Base #191724, Surface #1f1d2e, Overlay #26233a, Text #e0def4, Muted #6e6a86, Pine #31748f, Love #eb6f92, Gold #f6c177.

### 4. Everforest 调色盘（参考备选）【事实】
- **仓库与许可**：https://github.com/sainnhe/everforest (MIT License)
- **实测文件**：palette.md，LICENSE
- **原始色板摘录**：
  * **Medium Dark**：Background #2d353b, Surface #343f44, Text #d3c6aa, Green #a7c080, Red #e67e80.
  * **Medium Light**：Background #fdf6e3, Surface #f4f0d9, Text #5c6a72, Green #8da101, Red #f85552.

---

## 四、推荐 Kal 静态优先预设方案（建议模式 Scheme）【建议】

以下 4 套预设基于上述官方数据蒸馏而成，**属于面向 Kal 语义层的建议适配方案，非官方直接原版，未写入业务代码**。

### 预设 1：星港·素纸深洋 (Tianshu Modern Whale)
- **定位**：融合天枢官方素净纸面与鲸鱼娘深潜绀青，兼顾中文阅读舒适感与专业质感。
- **浅色模式 (Paper Warm)**：
  * canvas: #fbf6ec | surface: #fffdf7 | border: #d5dceb
  * ink: #172648 | muted: #536389
  * accent: #2649a0 | accentSoft: #e2e9f7 | danger: #c34a65 | warning: #946a2e
- **深色模式 (Deep Ocean)**：
  * canvas: #071428 | surface: #0e2140 | border: #2b4a78
  * ink: #e6f0ff | muted: #a5bbdb
  * accent: #7fc4ff | accentSoft: #173a66 | danger: #ff9fb4 | warning: #e1bf7a

### 预设 2：极地霜夜 (Nord Frost Crisp)
- **定位**：参考 Nord 原始色板，采用冷灰底和冰蓝强调；层次区分与可读性仍需按 Kal 实际文本和背景验收。
- **浅色模式 (Snow Storm)**：
  * canvas: #eceff4 | surface: #e5e9f0 | border: #d8dee9
  * ink: #2e3440 | muted: #4c566a
  * accent: #5e81ac | accentSoft: #e5e9f0 | danger: #bf616a | warning: #d08770
- **深色模式 (Polar Night)**：
  * canvas: #2e3440 | surface: #3b4252 | border: #434c5e
  * ink: #eceff4 | muted: #d8dee9
  * accent: #88c0d0 | accentSoft: #3b4252 | danger: #bf616a | warning: #ebcb8b

### 预设 3：抚松暮霞 (Rosé Pine Soothe)
- **定位**：暖灰紫与松针青配色，作为长期桌面显示的审美候选。未做眼疲劳或医学效果研究，不宣称能缓解眼睛干涩。
- **浅色模式 (Dawn)**：
  * canvas: #faf4ed | surface: #fffaf3 | border: #f2e9e1
  * ink: #464261 | muted: #797593
  * accent: #286983 | accentSoft: #f2e9e1 | danger: #b4637a | warning: #ea9d34
- **深色模式 (Moon & Main)**：
  * canvas: #191724 | surface: #1f1d2e | border: #26233a
  * ink: #e0def4 | muted: #908caa
  * accent: #31748f | accentSoft: #26233a | danger: #eb6f92 | warning: #f6c177

### 预设 4：森林和纸 (Everforest Organic)
- **定位**：参考大地和森林的自然中性调，适用于偏好暖绿配色的用户；不同字号与屏幕下的效果待验收。
- **浅色模式 (Medium Warm)**：
  * canvas: #fdf6e3 | surface: #f4f0d9 | border: #e0dcc7
  * ink: #5c6a72 | muted: #829181
  * accent: #3a94c5 | accentSoft: #e9f0e9 | danger: #f85552 | warning: #dfa000
- **深色模式 (Medium Forest)**：
  * canvas: #2d353b | surface: #343f44 | border: #475258
  * ink: #d3c6aa | muted: #859289
  * accent: #7fbbb3 | accentSoft: #3a515d | danger: #e67e80 | warning: #dbbc7f

---

## 五、中英文排版与对比度落地建议【建议】

1. **字体栈层级建议**：
   - 西文字体优先采用无衬线系统字体（如 system-ui, -apple-system, Segoe UI），保证英数标点比例工整；
   - 中文字体建议优先使用 PingFang SC、Microsoft YaHei、Noto Sans CJK SC；
   - 阅读型界面可借鉴天枢星港配置，提供衬线体可选（Songti SC、Noto Serif SC）。
2. **文字对比度安全准则**：
   - 浅色与深色模式下，主正文（ink）与底色（canvas/surface）对比度均须严格满足 WCAG 2.1 AA 级标准（≥ 4.5:1）；
   - 小号且传达信息的辅助文字也以 ≥ 4.5:1 为目标，不因命名为 muted 就降为 3.0:1；3.0:1 的大字/非文本等规则按实际用途另行判断。上述候选颜色尚未全部做对比度验收，不可直接宣称达标。
3. **静态优先原则**：
   - 纯 CSS 变量驱动，不强制加载额外大字体文件或复杂 JS 监听器，确保首屏加载零抖动。
