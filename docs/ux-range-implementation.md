# 可见日期范围读取实施记录

> 2026-10-15 的历史实施记录，文中的固定 42 格和待集成状态属于当时版本。当前月历按月份使用 35/42 格，最新功能与支持范围以 [README](../README.md) 和 [v0.1.3 发行说明](RELEASE_NOTES_0.1.3.md) 为准。

2026-10-15。主会话 BEFORE 基线报告 large20k 月读取 144.8 ms、日读取 58.2 ms、三个月数据读取 297.2 ms（p95 336.3 ms），已定位可见月历重复三次全量归一化的放大路径。本阶段只减少可见范围读取次数，不据此预告 AFTER 加速比例。

新增 `CalendarDb::range_items(&self, start: &str, end: &str) -> Result<Vec<DayItem>, String>`，起止日均包含，最多 93 个自然日。参数必须是严格 `YYYY-MM-DD` 且是真实公历日期，年份 0001–9999；拒绝逆序、无效闰日、非标准表示或超长范围。参数验证完成后只调用一次 `all_items()`，再按规范化的 `DayItem.date` 过滤，返回原排序与完整对象。

没有对未经核实的数据库原始日期列追加 SQL WHERE，没有新增缓存、索引服务、线程锁或依赖。沿用 `all_items` 的全部日期归一化、空行计数、Markdown 完成态、修订快照、用户/分组作用域、事件起始日期优先级、便签只读语义。因此本次减少扫描次数，但单次范围查询仍会归一化全库。

新增异步 IPC `range_events(start: String, end: String) -> Result<Vec<DayItem>, String>`，通过 `tauri::async_runtime::spawn_blocking` 打开只读数据源并执行范围读取。前端调用 `rangeEvents(start, end)` 即可请求完整可见 42 格。原有 `month_events(year, month)`、`day_events(date)` 保留参数及正常返回语义，仅改为异步阻塞工作线程读取，避免同步数据库读取停留在 IPC 处理路径。

源码修改仅为 `src-tauri/src/db.rs` 与 `lib.rs`，新增 `db_range_tests.rs`。修改前针对性备份位于 `_backup/range-backend-20261015-022341`。没有修改 UI、主题、store、性能脚本、生产库或旧二进制。

验证命令：`cargo test --manifest-path src-tauri/Cargo.toml range_ --lib -- --nocapture`。结果 3/3 通过，21 项无关测试过滤。测试使用独立操作系统临时 SQLite fixture，覆盖跨月/跨年/闰日及两端包含、93/94 天边界、非法日期和验证先于数据库读取；范围结果与同源 `all_items` 过滤结果逐字段相等；空行后保留 `it-4:0/2/3` 的真实行号、重复作用域禁写、单一作用域可编辑、修订、事件 ID/时间/完成态及便签只读属性均保留。测试没有连接 MCP、运行 GUI、构建 bin 或修改 APPDATA。

遗留：主会话需整合前端可见 42 格调用并用同环境 AFTER 测量确认实际延迟、序号守卫与请求次数；当前记录只证明后端实现及隔离语义验证。生产宿主写入与同步仍未联调。

设计偏差：无。采用范围一次扫描和现有工作线程接口，未扩展为缓存或原始日期 SQL 优化。
