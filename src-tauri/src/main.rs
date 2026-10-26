// GUI 子系统下不弹控制台；CLI 诊断请用 debug 构建（cargo run -- --doctor）
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let has = |f: &str| args.iter().any(|a| a == f);

    if has("--selftest") {
        std::process::exit(kal_shell::selftest_cli());
    }
    if has("--doctor") {
        kal_shell::doctor_cli();
        return;
    }
    if has("--theme-save") {
        let name = args
            .iter()
            .skip_while(|a| *a != "--theme-save")
            .skip(1)
            .find(|a| !a.starts_with("--"))
            .cloned();
        let mode = if has("--light") {
            Some("light".to_string())
        } else if has("--dark") {
            Some("dark".to_string())
        } else {
            None
        };
        std::process::exit(kal_shell::theme_save_cli(name, mode));
    }
    if let Some(i) = args.iter().position(|a| a == "--palette") {
        let p = args.get(i + 1).filter(|s| !s.starts_with("--")).cloned();
        kal_shell::palette_cli(p);
        return;
    }

    #[cfg(windows)]
    let _instance = match kal_shell::single_instance::acquire() {
        Ok(Some(instance)) => instance,
        Ok(None) => {
            eprintln!("已通知正在运行的 Kal 呼出窗口。");
            return;
        }
        Err(error) => { eprintln!("{error}"); return; }
    };

    kal_shell::run();
}
