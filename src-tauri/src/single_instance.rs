//! Session-local single instance gate; pending activation survives GUI startup.
use windows_sys::Win32::{
    Foundation::{CloseHandle, HANDLE, WAIT_ABANDONED, WAIT_OBJECT_0, WAIT_TIMEOUT},
    System::Threading::{CreateEventW, CreateMutexW, ReleaseMutex, SetEvent, WaitForSingleObject},
};

const MUTEX_NAME: &str = "Local\\Kal-SingleInstance-Mutex-v2";
pub(crate) const EVENT_NAME: &str = "Local\\Kal-Activate-v2";

/// Isolated runs must not acquire or signal the production session objects.
pub fn is_isolated() -> bool { crate::store::is_isolated() }

pub(crate) fn wide(value: &str) -> Vec<u16> {
    value.encode_utf16().chain(Some(0)).collect()
}

// Must stay on the acquiring main thread until the application exits.
pub struct InstanceGuard {
    mutex: HANDLE,
    event: HANDLE,
    _main_thread: std::marker::PhantomData<std::rc::Rc<()>>,
}

impl Drop for InstanceGuard {
    fn drop(&mut self) {
        unsafe {
            ReleaseMutex(self.mutex);
            CloseHandle(self.mutex);
            CloseHandle(self.event);
        }
    }
}

pub fn acquire() -> Result<Option<InstanceGuard>, String> {
    acquire_named(MUTEX_NAME, EVENT_NAME)
}

fn acquire_named(mutex_name: &str, event_name: &str) -> Result<Option<InstanceGuard>, String> {
    unsafe {
        // Create the auto-reset event before competing for the mutex. A second
        // launch can signal it even before Tauri has initialized its listener.
        let event = CreateEventW(std::ptr::null(), 0, 0, wide(event_name).as_ptr());
        if event.is_null() {
            return Err(format!("无法创建 Kal 呼出事件：{}", std::io::Error::last_os_error()));
        }
        let mutex = CreateMutexW(std::ptr::null(), 0, wide(mutex_name).as_ptr());
        if mutex.is_null() {
            let error = std::io::Error::last_os_error();
            CloseHandle(event);
            return Err(format!("无法创建 Kal 单实例锁：{error}"));
        }
        let result = WaitForSingleObject(mutex, 0);
        if result == WAIT_OBJECT_0 || result == WAIT_ABANDONED {
            Ok(Some(InstanceGuard { mutex, event, _main_thread: std::marker::PhantomData }))
        } else {
            let error = if result == WAIT_TIMEOUT {
                if SetEvent(event) == 0 { Some(std::io::Error::last_os_error().to_string()) } else { None }
            } else { Some(std::io::Error::last_os_error().to_string()) };
            CloseHandle(mutex);
            CloseHandle(event);
            match error {
                Some(error) => Err(format!("无法通知已有 Kal 实例：{error}")),
                None => Ok(None),
            }
        }
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn desktop_instance_lock_notifies_and_releases() {
        let prefix = format!("Local\\Kal-test-{}", std::process::id());
        let mutex_name = format!("{prefix}-mutex");
        let event_name = format!("{prefix}-event");
        let guard = super::acquire_named(&mutex_name, &event_name).unwrap().unwrap();
        let names = (mutex_name.clone(), event_name.clone());
        std::thread::spawn(move || assert!(super::acquire_named(&names.0, &names.1).unwrap().is_none())).join().unwrap();
        assert_eq!(unsafe { windows_sys::Win32::System::Threading::WaitForSingleObject(guard.event, 0) }, windows_sys::Win32::Foundation::WAIT_OBJECT_0);
        drop(guard);
        let next = std::thread::spawn(move || assert!(super::acquire_named(&mutex_name, &event_name).unwrap().is_some()));
        next.join().unwrap();
    }
}
