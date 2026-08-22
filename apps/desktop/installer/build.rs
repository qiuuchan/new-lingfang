// build.rs —— 注入桌面端版本，并在 Windows 构建时嵌入 VERSIONINFO 资源。
//
// 为什么：未签名 + 无版本元数据的 EXE 易被杀软启发式判定为「匿名 dropper」
// （installer 的自解压行为本身像 dropper）。补合法 VERSIONINFO（公司/产品/版本/描述）
// 让 PE 文件属性显示正规软件元数据，降低误报概率（非根治，签名才是根治）。
//
// 安装器展示/注册表/文件属性版本以桌面端 tauri.conf.json 为真相源，避免
// installer/Cargo.toml 版本忘记同步导致标题显示旧版本。
fn main() {
    let version = desktop_version().unwrap_or_else(|| {
        std::env::var("CARGO_PKG_VERSION").unwrap_or_else(|_| "0.0.0".to_string())
    });
    println!("cargo:rustc-env=LINGFANG_APP_VERSION={version}");
    println!("cargo:rerun-if-changed=../src-tauri/tauri.conf.json");

    #[cfg(target_os = "windows")]
    {
        let mut res = winres::WindowsResource::new();
        // 与 paths.rs / tauri.conf.json 对齐的显示信息。
        res.set("FileDescription", "灵坊工作台 安装程序");
        res.set("ProductName", "灵坊工作台");
        res.set("LegalCopyright", "© 2026 灵坊工作台");
        res.set("CompanyName", "灵坊工作台");
        res.set("ProductVersion", &version);
        res.set("FileVersion", &windows_file_version(&version));
        // 原始版本四元组（winres 默认从 ProductVersion 解析；这里显式确保格式合法）。
        // 若解析失败（如含非数字），winres 会用 0.0.0.0 兜底，不影响构建。
        if let Err(e) = res.compile() {
            // 资源编译失败不应阻断构建（如缺 rc.exe 工具链）——降级为无资源 exe。
            println!("cargo:warning=winres 编译 VERSIONINFO 失败（降级为无资源）：{e}");
        }
    }
    println!("cargo:rerun-if-changed=build.rs");
}

fn desktop_version() -> Option<String> {
    let manifest_dir = std::path::PathBuf::from(std::env::var_os("CARGO_MANIFEST_DIR")?);
    let conf_path = manifest_dir.join("../src-tauri/tauri.conf.json");
    let raw = std::fs::read_to_string(conf_path).ok()?;
    extract_json_string_field(&raw, "version")
}

fn extract_json_string_field(raw: &str, field: &str) -> Option<String> {
    let needle = format!("\"{field}\"");
    let after_field = raw.split_once(&needle)?.1;
    let after_colon = after_field.split_once(':')?.1.trim_start();
    let after_quote = after_colon.strip_prefix('"')?;
    let mut value = String::new();
    let mut escaped = false;
    for ch in after_quote.chars() {
        if escaped {
            value.push(ch);
            escaped = false;
        } else if ch == '\\' {
            escaped = true;
        } else if ch == '"' {
            return Some(value);
        } else {
            value.push(ch);
        }
    }
    None
}

fn windows_file_version(version: &str) -> String {
    let mut parts: Vec<&str> = version.split('.').collect();
    while parts.len() < 4 {
        parts.push("0");
    }
    parts.truncate(4);
    parts.join(".")
}
