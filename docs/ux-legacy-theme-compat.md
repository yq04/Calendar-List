# 旧 v1 主题跨层兼容修复

日期：2026-10-15。

## 根因

前端 `ui/src/theme.js::normalizeTheme` 已能从旧主题自身颜色派生缺失语义角色，但真实加载链先经过 Rust `theme::parse`。原解析直接调用 `serde_json::from_value`，`Colors::default` 会将六个缺失角色填成深色默认值。重新序列化后，前端会将这些字段视为显式值，无法执行旧主题回退。

旧浅色原始 JSON 回归已在修复前复现：`fgHoliday = #A51E35`，经 parse → serialize 后 `danger` 却变成 `#FF9FB4`。命令 `cargo test theme_legacy_v1_semantics_survive_parse_and_serialize --lib` 返回 Exit 1。

## 做了什么

仅在 `theme::parse` 的 schema 检查之后、反序列化之前补缺失的语义颜色，顺序与前端一致：`danger ← fgHoliday || fg`，`dangerFg ← bg`，`focus ← accent`，`done ← fgMuted || fg`，`selectedBg ← todayBg || surface`，`selectedFg ← fg`。不存在可用源值时仍交由既有 serde 默认处理；完全缺失 color 对象仍使用原默认值。显式语义字段不被覆盖，无效字段仍由既有反序列化和验证拒绝。

新增两项 Rust 测试，覆盖旧浅色 raw → parse → serialize、可选旧角色缺失时的第二级回退、旧颜色和个人排版/布局/缩放保留、显式语义颜色保留以及五套新预设颜色保留。透明度按 schema 的 `f32` 精度比较，颜色字符串精确比较。既有未知 schema 拒绝和缺失整个 color 的默认测试继续通过。

编辑前副本保存在 `_backup/legacy-theme-20261015-025416-410/`，包含 `theme.rs` 和 `theme_tests.rs`，未执行还原。

最终验证：在 `src-tauri` 运行 `cargo test theme_ --lib`，Exit 0，9 passed、0 failed，17 个无关测试未运行。通过后停止测试。

## 遗留

本轮未运行 GUI、二进制构建或全库回归。主代理需要重新构建包含该解析修复的应用；此前构建和截图不包含本次补丁。

## 设计偏差

无。schema 仍为 `kal.theme/1`，不自动升级未知版本，不改预设 JSON、前端、持久化模块或性能脚本，不新增依赖。
