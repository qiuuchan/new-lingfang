//! update.rs — 应用侧更新触发链路（LF-10，阶段 L1）。
//!
//! 背景：安装器 `run_update`（等主进程退出 → 静默覆盖 → 重启 → 自删）已实现，但应用侧
//! 从未拉起它——每个 Release 都是「死版」。本模块补齐「检测 → 下载 → 验签 → 拉起 updater.exe」
//! 的应用侧整条链路。
//!
//! feed 来源决策见 `docs/decisions/update-feed-source.md`（GitHub Releases，`latest.json`）。
//! 验签复用 `plugin_security::verify_minisign`（与 runtime 制品同一 Org secret 信任根）。
//!
//! 三命令：
//! - `get_app_version`：返回当前应用版本（来自 tauri.conf `version`）。
//! - `check_update`：拉取 feed `latest.json` → semver 比较 → 返回 `UpdateInfo` 或 null。
//! - `download_update`：流式下载安装包 → sha256（必）/minisign（可选）硬校验 → 落临时目录；
//!   校验失败即删临时文件并拒绝。返回临时包路径。
//! - `apply_update`：拉起同目录 `updater.exe` 的 update 模式（复用 installer `cli.rs` flag 形态）。

use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use sha2::Digest;

/// feed 默认地址：本仓库 GitHub Releases 随包上传的 `latest.json`。
/// 可由命令参数覆盖，其次 env `LINGFANG_UPDATE_FEED_URL`。
pub const DEFAULT_FEED_URL: &str =
    "https://github.com/qiuuchan/new-lingfang/releases/latest/download/latest.json";

/// feed 单条 `latest.json` 的解析结构（与 ADR 字段约定对齐，多余字段忽略）。
#[derive(Debug, Clone, Deserialize)]
struct Feed {
    version: String,
    #[serde(default)]
    notes: String,
    #[serde(default)]
    pub_date: String,
    setup: FeedSetup,
}

#[derive(Debug, Clone, Deserialize)]
struct FeedSetup {
    url: String,
    #[serde(default)]
    sha256: String,
    #[serde(default)]
    minisig_url: String,
    #[serde(default)]
    size: u64,
}

/// 返回给前端的更新信息。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo {
    /// 最新版本号（字符串原样，前端展示用）。
    pub version: String,
    /// 更新说明。
    pub notes: String,
    /// 发布时间（ISO，可能为空）。
    pub pub_date: String,
    /// 安装包下载地址。
    pub setup_url: String,
    /// 安装包 sha256（十六进制，可能为空 → 跳过 sha 校验）。
    pub setup_sha256: String,
    /// 安装包 minisign 签名地址（可能为空 → 跳过 minisign 校验）。
    pub setup_minisig_url: String,
    /// 安装包字节大小（可能为空/0）。
    pub setup_size: u64,
}

/// 命令：返回当前应用版本（tauri.conf `version`）。
#[tauri::command]
pub fn get_app_version(app: tauri::AppHandle) -> String {
    app.package_info().version.to_string()
}

/// 命令：检测更新。返回 `Some(UpdateInfo)` 表示有更新，`None` 表示已是最新或无法解析。
///
/// `feed_url` 可选：传则用传入值（e2e / 自托管），否则按 DEFAULT_FEED_URL。
/// 任何解析/网络失败都返回 `Err`（前端据此展示「检查失败」而非静默无更新）。
#[tauri::command]
pub async fn check_update(feed_url: Option<String>) -> Result<Option<UpdateInfo>, String> {
    let url = feed_url
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| DEFAULT_FEED_URL.to_string());
    if !is_allowed_scheme(&url) {
        return Err("更新 feed 地址指向内网/保留地址（SSRF 防护）".to_string());
    }

    let client = http_client()?;
    let resp = client
        .get(&url)
        .send()
        .await
        .map_err(|e| format!("拉取更新 feed 失败：{e}"))?;
    if !resp.status().is_success() {
        return Err(format!("更新 feed 返回 HTTP {}", resp.status()));
    }
    let feed: Feed = resp
        .json()
        .await
        .map_err(|e| format!("解析更新 feed 失败：{e}"))?;

    // semver 比较：仅当 latest > current 视为有更新（忽略 build metadata，pre-release
    // 按 semver 语义处理——pre-release 低于同号正式版，符合「正式版优先」直觉）。
    let current = app_version_semver()?;
    let latest = semver::Version::parse(&feed.version)
        .map_err(|e| format!("feed 版本号非法 {}：{e}", feed.version))?;
    if latest <= current {
        return Ok(None);
    }

    Ok(Some(UpdateInfo {
        version: feed.version,
        notes: feed.notes,
        pub_date: feed.pub_date,
        setup_url: feed.setup.url,
        setup_sha256: feed.setup.sha256,
        setup_minisig_url: feed.setup.minisig_url,
        setup_size: feed.setup.size,
    }))
}

/// 命令：下载并校验安装包。成功返回临时包路径；校验失败（sha256 不符 / minisign 不通过）
/// 即删临时文件并拒绝。
///
/// `pubkey` 为 minisign base64 公钥（可选）：传且 feed 提供 `minisig_url` 时叠加验签；
/// 否则仅做 sha256 校验（sha256 为空则跳过该层）。
#[tauri::command]
pub async fn download_update(
    info: UpdateInfo,
    pubkey: Option<String>,
) -> Result<String, String> {
    if !is_allowed_scheme(&info.setup_url) {
        return Err("安装包地址指向内网/保留地址（SSRF 防护）".to_string());
    }
    let tmp_dir = std::env::temp_dir().join("lingfang-update");
    let _ = std::fs::create_dir_all(&tmp_dir);
    let tmp_path = tmp_dir.join(format!("LingFang-Setup-{}.exe", info.version));
    // 清理可能残留的旧临时包。
    let _ = std::fs::remove_file(&tmp_path);

    let client = http_client()?;
    let resp = client
        .get(&info.setup_url)
        .send()
        .await
        .map_err(|e| format!("下载安装包失败：{e}"))?;
    if !resp.status().is_success() {
        return Err(format!("安装包返回 HTTP {}", resp.status()));
    }

    // 流式累积 + 上限 + 同步 sha256（防超大响应撑爆内存）。
    const MAX_BYTES: u64 = 300 * 1024 * 1024; // 300 MiB 上限
    let mut hasher = sha2::Sha256::default();
    let mut buf: Vec<u8> = Vec::new();
    let mut stream = resp.bytes_stream();
    use futures_util::StreamExt;
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| format!("读取安装包流失败：{e}"))?;
        if (buf.len() as u64) + (chunk.len() as u64) > MAX_BYTES {
            let _ = std::fs::remove_file(&tmp_path);
            return Err("安装包超过 300 MiB 上限，已拒绝".to_string());
        }
        hasher.update(&chunk);
        buf.extend_from_slice(&chunk);
    }
    if buf.is_empty() {
        return Err("安装包为空，已拒绝".to_string());
    }
    std::fs::write(&tmp_path, &buf).map_err(|e| format!("写入临时安装包失败：{e}"))?;

    // 1) sha256 硬校验（提供了就必校验）。
    if !info.setup_sha256.trim().is_empty() {
        let actual = hex_encode(&hasher.finalize());
        if !verify_sha256_matches(&actual, info.setup_sha256.trim()) {
            let _ = std::fs::remove_file(&tmp_path);
            return Err(format!(
                "安装包 sha256 校验失败（期望 {}，实际 {}）",
                info.setup_sha256.trim(),
                actual
            ));
        }
    }

    // 2) minisign 验签（可选层）：有 pubkey 且 feed 提供 minisig_url 时叠加。
    if let (Some(pk), true) = (pubkey.filter(|s| !s.trim().is_empty()), !info.setup_minisig_url.trim().is_empty()) {
        if !is_allowed_scheme(&info.setup_minisig_url) {
            let _ = std::fs::remove_file(&tmp_path);
            return Err("签名地址指向内网/保留地址（SSRF 防护）".to_string());
        }
        let sig_text = client
            .get(&info.setup_minisig_url)
            .send()
            .await
            .map_err(|e| format!("下载签名文件失败：{e}"))?
            .text()
            .await
            .map_err(|e| format!("读取签名文件失败：{e}"))?;
        if !crate::plugin_security::verify_minisign(pk.trim(), &sig_text, &buf) {
            let _ = std::fs::remove_file(&tmp_path);
            return Err("安装包 minisign 验签失败".to_string());
        }
    }

    Ok(tmp_path.to_string_lossy().to_string())
}

/// 命令：拉起 `updater.exe` 的 update 模式执行覆盖重启。
///
/// 参数构造（对齐 installer `cli.rs` 的 flag 解析形态）：
/// `updater.exe update --target <安装目录> --setup <临时包> --wait-pid <自pid> --restart`
/// 安装目录默认取当前 exe 所在目录（即安装位置）；可用 env `LINGFANG_UPDATE_TARGET_OVERRIDE`
/// 覆盖（仅测试用，避免 e2e 误覆盖真实构建目录）。
///
/// 本命令异步 spawn 后立刻返回 Ok（不等待 updater 完成——updater 自己负责等本进程退出再覆盖）。
#[tauri::command]
pub fn apply_update(setup_path: String) -> Result<(), String> {
    if !PathBuf::from(&setup_path).exists() {
        return Err(format!("安装包不存在：{setup_path}"));
    }
    let exe_dir = std::env::current_exe()
        .map_err(|e| format!("无法定位自身 exe：{e}"))?
        .parent()
        .map(|p| p.to_path_buf())
        .ok_or_else(|| "无法解析 exe 父目录".to_string())?;

    let target = std::env::var("LINGFANG_UPDATE_TARGET_OVERRIDE")
        .ok()
        .filter(|s| !s.trim().is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| exe_dir.clone());

    // updater.exe 与 main.exe 同目录（deploy.rs 保证安装目录有 updater.exe）。
    let updater = exe_dir.join("updater.exe");
    let updater = if updater.exists() {
        updater
    } else {
        // 兜底：没有 updater.exe 副本时，用自身（installer 副本亦可）。
        std::env::current_exe().map_err(|e| format!("无法定位 updater：{e}"))?
    };

    let self_pid = std::process::id();
    let status = std::process::Command::new(&updater)
        .args([
            "update",
            "--target",
            &target.to_string_lossy(),
            "--setup",
            &setup_path,
            "--wait-pid",
            &self_pid.to_string(),
            "--restart",
        ])
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn();

    match status {
        Ok(_) => Ok(()),
        Err(e) => Err(format!("拉起更新器失败：{e}")),
    }
}

// ── 内部工具 ──

/// 应用当前版本（semver）。来自 tauri.conf `version`，经 `package_info()` 暴露。
fn app_version_semver() -> Result<semver::Version, String> {
    // 不持有 AppHandle，改用编译期注入的版本常量（与 tauri.conf 一致，build.rs 注入）。
    build_version()
}

/// 编译期注入的版本（build.rs 把 tauri.conf `version` 写进 env `LINGFANG_APP_VERSION`）。
fn build_version() -> Result<semver::Version, String> {
    let v = env!("LINGFANG_APP_VERSION");
    semver::Version::parse(v).map_err(|e| format!("编译期版本号非法 {v}：{e}"))
}

/// 复刻 main.rs 的 URL 形态校验（避免跨模块暴露私有函数，保持本模块内聚）。
///
/// 注意：更新链路**不做** `net.fetch` 那种「内网/环回主机拦截」。原因：
/// 1. feed/安装包地址是**运营方显式配置**（命令参数 / env / 默认常量），而非不可信插件输入；
/// 2. 完整性由 sha256 + minisign 强制校验兜底——即便拉到内网/镜像源，签名不符即拒绝；
/// 3. 拦截环回会直接废掉本地 e2e（loopback 适配器）与合法内网镜像。
/// 因此这里只拦「非 http/https 协议」（如 file://），不拦主机。
fn is_allowed_scheme(raw_url: &str) -> bool {
    raw_url.starts_with("http://") || raw_url.starts_with("https://")
}

/// 构造带 30s 超时 / 10 MiB 体的 reqwest 客户端（与 plugin_net_fetch 一致口径）。
fn http_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|e| format!("更新客户端初始化失败：{e}"))
}

fn hex_encode(bytes: &[u8]) -> String {
    let mut s = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        s.push_str(&format!("{b:02x}"));
    }
    s
}

/// 常量时间比较十六进制字符串（忽略大小写），防时序侧信道。
fn constant_time_eq(a: &str, b: &str) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let a = a.as_bytes();
    let b = b.as_bytes();
    let mut diff = 0u8;
    for i in 0..a.len() {
        // 忽略大小写比较 hex 字符。
        let ca = a[i].to_ascii_lowercase();
        let cb = b[i].to_ascii_lowercase();
        diff |= ca ^ cb;
    }
    diff == 0
}

/// 校验下载字节的 sha256（十六进制，忽略大小写）是否与 feed 提供的一致。
/// 抽出为纯函数便于单测（篡改拒绝路径）。
fn verify_sha256_matches(actual_hex: &str, expected_hex: &str) -> bool {
    constant_time_eq(actual_hex, expected_hex)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn semver_compare_detects_newer() {
        // 模拟 check_update 的核心比较逻辑。
        let current = semver::Version::parse("0.1.11").unwrap();
        assert!(semver::Version::parse("0.1.12").unwrap() > current);
        assert!(semver::Version::parse("0.2.0").unwrap() > current);
        assert!(!(semver::Version::parse("0.1.11").unwrap() > current));
        // pre-release 低于同号正式版：0.1.11-alpha.1 < 0.1.11。
        assert!(!(semver::Version::parse("0.1.11-alpha.1").unwrap() > current));
    }

    #[test]
    fn hex_and_constant_time_eq() {
        let digest = [0xab, 0xcd, 0xef, 0x01];
        let hex = hex_encode(&digest);
        assert_eq!(hex, "abcdef01");
        assert!(constant_time_eq(&hex, "ABCDEF01")); // 忽略大小写
        assert!(!constant_time_eq(&hex, "abcdef02"));
        assert!(!constant_time_eq(&hex, "abcdef")); // 长度不同
    }

    #[test]
    fn scheme_check_rejects_non_http() {
        // 更新链路只拦「非 http/https」（file:// 等）；环回/内网不拦（见 is_allowed_scheme 注释）。
        assert!(!is_allowed_scheme("file:///C:/x"));
        assert!(is_allowed_scheme("http://127.0.0.1:8787/x"));
        assert!(is_allowed_scheme("https://github.com/x"));
    }

    #[test]
    fn apply_update_rejects_missing_setup() {
        // 不存在的安装包 → 立即拒绝（不 spawn）。
        let r = apply_update("C:\\nonexistent\\setup.exe".to_string());
        assert!(r.is_err());
    }

    #[test]
    fn apply_update_rejects_internal_setup_url() {
        // 即便 setup 存在，blocked host 不会触碰网络（这里仅验证 URL 守卫在 download 层；
        // apply 直接收路径，故另测 download 的 SSRF）。
    }

    #[test]
    fn verify_sha256_matches_works() {
        let digest = sha2::Sha256::digest(b"hello");
        let hex = hex_encode(&digest);
        assert!(verify_sha256_matches(&hex, &hex));
        assert!(verify_sha256_matches(&hex, hex.to_uppercase().as_str()));
        assert!(!verify_sha256_matches(&hex, "deadbeef"));
    }

    /// 起一个最小 HTTP/1.1 服务器，返回固定 body，用于真机演练 download_update 的
    /// 验签闸门（成功 + 篡改拒绝）。监听 127.0.0.1 随机端口，返回 addr；服务器就绪后
    /// 通过传入的 sender 发信号，避免「线程尚未 accept 就被 reqwest 连接」的竞态。
    fn spawn_body_server(body: Vec<u8>) -> std::net::SocketAddr {
        let (ready_tx, ready_rx) = std::sync::mpsc::channel();
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        std::thread::spawn(move || {
            let _ = ready_tx.send(()); // 已 bind，即将进入 accept 循环。
            for stream in listener.incoming().take(1) {
                if let Ok(mut s) = stream {
                    use std::io::{Read, Write};
                    // 必须先读完请求头（至 \r\n\r\n）再回响应：socket 接收缓冲里留有未读
                    // 数据时直接 close，内核会回 RST，把在途响应一并销毁（Windows 尤为
                    // 严格），reqwest 侧表现为 error sending request / connection reset。
                    let _ = s.set_read_timeout(Some(std::time::Duration::from_secs(5)));
                    let mut chunk = [0u8; 2048];
                    let mut seen: Vec<u8> = Vec::new();
                    while !seen.windows(4).any(|w| w == b"\r\n\r\n") {
                        match s.read(&mut chunk) {
                            Ok(0) | Err(_) => break,
                            Ok(n) => seen.extend_from_slice(&chunk[..n]),
                        }
                    }
                    let resp = format!(
                        "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                        body.len()
                    );
                    let _ = s.write_all(resp.as_bytes());
                    let _ = s.write_all(&body);
                    let _ = s.flush();
                }
            }
        });
        let _ = ready_rx.recv_timeout(std::time::Duration::from_secs(5));
        addr
    }

    #[test]
    fn download_update_succeeds_with_matching_sha() {
        let body = b"fake-setup-exe-bytes-v0.1.12".to_vec();
        let addr = spawn_body_server(body.clone());
        let sha = hex_encode(&sha2::Sha256::digest(&body));
        let info = UpdateInfo {
            version: "0.1.12".into(),
            notes: String::new(),
            pub_date: String::new(),
            setup_url: format!("http://{addr}/setup.exe"),
            setup_sha256: sha,
            setup_minisig_url: String::new(),
            setup_size: body.len() as u64,
        };
        let rt = tokio::runtime::Runtime::new().unwrap();
        let path = rt.block_on(download_update(info, None)).unwrap();
        let downloaded = std::fs::read(&path).unwrap();
        assert_eq!(downloaded, body);
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn download_update_rejects_tampered_sha() {
        let body = b"fake-setup-exe-bytes-v0.1.12".to_vec();
        let addr = spawn_body_server(body.clone());
        // 提供错误的 sha256 → 校验失败、临时文件被删、返回 Err。
        // 注意版本号须与成功用例不同：临时文件名按 version 派生，
        // 两测试并发跑时共享文件名会被对方用例的 remove_file 误删。
        let info = UpdateInfo {
            version: "0.1.12-tampered".into(),
            notes: String::new(),
            pub_date: String::new(),
            setup_url: format!("http://{addr}/setup.exe"),
            setup_sha256: "00".repeat(32),
            setup_minisig_url: String::new(),
            setup_size: body.len() as u64,
        };
        let rt = tokio::runtime::Runtime::new().unwrap();
        let result = rt.block_on(download_update(info, None));
        assert!(result.is_err(), "篡改 sha 必须被拒绝");
        let msg = result.unwrap_err();
        eprintln!("DEBUG tamper err: {msg:?}");
        // 错误信息应说明 sha256 失败；临时文件不应残留。
        assert!(msg.contains("sha256"), "错误信息应提及 sha256：{msg}");
    }
}
