//! LingFang 桌面壳（Tauri 2，见 ADR-0001 / ADR-0004）。
//! 极简工作台 + 插件加载器 + capability 权限网关。
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod builtin_plugin_bundle;
mod builtin_plugin_index;
mod capability;
mod client_ai_proxy;
mod client_host_caps;
mod mirror_presets;
mod plugin_artifact_v4;
mod plugin_llm_bridge;
mod plugin_package_manager;
mod plugin_runner;
mod plugin_script;
mod plugin_security;
mod plugin_shell;
mod plugin_store;
mod plugins;
mod process_util;
mod runtime_commands;
mod runtime_resolver;
mod update;

use serde_json::{json, Value};
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::WindowEvent;
use tauri::{Emitter, Manager};

use capability::CapabilityRegistry;
use plugins::LoadedPlugin;

/// 从完整 URL 中提取主机名（含 IPv6 的 `[..]` 包裹形式）。
/// 用于 net.fetch 的 SSRF 防护：解析目标主机判断是否指向内网/保留地址。
fn extract_host(raw_url: &str) -> Option<String> {
    let authority = raw_url
        .split("://")
        .nth(1)?
        .split(['/', '?', '#'])
        .next()?;
    if authority.starts_with('[') {
        // IPv6 形式：[addr]:port
        let end = authority.find(']')?;
        Some(authority[..=end].to_string())
    } else {
        Some(authority.split(':').next()?.to_string())
    }
}

/// IpAddr 枚举本身没有 `is_private`/`is_link_local`（这两个方法只存在于
/// `Ipv4Addr`/`Ipv6Addr`），SSRF 判断需按 IP 版本拆分。
fn is_blocked_ip(ip: std::net::IpAddr) -> bool {
    match ip {
        std::net::IpAddr::V4(a) => {
            a.is_loopback() || a.is_private() || a.is_link_local() || a.is_unspecified() || a.is_multicast()
        }
        std::net::IpAddr::V6(a) => {
            // IPv6 没有 is_private/is_link_local；对应概念为唯一本地(fc00::/7)与单播链路本地。
            a.is_loopback() || a.is_unspecified() || a.is_multicast() || a.is_unicast_link_local() || a.is_unique_local()
        }
    }
}

/// net.fetch SSRF 防护：拒绝环回/私网/链路本地/未指定/组播地址（含云元数据 169.254.169.254）。
/// 域名会做 DNS 解析后逐一检查；解析失败按拦截处理（fail-closed）。
fn is_blocked_host(host: &str) -> bool {
    is_blocked_host_with(host, resolve_host_addrs)
}

/// 真实 DNS 解析（唯一网络调用点；测试注入可控 resolver，见 `is_blocked_host_with`）。
fn resolve_host_addrs(host: &str) -> Result<Vec<std::net::IpAddr>, ()> {
    let addrs = std::net::ToSocketAddrs::to_socket_addrs(&format!("{host}:0"))
        .map_err(|_| ())?;
    Ok(addrs.map(|a| a.ip()).collect())
}

/// 注入式 SSRF 判定（LF-19：真实域名 DNS fail-closed 的稳定单测由此可控 resolver 提供）。
/// 语义与 `is_blocked_host` 完全一致，仅解析实现可替换：
/// - 字面 IP / localhost：纯判定，不触网；
/// - 域名：解析结果逐地址检查，**解析失败一律拦截**（fail-closed——宁可误拦不可放行）。
fn is_blocked_host_with(
    host: &str,
    resolve: impl Fn(&str) -> Result<Vec<std::net::IpAddr>, ()>,
) -> bool {
    let host = host.trim_matches(['[', ']']).to_ascii_lowercase();
    if host == "localhost" {
        return true;
    }
    if let Ok(ip) = host.parse::<std::net::IpAddr>() {
        return is_blocked_ip(ip);
    }
    // 域名：解析后逐地址检查（fail-closed：解析失败即拦截）。
    let Ok(addrs) = resolve(&host) else {
        return true;
    };
    addrs.into_iter().any(is_blocked_ip)
}

/// 壳全局状态：能力注册表 + 已加载插件。
///
/// 注：AppState 本身由 Tauri 以 `Arc` 方式托管（`app.manage`），
/// 故 registry 不再额外包 `Arc`（此前为双写 Arc，无收益且易误导）。
pub struct AppState {
    registry: CapabilityRegistry,
    plugins: Vec<LoadedPlugin>,
}

/// 命令：列出已加载（内置）插件。
#[tauri::command]
fn list_plugins(state: tauri::State<AppState>) -> Vec<LoadedPlugin> {
    state.plugins.clone()
}

/// 命令：切换开发者工具（控制台）。右键菜单「控制台」调用。
#[tauri::command]
fn toggle_devtools(app: tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        if window.is_devtools_open() {
            window.close_devtools();
        } else {
            window.open_devtools();
        }
    }
}

/// 命令：启动内置脚本插件（builtin-plugins 下的 nodejs/python）。
///
/// 内置插件 id 允许 `builtin.xxx` 这种点号命名，不能直接复用 plugins_root 的
/// plugin_id 白名单目录解析；这里用已加载插件表定位资源目录，再复用 plugin_runner
/// 的按目录启动逻辑，避免把 main.py/index.js 当 HTML iframe 渲染。
#[tauri::command]
async fn start_builtin_plugin(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    manager: tauri::State<'_, plugin_package_manager::PluginPackageManager>,
    process_table: tauri::State<'_, plugin_runner::PluginProcessTable>,
    bridge: tauri::State<'_, plugin_llm_bridge::PluginLlmBridge>,
    plugin_id: String,
    api_base: Option<String>,
    auth_token: Option<String>,
    action_invocation: Option<bool>,
) -> Result<plugin_runner::StartPluginResult, String> {
    let plugin = state
        .plugins
        .iter()
        .find(|plugin| plugin.id == plugin_id)
        .ok_or_else(|| format!("内置插件不存在: {plugin_id}"))?;
    let plugin_dir = std::path::Path::new(&plugin.dir)
        .canonicalize()
        .map_err(|error| format!("内置插件目录不可用：{error}"))?;
    // venv/pip/pnpm 装依赖是长时间阻塞子进程等待，offload 到阻塞线程池避免卡主线程
    // （窗口"未响应" + emit 事件投递不出去）。与 start_installed_plugin 同理。
    let app_handle = app.clone();
    let process_table = process_table.inner().clone();
    let bridge = bridge.inner().clone();
    let manager = manager.inner().clone();
    let plugin_id_for_runner = plugin_id.clone();
    // LF-06：action_invocation=true 时，以「action invocation」会话启动内置进程插件，
    // 武装 action_invocation_id + action_context（经 register_action_session），
    // 使其能合法调用桥路由 /actions/call（验证 client-action 桥真机闭环）。
    // 否则维持原有 start_plugin_from_dir（register_session，无 action 上下文）。
    if action_invocation == Some(true) {
        tauri::async_runtime::spawn_blocking(move || {
            plugin_runner::start_builtin_action_invocation(
                &app_handle,
                &process_table,
                &bridge,
                &manager,
                &plugin_id_for_runner,
                plugin_dir,
            )
        })
        .await
        .map_err(|join_error| format!("插件启动任务异常退出：{join_error}"))?
    } else {
        tauri::async_runtime::spawn_blocking(move || {
            plugin_runner::start_plugin_from_dir(
                &app_handle,
                &process_table,
                &bridge,
                &plugin_id_for_runner,
                plugin_dir,
                api_base,
                auth_token,
            )
        })
        .await
        .map_err(|join_error| format!("插件启动任务异常退出：{join_error}"))?
    }
}

/// 命令：插件网络请求（R5 net.fetch capability）。
///
/// 内置可信插件经前端桥调用 sdk.net.fetch 时走此命令：从 Rust 进程发起 HTTP 请求，
/// 绕过 webview 跨域（CORS）限制。仅允许 manifest 声明了 net.fetch 的插件调用。
/// args: { url, method?, headers?, body? }。返回 { status, headers, body }。
/// 限制：30s 超时，body 最大 10 MiB（防滥用）。
#[tauri::command]
async fn plugin_net_fetch(
    state: tauri::State<'_, AppState>,
    plugin_id: String,
    args: Value,
) -> Result<Value, String> {
    // 1) manifest 声明校验：仅声明了 net.fetch 的插件可用。
    let declared = state.registry.find(&plugin_id, "net.fetch");
    if declared.is_none() {
        return Err("插件未声明能力: net.fetch".to_string());
    }
    let url = args
        .get("url")
        .and_then(|v| v.as_str())
        .ok_or_else(|| "net.fetch 缺少 url 参数".to_string())?;
    // 仅允许 http/https（防 file:// 等本地协议绕过）。
    if !(url.starts_with("http://") || url.starts_with("https://")) {
        return Err("net.fetch 仅支持 http/https".to_string());
    }
    // SSRF 防护：拒绝指向环回/私网/链路本地/云元数据等保留地址的主机。
    let host = extract_host(url)
        .ok_or_else(|| "net.fetch 无法解析目标主机".to_string())?;
    if is_blocked_host(&host) {
        return Err("net.fetch 禁止访问内网/保留地址（SSRF 防护）".to_string());
    }
    let method = args
        .get("method")
        .and_then(|v| v.as_str())
        .unwrap_or("GET")
        .to_uppercase();
    // 2) 构建请求（reqwest 从 Rust 进程发，不受 webview CORS 约束）。
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .user_agent("LingFang-Desktop-Plugin")
        // SSRF 兜底：跟随重定向时再次校验目标主机，阻断「公网跳转内网」绕过。
        .redirect(reqwest::redirect::Policy::custom(|attempt| {
            let host = extract_host(attempt.url().as_str()).unwrap_or_default();
            if is_blocked_host(&host) {
                attempt.stop()
            } else {
                attempt.follow()
            }
        }))
        .build()
        .map_err(|e| format!("网络请求初始化失败：{e}"))?;
    let mut req = match method.as_str() {
        "GET" => client.get(url),
        "POST" => client.post(url),
        "PUT" => client.put(url),
        "DELETE" => client.delete(url),
        "PATCH" => client.patch(url),
        other => return Err(format!("net.fetch 不支持的方法：{other}")),
    };
    // headers：透传插件指定的请求头（如 Authorization）。
    if let Some(headers) = args.get("headers").and_then(|v| v.as_object()) {
        for (k, v) in headers {
            if let Some(s) = v.as_str() {
                req = req.header(k, s);
            }
        }
    }
    // body：JSON 字符串透传。
    if let Some(body) = args.get("body") {
        req = req.json(body);
    }
    let resp = req.send().await.map_err(|e| format!("网络请求失败：{e}"))?;
    let status = resp.status().as_u16();
    // 响应头（扁平化为 string=>string）。
    let headers: serde_json::Map<String, Value> = {
        let mut m = serde_json::Map::new();
        for (k, v) in resp.headers() {
            if let Ok(vs) = v.to_str() {
                m.insert(k.as_str().to_string(), Value::String(vs.to_string()));
            }
        }
        m
    };
    // body 文本（限制 10 MiB，防超大响应撑爆内存）。
    const MAX_BODY_BYTES: usize = 10 * 1024 * 1024;
    let bytes = resp
        .bytes()
        .await
        .map_err(|e| format!("读取响应失败：{e}"))?;
    if bytes.len() > MAX_BODY_BYTES {
        return Err(format!("响应体超过 {} 字节上限", MAX_BODY_BYTES));
    }
    // 尝试 UTF-8 解码；失败给 base64（前端按需处理）。此处简化：lossy 转 string。
    let body = String::from_utf8_lossy(&bytes).to_string();
    Ok(json!({ "status": status, "headers": headers, "body": body }))
}

/// 命令：读取插件资源文件内容（用于壳加载 entry HTML）。
/// 仅允许读取该插件自身目录下的文件，防止路径穿越。
///
/// 插件根解析顺序：内置插件按 manifest id 命中 `AppState.plugins`；否则把
/// `plugin_id` 视为安装账本 installationId（前端 `LoadedPlugin.id` 即安装 id，
/// 安装插件不在 AppState.plugins 中）→ 解析其活动版本目录。
#[tauri::command]
fn read_plugin_file(
    state: tauri::State<AppState>,
    manager: tauri::State<plugin_package_manager::PluginPackageManager>,
    plugin_id: String,
    file: String,
) -> Result<String, String> {
    let base = state
        .plugins
        .iter()
        .find(|p| p.id == plugin_id)
        .map(|p| std::path::PathBuf::from(&p.dir))
        .or_else(|| {
            manager
                .list_installations()
                .into_iter()
                .find(|installation| installation.installation_id == plugin_id)
                .map(|installation| std::path::PathBuf::from(installation.active_release.path))
        })
        .ok_or_else(|| format!("插件不存在: {plugin_id}"))?;

    let base = base.canonicalize().map_err(|e| e.to_string())?;
    let target = base.join(&file).canonicalize().map_err(|e| e.to_string())?;
    // 防穿越：目标必须仍在插件目录内。
    if !target.starts_with(&base) {
        return Err("非法文件路径".to_string());
    }
    std::fs::read_to_string(&target).map_err(|e| e.to_string())
}

/// 命令：插件调用 capability（三重校验 + 执行，见 capability.rs）。
#[tauri::command]
fn invoke_capability(
    state: tauri::State<AppState>,
    plugin_id: String,
    kind: String,
    args: Value,
) -> Result<Value, String> {
    capability::invoke(&state.registry, &plugin_id, &kind, &args).map_err(|e| e.to_string())
}

// code_assistant CLI（ClaudeCode/Codex 子进程）已整体移除：AI 能力统一走平台 relay。
// 原 code_assistant_* / fetch_models / test_llm_chat 命令及 mod code_assistant / llm_credentials / llm_fetch 一并删除。
// 注：本仓库为零服务器桌面壳，不含后端 / relay / billing 服务；relay 仅由平台云侧提供，
// 相关设计说明不在本仓库内（CONTRACT 由 packages/contract 维护）。

// 项 11：系统托盘 + 关窗最小化到托盘。
//
// 托盘图标：左键单击 / 右键菜单「显示窗口」→ 显示并聚焦主窗口；菜单「退出」→ app.exit(0)。
// 关窗：不直接退出，prevent_close 后向主窗口 emit `close-requested`，由前端按偏好
// （lf:close-action：ask/tray/quit，localStorage）决定 隐藏到托盘 / 退出 / 弹询问。
fn show_main_window(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.set_focus();
    }
}

fn setup_tray(app: &tauri::App) -> Result<(), tauri::Error> {
    let show_item = MenuItem::with_id(app, "tray-show", "显示窗口", true, None::<&str>)?;
    let sep = PredefinedMenuItem::separator(app)?;
    let quit_item = MenuItem::with_id(app, "tray-quit", "退出", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show_item, &sep, &quit_item])?;
    TrayIconBuilder::with_id("main-tray")
        .icon(app.default_window_icon().unwrap().clone())
        .tooltip("灵坊")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "tray-show" => show_main_window(app),
            "tray-quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            // 左键单击恢复窗口（右键由系统触发菜单）。
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                show_main_window(tray.app_handle());
            }
        })
        .build(app)?;
    Ok(())
}

/// 前端在「直接退出」选择后调用，立即结束进程（配合关窗询问流程）。
#[tauri::command]
fn quit_app(app: tauri::AppHandle) {
    app.exit(0);
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .setup(|app| {
            // task 06-16 组A：插件持久化目录存储（plugins_root 配置 + 目录定位 + 状态扫描）。
            // 组B 的 start_plugin/stop_plugin 经此 State 的 ensure_plugin_dir 解析插件目录，
            // scan_plugin_status 据此扫文件系统判 ready/incomplete/error + 合并组B 内存进程表判 running。
            // 配置落 app_data_dir/plugins/.lingfang/config.json（原子写），默认 plugins_root = app_data_dir/plugins。
            let plugin_store = plugin_store::PluginStore::new(
                &app.path().app_data_dir().map_err(|e| e.to_string())?,
            )?;
            let plugin_package_manager =
                plugin_package_manager::PluginPackageManager::new(&plugin_store)?;
            match plugin_package_manager.migrate_legacy_layout() {
                Ok((migrated, failed)) => {
                    eprintln!("[plugin-v4-migration] migrated={migrated} failed={failed}")
                }
                Err(error) => {
                    eprintln!("[plugin-v4-migration] 启动迁移失败（保留旧目录）：{error}")
                }
            }
            match plugin_package_manager.register_builtins(
                builtin_plugin_bundle::INDEX_JSON,
                builtin_plugin_bundle::ARTIFACTS,
            ) {
                Ok(count) => eprintln!("[plugin-v4-builtins] registered={count}"),
                Err(error) => eprintln!("[plugin-v4-builtins] 注册失败：{error}"),
            }
            let registry = CapabilityRegistry::default();
            let builtin_installations = plugin_package_manager
                .list_installations()
                .into_iter()
                .filter(|installation| {
                    installation.origin == plugin_package_manager::InstallationOrigin::Builtin
                })
                .collect::<Vec<_>>();
            // release 目录 → installationId 别名：内置插件双 key 注册（manifest id + 安装 id）。
            let dir_aliases = builtin_installations
                .iter()
                .map(|installation| {
                    (
                        std::path::PathBuf::from(&installation.active_release.path),
                        installation.installation_id.clone(),
                    )
                })
                .collect::<std::collections::HashMap<_, _>>();
            let builtin_release_dirs = builtin_installations
                .into_iter()
                .map(|installation| std::path::PathBuf::from(installation.active_release.path))
                .collect();
            let loaded = plugins::load_builtin_plugins_from_dirs(builtin_release_dirs, &dir_aliases, &registry);
            eprintln!("已从本机安装账本加载 {} 个内置插件", loaded.len());

            // 启动还原开发态安装（origin = Dev）：直接以源目录为 release.path 加载，
            // 并把其 manifest 声明能力注册进网关注册表（与 register_dev_dir 命令一致）。
            // 开发态 client 插件无进程，不在此启动进程、不加载政策源。单个损坏的安装
            // 不应阻断整条启动链路——出错仅记录日志。
            for installation in plugin_package_manager
                .list_installations()
                .into_iter()
                .filter(|installation| {
                    installation.origin
                        == plugin_package_manager::InstallationOrigin::Dev
                })
            {
                match plugin_package_manager.load_installed_plugin(&installation.installation_id) {
                    Ok(payload) => {
                        let caps = plugins::capabilities_from_manifest(&payload.manifest);
                        if !caps.is_empty() {
                            registry.register(&installation.installation_id, caps);
                        }
                    }
                    Err(error) => eprintln!(
                        "[plugin-v4-dev] 启动还原开发态安装 {} 失败，已跳过：{error}",
                        installation.installation_id
                    ),
                }
            }

            app.manage(AppState {
                registry,
                plugins: loaded,
            });
            app.manage(plugin_store);
            app.manage(plugin_package_manager);
            // task 06-16 组B：插件持久化运行引擎的内存进程表（plugin_id→Child 句柄）。
            // start_plugin/stop_plugin/get_plugin_status 经此 State spawn/take/kill 进程。
            app.manage(plugin_runner::PluginProcessTable::new());
            // task 06-26：Node/Python 插件通过 localhost 一次性 token 调平台 LLM；
            // 桥持有后端地址与登录态，插件进程不直接接触 JWT/API Key。
            app.manage(plugin_llm_bridge::PluginLlmBridge::new());
            // 项 11：系统托盘（显示窗口 / 退出菜单 + 左键单击恢复）。
            setup_tray(app)?;
            Ok(())
        })
        // 项 11：关窗拦截——prevent_close + emit close-requested，由前端按偏好决定（托盘/退出/询问）。
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                if window.label() == "main" {
                    api.prevent_close();
                    let _ = window.emit("close-requested", ());
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            quit_app,
            list_plugins,
            toggle_devtools,
            start_builtin_plugin,
            read_plugin_file,
            invoke_capability,
            plugin_net_fetch,
            plugin_script::probe_script_runtime,
            plugin_script::run_plugin_script,
            plugin_llm_bridge::revoke_all_plugin_bridge_sessions,
            plugin_llm_bridge::respond_plugin_action_bridge,
            plugin_shell::run_plugin_shell,
            runtime_commands::get_runtime_status,
            plugin_runner::start_plugin,
            plugin_runner::stop_plugin,
            plugin_runner::delete_plugin,
            plugin_runner::get_plugin_status,
            plugin_store::get_plugins_root,
            plugin_store::set_plugins_root,
            plugin_store::scan_plugin_status,
            plugin_store::read_local_plugin_file,
            plugin_store::read_local_plugin_file_bytes,
            plugin_store::write_plugin_files,
            plugin_store::write_plugin_file_bytes,
            plugin_store::list_plugin_files,
            plugin_store::write_plugin_file,
            plugin_store::delete_plugin_file,
            plugin_store::move_plugin_file,
            plugin_store::set_plugin_draft_flag,
            plugin_store::open_plugins_root,
            plugin_store::open_plugin_dir,
            plugin_store::rename_plugin_dir,
            plugin_store::get_relay_settings,
            plugin_store::set_relay_settings,
            client_ai_proxy::client_llm_chat,
            client_ai_proxy::client_image_generate,
            client_ai_proxy::client_image_edit,
            client_ai_proxy::client_video_generate,
            client_ai_proxy::client_audio_generate,
            client_host_caps::client_storage_kv,
            client_host_caps::client_fs_pick,
            client_host_caps::client_system_notify,
            plugin_package_manager::commands::list_plugin_installations,
            plugin_package_manager::commands::install_plugin_artifact,
            plugin_package_manager::commands::register_dev_dir,
            plugin_package_manager::commands::unregister_dev_dir,
            plugin_package_manager::commands::load_installed_plugin,
            plugin_package_manager::commands::preview_pending_installed_plugin,
            plugin_package_manager::commands::read_installed_plugin_policy_source,
            plugin_package_manager::commands::activate_pending_client_plugin,
            plugin_package_manager::commands::discard_pending_plugin_update,
            plugin_package_manager::commands::rollback_plugin_installation,
            plugin_package_manager::commands::uninstall_plugin_installation,
            plugin_package_manager::commands::start_installed_plugin,
            plugin_package_manager::commands::stop_installed_plugin,
            plugin_package_manager::commands::list_draft_workspaces,
            plugin_package_manager::commands::read_draft_workspace_files,
            plugin_package_manager::commands::create_draft_workspace,
            plugin_package_manager::commands::import_draft_workspace,
            plugin_package_manager::commands::copy_installation_to_draft_workspace,
            plugin_package_manager::commands::pack_draft_workspace,
            plugin_package_manager::commands::mark_draft_workspace_published,
            plugin_package_manager::commands::delete_draft_workspace,
            plugin_package_manager::commands::sync_draft_workspace_metadata,
            plugin_package_manager::commands::inspect_lfplugin_v4,
            plugin_package_manager::commands::sha256_lfplugin,
            plugin_package_manager::network::install_plugin_from_url,
            plugin_security::verify_plugin_signature_command,
            plugin_security::check_plugin_recall_command,
            update::get_app_version,
            update::check_update,
            update::download_update,
            update::apply_update
        ])
        .run(tauri::generate_context!())
        .expect("启动 LingFang 桌面壳失败");
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};

    // ── extract_host：纯字符串解析，按 "://" 切分，不看 scheme ──
    #[test]
    fn extract_host_strips_scheme_path_query() {
        assert_eq!(extract_host("https://example.com/path?x=1"), Some("example.com".to_string()));
        assert_eq!(extract_host("http://127.0.0.1:8787/x"), Some("127.0.0.1".to_string()));
        assert_eq!(extract_host("ftp://127.0.0.1"), Some("127.0.0.1".to_string()));
    }

    #[test]
    fn extract_host_keeps_ipv6_brackets() {
        assert_eq!(extract_host("http://[2001:db8::1]:8080/foo"), Some("[2001:db8::1]".to_string()));
    }

    #[test]
    fn extract_host_returns_none_without_scheme() {
        assert_eq!(extract_host("no-scheme-host"), None);
        assert_eq!(extract_host(""), None);
    }

    // ── is_blocked_ip：直接构造 IpAddr（确定性，无 DNS） ──
    #[test]
    fn is_blocked_ip_v4_reserved_ranges() {
        let blocked = [
            IpAddr::V4(Ipv4Addr::new(127, 0, 0, 1)),  // loopback
            IpAddr::V4(Ipv4Addr::new(10, 0, 0, 1)),   // private
            IpAddr::V4(Ipv4Addr::new(192, 168, 1, 1)), // private
            IpAddr::V4(Ipv4Addr::new(172, 16, 5, 5)),  // private (16-31)
            IpAddr::V4(Ipv4Addr::new(169, 254, 1, 1)), // link-local (cloud metadata)
            IpAddr::V4(Ipv4Addr::new(0, 0, 0, 0)),     // unspecified
        ];
        for ip in blocked {
            assert!(is_blocked_ip(ip), "{ip} 应被 SSRF 拦截");
        }
    }

    #[test]
    fn is_blocked_ip_v4_public_allowed() {
        let allowed = [
            IpAddr::V4(Ipv4Addr::new(8, 8, 8, 8)),
            IpAddr::V4(Ipv4Addr::new(1, 1, 1, 1)),
        ];
        for ip in allowed {
            assert!(!is_blocked_ip(ip), "{ip} 为公网地址，不应被拦截");
        }
    }

    #[test]
    fn is_blocked_ip_v6_reserved_ranges() {
        let blocked = [
            IpAddr::V6(Ipv6Addr::new(0, 0, 0, 0, 0, 0, 0, 1)),        // loopback ::1
            IpAddr::V6(Ipv6Addr::new(0xfd00, 0, 0, 0, 0, 0, 0, 1)),  // unique-local
            IpAddr::V6(Ipv6Addr::new(0xfe80, 0, 0, 0, 0, 0, 0, 1)),  // link-local
            IpAddr::V6(Ipv6Addr::UNSPECIFIED),                         // ::
        ];
        for ip in blocked {
            assert!(is_blocked_ip(ip), "{ip} 应被 SSRF 拦截");
        }
    }

    #[test]
    fn is_blocked_ip_v6_public_allowed() {
        let allowed = [IpAddr::V6(Ipv6Addr::new(0x2606, 0x4700, 0x4700, 0, 0, 0, 0, 0x1111))];
        for ip in allowed {
            assert!(!is_blocked_ip(ip), "{ip} 为公网地址，不应被拦截");
        }
    }

    // ── is_blocked_host：确定性字面量（127.0.0.1 / ::1 / localhost / [::1]） ──
    #[test]
    fn is_blocked_host_loopback_and_private() {
        for h in [
            "localhost",
            "127.0.0.1",
            "::1",
            "192.168.0.5",
            "10.0.0.1",
            "[::1]",
        ] {
            assert!(is_blocked_host(h), "{h} 应被 SSRF 拦截");
        }
    }

    #[test]
    fn is_blocked_host_public_domain_literal_allowed() {
        // 字面公网地址确定性允许；真实域名解析走 fail-closed 由集成覆盖。
        assert!(!is_blocked_host("8.8.8.8"));
    }

    // ── LF-19：真实域名 DNS fail-closed 稳定化——可控 resolver 注入（不触真实 DNS） ──
    /// 公网域名 → 解析出公网地址 → 放行。
    #[test]
    fn is_blocked_host_with_public_domain_allowed() {
        let resolve = |_: &str| Ok(vec![IpAddr::V4(Ipv4Addr::new(1, 1, 1, 1))]);
        assert!(!is_blocked_host_with("example.com", resolve));
    }

    /// 多地址解析中只要**有一个**内网地址即拦截（DNS rebinding 防御：
    /// 连接可能落在任一解析地址上，含内网的那个）。
    #[test]
    fn is_blocked_host_with_mixed_addrs_blocked() {
        let resolve = |_: &str| {
            Ok(vec![
                IpAddr::V4(Ipv4Addr::new(10, 0, 0, 1)),
                IpAddr::V4(Ipv4Addr::new(93, 184, 216, 34)),
            ])
        };
        assert!(
            is_blocked_host_with("mixed.example", resolve),
            "域名解析出内网地址（哪怕混有公网）必须拦截"
        );
    }

    /// 域名解析出内网地址 → 拦截（DNS rebinding 的典型形态）。
    #[test]
    fn is_blocked_host_with_domain_to_private_blocked() {
        let resolve = |_: &str| Ok(vec![IpAddr::V4(Ipv4Addr::new(192, 168, 1, 1))]);
        assert!(is_blocked_host_with("evil.example", resolve));
        let resolve = |_: &str| Ok(vec![IpAddr::V6(Ipv6Addr::new(0xfd00, 0, 0, 0, 0, 0, 0, 1))]);
        assert!(is_blocked_host_with("v6-ula.example", resolve));
    }

    /// **fail-closed**：真实域名解析失败（NXDOMAIN / 无网络 / 解析器故障）一律拦截。
    #[test]
    fn is_blocked_host_with_dns_failure_fail_closed() {
        let resolve = |_: &str| Err(());
        assert!(is_blocked_host_with("nonexistent.invalid", resolve));
        assert!(is_blocked_host_with("dns-down.example", resolve));
    }

    /// 真机 DNS 的 fail-closed 实证：RFC 2606 保留域 `.invalid` 永不解析，
    /// 无论网络通断（NXDOMAIN）或解析器故障（超时/失败）都必然被拦截。
    /// 这是「真实域名」路径（走 ToSocketAddrs）而非注入 resolver 的纯逻辑证明。
    #[test]
    fn is_blocked_host_real_invalid_domain_fail_closed() {
        assert!(
            is_blocked_host("nonexistent-host.invalid"),
            ".invalid 保留域必须 fail-closed 拦截"
        );
    }
}
