# 主题后端实施记录

2026-10-15。实施范围为 `src-tauri/src/theme.rs`、`store.rs`、`lib.rs` 的主题 IPC、新增主题测试、五个静态 JSON 与主题来源文档。原有源码已在 `_backup/ux-themes-20261015-014117` 备份。未修改数据库模块、原软件目录、生产配置、旧二进制或技术栈。

完成五套完整、固定模式、两浅三深预设。固定 ID 与角色映射见 [theme-presets.md](theme-presets.md)；`ThemeRef` 新增 `builtin`，保留 `id/name/mode/source/created`。内置从编译资源加载，不受同名磁盘文件影响；保留 ID 不接受 save/delete。activate 先成功加载校验对象才更新设置；settings_set 的 activeTheme 补丁也走同一主题锁与加载验证。当前已启用用户主题须先切换后删除。

新增 `theme_commit(theme: Theme) -> Result<Theme, String>`。校验原草稿的 schema、ID、名称、模式、颜色、数值范围和字体引用后，分配与显示名称无关的 `user-进程-纳秒-序号` ID，写独立临时文件，sync 后回读 JSON 校验，使用不替换目标的 hard_link 发布新版本，再更新 activeTheme，返回完整验证对象。默认编辑始终另存；旧 theme_save 遇到已有 ID 报错，不静默覆盖。theme_import 也另分配用户 ID，不激活。

新增 `theme_export_draft(theme, path) -> Result<String, String>`，只导出传入草稿，保持草稿内容与 ID，不写主题库或活动指针。旧 theme_export 复用此安全写入路径。导出只接受绝对 .json 路径且父目录已存在，拒绝 Kal 配置目录树，目标已存在则返回错误以保留原文件。导入仍先校验，不自动启用。

`kal.theme/1` 的旧文档按 serde 默认补缺字段；缺失 schema 视为既有 v1，显式未知 schema 或主版本拒绝，不强改版本为 v1。颜色必须是 `#RRGGBB`，alpha 和所有尺寸范围受限；拒绝无效/穿越 ID、Windows 设备名、CSS 表达式字体及不存在、越界或链接形式的私有字体引用。系统字体名称允许系统回退，不要求当前机器恰好安装。

同目标写入由进程内锁保护，JSON 临时名独立且用 create_new。新主题通过独占发布避免跨进程同 ID 覆盖；应用层锁序固定为 THEMES_WRITE → SETTINGS_WRITE → JSON_WRITE，窗口几何等既有设置保存继续共享 SETTINGS_WRITE，避免读改写丢字段。跨进程设置互斥并未实现，Kal 正常单实例约束仍是前提。hard_link 需要同目录文件系统支持，常规 Windows NTFS 支持；不支持时返回保存错误，不退回覆盖。

主题文件和 settings 是两个文件，不宣称跨文件操作系统级原子事务。活动指针更新是应用提交点：校验/主题文件保存失败不改旧指针；设置提交失败保留旧指针并明确返回新主题 ID，新生成但未激活的文件保留为可恢复用户版本。设置 JSON 损坏或不可读时也拒绝覆盖原数据。崩溃、断电、恶意并发替换路径不在已验证保证内；没有为此擅自删除或回滚用户文件。

验证命令 `cargo test --manifest-path src-tauri/Cargo.toml theme_ --lib -- --nocapture`：7/7 通过，14 个无关测试过滤。新增测试只用自建操作系统临时目录，未修改 APPDATA 环境或访问真实用户主题。覆盖完整文字角色与五种状态底色、焦点及今日环、按钮填充文字；内置磁盘遮盖、未知 schema 与旧 v1 默认、非法路径/颜色/范围/字体；校验和文件失败、注入设置写入失败与真实损坏设置失败；并发同名新版本、同 ID 独占发布、并行设置合并；只导出未保存草稿且不改变主题库/活动指针。没有运行 GUI 或重建 bin。

遗留：前端默认合并、预览撤销、真实窗口状态、中文字体回退、Windows IME、坐标命中及 DPI 由主会话整合验收；后端色对计算不能替代这些结果。真实 DesktopCal 写入和同步保持未联调。许可证已锁定并保留副本，官网资产许可仍未知且未复制。

设计偏差：Nord 两个候选颜色为满足今日/悬停底色的小字对比度做了最小整数 RGB 校正；导出采用不覆盖目标的保守策略，用户另选文件名即可重导。主题 ID 使用系统时间纳秒、进程号与单调序号，不增 UUID 依赖；实际目标发布仍以 create_new/hard_link 拒绝碰撞。保留既有默认字号和布局，主题切换的排版保留由前端负责。
