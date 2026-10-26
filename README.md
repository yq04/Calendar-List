<div align="center">

<img src="docs/screenshots/v0.1.0/logo.png" alt="Calendar List Logo" width="108" height="108" />

# 日历清单 · Calendar List

**轻量、温润、高颜值的 Windows 嵌入式桌面日历与待办清单**  
*A Lightweight, Customizable Desktop Calendar & Todo List for Windows — Powered by Rust + Tauri v2*

[![Release v0.1.0](https://img.shields.io/badge/release-v0.1.0-1e40af?style=flat-square)](https://github.com/yq04/Calendar-List/releases/tag/v0.1.0)
[![Platform](https://img.shields.io/badge/platform-Windows%2010%2F11%20x64-0078d4?style=flat-square)](https://github.com/yq04/Calendar-List/releases)
[![Tech Stack](https://img.shields.io/badge/stack-Rust%20%2B%20Tauri%20v2-dea584?style=flat-square)](src-tauri/Cargo.toml)
[![Frontend](https://img.shields.io/badge/frontend-Zero--Bundle%20ESM-10b981?style=flat-square)](ui/src/main.js)
[![License: MIT](https://img.shields.io/badge/license-MIT-64748b?style=flat-square)](LICENSE)

[**⬇️ 下载 Windows x64 安装包 (v0.1.0 · 2.23 MB)**](https://github.com/yq04/Calendar-List/releases/download/v0.1.0/CalendarList_0.1.0_x64-setup.exe) · [**📋 v0.1.0 发行说明**](docs/RELEASE_NOTES_0.1.0.md) · [**🎨 主题与色板说明**](docs/theme-presets.md) · [**⚡ 性能基线报告**](docs/performance-baseline.md)

</div>

---

## ✨ 为什么选择「日历清单 · Calendar List」？

传统桌面日历（如 DesktopCal）拥有实用的月历格子记事模型，但其早期的 GDI 自绘渲染层难以兼顾现代高分屏字体排版、色彩可读性与轻快交互；而重型全功能日历客户端又往往充斥着繁琐的表单、精确到分钟的强制时间段和沉重的后台开销。

**日历清单 · Calendar List** 用 **Rust + Tauri v2 + 零打包器原生 ES Module** 重新打造了一款回归纯粹的桌面日历清单：

- 🪶 **极致轻量，低配友好**：安装包仅 **2.23 MB**，无 Node.js 运行时与前端框架臃肿包体；内置「减少动画」与「温润实底」模式，核显与老旧办公本也能丝滑常驻桌面。
- ✍️ **左右双侧直接编辑，默认不设时间负担**：既能在**左侧 42 格日历任意格子双击直接打字**，也能在**右侧每日清单原位新建或双击修改**；日常安排默认不要求填写具体时刻，需要时再一键展开手动时间。
- 📐 **满格不溢出、不吞字**：智能识别单格事项密度，满格自动启用紧凑单行截断并将 **`+N 更多`** 独立固定于格子底栏，点击即可弹出当日完整清单。
- 🎨 **护眼素纸美学 + OKLab 壁纸取色引擎**：内置 **星港素纸、深海夜航、摩卡紫蓝、极地霜夜、松影晨纸** 5 套主题与 8 色快选圆点，支持按桌面壁纸自动生成符合 WCAG AA/AAA 对比度的专属配色。
- 🗓️ **本土化日历细节拉满**：内置 1900–2100 农历、二十四节气、法定节假日「休/班」角标、周视图 7 列专注看板、跨日拖拽改期、未完事项一键顺延，以及 **A4 横向满幅 PDF / Markdown / iCalendar (`.ics`)** 导入导出。

---

## 🖼️ 界面预览（`v0.1.0` 实机渲染）

> 以下截图均来自 `v0.1.0` 实际前端与隔离演示数据，不包含任何个人隐私数据。

### 1. 主界面总览（护眼暖白主题 · 清晰日期星期 · 满格 `+N 更多` 常驻）
顶部紧凑 `[ ‹ 今天 › | 周视图 ]` 导航胶囊，左侧 42 格等高矩阵清晰呈现公历、农历、节气与法定休/班角标；右侧聚焦当日 **日期 + 星期** 与待办清单，彻底告别杂乱黄历干扰。

![主界面总览：满格 +3 更多常驻与右侧清爽日程栏](docs/screenshots/v0.1.0/01-main-overview.png)

### 2. 左右双侧直接编辑（左侧日历格双击直编 + 右侧列表原位直编）
无论是习惯在**左侧日历格子上直接双击记录**（或点击格子右上角悬停 `+` 号），还是习惯在**右侧面板顶部/底部直接输入**，都能一键回车即存；双击任意已有事项即可原位修改文字。

| 左侧日历格双击原位输入 | 右侧清单底部 `+ 直接添加安排` 原位编辑 |
| :---: | :---: |
| ![左侧日历格双击直接编辑](docs/screenshots/v0.1.0/02-left-direct-edit.png) | ![右侧列表直接编辑](docs/screenshots/v0.1.0/03-right-direct-edit.png) |

### 3. 设置与工作台 `v0.1.0`（多语言 · 减少动画 · 8 色快选 · 检查更新 · 操作日志）
借鉴现代桌面工具的卡片化分组设计，支持 **简体中文 / 繁體中文 / English** 实时切换、**减少动画**开关、**8 色强调色快选**、**版本检查更新**与可导出的**操作日志历史**。

![设置与工作台 v0.1.0](docs/screenshots/v0.1.0/04-settings-updater.png)

<details>
<summary><b>🔍 点击展开更多预览：周视图看板、A4 横向满幅打印导出与 5 套内置主题矩阵</b></summary>
<br />

**周视图 7 列专注看板 & A4 横向满幅 PDF / Markdown / ICS 导出**：

![周视图看板与导出面板](docs/screenshots/v0.1.0/05-week-kanban-export.png)

**5 套内置静态高对比度主题（星港素纸 / 深海夜航 / 摩卡紫蓝 / 极地霜夜 / 松影晨纸）**：

![5 套内置主题对比](docs/screenshots/v0.1.0/06-themes-contact-sheet.png)

</details>

---

## 🚀 核心功能一览

| 模块 | 核心能力 |
|---|---|
| **日历矩阵与视图** | 42 格月历矩阵、7 列纵向周视图看板、跨月灰显、今日焦点框、周次徽章、年月快速跳转面板 |
| **农历与节假日** | 1900–2100 农历日期、二十四节气高亮、法定节假日「休/班」角标、支持在设置中导入自定义节假日 JSON |
| **多样化日程录入** | 左格双击内联新建、左格双击事项原位改字、右侧顶部快速输入、右侧底部内联新建；默认不设时间，按需展开手动时间/日期/重要标记与单日 6 色背景高亮 |
| **效率流转操作** | 跨日期格拖拽改期（指针阈值防误触）、当日未完事项一键顺延至明天、单步撤销（Undo）、整日安排一键复制、重要日期倒计时、独立便签本 |
| **外观与壁纸取色** | 5 套内置主题、4 套一键质感配方（纯透悬浮 / 冰晶毛玻璃 / 沉浸画布 / 温润实底）、OKLab 壁纸取色生成、物理显示器 PPI 感知缩放、本地私有字体加载 |
| **导出与开放格式** | A4 横向满幅 PDF 打印排版（格内自动换行不截断）、Markdown (`.md`) 导出、标准 iCalendar (`.ics`) 导入与导出 |
| **桌面集成与安全** | 桌面图层嵌入（Progman / WorkerW）、窗口位置锁定、一键防窥模糊遮罩、全局快捷键（`Win+Alt+C` 可选开启）、系统托盘常驻、独立本地 SQLite 沙盒与操作日志审计 |

---

## 📦 下载与安装

前往 [**GitHub Releases (`v0.1.0`)**](https://github.com/yq04/Calendar-List/releases/tag/v0.1.0) 下载最新 Windows x64 安装包：

- **安装包文件**：[`CalendarList_0.1.0_x64-setup.exe`](https://github.com/yq04/Calendar-List/releases/download/v0.1.0/CalendarList_0.1.0_x64-setup.exe)
- **安装包大小**：`2,342,572` 字节（约 `2.23 MB`）
- **SHA-256 校验值**：`8058bd8ed2c557a57a3fdc36aa3a1120d1b43b146957b7016cfe756d575c5e4e`
- **系统要求**：Windows 10 / Windows 11 (x64)，内置 WebView2 Runtime（Windows 11 及现代 Windows 10 已默认自带）。
- **自定义安装路径**：双击向导可直接安装，或通过命令行指定目录（例如安装至 `D:\1_app\CalendarList`）：
  ```powershell
  Start-Process -FilePath .\CalendarList_0.1.0_x64-setup.exe -ArgumentList "/S /D=D:\1_app\CalendarList" -Wait
  ```

---

## 🛠️ 技术架构与目录结构

| 层级 | 技术选型 | 设计取舍 |
|---|---|---|
| **原生外壳** | Rust + Tauri v2 + `windows-sys` | 负责桌面图层嵌入、系统托盘、GDI 物理显示器 PPI 感知、单实例锁与文件事务提交 |
| **渲染引擎** | WebView2 (Chromium DirectWrite) | 硬件加速字体抗锯齿、CSS 变量单一出口实时换肤、打印级 A4 横向排版 |
| **前端代码** | 原生 ES Module + 原生 CSS | **零 npm 依赖、零打包器**，14 个高内聚模块，修改即生效 |
| **数据存储** | `rusqlite` (bundled SQLite) | 支持开箱即用的独立沙盒数据库（`%APPDATA%\Kal\standalone_calendar.db`），同时兼容只读导入/桥接 DesktopCal 数据库 |
| **色彩科学** | `image` + 自研 OKLab k-means | 在感知均匀的 OKLab 空间聚类取色，二分求解满足 WCAG AA/AAA 对比度的文字色彩 |

```text
Calendar-List/
├── src-tauri/                 # Rust + Tauri v2 原生后端
│   ├── src/
│   │   ├── color.rs           # sRGB <-> OKLab 转换、WCAG 对比度计算与二分校正
│   │   ├── palette.rs         # 壁纸降采样与 OKLab 加权 k-means++ 聚类取色
│   │   ├── theme.rs           # 主题 Schema 校验、5 套内置预设与硬链接事务提交
│   │   ├── display.rs         # 物理显示器毫米尺寸与真实 PPI 感知缩放
│   │   ├── embed.rs           # Windows 桌面层嵌入 (Progman owner / WorkerW)
│   │   ├── db.rs              # SQLite 日历范围查询 (range_events) 与日期归一化
│   │   ├── editing.rs         # 独立沙盒 CRUD、移动改期、便签管理与快照乐观锁
│   │   ├── fonts.rs           # 系统字体枚举与私有字体目录安全加载
│   │   └── lib.rs             # Tauri IPC 命令路由、系统托盘与单实例唤醒
│   ├── themes/                # 5 套内置静态主题 JSON
│   └── tauri.conf.json        # Tauri v2 窗口与 NSIS 打包配置
├── ui/                        # 零构建依赖原生 ES Module 前端
│   ├── index.html             # 主视图与设置工作台骨架
│   ├── styles/                # tokens.css / layout.css / components.css / panel.css
│   ├── src/                   # main.js / calendar.js / lunar.js / theme.js / panel.js 等
│   └── _selftest.mjs          # 132 项前端纯函数与状态机单元测试
├── tools/                     # 自动化实机验证与性能基线工具链
│   ├── ui-check.mjs           # 无头 Edge CDP 真实 DOM 端到端回归测试 (38 项)
│   ├── perf-check.mjs         # 20 / 2k / 20k 规模性能评测探针
│   └── cdp.mjs                # 实时 WebView2 CDP 调试器
└── docs/                      # 发行说明、主题许可、性能基线与界面截图
```

---

## 💻 从源码构建与验证

### 1. 环境准备
- **Rust 工具链**：Rust 1.77+ (`stable-x86_64-pc-windows-msvc`)
- **Tauri CLI**：`cargo install tauri-cli --version "^2.0.0"`
- **Node.js 20+**（仅用于运行 `ui/_selftest.mjs` 与 `tools/ui-check.mjs` 自动化测试，前端本身无需 `npm install`）

### 2. 开发运行与打包安装器

```powershell
# 克隆仓库
git clone https://github.com/yq04/Calendar-List.git
cd Calendar-List

# 开发模式启动
cargo run --manifest-path src-tauri/Cargo.toml

# 构建 Windows x64 NSIS 安装程序 (CalendarList_0.1.0_x64-setup.exe)
cd src-tauri
cargo tauri build --bundles nsis
```

### 3. 命令行诊断与主题工具

```powershell
kal --doctor                            # 桌面结构 / 显示器 PPI / 壁纸 / 主题库 / 数据库全量诊断
kal --palette [图片路径]                 # 输出壁纸 OKLab 取色报告、对比度与主题 JSON
kal --theme-save "自定义名" [--light|--dark] # 按当前壁纸生成并激活主题
kal --selftest                          # 运行 Rust 端色彩与主题生成无头自检
```

### 4. 运行全量自动化测试套件

```powershell
# 1. 前端纯函数、农历节气、主题映射与输入会话自检 (132 项)
node ui/_selftest.mjs
node ui/_themes-selftest.mjs

# 2. Playwright / Edge CDP 真实 DOM 端到端交互自检 (38 项，含双侧直编与版本检查)
node tools/ui-check.mjs

# 3. Rust 核心单元与集成测试 (29 项)
cargo test --manifest-path src-tauri/Cargo.toml
```

---

## 🔒 数据边界与开源许可

- **本地数据优先，零云端遥测**：所有日程、倒计时、便签、主题与操作日志均保存在本地用户目录（`%APPDATA%\Kal` 与 browser `localStorage`），无任何后台上传或第三方统计脚本。
- **外部数据库只读安全红线**：当检测到本地已安装 DesktopCal 数据库时，默认仅以只读方式读取或复制至独立沙盒数据库（`standalone_calendar.db`），绝不直接覆盖或破坏第三方软件原始数据库文件。
- **开源许可**：本项目源码基于 [**MIT License**](LICENSE) 开源；内置配色方案所参考的开源色板许可声明详见 [`docs/third-party-themes.md`](docs/third-party-themes.md) 与 [`docs/licenses/`](docs/licenses/)。
