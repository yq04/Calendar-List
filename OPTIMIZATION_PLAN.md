# 日历清单 · Calendar List (`Kal`) 第二轮深度调研诊断与全量优化方案 (`OPTIMIZATION_PLAN.md`)

> **更新时间**：2026-10-26  
> **调研范围**：GitHub 8 大标杆开源桌面日历/效率工具对标 + 全量 Rust/JS/CSS 源码走查 + 4 张无头浏览器实机像素级渲染截图诊断

---

## 一、 开源项目对标调研（借鉴成熟方案，拒绝闭门造车）

我们调研了 GitHub 上主流的开源桌面日历、Tauri 桌面组件及极简待办项目，提炼出可直接落地到 **日历清单 (`Calendar List`)** 的最佳实践：

| 对标开源项目 / 产品 | 技术栈与定位 | 核心借鉴点（本次直接吸收落地） |
| :--- | :--- | :--- |
| **`eythaann/Seelen-UI`** & **`rainmeter/rainmeter`** | Rust + Tauri v2 / C++ Win32 桌面组件引擎 | **桌面固定层 (`SHELLDLL_DefView`) 挂载与状态隔离**：固定到桌面时优先挂载于 `SHELLDLL_DefView` 宿主窗口以抵御 `Win+D`（显示桌面）遮挡；解除固定切回可动窗口时，彻底清理 `GWLP_HWNDPARENT` 与 `HWND_BOTTOM`，防止普通窗口被压入桌面底层。 |
| **`FlatBone/Feather-Calendar`** & **Rainlendar** | 极简 Windows 桌面日历挂件 | **桌面固定「闲置半透减淡 / 鼠标悬停唤醒（Idle Hover-Fade）」**：当窗口固定在桌面上且鼠标移出时，自动平滑减淡透明度以融入壁纸；鼠标移入瞬间 `160ms` 恢复 100% 清晰可读。 |
| **`manuelernestog/weektodo` (WeekToDo)** | 开源极简周/月待办计划表 | **日历格内直接勾选完成 + 失焦自动保存**：无需每次去右侧栏找复选框，在左侧日历格悬停事项或打开 `+N 更多` 弹窗时即可一键勾选完成；双击格内输入文字后点击别处（`blur`）自动保存而非丢失草稿。 |
| **`Beaver-Notes/Beaver-Notes`** & **`CC Switch`** | 现代本地优先笔记与配置工作台 | **设置弹窗「未保存预览」状态提示 + 预设卡片激活态同步**：当前正在使用的主题、质感、排版、字体模板必须带有明确的 `.is-on` 选中高亮框；有未保存预览修改时高亮「保存设置」按钮。 |
| **Notion Calendar (Cron) + Linear + Raycast** | 现代桌面生产力 UI 标杆 | **左导航 + 右工作台双栏设置弹窗 & 42 格全键盘方向键导航**：摒弃拥挤的顶部水平换行标签，采用「左侧垂直图标导航栏 + 右侧分节卡片画布」；支持 `↑` `↓` `←` `→` 在 42 格日历间移动选中日、按 `Enter` 直接新建安排。 |
| **优效日历 / 中国本土日历规范** | 本土化节假日与视觉细节 | **「今天」实心胶囊徽章 vs 「选中日」内环描边 + 调休补班周末字色修正**：当周六/周日为法定补班日（带 `班` 角标）时，将周末红字恢复为工作日正文色，避免误以为放假。 |

---

## 二、 分项优化执行清单（使用与功能 5 项 + 外观与美化 5 项）

### （一） 使用与功能优化（Usability & Functionality）
1. **`[U1]` 桌面固定模式与默认可动窗口模式的 Win32 状态隔离及 `Win+D` 防遮挡**（[`src-tauri/src/embed.rs`](file:///d:/1_Research/AI_Workspace/Task_Plan/Kal/src-tauri/src/embed.rs)、[`src-tauri/src/lib.rs`](file:///d:/1_Research/AI_Workspace/Task_Plan/Kal/src-tauri/src/lib.rs)）
2. **`[U2]` 桌面固定「闲置半透减淡 / 鼠标悬停唤醒（Idle Hover-Fade）」**（[`ui/src/panel.js`](file:///d:/1_Research/AI_Workspace/Task_Plan/Kal/ui/src/panel.js)、[`ui/styles/layout.css`](file:///d:/1_Research/AI_Workspace/Task_Plan/Kal/ui/styles/layout.css)）
3. **`[U3]` 左格/右栏内联新建失焦（`blur`）自动保存 + 格内与 `+N 更多` 弹窗直接勾选完成**（[`ui/src/main.js`](file:///d:/1_Research/AI_Workspace/Task_Plan/Kal/ui/src/main.js)）
4. **`[U4]` 42 格日历键盘上下周移动（`↑`/`↓`）与回车（`Enter`）极速新建**（[`ui/src/main.js`](file:///d:/1_Research/AI_Workspace/Task_Plan/Kal/ui/src/main.js)）
5. **`[U5]` 设置中心「未保存预览」状态提醒 + 全环境内置主题列表兜底**（[`ui/src/bridge.js`](file:///d:/1_Research/AI_Workspace/Task_Plan/Kal/ui/src/bridge.js)、[`ui/src/panel.js`](file:///d:/1_Research/AI_Workspace/Task_Plan/Kal/ui/src/panel.js)）

### （二） 外观与美化优化（Appearance & Visual Polish）
6. **`[V1]` 修复日历格多行文字「下半截被削掉」与格内输入框双层底边伪影**（[`ui/src/main.js`](file:///d:/1_Research/AI_Workspace/Task_Plan/Kal/ui/src/main.js)、[`ui/styles/components.css`](file:///d:/1_Research/AI_Workspace/Task_Plan/Kal/ui/styles/components.css)）
7. **`[V2]` 设置中心升级为「左侧图标导航栏 + 右侧卡片工作台」双栏模态弹窗 + 全局快捷键卡片化**（[`ui/src/panel.js`](file:///d:/1_Research/AI_Workspace/Task_Plan/Kal/ui/src/panel.js)、[`ui/src/desktop-settings.js`](file:///d:/1_Research/AI_Workspace/Task_Plan/Kal/ui/src/desktop-settings.js)、[`ui/styles/panel.css`](file:///d:/1_Research/AI_Workspace/Task_Plan/Kal/ui/styles/panel.css)）
8. **`[V3]` 移除预设卡片杂乱彩色 Emoji + 全面补齐 4 类预设模板 `.is-on` 选中高亮**（[`ui/src/theme.js`](file:///d:/1_Research/AI_Workspace/Task_Plan/Kal/ui/src/theme.js)、[`ui/src/panel.js`](file:///d:/1_Research/AI_Workspace/Task_Plan/Kal/ui/src/panel.js)、[`ui/styles/panel.css`](file:///d:/1_Research/AI_Workspace/Task_Plan/Kal/ui/styles/panel.css)）
9. **`[V4]` 拉开「今天 (`is-today`)」与「选中日 (`is-selected`)」视觉区分度 + 调休补班周末字色修正**（[`ui/styles/components.css`](file:///d:/1_Research/AI_Workspace/Task_Plan/Kal/ui/styles/components.css)）
10. **`[V5]` 顶栏「固定」按钮状态显性化 + 右侧清单空状态与倒数日卡片美化**（[`ui/styles/components.css`](file:///d:/1_Research/AI_Workspace/Task_Plan/Kal/ui/styles/components.css)）

---

## 三、 全量测试与安装包构建结果

- **前端单元测试**：`node ui/_selftest.mjs`（132/132 通过）、`node ui/_themes-selftest.mjs`（5/5 通过）、`node ui/_productivity-selftest.mjs`（16/16 通过）
- **E2E 浏览器实机验收**：`node tools/ui-check.mjs`（**40/40 全部通过**，含 `[P10-ux-and-visual-polish]`）
- **Rust 单元测试与 NSIS 安装包构建**：`cargo test`（29/29 通过）+ `cargo tauri build --bundles nsis` 并部署至 `D:\1_app\CalendarList\kal.exe`
