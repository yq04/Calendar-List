//! DesktopCal 官方 AI MCP 命名管道客户端。
//!
//! 这里只实现协议适配，不启动或修改 DesktopCal。写操作始终先经过
//! `\\\\.\\pipe\\DesktopCalAiMcp-v1`；管道不可用时返回可读错误，让前端
//! 明确提示用户，而不是偷偷直写 calendar.db。

use serde_json::{json, Value};
use std::sync::atomic::{AtomicU64, Ordering};

pub const PIPE: &str = r"\\.\pipe\DesktopCalAiMcp-v1";
static NEXT_ID: AtomicU64 = AtomicU64::new(1);

fn next_id() -> String {
    format!("kal-{}", NEXT_ID.fetch_add(1, Ordering::Relaxed))
}

#[cfg(windows)]
pub(crate) fn exchange_at(path: &str, request: &Value, timeout_ms: u32) -> Result<Value, String> {
    use std::{fs::OpenOptions, os::windows::fs::OpenOptionsExt, os::windows::io::AsRawHandle};
    use windows_sys::Win32::{
        Foundation::{CloseHandle, GetLastError, ERROR_IO_PENDING, ERROR_MORE_DATA, WAIT_TIMEOUT},
        Storage::FileSystem::{ReadFile, WriteFile, FILE_FLAG_OVERLAPPED},
        System::{
            IO::{CancelIoEx, GetOverlappedResult, GetOverlappedResultEx, OVERLAPPED},
            Pipes::{SetNamedPipeHandleState, PIPE_READMODE_MESSAGE},
            Threading::CreateEventW,
        },
    };
    use std::time::Instant;
    let pipe = OpenOptions::new().read(true).write(true)
        .custom_flags(FILE_FLAG_OVERLAPPED).open(path)
        .map_err(|_| "无法保存：日历连接不可用，请启动 DesktopCal 并开启 AI MCP".to_string())?;
    let handle = pipe.as_raw_handle();
    let mode = PIPE_READMODE_MESSAGE;
    if unsafe { SetNamedPipeHandleState(handle, &mode, std::ptr::null(), std::ptr::null()) } == 0 {
        return Err("日历连接不是受支持的消息管道".into());
    }
    let deadline = Instant::now() + std::time::Duration::from_millis(timeout_ms as u64);
    let io = |buffer: &mut [u8], writing: bool| -> Result<(usize, bool), String> {
        unsafe {
            let event = CreateEventW(std::ptr::null(), 1, 0, std::ptr::null());
            if event.is_null() { return Err("无法创建日历通信事件".into()); }
            let mut overlap: OVERLAPPED = std::mem::zeroed();
            overlap.hEvent = event;
            let mut count = 0;
            let ok = if writing {
                WriteFile(handle, buffer.as_ptr(), buffer.len() as u32, &mut count, &mut overlap)
            } else {
                ReadFile(handle, buffer.as_mut_ptr(), buffer.len() as u32, &mut count, &mut overlap)
            };
            let mut code = if ok != 0 { 0 } else { GetLastError() };
            if code == ERROR_IO_PENDING {
                let wait = deadline.saturating_duration_since(Instant::now()).as_millis().min(u32::MAX as u128) as u32;
                if GetOverlappedResultEx(handle, &overlap, &mut count, wait, 0) != 0 {
                    code = 0;
                } else {
                    code = GetLastError();
                    if code == WAIT_TIMEOUT {
                        // 取消并等待内核释放 OVERLAPPED/缓冲区，避免超时后的悬挂线程和 UAF。
                        CancelIoEx(handle, &overlap);
                        GetOverlappedResult(handle, &overlap, &mut count, 1);
                    }
                }
            }
            CloseHandle(event);
            if code == WAIT_TIMEOUT {
                return Err("保存结果尚未确认：连接超时，请先刷新核对后再操作".into());
            }
            if code != 0 && code != ERROR_MORE_DATA {
                return Err(if writing { "日历请求未能发送" } else { "保存结果尚未确认：响应读取失败，请刷新核对" }.into());
            }
            Ok((count as usize, code == ERROR_MORE_DATA))
        }
    };
    let mut body = serde_json::to_vec(request).map_err(|_| "日历请求编码失败".to_string())?;
    if body.len() > 65_536 { return Err("日历请求超过 64 KiB".into()); }
    let (sent, _) = io(&mut body, true)?;
    if sent != body.len() { return Err("日历请求未完整发送".into()); }
    let mut response = Vec::new();
    loop {
        let mut chunk = vec![0u8; 65_536];
        let (n, more) = io(&mut chunk, false)?;
        response.extend_from_slice(&chunk[..n]);
        if response.len() > 1_048_576 { return Err("日历响应超过 1 MiB".into()); }
        if !more { break; }
    }
    serde_json::from_slice(&response).map_err(|_| "日历响应格式无效，保存结果尚未确认，请刷新核对".into())
}

#[cfg(not(windows))]
fn exchange_at(_path: &str, _request: &Value, _timeout_ms: u32) -> Result<Value, String> {
    Err("DesktopCal MCP 仅支持 Windows".into())
}

#[allow(dead_code)]
fn exchange(request: &Value) -> Result<Value, String> {
    exchange_at(PIPE, request, 8_000)
}

fn token() -> Option<String> {
    std::env::var("DESKTOPCAL_AIMCP_TOKEN")
        .ok()
        .filter(|s| !s.trim().is_empty())
}

fn error_from_response(response: &Value, credential: &str) -> Option<String> {
    response.get("error").map(|e| {
        let code = e.get("code").and_then(Value::as_str).unwrap_or("MCP_ERROR");
        let msg = e
            .get("message")
            .and_then(Value::as_str)
            .unwrap_or("未知错误");
        let message = format!("{code}: {msg}");
        let message = if credential.is_empty() { message } else { message.replace(credential, "***") };
        message.chars().take(500).collect()
    })
}

#[allow(dead_code)]
pub fn ping() -> Result<Value, String> {
    ping_at(PIPE)
}

pub fn ping_at(pipe: &str) -> Result<Value, String> {
    let request = json!({"id": next_id(), "method": "ping"});
    let raw = exchange_at(pipe, &request, 8_000)?;
    let response = decode_response(&request, raw, "")?;
    if response.get("pong").and_then(Value::as_bool) != Some(true) {
        return Err("日历服务未返回有效握手".into());
    }
    Ok(response)
}

fn decode_response(request: &Value, response: Value, credential: &str) -> Result<Value, String> {
    if response.get("id") != request.get("id") {
        return Err("日历响应与本次请求不匹配".into());
    }
    if let Some(e) = error_from_response(&response, credential) { return Err(e); }
    if response.get("ok").and_then(Value::as_bool) != Some(true) {
        return Err("日历服务没有确认请求成功，请刷新核对".into());
    }
    let result = response.get("result").cloned()
        .ok_or_else(|| "日历响应没有执行结果，保存结果尚未确认，请刷新核对".to_string())?;
    if let Some(e) = error_from_response(&result, credential) { return Err(e); }
    if !result.is_object() || result.as_object().is_some_and(|o| o.is_empty()) {
        return Err("日历响应没有有效结果".into());
    }
    Ok(result)
}

fn check_method_result(method: &str, params: &Value, result: Value) -> Result<Value, String> {
    if result.get("status").and_then(Value::as_str) == Some("pending_confirmation") {
        if result.get("confirm_token").and_then(Value::as_str).is_none() { return Err("日历服务未提供确认凭证".into()); }
        return Ok(result);
    }
    let valid = match method {
        "items_get" | "items_append_line" | "item_line_update" | "item_line_set_done" | "item_line_delete" =>
            result.get("date") == params.get("date") && result.get("text").is_some_and(Value::is_string) && result.get("lines").is_some_and(Value::is_array),
        "event_update" | "event_delete" => result.get("status").and_then(Value::as_str) == Some("ok"),
        "event_confirm" => {
            let accepted = params.get("accept").and_then(Value::as_bool) == Some(true);
            if accepted { result.get("status").and_then(Value::as_str) == Some("ok") || (result.get("text").is_some_and(Value::is_string) && result.get("lines").is_some_and(Value::is_array)) }
            else { result.get("status").and_then(Value::as_str) == Some("cancelled") }
        }
        _ => true,
    };
    if !valid { return Err("日历返回了未识别的执行结果，请刷新核对".into()); }
    Ok(result)
}

#[allow(dead_code)]
pub fn call(method: &str, params: Value, db_token: Option<String>) -> Result<Value, String> {
    call_at(PIPE, method, params, db_token)
}

pub fn call_at(pipe: &str, method: &str, params: Value, db_token: Option<String>) -> Result<Value, String> {
    let token = token().or(db_token).ok_or_else(|| {
        "找不到 DesktopCal MCP token，请先在 DesktopCal 的 AI MCP 设置中启用并配置".to_string()
    })?;
    let request = json!({
        "id": next_id(),
        "token": token,
        "method": method,
        "params": params,
    });
    let response = exchange_at(pipe, &request, 8_000)?;
    let result = decode_response(&request, response, &token)?;
    check_method_result(method, &request["params"], result)
}

#[cfg(test)]
#[path = "mcp_tests.rs"]
mod tests;
