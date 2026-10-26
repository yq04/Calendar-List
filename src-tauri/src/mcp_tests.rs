use super::*;

#[test]
fn edit_response_rejects_false_success_and_redacts_credential() {
    let request = json!({"id":"kal-test"});
    assert!(decode_response(&request, json!({}), "test-only").is_err());
    assert!(decode_response(&request, json!({"id":"wrong", "result":{"saved":true}}), "test-only").is_err());
    let error = decode_response(&request, json!({"id":"kal-test", "error":{"code":"DENIED", "message":"test-only"}}), "test-only").unwrap_err();
    assert!(!error.contains("test-only"));
    let pending = decode_response(&request, json!({"id":"kal-test", "ok":true, "result":{"status":"pending_confirmation", "confirm_token":"test-only"}}), "test-only").unwrap();
    assert_eq!(pending["status"], "pending_confirmation");
    assert!(check_method_result("event_confirm", &json!({"accept":true}), json!({"status":"cancelled"})).is_err());
    assert!(check_method_result("item_line_update", &json!({"date":"2026-10-12"}), json!({"status":"ok"})).is_err());
}

#[cfg(windows)]
fn server(reply: Value, delay_ms: u64) -> (String, std::thread::JoinHandle<Value>) {
    use std::os::windows::io::{FromRawHandle, AsRawHandle};
    use std::io::{Read, Write};
    use windows_sys::Win32::{
        Foundation::{GetLastError, ERROR_PIPE_CONNECTED, INVALID_HANDLE_VALUE},
        Storage::FileSystem::{FlushFileBuffers, PIPE_ACCESS_DUPLEX},
        System::Pipes::{CreateNamedPipeW, ConnectNamedPipe, PIPE_READMODE_MESSAGE, PIPE_TYPE_MESSAGE},
    };
    let path = format!(r"\\.\pipe\Kal-edit-test-{}-{}", std::process::id(), next_id());
    let target = path.clone();
    let (ready_tx, ready_rx) = std::sync::mpsc::channel();
    let join = std::thread::spawn(move || {
        let wide: Vec<u16> = target.encode_utf16().chain(Some(0)).collect();
        let handle = unsafe { CreateNamedPipeW(wide.as_ptr(), PIPE_ACCESS_DUPLEX, PIPE_TYPE_MESSAGE | PIPE_READMODE_MESSAGE, 1, 65_536, 65_536, 0, std::ptr::null()) };
        assert_ne!(handle, INVALID_HANDLE_VALUE);
        let mut file = unsafe { std::fs::File::from_raw_handle(handle) };
        ready_tx.send(()).unwrap();
        let connected = unsafe { ConnectNamedPipe(handle, std::ptr::null_mut()) };
        assert!(connected != 0 || unsafe { GetLastError() } == ERROR_PIPE_CONNECTED);
        let mut input = vec![0; 65_536];
        let n = file.read(&mut input).unwrap();
        let request: Value = serde_json::from_slice(&input[..n]).unwrap();
        std::thread::sleep(std::time::Duration::from_millis(delay_ms));
        let output = serde_json::to_vec(&reply).unwrap();
        let _ = file.write_all(&output);
        if delay_ms == 0 { unsafe { FlushFileBuffers(file.as_raw_handle()); } }
        request
    });
    ready_rx.recv_timeout(std::time::Duration::from_secs(2)).unwrap();
    (path, join)
}

#[test]
#[cfg(windows)]
fn edit_named_pipe_reads_large_message_and_cancels_timeout() {
    let payload = json!({"id":"test", "result":{"text":"日".repeat(30_000)}});
    let (path, join) = server(payload.clone(), 0);
    let response = exchange_at(&path, &json!({"id":"test","method":"items_get"}), 2_000).unwrap();
    assert_eq!(response, payload);
    assert_eq!(join.join().unwrap()["method"], "items_get");

    let (path, join) = server(json!({"pong":true}), 120);
    let start = std::time::Instant::now();
    assert!(exchange_at(&path, &json!({"method":"ping"}), 30).unwrap_err().contains("超时"));
    assert!(start.elapsed().as_millis() < 500);
    join.join().unwrap();
    // 超时操作已经撤销、关闭，不留下等待服务端的工作线程。
    assert!(exchange_at(&path, &json!({"method":"ping"}), 30).is_err());
}
