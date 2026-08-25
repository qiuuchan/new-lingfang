//! client 插件的本地宿主能力落点（storage.kv / fs.pick / system.notify）。
//!
//! 与 client_ai_proxy 同一模式：client HTML iframe 不直接触达系统能力，
//! 由宿主侧 Tauri 命令代理——命令先校验 manifest 声明（registry.find），再执行。
//! 网关 capability.rs 保持同步纯分派；需要异步/系统对话框的 kind 走独立 async 命令
//! （与 net.fetch → plugin_net_fetch 的既有分工一致）。
//!
//! 未落地的 plugin.upload / plugin.submitMarketplace 仍走网关 NotSupported：
//! 两者是平台市场审核流交互，需平台凭据与流程，桌面壳不越权伪造。

use std::collections::BTreeMap;
use std::path::PathBuf;

use serde_json::{json, Map, Value};
use tauri::{AppHandle, State};
use tauri_plugin_dialog::DialogExt;

use crate::plugin_package_manager::PluginPackageManager;
use crate::AppState;

const ERR_CAPABILITY_NOT_DECLARED: &str = "capability_not_declared:";

fn require_capability(
    app_state: &AppState,
    plugin_id: &str,
    kind: &str,
) -> Result<(), String> {
    if app_state.registry.find(plugin_id, kind).is_none() {
        return Err(format!("{ERR_CAPABILITY_NOT_DECLARED}{kind}"));
    }
    Ok(())
}

// ---------- storage.kv ----------

/// 单值序列化上限：防单 key 塞入超大 payload 拖垮整个 kv.json 读放大。
const KV_MAX_VALUE_BYTES: usize = 256 * 1024;
/// 单插件条目数上限。
const KV_MAX_ENTRIES: usize = 1024;
/// key 长度上限。
const KV_MAX_KEY_LEN: usize = 256;
/// kv.json 整文件大小上限（读回防御）。
const KV_MAX_FILE_BYTES: u64 = 8 * 1024 * 1024;

fn err_kv(msg: impl Into<String>) -> String {
    format!("kv_error:{}", msg.into())
}

/// LF-05 / g2-sdk-friction #5：配额类错误用独立可识别前缀（kv_value_too_large /
/// kv_quota_exceeded），宿主 normalizeCapabilityError 与文档据此给稳定 code，
/// 插件才能可靠地提示「已达上限」而非静默降级掩盖真实错误。
fn err_kv_code(code: &str, msg: impl Into<String>) -> String {
    format!("{code}:{}", msg.into())
}

/// 从安装账本解析插件数据目录（installationId → dataPath）。内置与安装插件同表。
fn resolve_data_dir(manager: &PluginPackageManager, plugin_id: &str) -> Result<PathBuf, String> {
    manager
        .list_installations()
        .into_iter()
        .find(|i| i.installation_id == plugin_id)
        .map(|i| PathBuf::from(i.data_path))
        .ok_or_else(|| err_kv("无法解析插件数据目录（未知 installationId）"))
}

fn load_kv_map(data_dir: &std::path::Path) -> Result<BTreeMap<String, Value>, String> {
    let file = data_dir.join("kv.json");
    if !file.exists() {
        return Ok(BTreeMap::new());
    }
    let meta = std::fs::metadata(&file).map_err(|e| err_kv(format!("读取元数据失败:{e}")))?;
    if meta.len() > KV_MAX_FILE_BYTES {
        return Err(err_kv("存储文件超出大小上限"));
    }
    let raw = std::fs::read_to_string(&file).map_err(|e| err_kv(format!("读取失败:{e}")))?;
    if raw.trim().is_empty() {
        return Ok(BTreeMap::new());
    }
    serde_json::from_str::<Map<String, Value>>(&raw)
        .map(|m| m.into_iter().collect())
        .map_err(|e| err_kv(format!("存储文件损坏:{e}")))
}

/// 原子写：tmp + rename，避免写一半崩溃留下半截 JSON。
fn save_kv_map(data_dir: &std::path::Path, map: &BTreeMap<String, Value>) -> Result<(), String> {
    std::fs::create_dir_all(data_dir).map_err(|e| err_kv(format!("创建数据目录失败:{e}")))?;
    let file = data_dir.join("kv.json");
    let tmp = data_dir.join("kv.json.tmp");
    let body =
        serde_json::to_string_pretty(map).map_err(|e| err_kv(format!("序列化失败:{e}")))?;
    std::fs::write(&tmp, body).map_err(|e| err_kv(format!("写入失败:{e}")))?;
    std::fs::rename(&tmp, &file).map_err(|e| err_kv(format!("落盘失败:{e}")))
}

/// 纯逻辑：对 map 应用一次 op。独立成函数便于单测（无 Taurio 依赖）。
fn kv_apply(
    map: &mut BTreeMap<String, Value>,
    args: &Value,
) -> Result<Value, String> {
    let op = args
        .get("op")
        .and_then(|v| v.as_str())
        .ok_or_else(|| err_kv("缺少 op 参数"))?;
    match op {
        "get" => {
            let key = kv_key(args)?;
            Ok(map.get(key.as_str()).cloned().unwrap_or(Value::Null))
        }
        "set" => {
            let key = kv_key(args)?;
            let value = args.get("value").cloned().unwrap_or(Value::Null);
            let serialized = serde_json::to_string(&value)
                .map_err(|e| err_kv(format!("value 不可序列化:{e}")))?;
            if serialized.len() > KV_MAX_VALUE_BYTES {
                return Err(err_kv_code(
                    "kv_value_too_large",
                    format!("value 超出 {} 字节上限", KV_MAX_VALUE_BYTES),
                ));
            }
            if !map.contains_key(&key) && map.len() >= KV_MAX_ENTRIES {
                return Err(err_kv_code(
                    "kv_quota_exceeded",
                    format!("条目数超出 {} 上限", KV_MAX_ENTRIES),
                ));
            }
            map.insert(key, value);
            Ok(json!({ "ok": true }))
        }
        other => Err(err_kv(format!("不支持的 op: {other}"))),
    }
}

fn kv_key(args: &Value) -> Result<String, String> {
    let key = args
        .get("key")
        .and_then(|v| v.as_str())
        .ok_or_else(|| err_kv("缺少 key 参数"))?;
    if key.is_empty() || key.len() > KV_MAX_KEY_LEN {
        return Err(err_kv("key 长度非法"));
    }
    Ok(key.to_string())
}

/// storage.kv 宿主代理：按插件隔离持久化到 <data>/kv.json。
#[tauri::command]
pub fn client_storage_kv(
    app_state: State<'_, AppState>,
    manager: State<'_, PluginPackageManager>,
    plugin_id: String,
    args: Value,
) -> Result<Value, String> {
    require_capability(&app_state, &plugin_id, "storage.kv")?;
    let data_dir = resolve_data_dir(&manager, &plugin_id)?;
    let mut map = load_kv_map(&data_dir)?;
    let out = kv_apply(&mut map, &args)?;
    if args.get("op").and_then(|v| v.as_str()) == Some("set") {
        save_kv_map(&data_dir, &map)?;
    }
    Ok(out)
}

// ---------- fs.pick ----------

/// fs.pick 宿主代理：原生文件选择器（tauri-plugin-dialog 已注册）。
///
/// accept 为扩展名数组（如 ["png","jpg"]）；缺省不过滤。返回选中路径数组（当前单选）。
/// 用户取消返回空数组（与 SDK Promise<string[]> 对齐，取消不算错误）。
#[tauri::command]
pub async fn client_fs_pick(
    app: AppHandle,
    app_state: State<'_, AppState>,
    plugin_id: String,
    args: Value,
) -> Result<Value, String> {
    require_capability(&app_state, &plugin_id, "fs.pick")?;
    let mut dialog = app.dialog().file();
    let accept: Vec<String> = args
        .get("accept")
        .and_then(|v| v.as_array())
        .map(|list| {
            list.iter()
                .filter_map(|v| v.as_str())
                .map(|s| s.trim_start_matches('*').trim_start_matches('.').to_string())
                .filter(|s| !s.is_empty())
                .collect()
    })
        .unwrap_or_default();
    if !accept.is_empty() {
        // 扩展名列表作为单一过滤器（名称用首扩展名占位，仅影响下拉展示）。
        dialog = dialog.add_filter(accept.join(", "), &accept.iter().map(|s| s.as_str()).collect::<Vec<_>>());
    }
    // blocking_pick_file 不可在主线程调用——async 命令运行于 tokio worker，
    // 再入 spawn_blocking 双保险，不阻塞 runtime。
    let picked = tauri::async_runtime::spawn_blocking(move || dialog.blocking_pick_file())
        .await
        .map_err(|e| format!("fs_pick_error:任务失败:{e}"))?;
    let path = picked
        .and_then(|p| p.into_path().ok())
        .map(|p| p.to_string_lossy().to_string());
    Ok(json!({ "paths": path.map(|p| vec![p]).unwrap_or_default() }))
}

// ---------- system.notify ----------

/// system.notify 宿主代理：系统通知（tauri-plugin-notification）。
#[tauri::command]
pub async fn client_system_notify(
    app: AppHandle,
    app_state: State<'_, AppState>,
    plugin_id: String,
    args: Value,
) -> Result<Value, String> {
    use tauri_plugin_notification::NotificationExt;
    require_capability(&app_state, &plugin_id, "system.notify")?;
    let title = args
        .get("title")
        .and_then(|v| v.as_str())
        .filter(|s| !s.trim().is_empty())
        .ok_or_else(|| "notify_error:缺少 title 参数".to_string())?
        .to_string();
    let body = args.get("body").and_then(|v| v.as_str()).unwrap_or("").to_string();
    // show() 内部为 fire-and-forget 投递；错误多为权限/后端缺失，转可读文案。
    app.notification()
        .builder()
        .title(title)
        .body(body)
        .show()
        .map_err(|e| format!("notify_error:系统通知发送失败:{e}"))?;
    Ok(json!({ "ok": true }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn set_args(key: &str, value: Value) -> Value {
        json!({ "op": "set", "key": key, "value": value })
    }

    #[test]
    fn get_missing_returns_null() {
        let mut map = BTreeMap::new();
        let out = kv_apply(&mut map, &json!({ "op": "get", "key": "nope" })).unwrap();
        assert_eq!(out, Value::Null);
    }

    #[test]
    fn set_then_get_roundtrip() {
        let mut map = BTreeMap::new();
        kv_apply(&mut map, &set_args("k", json!({ "a": [1, 2] }))).unwrap();
        let out = kv_apply(&mut map, &json!({ "op": "get", "key": "k" })).unwrap();
        assert_eq!(out, json!({ "a": [1, 2] }));
    }

    #[test]
    fn missing_params_rejected() {
        let mut map = BTreeMap::new();
        assert!(kv_apply(&mut map, &json!({ "op": "get" })).is_err());
        assert!(kv_apply(&mut map, &json!({ "op": "set", "value": 1 })).is_err());
        assert!(kv_apply(&mut map, &json!({ "op": "wipe" })).is_err());
    }

    #[test]
    fn oversize_value_rejected() {
        let mut map = BTreeMap::new();
        let big = "x".repeat(KV_MAX_VALUE_BYTES + 1);
        let err = kv_apply(&mut map, &set_args("big", json!(big))).unwrap_err();
        assert!(err.starts_with("kv_value_too_large:"), "got: {err}");
    }

    #[test]
    fn entry_cap_enforced_only_for_new_keys() {
        let mut map = BTreeMap::new();
        for i in 0..KV_MAX_ENTRIES {
            kv_apply(&mut map, &set_args(&format!("k{i}"), json!(i))).unwrap();
        }
        // 新 key 被上限拒绝（可识别配额码）。
        let err = kv_apply(&mut map, &set_args("overflow", json!(1))).unwrap_err();
        assert!(err.starts_with("kv_quota_exceeded:"), "got: {err}");
        // 覆盖已有 key 不受上限影响。
        kv_apply(&mut map, &set_args("k0", json!("updated"))).unwrap();
    }

    #[test]
    fn file_roundtrip_and_atomicity_artifacts() {
        let dir = tempfile::tempdir().unwrap();
        let mut map = BTreeMap::new();
        kv_apply(&mut map, &set_args("persist", json!("yes"))).unwrap();
        save_kv_map(dir.path(), &map).unwrap();
        let reloaded = load_kv_map(dir.path()).unwrap();
        assert_eq!(reloaded.get("persist"), Some(&json!("yes")));
        // tmp 文件已 rename 消失。
        assert!(!dir.path().join("kv.json.tmp").exists());
    }

    #[test]
    fn empty_store_file_tolerated() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("kv.json"), "").unwrap();
        let map = load_kv_map(dir.path()).unwrap();
        assert!(map.is_empty());
    }

    #[test]
    fn corrupted_store_file_rejected() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("kv.json"), "{not-json").unwrap();
        assert!(load_kv_map(dir.path()).is_err());
    }
}
