# Kal 桌面交互与性能代码证据与风险分析

> 2026-10-15 的历史分析，包含当时发现的问题与候选方案，不代表这些问题仍存在于当前版本。最新功能与验证范围以 [README](../../README.md) 和 [v0.1.3 发行说明](../RELEASE_NOTES_0.1.3.md) 为准。

> 日期：2026-10-15  
> 性质：只读代码静态核对报告（未运行测试、未启动应用、未修改现有源码）  
> 依据文件：`ui/src/main.js`, `panel.js`, `theme.js`, `local-fonts.js`, `productivity.js`, `write-state.js`; `ui/styles/components.css`, `layout.css`; `src-tauri/src/lib.rs`, `db.rs`, `display.rs`, `theme.rs`, `embed.rs`; `tools/ui-check.mjs`, `tools/native-check.mjs`

---

## 1. 审查结论总览

针对用户核心关切的「点击/输入准确、字体观感、可修改、速度」进行有限范围代码核验，按 P0/P1/P2 建议优先级登记源码事实与待复现风险。级别是规划建议，不代表所有条目已复现。本文不提供未经测量的时延、误触率或缺陷数量保证。

---

## 2. 输入一致性与快捷键策略

### P0-1: 异步保存完成时强行清空用户新输入（State Overwrite / Race Condition）
- **源码事实**：
  - `ui/src/main.js:460`: 在 `writeAction` 中，调用后端操作完成后立即设置 `state.writeBusy = false`。
  - `ui/src/main.js:491-492`: 执行 `onConfirmed?.()` 后立即调用 `syncWriteUi()`；因为 `writeBusy` 已被置为 `false`，输入框 `kal-agenda-input.disabled` 立即解除禁用。
  - `ui/src/main.js:494`: 随后通过 `await render()` 发起异步全日历及日程重绘（跨 IPC 调用数据库）。
  - `ui/src/main.js:1143-1145`: 表单 submit 闭包在 `writeAction` 完全返回且结果为 `saved` 后，再次执行清空逻辑：
    ```javascript
    if (outcome === "saved") {
      el["kal-agenda-input"].value = "";
    }
    ```
- **源码时序风险**：在 `await render()` 进行跨进程查询的等待窗口内，输入框已处于可用状态。如果用户在此期间聚焦输入框并开始键入下一条任务内容，待 `render()` 返回后，第 1144 行代码会再次清空输入。等待窗口的实际时长与可见丢字尚未复现，不使用 50–300ms 等未测数值。
- **未测项**：高频键盘连击与异步 IPC 延迟重叠时的实际字符丢失概率。

### P1 策略项：全局 Ctrl+F 与编辑上下文的边界
- **源码事实**：
  - `ui/src/main.js:1153-1157`: `window.addEventListener("keydown")` 已先检查 `isImeComposing(e)`；此后 `Ctrl+F` 分支位于面板/编辑元素上下文守卫之前：
    ```javascript
    if ((e.ctrlKey || e.metaKey) && !e.altKey && (e.key === "f" || e.key === "F")) {
      e.preventDefault();
      openSearch();
      return;
    }
    ```
  - `ui/src/main.js:1162`: 后续常规导航键虽有 `if (e.target?.matches?.("input, textarea, [contenteditable]")) return;` 守卫，但 `Ctrl+F` 完全绕过了该守卫，也未检查 `panel?.isOpen()`。
- **产品策略待定**：当前 Ctrl+F 明确执行全日期搜索，这本身可以是有意设计，不能单凭全局绑定宣布缺陷。需明确编辑/设置/便签上下文的预期，保证切换搜索时草稿和焦点可恢复；不把该分支误写成完全没有 IME 守卫。
- **未测项**：第三方输入法在使用带 Ctrl 翻页快捷键时是否存在偶发误触发。

---

## 3. P1 级别：命中区域、失焦提交流程与全表扫描

### P1-1: 6px 完成圆点实际命中热区狭窄与双击编辑边界
- **源码事实**：
  - `ui/styles/components.css:336-343`: `.kal-agenda-dot` 通过 CSS 尺寸控制视觉与命中区域，实际值受 `--kal-u` 影响：
    ```css
    .kal-agenda-dot {
      flex: 0 0 auto;
      width: calc(6 * var(--kal-u));
      height: calc(6 * var(--kal-u));
      margin-top: calc(6 * var(--kal-u));
      border-radius: 50%;
      background: rgb(var(--kal-accent));
    }
    ```
    未设置 padding，未通过伪元素（如 `::before`）扩展命中热区。在标准 1.0 缩放下仅为 6×6 CSS 像素。
  - `ui/src/main.js:243`: `dot.addEventListener("click", e => { e.stopPropagation(); toggle(); })`，圆点点击显式阻止了冒泡。
  - `ui/src/main.js:264-267`: 双击编辑事件仅绑定在文本节点：
    ```javascript
    txt.addEventListener("dblclick", () => beginAgendaEdit(li, txt, ev));
    ```
    外部容器 `li` 未绑定双击事件。
- **潜在风险**：当前约 6 个设计像素的命中区域值得优先改进；双击编辑只支持文本区域也是待明确的交互边界。WCAG 2.5.8 正式条款为至少 24×24 CSS px 或满足间距等例外，不能在未核查例外与实际布局前直接宣布不合规。双击空白能否进入编辑属于产品约定，须避免与完成、删除和选日动作重叠。
- **未测项**：鼠标高速滑动点击、触控板点击或高 DPI 屏幕下的实际误触率。

### P1-2: blur 提交缺少合成态检查与校验失败回拉焦点
- **源码事实**：
  - `ui/src/main.js:583-585`: 内联编辑组件的失焦提交未检查中文输入法合成态：
    ```javascript
    input.addEventListener("blur", () => {
      if (!done && !submitting) commitEdit();
    });
    ```
  - `ui/src/main.js:522-525`: 在 `commitEdit()` 中，内容为空或校验失败时重新夺回焦点：
    ```javascript
    if (!value) {
      setWriteStatus("内容不能为空", true);
      input.focus();
      return;
    }
    ```
- **潜在风险**：
  - 中文输入法选词过程中若意外触发失焦（如点击系统弹窗或外部托盘），未完成合成的临时输入可能直接被提交保存。
  - 空内容或校验失败会调用 `input.focus()`，存在反复回拉焦点的风险；代码仍提供 Esc 取消，不能称为无法退出的死锁。应实测外部点击、取消和错误提示的行为。
- **未测项**：微软拼音输入法候选悬浮窗激活期间主窗口失焦时，DOM 获取到的 `input.value` 具体取值情况。

### P1-3: WindowEvent::Focused(false) 全局失焦收起风险
- **源码事实**：
  - `src-tauri/src/lib.rs:623-626`: 监听全局窗口失焦事件：
    ```rust
    win.on_window_event(move |ev| {
        if matches!(ev, tauri::WindowEvent::Focused(false)) {
            dismiss_window(&w2);
        }
    });
    ```
  - `src-tauri/src/lib.rs:309-329`: `dismiss_window` 会立即清除 `HWND_TOPMOST`，归还焦点给前台应用，并将窗口重新设为桌面底层所有者。
- **潜在风险**：当系统弹出 WebView2 自带上下文菜单、系统级文件选择对话框或独立输入法候选框时，若 Windows 发出瞬时失焦事件，可能引发意外的 `dismiss_window`，使正在操作的界面意外沉底。
- **未测项**：多任务切换或全屏应用通知弹窗出现时失焦事件的具体触发时序。

### P1-4: SQLite 全表扫描与同步阻塞式 IPC 调用
- **源码事实**：
  - `src-tauri/src/lib.rs:91-99`: `month_events` 与 `day_events` 是同步命令函数（非 async fn），在命令处理过程中直接读库；执行线程及对界面延迟的影响仍需 profile：
    ```rust
    #[tauri::command]
    fn month_events(year: i32, month: u32) -> Result<Vec<DayItem>, String> {
        db::open_default()?.month_items(year, month)
    }
    ```
  - `src-tauri/src/db.rs:223-233`: `month_items` 与 `day_items` 内部均无条件调用 `self.all_items()?`。
  - `src-tauri/src/db.rs:278-380`: `all_items()` 对 `event_table` 与 `item_table` 执行无 WHERE 条件的全表查询，遍历所有记录并在 Rust 内存中逐行解析 JSON 格式的 `it_appinfo`。
  - `src-tauri/src/db.rs:149-160`: `search_items()` 同样直接调用 `self.all_items()?`。
- **潜在风险**：在用户积累数千条历史日程与便签后，月视图切换或搜索输入会导致密集的全表扫描与内存反序列化，同步 IPC 容易引起界面掉帧或卡顿。
- **未测项**：超过 5,000 条历史数据在真实旧款硬件上的 IPC 阻塞延迟。

---

## 4. P2 级别：缩放链、主题事务与字体对比度

### P2-1: PPI 缩放截断与多屏换屏通知缺失
- **源码事实**：
  - `src-tauri/src/display.rs:167`: 物理 PPI 缩放比例进行了硬性截断：
    ```rust
    let kal_scale = if ppi_known { (ppi / 96.0).clamp(0.85, 1.40) } else { 1.0 };
    ```
    与 `HANDOFF.md:38` 所记载的“无条件公式 `kalScale = PPI / 96`”存在事实性不一致。
  - `src-tauri/src/lib.rs:627-631`: 窗口发生 `Moved` 或 `Resized` 时仅调用 `save_geometry_throttled` 保存坐标，并未重新评估 `display::for_window`，亦未向前端派发 DPI/PPI 变更事件。
  - `ui/src/main.js:840`: 前端仅在初始化启动时通过 `state.info?.display?.kalScale` 读取一次基准 PPI。
- **潜在风险**：在多显示器环境下（如一屏 1080p 24 寸，另一屏 4K 27 寸），跨屏拖拽窗口后缩放比例无法动态更新；同时需注意 WebView2 默认已自带系统级 DPI 适配，与应用层 CSS `--kal-ui-scale` 存在累加缩放的协调机制。
- **未测项**：跨多台不同 DPI 显示器热插拔或拖拽时 WebView2 与自定义 PPI 的实际渲染尺寸。

### P2-2: 主题预览无脏状态自动回滚与预设支持缺失
- **源码事实**：
  - `ui/src/main.js:830-844`: 面板内滑块微调时，`applyDraft` 实时修改了全局 CSS 变量。
  - `ui/src/panel.js:386-388`: 点击右上角关闭按钮 `[data-act="close"]` 仅移除 CSS 类，并未触发 `onReset()`。
  - `ui/src/main.js:906-918`: `saveTheme` 依次执行 save/activate/load，完成后才调用 `applyApplied`；前序失败时不需要回滚尚未改变的 `state.applied`。但保存、激活与载入分步进行，若中途失败可能留下磁盘和前端状态不一致，尚未故障注入复现。
  - `src-tauri/src/theme.rs:564-580`: `theme::list()` 仅遍历本地保存的主题文件；代码中除保底的 `DEFAULT_THEME` 外，未提供任何静态主题预设。新安装用户的主题库列表为空。
- **潜在风险**：用户在面板尝试调色后若直接关闭面板，预览状态将残留于屏幕上，而重新启动应用后又会恢复旧主题，造成视觉不一致；且缺乏官方预设供初次配置时一键选择。
- **未测项**：多次保存失败后内存中的 draft 状态与磁盘文件之间的漂移情况。

### P2-3: 任意透明壁纸下的正文有效对比度不确定性与字宽无效
- **源码事实**：
  - `src-tauri/src/theme.rs:441-443`: 算法测算 13.0:1 目标对比度（`color::at_contrast(bg, ... 13.0)`）是假定在不透明的纯色 `bg` 表面。
  - 界面实际渲染采用了半透明背景（默认 `bgAlpha: 0.62`，可调节），底层叠加的是动态桌面壁纸。
  - `ui/src/theme.js:176-178`: 字宽调整采用 CSS `font-stretch` 属性。
- **潜在风险**：
  - 13.0:1 的静态设计 Token 目标不能作为任意透明壁纸下的实测对比度保证。若壁纸包含高明度或高频杂色区域，透过半透明背景后的实际正文有效对比度可能低于 WCAG 4.5:1。
  - 对没有相应宽度变体或可变宽度轴的字体，font-stretch 可能无可见变化；未核查本机每种字体的元数据，不能笼统承诺或否定所有 Windows 字体的效果。
- **未测项**：透明表面与壁纸合成后的有效背景和文字对比度；规范对比度不直接采用抗锯齿字缘的像素颜色。细字重和高频壁纸的实际观感另行验收。

---

## 5. 现有工具覆盖边界总结

1. **`tools/ui-check.mjs`（基于 Headless Edge + Mock IPC，共 15 项）**：
   - **已覆盖**：42 格日历渲染、新增表单防抖与二次确认流、双击编辑 Enter/blur 单次更新、完成状态流转、中文 IME 合成态快捷键守卫、读写异常降级、只读模式本机倒计时。
   - **未覆盖边界**：真实数据库全表扫描延迟、多显示器动态热插拔与移动换屏、物理鼠标点击 6px 圆点的误触率、复杂桌面壁纸实际透色对比度。
2. **`tools/native-check.mjs`（基于真实 Debug Tauri + 隔离 APPDATA，共 5 组）**：
   - **已覆盖**：私有 Consolas 字体加载、Win+Alt+C 热键唤醒与临时置顶、失焦恢复底层、单实例重复启动唤醒。
   - **未覆盖边界**：长周期真实日历数据（数千条）的 IPC 响应时间、多屏跨 DPI 拖拽动态缩放、极端失焦场景下的窗口沉底风险。

