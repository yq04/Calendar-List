//! One Win32 thread owns hotkey registration and the activation event.
use std::sync::{mpsc, Arc, Mutex};
use tauri::Manager;
use windows_sys::Win32::{
    Foundation::{CloseHandle, GetLastError, WAIT_FAILED, WAIT_OBJECT_0},
    System::Threading::{CreateEventW, GetCurrentThreadId, INFINITE},
    UI::{Input::KeyboardAndMouse::{RegisterHotKey, UnregisterHotKey, MOD_ALT, MOD_NOREPEAT, MOD_WIN},
        WindowsAndMessaging::{MsgWaitForMultipleObjects, PeekMessageW, PostThreadMessageW, MSG, PM_NOREMOVE, PM_REMOVE, QS_ALLINPUT, WM_APP, WM_HOTKEY}},
};

const HOTKEY_ID: i32 = 0x4b41;
const COMMAND: u32 = WM_APP + 41;

#[derive(Clone, Debug, serde::Serialize)]
pub struct Status {
    pub enabled: bool,
    pub registered: bool,
    pub shortcut: &'static str,
    pub error: Option<String>,
}

fn initial_status(settings: &serde_json::Value) -> Status {
    Status {
        enabled: settings.pointer("/desktop/hotkeyEnabled").and_then(|v| v.as_bool()).unwrap_or(false),
        registered: false,
        shortcut: "Win+Alt+C",
        error: None,
    }
}

enum Command { Set(bool, mpsc::SyncSender<Status>), Stop }

pub struct Controller {
    status: Arc<Mutex<Status>>,
    serial: Mutex<()>,
    tx: mpsc::Sender<Command>,
    thread_id: u32,
    worker: Mutex<Option<std::thread::JoinHandle<()>>>,
}

fn register(status: &mut Status, enabled: bool) {
    if status.registered && !enabled {
        unsafe { UnregisterHotKey(std::ptr::null_mut(), HOTKEY_ID); }
        status.registered = false;
    }
    status.enabled = enabled;
    status.error = None;
    if enabled && !status.registered {
        status.registered = unsafe { RegisterHotKey(std::ptr::null_mut(), HOTKEY_ID, MOD_WIN | MOD_ALT | MOD_NOREPEAT, u32::from(b'C')) } != 0;
        if !status.registered {
            let code = unsafe { GetLastError() };
            status.error = Some(if code == 1409 {
                "Win+Alt+C 已被其他程序占用；请关闭占用程序后重新启用。".into()
            } else { format!("无法注册 Win+Alt+C（Windows 错误 {code}）。") });
        }
    }
}

impl Controller {
    pub fn new(app: tauri::AppHandle) -> Self {
        let status = Arc::new(Mutex::new(initial_status(&crate::store::read_settings())));
        let shared = status.clone();
        let (tx, rx) = mpsc::channel();
        let (ready_tx, ready_rx) = mpsc::sync_channel(1);
        let worker = std::thread::spawn(move || unsafe {
            let event = CreateEventW(std::ptr::null(), 0, 0, crate::single_instance::wide(crate::single_instance::EVENT_NAME).as_ptr());
            let mut message: MSG = std::mem::zeroed();
            PeekMessageW(&mut message, std::ptr::null_mut(), 0, 0, PM_NOREMOVE);
            {
                let mut current = shared.lock().unwrap();
                let enabled = current.enabled;
                register(&mut current, enabled);
                if event.is_null() { current.error = Some("无法接收重复启动呼出通知。".into()); }
            }
            let _ = ready_tx.send(GetCurrentThreadId());
            'messages: loop {
                let count = if event.is_null() { 0 } else { 1 };
                let result = MsgWaitForMultipleObjects(count, &event, 0, INFINITE, QS_ALLINPUT);
                if result == WAIT_FAILED {
                    shared.lock().unwrap().error = Some("桌面快捷键消息循环已停止。".into());
                    break;
                }
                if count == 1 && result == WAIT_OBJECT_0 { dispatch(&app, false); }
                while PeekMessageW(&mut message, std::ptr::null_mut(), 0, 0, PM_REMOVE) != 0 {
                    if message.message == WM_HOTKEY && message.wParam == HOTKEY_ID as usize && shared.lock().unwrap().registered {
                        dispatch(&app, true);
                    }
                    if message.message == COMMAND {
                        for command in rx.try_iter() {
                            match command {
                                Command::Stop => break 'messages,
                                Command::Set(enabled, reply) => {
                                    let mut current = shared.lock().unwrap();
                                    register(&mut current, enabled);
                                    let _ = reply.send(current.clone());
                                }
                            }
                        }
                    }
                }
            }
            let mut current = shared.lock().unwrap();
            if current.registered { UnregisterHotKey(std::ptr::null_mut(), HOTKEY_ID); }
            current.registered = false;
            if !event.is_null() { CloseHandle(event); }
        });
        let thread_id = ready_rx.recv().unwrap_or(0);
        Self { status, serial: Mutex::new(()), tx, thread_id, worker: Mutex::new(Some(worker)) }
    }

    pub fn status(&self) -> Status { self.status.lock().unwrap().clone() }

    pub fn set_enabled(&self, enabled: bool) -> Status {
        let _serial = self.serial.lock().unwrap();
        if let Err(error) = crate::store::merge_settings(&serde_json::json!({"desktop":{"hotkeyEnabled":enabled}})) {
            let mut result = self.status();
            result.error = Some(format!("快捷键设置未保存：{error}"));
            return result;
        }
        let (reply, rx) = mpsc::sync_channel(1);
        if self.tx.send(Command::Set(enabled, reply)).is_ok()
            && unsafe { PostThreadMessageW(self.thread_id, COMMAND, 0, 0) } != 0 {
            if let Ok(status) = rx.recv_timeout(std::time::Duration::from_secs(2)) { return status; }
        }
        let mut result = self.status();
        result.error = Some("设置已保存，但桌面快捷键线程没有响应；请重启 Kal。".into());
        result
    }

    pub fn shutdown(&self) {
        if let Some(worker) = self.worker.lock().unwrap().take() {
            let _ = self.tx.send(Command::Stop);
            unsafe { PostThreadMessageW(self.thread_id, COMMAND, 0, 0); }
            let _ = worker.join();
        }
    }
}

impl Drop for Controller { fn drop(&mut self) { self.shutdown(); } }

fn dispatch(app: &tauri::AppHandle, toggle: bool) {
    let handle = app.clone();
    let _ = app.run_on_main_thread(move || {
        if let Some(window) = handle.get_webview_window("main") { crate::summon_window(&window, toggle); }
    });
}

#[cfg(test)]
mod tests {
    #[test]
    fn desktop_hotkey_defaults_off_and_requires_boolean() {
        for settings in [serde_json::json!({}), serde_json::json!({"desktop":{"hotkeyEnabled":"true"}})] {
            let status = super::initial_status(&settings);
            assert!(!status.enabled);
            assert!(!status.registered);
        }
        assert!(super::initial_status(&serde_json::json!({"desktop":{"hotkeyEnabled":true}})).enabled);
    }
}
