//! plugin_security.rs — 插件安全与管理（Task 14）。
//!
//! 三项能力：
//! 1. **签名校验**：verify_plugin_signature 用 minisign 非对称验签。插件目录放 manifest.sig
//!    （minisign 文本格式），与 plugins_root/.plugin-pubkey（或 env LINGFANG_PLUGIN_PUBKEY）
//!    配对的公钥验签 manifest.json。未配置公钥 / 无签名文件 → signed=false（不阻断，仅状态展示）。
//! 2. **版本召回**：PluginRecallInfo 描述某插件版本是否被召回（前端据此展示警告，禁止运行）。
//!    召回标记落在 plugins_root/.recalled.json（平台下发），格式 { "<pluginId>": "<version>" }。
//! 3. **系统级权限请求**：SystemPermissionRequest 描述插件请求的系统权限；实际授权由前端用户确认
//!    （此处提供数据结构 + Rust 侧读取请求清单，授权动作在前端 capability 网关完成）。
//!
//! 设计原则：签名/召回均为「可选增强」——未配置时降级为「未签名/未召回」状态，不阻断既有插件加载
//! 与运行（避免破坏 AI 生成插件的工作流：它们默认无签名）。

use std::fs;
use std::path::PathBuf;

use serde::Serialize;

use crate::plugin_store::PluginStore;

/// 签名校验结果（前端展示「已签名验证 / 未签名 / 签名无效」）。
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginSignatureStatus {
    /// 是否存在签名文件（manifest.sig）。
    pub signed: bool,
    /// 签名是否通过验证（signed=false 时恒为 false）。
    pub verified: bool,
    /// 说明（未配置公钥 / 无签名 / 验签失败原因 / 验证通过）。
    pub reason: String,
}

/// 通用 minisign 验签：给定 base64 公钥、签名文本（minisign .sig 文件内容）、待验消息字节，
/// 返回是否通过。供插件包与（未来的）CI 运行时产物复用同一套 minisign 原语。
pub(crate) fn verify_minisign(pubkey_b64: &str, sig_text: &str, message: &[u8]) -> bool {
    use minisign_verify::{PublicKey, Signature};
    let pubkey = match PublicKey::from_base64(pubkey_b64) {
        Ok(k) => k,
        Err(_) => return false,
    };
    let signature = match Signature::decode(sig_text) {
        Ok(s) => s,
        Err(_) => return false,
    };
    pubkey.verify(message, &signature, false).is_ok()
}

/// 读取插件签名状态：manifest.sig + manifest.json + 配置的公钥。
pub fn verify_plugin_signature(
    store: &PluginStore,
    plugin_id: &str,
) -> Result<PluginSignatureStatus, String> {
    let dir = store.plugin_dir(plugin_id)?;
    let sig_path = dir.join("manifest.sig");
    let manifest_path = dir.join("manifest.json");

    if !sig_path.exists() {
        return Ok(PluginSignatureStatus {
            signed: false,
            verified: false,
            reason: "插件未附带签名（manifest.sig 缺失）".into(),
        });
    }
    if !manifest_path.exists() {
        return Ok(PluginSignatureStatus {
            signed: true,
            verified: false,
            reason: "manifest.json 缺失，无法验签".into(),
        });
    }

    // 公钥来源：plugins_root/.plugin-pubkey（优先）或 env LINGFANG_PLUGIN_PUBKEY。
    // 未配置时返回 signed=true 但 verified=false（不阻断，提示「平台未配置验签公钥」）。
    let pubkey_str = match read_pubkey(store)? {
        Some(k) => k,
        None => {
            return Ok(PluginSignatureStatus {
                signed: true,
                verified: false,
                reason: "平台未配置插件验签公钥（.plugin-pubkey / LINGFANG_PLUGIN_PUBKEY）".into(),
            });
        }
    };

    let sig_text = fs::read_to_string(&sig_path).map_err(|e| format!("读取签名文件失败：{e}"))?;
    let message = fs::read(&manifest_path).map_err(|e| format!("读取 manifest 失败：{e}"))?;

    if verify_minisign(&pubkey_str, &sig_text, &message) {
        Ok(PluginSignatureStatus {
            signed: true,
            verified: true,
            reason: "签名验证通过".into(),
        })
    } else {
        Ok(PluginSignatureStatus {
            signed: true,
            verified: false,
            reason: "签名验证失败".into(),
        })
    }
}

/// 公钥读取：plugins_root/.plugin-pubkey（单行 base64）> env LINGFANG_PLUGIN_PUBKEY > None。
fn read_pubkey(store: &PluginStore) -> Result<Option<String>, String> {
    let path: PathBuf = store.plugins_root().join(".plugin-pubkey");
    if path.exists() {
        let raw = fs::read_to_string(&path).map_err(|e| format!("读取公钥文件失败：{e}"))?;
        let trimmed = raw.trim();
        if !trimmed.is_empty() {
            return Ok(Some(trimmed.to_string()));
        }
    }
    Ok(std::env::var("LINGFANG_PLUGIN_PUBKEY")
        .ok()
        .filter(|s| !s.is_empty()))
}

// === 版本召回 ===

/// 召回表：plugins_root/.recalled.json，{ "<pluginId>": "<被召回的版本号>" }。
/// 前端据此对已安装的对应版本展示警告并禁用运行（「版本召回」能力）。
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginRecallInfo {
    pub recalled: bool,
    /// 被召回的版本（recalled=false 时为空）。
    pub version: String,
    /// 召回原因（可选，来自 .recalled.json 的 "_reason_<id>"）。
    pub reason: String,
}

/// 查询某插件当前安装版本是否被召回。
pub fn check_plugin_recall(
    store: &PluginStore,
    plugin_id: &str,
    installed_version: &str,
) -> PluginRecallInfo {
    let path = store.plugins_root().join(".recalled.json");
    let Ok(raw) = fs::read_to_string(&path) else {
        return PluginRecallInfo {
            recalled: false,
            version: String::new(),
            reason: String::new(),
        };
    };
    let Ok(map) = serde_json::from_str::<serde_json::Value>(&raw) else {
        return PluginRecallInfo {
            recalled: false,
            version: String::new(),
            reason: String::new(),
        };
    };
    let recalled_version = map.get(plugin_id).and_then(|v| v.as_str()).unwrap_or("");
    if recalled_version.is_empty() {
        return PluginRecallInfo {
            recalled: false,
            version: String::new(),
            reason: String::new(),
        };
    }
    if recalled_version != installed_version {
        // 该插件有被召回的版本，但当前安装版本不同 → 不影响。
        return PluginRecallInfo {
            recalled: false,
            version: String::new(),
            reason: String::new(),
        };
    }
    let reason_key = format!("_reason_{plugin_id}");
    let reason = map
        .get(&reason_key)
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    PluginRecallInfo {
        recalled: true,
        version: recalled_version.to_string(),
        reason,
    }
}

// === Tauri 命令封装（供前端 invoke） ===

/// 命令：校验插件签名（Task 14）。未配置公钥/无签名时返回 signed=false，不抛错。
#[tauri::command]
pub fn verify_plugin_signature_command(
    store: tauri::State<'_, PluginStore>,
    plugin_id: String,
) -> Result<PluginSignatureStatus, String> {
    verify_plugin_signature(&store, &plugin_id)
}

/// 命令：查询插件版本是否被召回（Task 14）。installed_version 由前端从 manifest 读出后传入。
#[tauri::command]
pub fn check_plugin_recall_command(
    store: tauri::State<'_, PluginStore>,
    plugin_id: String,
    installed_version: String,
) -> Result<PluginRecallInfo, String> {
    Ok(check_plugin_recall(&store, &plugin_id, &installed_version))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::plugin_store::PluginStore;

    fn temp_store(name: &str) -> PluginStore {
        let root = std::env::temp_dir().join(format!(
            "lingfang-plugin-security-{}-{name}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&root);
        PluginStore::new(&root).unwrap()
    }

    #[test]
    fn unsigned_plugin_reports_unsigned() {
        let store = temp_store("unsigned");
        let dir = store.plugin_dir("p1").unwrap();
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("manifest.json"), r#"{"id":"p1"}"#).unwrap();
        let status = verify_plugin_signature(&store, "p1").unwrap();
        assert!(!status.signed);
        assert!(!status.verified);
        assert!(status.reason.contains("签名"));
    }

    #[test]
    fn recall_detects_matching_version() {
        let store = temp_store("recall");
        std::fs::write(
            store.plugins_root().join(".recalled.json"),
            serde_json::json!({ "vuln-plugin": "1.2.3", "_reason_vuln-plugin": "存在安全漏洞" })
                .to_string(),
        )
        .unwrap();
        // 命中：版本一致 → recalled=true。
        let hit = check_plugin_recall(&store, "vuln-plugin", "1.2.3");
        assert!(hit.recalled);
        assert_eq!(hit.version, "1.2.3");
        assert_eq!(hit.reason, "存在安全漏洞");
        // 未命中：版本不同 → recalled=false。
        let miss = check_plugin_recall(&store, "vuln-plugin", "1.2.4");
        assert!(!miss.recalled);
        // 其它插件不在表里 → recalled=false。
        let other = check_plugin_recall(&store, "other-plugin", "1.0.0");
        assert!(!other.recalled);
    }

    #[test]
    fn recall_missing_table_returns_not_recalled() {
        let store = temp_store("no-recall-table");
        // 无 .recalled.json → 全部 not recalled，不报错。
        let info = check_plugin_recall(&store, "any", "1.0.0");
        assert!(!info.recalled);
    }
}
