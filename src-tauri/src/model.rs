//! 前后端共用的数据模型
use crate::display::DisplayInfo;
use serde::{Deserialize, Serialize};

/// 一条日程 / 任务
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct DayItem {
    /// YYYY-MM-DD
    pub date: String,
    pub time: String,
    pub title: String,
    pub done: bool,
    /// event | item | note
    pub kind: String,
    pub id: String,
    #[serde(default, rename = "canEdit")]
    pub can_edit: bool,
    #[serde(default, rename = "canDelete")]
    pub can_delete: bool,
    #[serde(default, rename = "canComplete")]
    pub can_complete: bool,
    #[serde(default, rename = "calendarId")]
    pub calendar_id: String,
    #[serde(default, rename = "remoteId")]
    pub remote_id: String,
    #[serde(default)]
    pub revision: String,
}

/// 启动上下文（前端 boot 时拉一次）
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppInfo {
    pub name: String,
    pub version: String,
    pub source_label: String,
    pub db_path: String,
    pub db_found: bool,
    pub embed_mode: String,
    /// 最终生效的缩放（= PPI 校正 × 用户偏好）
    pub ui_scale: f64,
    pub dpi: u32,
    pub desk: String,
    pub display: DisplayInfo,
    pub theme_id: String,
    pub theme_name: String,
    pub wallpaper: String,
    pub app_dir: String,
}
