//! Capability 网关：插件越权能力的三重校验与执行（见 ADR-0004）。
//!
//! 校验链：
//!   1) 插件 manifest 是否声明该 capability（由已加载插件注册表提供）
//!   2) 作用域校验（如 fs.read 的 paths 白名单）
//!   3) 实际执行（fs / system 等真实 OS 操作）
//!
//! 注：M4 之前，插件授权（PluginGrant）由服务端在安装时校验；
//! 桌面壳这一层负责 manifest 声明 + 作用域 + 安全执行。

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

/// 已加载插件的能力注册表：plugin_id -> 声明的 capability 列表。
#[derive(Default)]
pub struct CapabilityRegistry {
    plugins: Mutex<HashMap<String, Vec<DeclaredCapability>>>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct DeclaredCapability {
    pub kind: String,
    /// fs.* 的路径白名单（已展开 $HOME 等）。
    #[serde(default)]
    pub paths: Vec<String>,
}

impl CapabilityRegistry {
    pub fn register(&self, plugin_id: &str, caps: Vec<DeclaredCapability>) {
        // 修复 CAPLOCK：原 .lock().unwrap() 在持锁线程 panic 时会 poison 锁，
        // 其后所有 register/find 调用二次 panic，整个插件能力子系统（所有 capability 调用）瘫痪需重启。
        // PoisonError::into_inner() 拿到锁内数据（数据仍有效，仅代表另一线程异常退出），
        // 与 code_assistant.rs::lock_or_recover 同款容忍策略，杜绝 panic 级联。
        let mut map = self
            .plugins
            .lock()
            .unwrap_or_else(|poison| poison.into_inner());
        map.insert(plugin_id.to_string(), caps);
    }

    pub fn find(&self, plugin_id: &str, kind: &str) -> Option<DeclaredCapability> {
        let map = self
            .plugins
            .lock()
            .unwrap_or_else(|poison| poison.into_inner());
        map.get(plugin_id)?.iter().find(|c| c.kind == kind).cloned()
    }
}

#[derive(Debug)]
pub enum CapError {
    NotDeclared(String),
    // 修复 CAP-01：OutOfScope 的内部字符串不再被 Display 消费（脱敏固定串），
    // 但保留字段以便调用方在需要时构造（matches! 仍可匹配变体）。允许 dead_code 抑制告警。
    #[allow(dead_code)]
    OutOfScope(String),
    Exec(String),
    // 修复 CAP-04（low 契约错位）：manifest 已声明但本地未实现的合法 capability（fs.write /
    // net.fetch / clipboard / storage.kv / system.screenshot 等）此前落入 other 分支返回 NotDeclared,
    // 文案「插件未声明能力」与事实矛盾（find() 已成功证明已声明）。新增 NotSupported 变体，
    // Display 为「插件已声明但桌面壳暂未实现」，与 capability-gateway.md Error Matrix 语义对齐。
    NotSupported(String),
}

impl std::fmt::Display for CapError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            CapError::NotDeclared(k) => write!(f, "插件未声明能力: {k}"),
            // 修复 CAP-01（low 安全）：OutOfScope 不再回显 canonicalize 后的绝对路径，
            // 只返回固定串，避免对任意路径的存在性 + 真实规范化路径盲探（信息泄漏 oracle）。
            CapError::OutOfScope(_) => write!(f, "路径超出授权范围"),
            // Exec：非路径参数错误（如「缺少 path 参数」）保持可读文案；
            // 真实 OS 文件错误已在 canonical_scoped_path 收敛为 OutOfScope（见下方注释）。
            CapError::Exec(e) => write!(f, "能力执行失败: {e}"),
            CapError::NotSupported(k) => write!(f, "插件已声明但桌面壳暂未实现: {k}"),
        }
    }
}

/// 把 manifest 里的相对路径模板（$HOME/Documents 等）展开为绝对路径。
pub fn expand_path(template: &str) -> String {
    if let Some(rest) = template.strip_prefix("$HOME") {
        if let Some(home) = dirs::home_dir() {
            return format!("{}{}", home.to_string_lossy(), rest);
        }
    }
    template.to_string()
}

/// 核心入口：校验 + 执行一次 capability 调用。
pub fn invoke(
    registry: &CapabilityRegistry,
    plugin_id: &str,
    kind: &str,
    args: &Value,
) -> Result<Value, CapError> {
    // 1) manifest 声明校验
    let declared = registry
        .find(plugin_id, kind)
        .ok_or_else(|| CapError::NotDeclared(kind.to_string()))?;

    // 2+3) 按能力类型分派（含作用域校验 + 执行）
    match kind {
        "fs.read" => fs_read(&declared, args),
        "fs.write" => fs_write(&declared, args),
        "system.info" => Ok(system_info()),
        "clipboard" => clipboard_op(args),
        "system.screenshot" => system_screenshot(),
        // 未实现的合法 kind（如经 manifest 注入但运行时无对应分派）落到 NotSupported。
        // 注意：net.fetch / storage.kv / fs.pick / system.notify / ui.view 与五个 AI kind
        // 均在 TS invokeRuntime（plugins-runtime.ts）路由到独立命令/宿主 UI，不会到达本网关；
        // 当前真正到此仍 NotSupported 的仅 plugin.upload / plugin.submitMarketplace
        // （平台市场审核流交互，桌面壳不越权伪造），其余视为契约与实现错位。
        other => Err(CapError::NotSupported(other.to_string())),
    }
}

/// fs.read：列目录或读文件，强制路径在 manifest 白名单内。
///
/// 修复 CAP-02（medium 边界）：此前无大小 / 数量上限，授权宽子树（如 $HOME/Documents、
/// $HOME/Downloads）后对大文件 read_to_string 或 read_dir
/// 全量收进 Vec 可致 OOM / 卡死整个桌面壳进程。修复：
/// - 文件分支：先 metadata.len() 上限校验（MAX_FS_READ_BYTES = 1 MiB），超出拒绝。
/// - 目录分支：entries 计数上限（MAX_FS_READ_ENTRIES = 4096），超出截断并在响应标记 truncated。
fn fs_read(declared: &DeclaredCapability, args: &Value) -> Result<Value, CapError> {
    // fs.read 单文件大小上限（1 MiB）：防止 read_to_string 把整 GB 日志/视频读进内存。
    // 选 1 MiB 兼顾实用性与内存峰值安全（文本插件配置/源码均远小于此）。
    const MAX_FS_READ_BYTES: u64 = 1024 * 1024;
    // fs.read 目录条目数上限（4096）：防止授权宽子树（如 node_modules）目录枚举爆炸。
    const MAX_FS_READ_ENTRIES: usize = 4096;

    let raw = args
        .get("path")
        .and_then(|v| v.as_str())
        .ok_or_else(|| CapError::Exec("缺少 path 参数".to_string()))?;
    let path = canonical_scoped_path(raw, &declared.paths)?;
    let meta = std::fs::metadata(&path).map_err(|_| CapError::Exec("目标不可访问".to_string()))?;
    if meta.is_dir() {
        let mut entries = Vec::new();
        let mut truncated = false;
        let read =
            std::fs::read_dir(&path).map_err(|_| CapError::Exec("目录读取失败".to_string()))?;
        for entry in read.flatten() {
            if entries.len() >= MAX_FS_READ_ENTRIES {
                truncated = true;
                break;
            }
            let p = entry.path();
            let m = entry.metadata().ok();
            entries.push(json!({
                "name": entry.file_name().to_string_lossy(),
                "path": p.to_string_lossy(),
                "isDirectory": m.as_ref().map(|m| m.is_dir()).unwrap_or(false),
                "size": m.as_ref().map(|m| m.len()).unwrap_or(0),
            }));
        }
        Ok(json!({ "entries": entries, "truncated": truncated }))
    } else {
        // 文件分支：先校验大小上限，超出拒绝（避免 read_to_string 把整文件读进内存再失败）。
        if meta.len() > MAX_FS_READ_BYTES {
            return Err(CapError::Exec(format!(
                "文件超过 {} 字节上限，请缩小读取范围",
                MAX_FS_READ_BYTES
            )));
        }
        let content = std::fs::read_to_string(&path)
            .map_err(|_| CapError::Exec("文件读取失败（可能非 UTF-8）".to_string()))?;
        Ok(json!({ "content": content }))
    }
}

/// fs.write：写文件，强制**父目录**在 manifest 白名单内。
///
/// 与 fs.read 的关键差异：写文件目标可能尚不存在（新建文件），而 `canonicalize()` 要求路径存在。
/// 故校验逻辑改为：对请求路径取 `parent`，canonicalize 父目录，校验父目录 starts_with 某个
/// 已 canonicalize 的 allowed 前缀。父目录不存在或越权统一 OutOfScope（与 fs.read 不存在路径同语义）。
/// 写入路径用用户请求的原始路径（已确认父目录在白名单内），不跟随 canonicalize 的符号链接解析结果。
///
/// 大小上限 MAX_FS_WRITE_BYTES = 1 MiB（与 fs.read 对称，防 OOM）。
fn fs_write(declared: &DeclaredCapability, args: &Value) -> Result<Value, CapError> {
    const MAX_FS_WRITE_BYTES: usize = 1024 * 1024;

    let raw = args
        .get("path")
        .and_then(|v| v.as_str())
        .ok_or_else(|| CapError::Exec("缺少 path 参数".to_string()))?;
    let content = args.get("content").and_then(|v| v.as_str()).unwrap_or("");
    if content.len() > MAX_FS_WRITE_BYTES {
        return Err(CapError::Exec(format!(
            "写入内容超过 {} 字节上限，请缩小范围",
            MAX_FS_WRITE_BYTES
        )));
    }

    // 校验父目录在白名单内（父目录需存在且可 canonicalize）。
    let target = PathBuf::from(expand_path(raw));
    let parent = target
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .ok_or_else(|| CapError::OutOfScope(String::new()))?;
    let canon_parent = parent
        .canonicalize()
        .map_err(|_| CapError::OutOfScope(String::new()))?;
    let allowed = declared.paths.iter().any(|prefix| {
        PathBuf::from(expand_path(prefix))
            .canonicalize()
            .map(|p| canon_parent.starts_with(p))
            .unwrap_or(false)
    });
    if !allowed {
        return Err(CapError::OutOfScope(String::new()));
    }

    std::fs::write(&target, content).map_err(|e| CapError::Exec(format!("文件写入失败：{e}")))?;
    Ok(json!({ "ok": true, "bytes": content.len() }))
}

/// clipboard：读 / 写系统剪贴板文本。
/// 契约（SDK sdk.clipboard）：{op:'read'} → {content}；{op:'write', text} → {}。
fn clipboard_op(args: &Value) -> Result<Value, CapError> {
    let op = args
        .get("op")
        .and_then(|v| v.as_str())
        .ok_or_else(|| CapError::Exec("缺少 op 参数".to_string()))?;
    let mut clipboard =
        arboard::Clipboard::new().map_err(|e| CapError::Exec(format!("无法访问剪贴板：{e}")))?;
    match op {
        "read" => {
            let text = clipboard
                .get_text()
                .map_err(|e| CapError::Exec(format!("读取剪贴板失败：{e}")))?;
            Ok(json!({ "content": text }))
        }
        "write" => {
            let text = args.get("text").and_then(|v| v.as_str()).unwrap_or("");
            clipboard
                .set_text(text)
                .map_err(|e| CapError::Exec(format!("写入剪贴板失败：{e}")))?;
            Ok(json!({ "ok": true }))
        }
        other => Err(CapError::Exec(format!("未知 clipboard op：{other}"))),
    }
}

/// system.screenshot：截取主显示器一帧，返回 PNG data URL（base64）。
/// 契约（SDK sdk.system.screenshot）：{} → {content: "data:image/png;base64,..."}。
///
/// 隐私：截屏是敏感能力。其授权由插件 manifest 声明 + capability 网关三重校验保证
/// （声明即授权，桌面壳无运行时权限弹窗）；不存在独立的 requestSystemPermission 运行时门。
fn system_screenshot() -> Result<Value, CapError> {
    use base64::{engine::general_purpose::STANDARD, Engine as _};
    use xcap::image::codecs::png::PngEncoder;
    use xcap::image::{ColorType, ImageEncoder};

    // 取主显示器（Monitor::all 第一个）。
    let monitor = xcap::Monitor::all()
        .map_err(|e| CapError::Exec(format!("枚举显示器失败：{e}")))?
        .into_iter()
        .next()
        .ok_or_else(|| CapError::Exec("无可用显示器".to_string()))?;
    let img = monitor
        .capture_image()
        .map_err(|e| CapError::Exec(format!("截屏失败：{e}")))?;

    // 编码为 PNG。
    let mut png_buf = Vec::with_capacity(img.len() / 2);
    let (w, h) = img.dimensions();
    PngEncoder::new(&mut png_buf)
        .write_image(img.as_raw(), w, h, ColorType::Rgba8.into())
        .map_err(|e| CapError::Exec(format!("PNG 编码失败：{e}")))?;
    let b64 = STANDARD.encode(&png_buf);
    Ok(json!({ "content": format!("data:image/png;base64,{b64}") }))
}

fn canonical_scoped_path(raw: &str, prefixes: &[String]) -> Result<PathBuf, CapError> {
    // 修复 CAP-01（low 安全）：canonicalize 要求路径必须存在才成功。
    // 此前失败映射为 Exec(OS 错误文本) 暴露「路径不存在」的存在性 oracle；
    // 越权分支则 OutOfScope(target.to_string_lossy()) 暴露 canonicalize 后的真实绝对路径。
    // 修复：canonicalize 失败（不存在）与越权统一映射为 OutOfScope 固定串（Display 不携带路径），
    // 收敛两类错误的可观察差异，关闭存在性 + 真实路径盲探 oracle。
    // 注意：spec 第 44 行「Requested path must exist and canonicalize successfully」决定了
    // 「不存在即失败」的行为是契约一部分，本修复只把错误文本脱敏，不改成功语义。
    let target = PathBuf::from(expand_path(raw))
        .canonicalize()
        .map_err(|_| CapError::OutOfScope(String::new()))?;
    let allowed = prefixes.iter().any(|prefix| {
        PathBuf::from(expand_path(prefix))
            .canonicalize()
            .map(|p| target.starts_with(p))
            .unwrap_or(false)
    });
    if allowed {
        Ok(target)
    } else {
        Err(CapError::OutOfScope(String::new()))
    }
}

/// system.info：返回系统概况。
fn system_info() -> Value {
    use sysinfo::System;
    let mut sys = System::new_all();
    sys.refresh_all();
    json!({
        "os": System::long_os_version().unwrap_or_else(|| "Unknown".into()),
        "arch": System::cpu_arch().unwrap_or_else(|| std::env::consts::ARCH.into()),
        "hostname": System::host_name().unwrap_or_else(|| "Unknown".into()),
        "cpuCores": sys.cpus().len(),
        "totalMemory": sys.total_memory(),
        "freeMemory": sys.available_memory(),
        "uptime": System::uptime(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn temp_root(name: &str) -> std::path::PathBuf {
        let root = std::env::temp_dir().join(format!(
            "lingfang-capability-test-{}-{name}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        root
    }

    #[test]
    fn fs_read_rejects_parent_traversal_outside_allowed_prefix() {
        let root = temp_root("parent");
        let allowed = root.join("Documents");
        let sibling = root.join("Secrets");
        fs::create_dir_all(&allowed).unwrap();
        fs::create_dir_all(&sibling).unwrap();
        fs::write(sibling.join("key.txt"), "secret").unwrap();
        let cap = DeclaredCapability {
            kind: "fs.read".to_string(),
            paths: vec![allowed.to_string_lossy().to_string()],
        };
        let request =
            json!({ "path": allowed.join("..").join("Secrets").join("key.txt").to_string_lossy() });

        let err = fs_read(&cap, &request).unwrap_err();

        assert!(matches!(err, CapError::OutOfScope(_)));
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn fs_read_rejects_same_prefix_sibling_directory() {
        let root = temp_root("prefix");
        let allowed = root.join("Documents");
        let sibling = root.join("Documents2");
        fs::create_dir_all(&allowed).unwrap();
        fs::create_dir_all(&sibling).unwrap();
        fs::write(sibling.join("note.txt"), "secret").unwrap();
        let cap = DeclaredCapability {
            kind: "fs.read".to_string(),
            paths: vec![allowed.to_string_lossy().to_string()],
        };
        let request = json!({ "path": sibling.join("note.txt").to_string_lossy() });

        let err = fs_read(&cap, &request).unwrap_err();

        assert!(matches!(err, CapError::OutOfScope(_)));
        let _ = fs::remove_dir_all(root);
    }

    // CAP-07（info 测试覆盖）：capability-gateway.md §6 Tests Required 明确要求三项：
    // 父级穿越拒绝 / 同名前缀兄弟目录拒绝 / 授权子路径成功。前两项已覆盖，本测试补齐第三项正向用例。
    // 修改 canonical_scoped_path / starts_with 判定逻辑后，两个负样例仍可能全绿而正样例静默失效，
    // 故必须有用例证明 starts_with 成立时能正常返回文件内容 / 目录列表。
    #[test]
    fn fs_read_accepts_authorized_child_path() {
        let root = temp_root("authorized-child");
        let allowed = root.join("Documents");
        fs::create_dir_all(&allowed).unwrap();
        fs::write(allowed.join("sub.txt"), "hello-content").unwrap();
        let cap = DeclaredCapability {
            kind: "fs.read".to_string(),
            paths: vec![allowed.to_string_lossy().to_string()],
        };

        // 子文件：应成功返回内容。
        let request = json!({ "path": allowed.join("sub.txt").to_string_lossy() });
        let result = fs_read(&cap, &request).expect("授权子路径应成功");
        assert_eq!(result["content"], json!("hello-content"));

        // 目录本身：应成功返回 entries 列表（CAP-02 的 truncated 字段也存在）。
        let dir_request = json!({ "path": allowed.to_string_lossy() });
        let dir_result = fs_read(&cap, &dir_request).expect("授权目录应成功");
        let entries = dir_result["entries"]
            .as_array()
            .expect("应返回 entries 数组");
        assert!(
            entries.iter().any(|e| e["name"] == "sub.txt"),
            "entries 应含 sub.txt，实际 {entries:?}"
        );
        // CAP-02 新增的 truncated 标记应在未超限时为 false。
        assert_eq!(dir_result["truncated"], json!(false));

        let _ = fs::remove_dir_all(root);
    }

    // CAP-01（low 安全）：OutOfScope 不应回显 canonicalize 后的绝对路径，
    // 避免存在性 + 真实路径信息泄漏 oracle。Display 应是固定串「路径超出授权范围」。
    #[test]
    fn out_of_scope_does_not_leak_canonical_path() {
        let root = temp_root("leak-oracle");
        let allowed = root.join("allowed");
        let secret = root.join("secret-target");
        fs::create_dir_all(&allowed).unwrap();
        fs::create_dir_all(&secret).unwrap();
        fs::write(secret.join("token"), "topsecret").unwrap();
        let cap = DeclaredCapability {
            kind: "fs.read".to_string(),
            paths: vec![allowed.to_string_lossy().to_string()],
        };
        // 越权请求存在的文件。
        let request = json!({ "path": secret.join("token").to_string_lossy() });
        let err = fs_read(&cap, &request).unwrap_err();
        let message = err.to_string();
        // 错误串中不应含真实绝对路径或文件名。
        assert!(
            !message.contains("topsecret"),
            "错误串不应泄漏目标内容/路径：{message}"
        );
        assert!(
            !message.contains("secret-target") && !message.contains("token"),
            "错误串不应泄漏真实路径片段：{message}"
        );
        // 不存在的路径也应统一为 OutOfScope 固定串（关闭「不存在」oracle）。
        let missing_request = json!({ "path": allowed.join("nonexistent-file").to_string_lossy() });
        let missing_err = fs_read(&cap, &missing_request).unwrap_err();
        assert!(
            matches!(missing_err, CapError::OutOfScope(_)),
            "canonicalize 失败应映射为 OutOfScope，实际 {missing_err:?}"
        );
        let _ = fs::remove_dir_all(root);
    }

    // CAP-02（medium 边界）：大文件超过 1 MiB 上限应被拒绝，不进 read_to_string。
    #[test]
    fn fs_read_rejects_oversized_file() {
        let root = temp_root("oversize");
        let allowed = root.join("allowed");
        fs::create_dir_all(&allowed).unwrap();
        // 写一个 2 MiB 文件（超 1 MiB 上限）。
        let big = "x".repeat(2 * 1024 * 1024);
        fs::write(allowed.join("huge.txt"), big).unwrap();
        let cap = DeclaredCapability {
            kind: "fs.read".to_string(),
            paths: vec![allowed.to_string_lossy().to_string()],
        };
        let request = json!({ "path": allowed.join("huge.txt").to_string_lossy() });
        let err = fs_read(&cap, &request).unwrap_err();
        assert!(
            matches!(err, CapError::Exec(_)),
            "超大文件应返回 Exec 错误，实际 {err:?}"
        );
        assert!(
            err.to_string().contains("上限"),
            "错误应说明上限原因：{}",
            err.to_string()
        );
        let _ = fs::remove_dir_all(root);
    }

    // CAP-04（low 契约错位）：manifest 已声明但本地未实现的 kind 应返回 NotSupported，
    // 而非 NotDeclared（find 成功证明已声明，文案不应自相矛盾）。
    #[test]
    fn unimplemented_capability_returns_not_supported() {
        let registry = CapabilityRegistry::default();
        // 注册一个已声明但本地无分派的伪 kind（fs.write 已实现，故用一个不存在分派的 kind）。
        registry.register(
            "test-plugin",
            vec![DeclaredCapability {
                kind: "fs.unreal".to_string(),
                paths: vec![],
            }],
        );
        // 调 invoke 时 find 成功（已声明），但 match 不命中任何已实现分支，
        // 落入 other 分支应返回 NotSupported（而非 NotDeclared）。
        let err = invoke(&registry, "test-plugin", "fs.unreal", &json!({})).unwrap_err();
        assert!(
            matches!(err, CapError::NotSupported(_)),
            "已声明但未实现应返回 NotSupported，实际 {err:?}"
        );
        // 文案语义：应明确「已声明但未实现」而非「未声明」。
        let message = err.to_string();
        assert!(
            message.contains("已声明") && message.contains("未实现"),
            "文案应区分已声明 vs 未声明：{message}"
        );
        // 对照：真正未声明的 kind 仍返回 NotDeclared（find 失败）。
        let undeclared_err = invoke(&registry, "test-plugin", "net.fetch", &json!({})).unwrap_err();
        assert!(
            matches!(undeclared_err, CapError::NotDeclared(_)),
            "未声明的 kind 应返回 NotDeclared，实际 {undeclared_err:?}"
        );
    }

    // fs.write：授权子目录写成功 / 越权父级写拒绝 / 超大内容拒绝。
    #[test]
    fn fs_write_accepts_authorized_child_path() {
        let root = temp_root("write-child");
        let allowed = root.join("Docs");
        fs::create_dir_all(&allowed).unwrap();
        let cap = DeclaredCapability {
            kind: "fs.write".to_string(),
            paths: vec![allowed.to_string_lossy().to_string()],
        };
        let target = allowed.join("out.txt");
        let req = json!({ "path": target.to_string_lossy(), "content": "hello" });
        let result = fs_write(&cap, &req).expect("授权子目录写应成功");
        assert_eq!(result["ok"], json!(true));
        assert_eq!(result["bytes"], json!(5));
        assert_eq!(fs::read_to_string(&target).unwrap(), "hello");
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn fs_write_rejects_out_of_scope_parent() {
        let root = temp_root("write-oos");
        let allowed = root.join("Docs");
        let secret = root.join("Secrets");
        fs::create_dir_all(&allowed).unwrap();
        fs::create_dir_all(&secret).unwrap();
        let cap = DeclaredCapability {
            kind: "fs.write".to_string(),
            paths: vec![allowed.to_string_lossy().to_string()],
        };
        // 试图写到越权目录下的文件。
        let req = json!({ "path": secret.join("stolen.txt").to_string_lossy(), "content": "x" });
        let err = fs_write(&cap, &req).unwrap_err();
        assert!(matches!(err, CapError::OutOfScope(_)));
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn fs_write_rejects_oversized_content() {
        let root = temp_root("write-oversize");
        let allowed = root.join("Docs");
        fs::create_dir_all(&allowed).unwrap();
        let cap = DeclaredCapability {
            kind: "fs.write".to_string(),
            paths: vec![allowed.to_string_lossy().to_string()],
        };
        // 2 MiB 内容超 1 MiB 上限。
        let big = "x".repeat(2 * 1024 * 1024);
        let req = json!({ "path": allowed.join("huge.txt").to_string_lossy(), "content": big });
        let err = fs_write(&cap, &req).unwrap_err();
        assert!(matches!(err, CapError::Exec(_)));
        assert!(err.to_string().contains("上限"));
        let _ = fs::remove_dir_all(root);
    }
}
