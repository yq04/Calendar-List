fn main() {
    tauri_build::build();

    // tauri-build 只为 tauri.conf.json 与 capabilities 发 rerun-if-changed，
    // 它不盯 frontendDist。而前端是被内嵌进二进制的 —— 改了 ui/ 不重新编译，
    // 跑起来看到的还是旧界面，很容易误判成「改动没生效」。
    // 这里手动把 ui/ 加进监视列表，保证改前端会触发重编。
    let ui = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../ui");
    println!("cargo:rerun-if-changed={}", ui.display());
    watch(&ui, 0);
}

fn watch(dir: &std::path::Path, depth: usize) {
    if depth > 6 {
        return;
    }
    let Ok(rd) = std::fs::read_dir(dir) else { return };
    for e in rd.flatten() {
        let p = e.path();
        if p.is_dir() {
            watch(&p, depth + 1);
        } else {
            println!("cargo:rerun-if-changed={}", p.display());
        }
    }
}
