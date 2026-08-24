use std::collections::{HashMap, HashSet};
use std::fs::{self, File};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use base64::{engine::general_purpose, Engine as _};
use chrono::Utc;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use uuid::Uuid;

use crate::builtin_plugin_index::parse_builtin_index;
use crate::plugin_artifact_v4::{
    collect_workspace_source_files, extract_artifact, inspect_artifact, package_workspace,
    sha256_bytes, sha256_file, InspectedArtifact,
};
use crate::plugin_store::{read_json, write_json, PluginStore};

pub(crate) mod commands;
mod helpers;
pub(crate) mod network;

use helpers::*;

#[cfg(test)]
mod tests;

fn lock_or_recover<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|poison| poison.into_inner())
}

fn read_tagged_source_files(root: &Path) -> Result<Vec<DraftWorkspaceFilePayload>, String> {
    let mut payloads = Vec::new();
    for (relative, path) in collect_workspace_source_files(root)? {
        let bytes =
            fs::read(&path).map_err(|error| format!("读取插件源文件 {relative} 失败：{error}"))?;
        match String::from_utf8(bytes) {
            Ok(content) => payloads.push(DraftWorkspaceFilePayload {
                path: relative,
                content,
                binary: false,
            }),
            Err(error) => payloads.push(DraftWorkspaceFilePayload {
                path: relative,
                content: general_purpose::STANDARD.encode(error.into_bytes()),
                binary: true,
            }),
        }
    }
    Ok(payloads)
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum InstallationOrigin {
    Builtin,
    Local,
    Team,
    Marketplace,
    Dev,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum DependencyStatus {
    Pending,
    Preparing,
    Ready,
    Failed,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct InstalledRelease {
    pub release_id: String,
    pub version: String,
    pub sha256: String,
    pub path: String,
    pub dependency_status: DependencyStatus,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct LocalInstallation {
    pub installation_id: String,
    pub package_id: String,
    pub origin: InstallationOrigin,
    pub protected: bool,
    pub active_release: InstalledRelease,
    pub pending_release: Option<InstalledRelease>,
    pub previous_release: Option<InstalledRelease>,
    pub data_path: String,
    pub installed_at: String,
    pub updated_at: String,
}

/// Desktop workflow executor 向平台提交的本机安装清单。
///
/// 只投影当前 active release 的精确身份与依赖准备状态；本机目录、pending/previous
/// release、共享 data 路径和安装来源都不跨出 native 边界。
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) struct WorkflowExecutorInventoryItem {
    pub installation_id: String,
    pub package_id: String,
    pub release_id: String,
    pub sha256: String,
    pub dependency_status: DependencyStatus,
}

#[derive(Clone, Debug)]
pub(crate) struct InstalledActionBinding {
    pub runtime: String,
    pub release_path: PathBuf,
    pub entry: String,
    pub callable: String,
    pub timeout_seconds: u64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) struct InstalledClientActionHandler {
    pub source: String,
    pub export_name: String,
    pub manifest: Value,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct InstallationLedger {
    #[serde(default = "schema_version")]
    schema_version: u32,
    #[serde(default)]
    installations: Vec<LocalInstallation>,
}

fn schema_version() -> u32 {
    1
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum DraftDiagnosticStatus {
    Idle,
    Checking,
    Ready,
    Warning,
    Error,
}

#[derive(Clone, Copy, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub(crate) enum PluginReleaseSourceKind {
    LingfangCreator,
    ExternalTool,
    LocalArtifact,
    CopiedInstallation,
    Api,
    LegacyMigration,
    #[default]
    Unknown,
}

impl PluginReleaseSourceKind {
    pub(crate) fn as_header_value(self) -> &'static str {
        match self {
            Self::LingfangCreator => "LINGFANG_CREATOR",
            Self::ExternalTool => "EXTERNAL_TOOL",
            Self::LocalArtifact => "LOCAL_ARTIFACT",
            Self::CopiedInstallation => "COPIED_INSTALLATION",
            Self::Api => "API",
            Self::LegacyMigration => "LEGACY_MIGRATION",
            Self::Unknown => "UNKNOWN",
        }
    }

    fn default_label(self) -> &'static str {
        match self {
            Self::LingfangCreator => "灵枋创建器",
            Self::ExternalTool => "外部开发工具",
            Self::LocalArtifact => "本地 .lfplugin 制品",
            Self::CopiedInstallation => "已安装插件副本",
            Self::Api => "API",
            Self::LegacyMigration => "旧版迁移",
            Self::Unknown => "来源未知",
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct ReleaseProvenance {
    pub source_kind: PluginReleaseSourceKind,
    pub source_label: String,
}

fn source_label_contains_absolute_path(value: &str) -> bool {
    let lower = value.to_ascii_lowercase();
    if lower.contains("file://") || value.contains("\\\\") {
        return true;
    }
    let chars: Vec<char> = value.chars().collect();
    for index in 0..chars.len() {
        let previous_is_boundary = index == 0
            || chars[index - 1].is_whitespace()
            || matches!(chars[index - 1], '(' | '[' | '{' | '"' | '\'' | '=' | ':');
        if chars[index] == '~'
            && previous_is_boundary
            && chars
                .get(index + 1)
                .is_some_and(|next| matches!(next, '/' | '\\'))
        {
            return true;
        }
        if chars[index].is_ascii_alphabetic()
            && previous_is_boundary
            && chars.get(index + 1) == Some(&':')
            && chars
                .get(index + 2)
                .is_some_and(|next| matches!(next, '/' | '\\'))
        {
            return true;
        }
        if chars[index] == '/'
            && previous_is_boundary
            && chars
                .get(index + 1)
                .is_some_and(|next| !next.is_whitespace() && *next != '/')
        {
            return true;
        }
    }
    false
}

pub(crate) fn normalize_release_provenance(
    source_kind: PluginReleaseSourceKind,
    source_label: Option<&str>,
) -> Result<ReleaseProvenance, String> {
    let candidate = source_label.unwrap_or_default().trim();
    let candidate = if candidate.is_empty() || source_label_contains_absolute_path(candidate) {
        source_kind.default_label()
    } else {
        candidate
    };
    if candidate.chars().any(char::is_control) {
        return Err("插件来源标签不能包含控制字符".to_string());
    }
    if candidate.chars().count() > 80 {
        return Err("插件来源标签不能超过 80 个字符".to_string());
    }
    Ok(ReleaseProvenance {
        source_kind,
        source_label: candidate.to_string(),
    })
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DraftWorkspace {
    pub workspace_id: String,
    pub title: String,
    pub path: String,
    pub manifest_id: String,
    pub current_version: String,
    pub runtime: String,
    #[serde(default)]
    pub source_kind: PluginReleaseSourceKind,
    #[serde(default)]
    pub source_label: String,
    pub conversation_id: Option<String>,
    pub diagnostic_status: DraftDiagnosticStatus,
    pub content_sha256: Option<String>,
    pub last_published_release_id: Option<String>,
    pub last_published_version: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct WorkspaceLedger {
    #[serde(default = "schema_version")]
    schema_version: u32,
    #[serde(default)]
    workspaces: Vec<DraftWorkspace>,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct LegacyMigrationJournal {
    #[serde(default = "schema_version")]
    schema_version: u32,
    #[serde(default)]
    completed_directories: Vec<String>,
    #[serde(default)]
    failures: Vec<LegacyMigrationFailure>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct LegacyMigrationFailure {
    directory: String,
    error: String,
    at: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct LocalPluginAuditEvent {
    action: String,
    target_id: String,
    detail: Value,
    at: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct InstallArtifactInput {
    pub artifact_path: String,
    pub expected_sha256: Option<String>,
    pub package_id: Option<String>,
    pub release_id: Option<String>,
    pub origin: InstallationOrigin,
    #[serde(default)]
    pub protected: bool,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RegisterDevDirInput {
    pub dir: PathBuf,
    #[serde(default)]
    pub package_id: Option<String>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CreateWorkspaceInput {
    pub title: String,
    pub manifest_id: String,
    pub version: String,
    pub runtime: String,
    pub conversation_id: Option<String>,
    #[serde(default)]
    pub source_kind: Option<PluginReleaseSourceKind>,
    #[serde(default)]
    pub source_label: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PackWorkspaceResult {
    pub artifact_path: String,
    pub artifact: InspectedArtifact,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct InstalledPluginPayload {
    pub installation: LocalInstallation,
    pub manifest: Value,
    pub entry_content: String,
    pub readme_markdown: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DownloadReleaseInput {
    pub api_base: String,
    pub auth_token: String,
    pub package_id: String,
    pub release_id: String,
    pub sha256: String,
    pub origin: InstallationOrigin,
}

/// 仓库即市场：从外部 URL 直接下载 .lfplugin v4 制品并安装。
/// 零服务器架构——不经过任何平台后端，URL 指向 GitHub Release 资产等公开地址。
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct InstallFromUrlInput {
    pub url: String,
    pub sha256: Option<String>,
    pub package_id: Option<String>,
    pub origin: InstallationOrigin,
    #[serde(default)]
    pub protected: bool,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PublishWorkspaceInput {
    pub api_base: String,
    pub auth_token: String,
    pub workspace_id: String,
    pub package_id: Option<String>,
    #[serde(default)]
    pub source_kind: Option<PluginReleaseSourceKind>,
    #[serde(default)]
    pub source_label: Option<String>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PublishLocalArtifactInput {
    pub api_base: String,
    pub auth_token: String,
    pub artifact_path: String,
    pub package_id: Option<String>,
    #[serde(default)]
    pub source_kind: Option<PluginReleaseSourceKind>,
    #[serde(default)]
    pub source_label: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DraftWorkspaceFilePayload {
    pub path: String,
    pub content: String,
    pub binary: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct InstalledPluginPolicySource {
    pub manifest: Value,
    pub files: Vec<DraftWorkspaceFilePayload>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(tag = "event", content = "data")]
pub(crate) enum PackageTransferEvent {
    #[serde(rename_all = "camelCase")]
    Stage { stage: String, message: String },
    #[serde(rename_all = "camelCase")]
    Started { total_bytes: Option<u64> },
    #[serde(rename_all = "camelCase")]
    Progress { chunk_length: usize },
    #[serde(rename_all = "camelCase")]
    Finished,
}

#[derive(Clone, Debug)]
pub(crate) struct PluginPackageManager {
    anchor_meta: PathBuf,
    plugins_root: PathBuf,
    file_lock: Arc<Mutex<()>>,
}

impl PluginPackageManager {
    pub(crate) fn new(store: &PluginStore) -> Result<Self, String> {
        let manager = Self {
            anchor_meta: store.metadata_root(),
            plugins_root: store.plugins_root(),
            file_lock: Arc::new(Mutex::new(())),
        };
        for directory in [
            manager.installed_root(),
            manager.cache_root(),
            manager.workspaces_root(),
            manager.staging_root(),
        ] {
            fs::create_dir_all(directory)
                .map_err(|error| format!("创建插件包目录失败：{error}"))?;
        }
        if !manager.installations_path().exists() {
            write_json(
                &manager.installations_path(),
                &InstallationLedger {
                    schema_version: 1,
                    installations: vec![],
                },
            )?;
        }
        if !manager.workspaces_path().exists() {
            write_json(
                &manager.workspaces_path(),
                &WorkspaceLedger {
                    schema_version: 1,
                    workspaces: vec![],
                },
            )?;
        }
        Ok(manager)
    }

    fn installations_path(&self) -> PathBuf {
        self.anchor_meta.join("installations-v1.json")
    }

    fn workspaces_path(&self) -> PathBuf {
        self.anchor_meta.join("workspaces-v1.json")
    }

    fn migration_journal_path(&self) -> PathBuf {
        self.anchor_meta.join("plugin-layout-migration-v1.json")
    }

    fn audit_path(&self) -> PathBuf {
        self.anchor_meta.join("plugin-audit-v1.json")
    }

    fn audit(&self, action: &str, target_id: &str, detail: Value) {
        let mut events: Vec<LocalPluginAuditEvent> =
            read_json(&self.audit_path()).unwrap_or_default();
        events.push(LocalPluginAuditEvent {
            action: action.to_string(),
            target_id: target_id.to_string(),
            detail,
            at: Utc::now().to_rfc3339(),
        });
        if events.len() > 2_000 {
            events.drain(..events.len() - 2_000);
        }
        let _ = write_json(&self.audit_path(), &events);
    }

    fn installed_root(&self) -> PathBuf {
        self.plugins_root.join("installed")
    }

    fn cache_root(&self) -> PathBuf {
        self.plugins_root.join("cache")
    }

    fn workspaces_root(&self) -> PathBuf {
        self.plugins_root.join("workspaces")
    }

    fn staging_root(&self) -> PathBuf {
        self.plugins_root.join(".lingfang-staging")
    }

    fn read_installations(&self) -> InstallationLedger {
        read_json(&self.installations_path()).unwrap_or_else(|| InstallationLedger {
            schema_version: 1,
            installations: vec![],
        })
    }

    fn write_installations(&self, ledger: &InstallationLedger) -> Result<(), String> {
        write_json(&self.installations_path(), ledger)
    }

    fn read_workspaces(&self) -> WorkspaceLedger {
        read_json(&self.workspaces_path()).unwrap_or_else(|| WorkspaceLedger {
            schema_version: 1,
            workspaces: vec![],
        })
    }

    fn write_workspaces(&self, ledger: &WorkspaceLedger) -> Result<(), String> {
        write_json(&self.workspaces_path(), ledger)
    }

    pub(crate) fn list_installations(&self) -> Vec<LocalInstallation> {
        self.read_installations().installations
    }

    pub(crate) fn executor_inventory(
        &self,
    ) -> Result<Vec<WorkflowExecutorInventoryItem>, String> {
        let mut installation_ids = HashSet::new();
        let mut package_ids = HashSet::new();
        let mut inventory = Vec::new();
        for installation in self.read_installations().installations {
            // Published workflow plans can only target releases known to the v4 registry.
            // Builtin/local artifacts deliberately stay outside the attested executor inventory;
            // including their synthetic IDs would make the server reject the whole session.
            if !matches!(
                installation.origin,
                InstallationOrigin::Team | InstallationOrigin::Marketplace
            ) {
                continue;
            }
            if !installation_ids.insert(installation.installation_id.clone()) {
                return Err("本机安装账本包含重复 installationId".to_string());
            }
            if !package_ids.insert(installation.package_id.clone()) {
                return Err("本机安装账本包含重复 packageId".to_string());
            }
            let active = installation.active_release;
            if installation.installation_id.trim().is_empty()
                || installation.package_id.trim().is_empty()
                || active.release_id.trim().is_empty()
                || active.sha256.len() != 64
                || !active
                    .sha256
                    .bytes()
                    .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
            {
                return Err("本机 active release 清单包含无效精确身份".to_string());
            }
            inventory.push(WorkflowExecutorInventoryItem {
                installation_id: installation.installation_id,
                package_id: installation.package_id,
                release_id: active.release_id,
                sha256: active.sha256,
                dependency_status: active.dependency_status,
            });
        }
        inventory.sort_by(|left, right| left.installation_id.cmp(&right.installation_id));
        Ok(inventory)
    }

    pub(crate) fn resolve_action_binding(
        &self,
        package_id: &str,
        release_id: &str,
        sha256: &str,
        action_id: &str,
        contract_version: &str,
    ) -> Result<InstalledActionBinding, String> {
        let installation = self.read_installations().installations.into_iter().find(|item| item.package_id == package_id).ok_or_else(|| "工作流目标插件未安装".to_string())?;
        let release = installation.active_release;
        if release.release_id != release_id || release.sha256 != sha256 {
            return Err("工作流目标与本机 active release 不一致".to_string());
        }
        if release.dependency_status != DependencyStatus::Ready {
            return Err("工作流目标插件依赖尚未就绪".to_string());
        }
        let root = PathBuf::from(&release.path);
        let manifest: Value = read_json(&root.join("manifest.json")).ok_or_else(|| "工作流目标 manifest 无法读取".to_string())?;
        let runtime = manifest.get("runtime_type").and_then(Value::as_str).unwrap_or_default();
        if !matches!(runtime, "nodejs" | "python") { return Err("当前本地 Action 仅支持 Node.js/Python".to_string()); }
        let action = manifest.get("actions").and_then(Value::as_array).and_then(|items| items.iter().find(|item| item.get("action_id").and_then(Value::as_str) == Some(action_id))).ok_or_else(|| "本机发行版未声明该 Action".to_string())?;
        if action.get("action_contract_version").and_then(Value::as_str) != Some(contract_version) { return Err("本机 Action contract version 不匹配".to_string()); }
        let handler = action.get("handler").and_then(Value::as_object).ok_or_else(|| "本机 Action 缺少 handler".to_string())?;
        let entry = handler.get("entry").and_then(Value::as_str).ok_or_else(|| "本机 Action handler.entry 无效".to_string())?.to_string();
        let callable = handler.get(if runtime == "python" { "callable" } else { "export" }).and_then(Value::as_str).ok_or_else(|| "本机 Action handler 导出无效".to_string())?.to_string();
        let entry_path = root.join(&entry).canonicalize().map_err(|error| format!("本机 Action handler 不可用：{error}"))?;
        let canonical_root = root.canonicalize().map_err(|error| format!("本机发行版目录不可用：{error}"))?;
        if !entry_path.starts_with(&canonical_root) || !entry_path.is_file() { return Err("本机 Action handler 越出发行版目录".to_string()); }
        Ok(InstalledActionBinding { runtime: runtime.to_string(), release_path: canonical_root, entry, callable, timeout_seconds: action.get("timeout_seconds").and_then(Value::as_u64).unwrap_or(900).min(24 * 60 * 60) })
    }

    pub(crate) fn resolve_client_action_handler(
        &self,
        package_id: &str,
        release_id: &str,
        sha256: &str,
        action_id: &str,
        contract_version: &str,
    ) -> Result<InstalledClientActionHandler, String> {
        let installation = self
            .read_installations()
            .installations
            .into_iter()
            .find(|item| item.package_id == package_id)
            .ok_or_else(|| "Client Action 目标插件未安装".to_string())?;
        let release = installation.active_release;
        if release.release_id != release_id || release.sha256 != sha256 {
            return Err("Client Action 目标与本机 active release 不一致".to_string());
        }
        if release.dependency_status != DependencyStatus::Ready {
            return Err("Client Action 目标插件依赖尚未就绪".to_string());
        }
        let root = PathBuf::from(&release.path);
        let manifest: Value = read_json(&root.join("manifest.json"))
            .ok_or_else(|| "Client Action manifest 无法读取".to_string())?;
        if manifest.get("runtime_type").and_then(Value::as_str) != Some("client") {
            return Err("目标不是 client runtime".to_string());
        }
        let action = manifest
            .get("actions")
            .and_then(Value::as_array)
            .and_then(|items| {
                items.iter().find(|item| {
                    item.get("action_id").and_then(Value::as_str) == Some(action_id)
                })
            })
            .ok_or_else(|| "本机发行版未声明该 Client Action".to_string())?;
        if action
            .get("action_contract_version")
            .and_then(Value::as_str)
            != Some(contract_version)
        {
            return Err("本机 Client Action contract version 不匹配".to_string());
        }
        let handler = action
            .get("handler")
            .and_then(Value::as_object)
            .ok_or_else(|| "本机 Client Action 缺少 handler".to_string())?;
        let entry = handler
            .get("entry")
            .and_then(Value::as_str)
            .ok_or_else(|| "本机 Client Action handler.entry 无效".to_string())?;
        let export_name = handler
            .get("export")
            .and_then(Value::as_str)
            .ok_or_else(|| "本机 Client Action handler.export 无效".to_string())?
            .to_string();
        let canonical_root = root
            .canonicalize()
            .map_err(|error| format!("本机发行版目录不可用：{error}"))?;
        let entry_path = root
            .join(entry)
            .canonicalize()
            .map_err(|error| format!("本机 Client Action handler 不可用：{error}"))?;
        if !entry_path.starts_with(&canonical_root) || !entry_path.is_file() {
            return Err("本机 Client Action handler 越出发行版目录".to_string());
        }
        let bytes = fs::read(&entry_path)
            .map_err(|error| format!("读取本机 Client Action handler 失败：{error}"))?;
        if bytes.len() > 256 * 1024 {
            return Err("Client Action handler 超过 256 KiB".to_string());
        }
        let source = String::from_utf8(bytes)
            .map_err(|_| "Client Action handler 必须是 UTF-8".to_string())?;
        Ok(InstalledClientActionHandler {
            source,
            export_name,
            manifest,
        })
    }

    pub(crate) fn action_caller_descriptor(&self, package_id: &str, release_id: &str, sha256: &str) -> Result<Value, String> {
        let installation = self.read_installations().installations.into_iter().find(|item| item.package_id == package_id).ok_or_else(|| "Action 调用方插件未安装".to_string())?;
        if installation.active_release.release_id != release_id || installation.active_release.sha256 != sha256 || installation.active_release.dependency_status != DependencyStatus::Ready { return Err("Action 调用方与本机 active release 不一致".to_string()); }
        let manifest: Value = read_json(&PathBuf::from(&installation.active_release.path).join("manifest.json")).ok_or_else(|| "Action 调用方 manifest 无法读取".to_string())?;
        Ok(serde_json::json!({
            "id": installation.installation_id,
            "installation_id": installation.installation_id,
            "package_id": installation.package_id,
            "release_id": installation.active_release.release_id,
            "release_sha256": installation.active_release.sha256,
            "installation_origin": match installation.origin { InstallationOrigin::Builtin => "builtin", InstallationOrigin::Local => "local", InstallationOrigin::Team => "team", InstallationOrigin::Marketplace => "marketplace", InstallationOrigin::Dev => "dev" },
            "name": manifest.get("name").and_then(Value::as_str).unwrap_or("Action Plugin"),
            "description": manifest.get("description").and_then(Value::as_str).unwrap_or(""),
            "version": manifest.get("version").and_then(Value::as_str).unwrap_or("0.0.0"),
            "entry": manifest.get("entry").and_then(Value::as_str).unwrap_or(""),
            "runtime_type": manifest.get("runtime_type").and_then(Value::as_str).unwrap_or("client"),
            "source": "installed",
            "manifest": manifest,
        }))
    }

    pub(crate) fn register_builtins(
        &self,
        index_json: &str,
        artifacts: &[(&str, &[u8])],
    ) -> Result<usize, String> {
        let index = parse_builtin_index(index_json)?;
        let mut bundled = HashMap::with_capacity(artifacts.len());
        for &(file_name, bytes) in artifacts {
            if bundled.insert(file_name, bytes).is_some() {
                return Err(format!("内置插件包包含重复制品：{file_name}"));
            }
        }
        if bundled.len() != index.artifacts.len() {
            return Err("内置插件索引与随包制品数量不一致".to_string());
        }
        for artifact in &index.artifacts {
            let bytes = bundled
                .get(artifact.artifact_file.as_str())
                .ok_or_else(|| format!("内置插件制品缺失：{}", artifact.artifact_file))?;
            if bytes.len() as u64 != artifact.size_bytes {
                return Err(format!(
                    "内置插件制品大小与索引不一致：{}",
                    artifact.manifest_id
                ));
            }
            let actual_sha256 = sha256_bytes(bytes);
            if actual_sha256 != artifact.sha256 {
                return Err(format!(
                    "内置插件制品 SHA-256 与索引不一致：{}",
                    artifact.manifest_id
                ));
            }
        }

        let existing: HashMap<String, LocalInstallation> = self
            .list_installations()
            .into_iter()
            .map(|installation| (installation.package_id.clone(), installation))
            .collect();
        let mut registered = 0;
        for artifact in index.artifacts {
            if let Some(installation) = existing.get(&artifact.package_id) {
                if installation.origin != InstallationOrigin::Builtin || !installation.protected {
                    return Err(format!(
                        "内置插件包 ID 已被非受保护安装占用：{}",
                        artifact.package_id
                    ));
                }
                let same_release = [
                    Some(&installation.active_release),
                    installation.pending_release.as_ref(),
                ]
                .into_iter()
                .flatten()
                .find(|release| release.release_id == artifact.release_id);
                if let Some(release) = same_release {
                    if release.sha256 != artifact.sha256 {
                        return Err(format!(
                            "内置插件同一发行版的 SHA-256 已变化：{}",
                            artifact.release_id
                        ));
                    }
                    if !Path::new(&release.path).join("manifest.json").is_file() {
                        return Err(format!(
                            "内置插件已安装发行版目录不可用：{}",
                            artifact.release_id
                        ));
                    }
                    continue;
                }
            }

            let bytes = bundled
                .get(artifact.artifact_file.as_str())
                .expect("bundle was validated above");
            let artifact_path = self.materialize_builtin_artifact(&artifact.sha256, bytes)?;
            let inspected = inspect_artifact(&artifact_path)?;
            if inspected.manifest.get("id").and_then(Value::as_str)
                != Some(artifact.manifest_id.as_str())
                || inspected.manifest.get("version").and_then(Value::as_str)
                    != Some(artifact.version.as_str())
            {
                return Err(format!(
                    "内置插件制品 manifest 与索引不一致：{}",
                    artifact.manifest_id
                ));
            }
            self.install(InstallArtifactInput {
                artifact_path: artifact_path.to_string_lossy().to_string(),
                expected_sha256: Some(artifact.sha256),
                package_id: Some(artifact.package_id),
                release_id: Some(artifact.release_id),
                origin: InstallationOrigin::Builtin,
                protected: true,
            })?;
            registered += 1;
        }
        Ok(registered)
    }

    fn materialize_builtin_artifact(&self, sha256: &str, bytes: &[u8]) -> Result<PathBuf, String> {
        let destination = self.cache_root().join(format!("{sha256}.lfplugin"));
        if destination.is_file() && sha256_file(&destination).as_deref() == Ok(sha256) {
            return Ok(destination);
        }
        let temporary = self
            .staging_root()
            .join(format!("builtin-artifact-{}.tmp", Uuid::new_v4()));
        let result = (|| {
            let mut output = File::create(&temporary)
                .map_err(|error| format!("创建内置插件暂存制品失败：{error}"))?;
            output
                .write_all(bytes)
                .map_err(|error| format!("写入内置插件暂存制品失败：{error}"))?;
            output
                .sync_all()
                .map_err(|error| format!("同步内置插件暂存制品失败：{error}"))?;
            if destination.exists() {
                fs::remove_file(&destination)
                    .map_err(|error| format!("替换损坏的内置插件缓存失败：{error}"))?;
            }
            fs::rename(&temporary, &destination)
                .map_err(|error| format!("提交内置插件缓存失败：{error}"))?;
            Ok::<(), String>(())
        })();
        if let Err(error) = result {
            let _ = fs::remove_file(temporary);
            return Err(error);
        }
        Ok(destination)
    }

    pub(crate) fn migrate_legacy_layout(&self) -> Result<(usize, usize), String> {
        let mut journal: LegacyMigrationJournal =
            read_json(&self.migration_journal_path()).unwrap_or_default();
        let completed: std::collections::HashSet<String> =
            journal.completed_directories.iter().cloned().collect();
        let mut migrated = 0;
        let mut failed = 0;
        let entries = fs::read_dir(&self.plugins_root)
            .map_err(|error| format!("读取旧插件目录失败：{error}"))?;
        for entry in entries.flatten() {
            let path = entry.path();
            if !path.is_dir() {
                continue;
            }
            let name = entry.file_name().to_string_lossy().to_string();
            if matches!(
                name.as_str(),
                ".lingfang" | ".lingfang-staging" | "installed" | "cache" | "workspaces"
            ) || completed.contains(&name)
            {
                continue;
            }
            let manifest_path = path.join("manifest.json");
            if !manifest_path.is_file() {
                continue;
            }
            match self.migrate_one_legacy_directory(&name, &path) {
                Ok(()) => {
                    journal.completed_directories.push(name.clone());
                    journal.failures.retain(|failure| failure.directory != name);
                    migrated += 1;
                }
                Err(error) => {
                    journal.failures.retain(|failure| failure.directory != name);
                    journal.failures.push(LegacyMigrationFailure {
                        directory: name.clone(),
                        error: error.clone(),
                        at: Utc::now().to_rfc3339(),
                    });
                    self.audit(
                        "plugin.layout_migration.failed",
                        &name,
                        serde_json::json!({ "error": error }),
                    );
                    failed += 1;
                }
            }
            write_json(&self.migration_journal_path(), &journal)?;
        }
        Ok((migrated, failed))
    }

    fn migrate_one_legacy_directory(&self, name: &str, path: &Path) -> Result<(), String> {
        let mut manifest: Value = read_json(&path.join("manifest.json"))
            .ok_or_else(|| "旧插件 manifest.json 无法读取".to_string())?;
        let is_draft = manifest
            .get("draft")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        if is_draft {
            if let Some(object) = manifest.as_object_mut() {
                object.remove("draft");
            }
            let workspace_id = Uuid::new_v4().to_string();
            let destination = self.workspaces_root().join(&workspace_id);
            fs::rename(path, &destination).map_err(|error| format!("迁移草稿目录失败：{error}"))?;
            let now = Utc::now().to_rfc3339();
            let workspace = DraftWorkspace {
                workspace_id,
                title: manifest
                    .get("title")
                    .or_else(|| manifest.get("name"))
                    .and_then(Value::as_str)
                    .unwrap_or(name)
                    .to_string(),
                path: destination.to_string_lossy().to_string(),
                manifest_id: manifest
                    .get("id")
                    .and_then(Value::as_str)
                    .unwrap_or(name)
                    .to_string(),
                current_version: manifest
                    .get("version")
                    .and_then(Value::as_str)
                    .unwrap_or("0.1.0")
                    .to_string(),
                runtime: manifest
                    .get("runtime_type")
                    .and_then(Value::as_str)
                    .unwrap_or("client")
                    .to_string(),
                source_kind: PluginReleaseSourceKind::LegacyMigration,
                source_label: PluginReleaseSourceKind::LegacyMigration
                    .default_label()
                    .to_string(),
                conversation_id: None,
                diagnostic_status: DraftDiagnosticStatus::Idle,
                content_sha256: None,
                last_published_release_id: None,
                last_published_version: None,
                created_at: now.clone(),
                updated_at: now,
            };
            let previous_ledger = self.read_workspaces();
            let mut ledger = previous_ledger.clone();
            ledger.workspaces.push(workspace);
            if let Err(error) = self.write_workspaces(&ledger) {
                return match fs::rename(&destination, path) {
                    Ok(()) => Err(error),
                    Err(rollback_error) => {
                        Err(format!("{error}；草稿目录回退失败：{rollback_error}"))
                    }
                };
            }
            if let Err(error) = write_json(&destination.join("manifest.json"), &manifest) {
                let ledger_rollback = self.write_workspaces(&previous_ledger).err();
                let directory_rollback = fs::rename(&destination, path).err();
                let mut detail = format!("清理草稿 manifest.draft 失败：{error}");
                if let Some(rollback_error) = ledger_rollback {
                    detail.push_str(&format!("；草稿账本回退失败：{rollback_error}"));
                }
                if let Some(rollback_error) = directory_rollback {
                    detail.push_str(&format!("；草稿目录回退失败：{rollback_error}"));
                }
                return Err(detail);
            }
            return Ok(());
        }

        let artifact_path = self
            .cache_root()
            .join(format!("legacy-{}.lfplugin", Uuid::new_v4()));
        let artifact = package_workspace(path, &artifact_path)?;
        let manifest_id = manifest.get("id").and_then(Value::as_str).unwrap_or(name);
        let backup = self
            .staging_root()
            .join(format!("legacy-layout-{}", Uuid::new_v4()));
        fs::rename(path, &backup).map_err(|error| format!("暂存旧插件目录失败：{error}"))?;
        // 迁移的是政策生效前已存在的安装（grandfathered），绕开 F2 v1 运行时政策。
        let installed = match self.install_with_runtime_policy(
            InstallArtifactInput {
                artifact_path: artifact_path.to_string_lossy().to_string(),
                expected_sha256: Some(artifact.sha256.clone()),
                package_id: Some(format!("local:{manifest_id}")),
                release_id: Some(format!("legacy-{}", &artifact.sha256[..16])),
                origin: InstallationOrigin::Local,
                protected: false,
            },
            false,
        ) {
            Ok(installed) => installed,
            Err(error) => {
                let _ = fs::remove_file(&artifact_path);
                return match fs::rename(&backup, path) {
                    Ok(()) => Err(error),
                    Err(rollback_error) => {
                        Err(format!("{error}；旧插件目录回退失败：{rollback_error}"))
                    }
                };
            }
        };
        let _ = fs::remove_file(&artifact_path);
        let old_data = backup.join("data");
        let new_data = PathBuf::from(&installed.data_path);
        if old_data.is_dir() {
            if let Err(error) = copy_directory_contents(&old_data, &new_data) {
                let uninstall_error = self.uninstall(&installed.installation_id).err();
                let restore_error = fs::rename(&backup, path).err();
                let mut detail = error;
                if let Some(rollback_error) = uninstall_error {
                    detail.push_str(&format!("；新安装项回退失败：{rollback_error}"));
                }
                if let Some(rollback_error) = restore_error {
                    detail.push_str(&format!("；旧插件目录回退失败：{rollback_error}"));
                }
                return Err(detail);
            }
        }
        if let Err(error) = fs::remove_dir_all(&backup) {
            self.audit(
                "plugin.layout_migration.cleanup_deferred",
                name,
                serde_json::json!({ "path": backup, "error": error.to_string() }),
            );
        }
        Ok(())
    }

    pub(crate) fn installation(&self, installation_id: &str) -> Result<LocalInstallation, String> {
        self.read_installations()
            .installations
            .into_iter()
            .find(|installation| installation.installation_id == installation_id)
            .ok_or_else(|| "本机安装项不存在".to_string())
    }

    /// 命令层安装入口（新安装）：执行 F2 v1 运行时政策（Local 来源仅 client）。
    pub(crate) fn install(&self, input: InstallArtifactInput) -> Result<LocalInstallation, String> {
        self.install_with_runtime_policy(input, true)
    }

    /// `enforce_v1_runtime_policy = false` 仅供 legacy 迁移——迁移的是政策生效前
    /// 已存在的安装（grandfathered），不按新政策拒收。
    fn install_with_runtime_policy(
        &self,
        input: InstallArtifactInput,
        enforce_v1_runtime_policy: bool,
    ) -> Result<LocalInstallation, String> {
        let _guard = lock_or_recover(&self.file_lock);
        let artifact_path = PathBuf::from(&input.artifact_path);
        let inspected = inspect_artifact(&artifact_path)?;
        if let Some(expected) = input.expected_sha256.as_deref() {
            if !expected.eq_ignore_ascii_case(&inspected.sha256) {
                self.audit(
                    "plugin.artifact.sha_failed",
                    input.release_id.as_deref().unwrap_or("local"),
                    serde_json::json!({ "expected": expected, "actual": inspected.sha256 }),
                );
                return Err(format!(
                    "插件制品 SHA-256 校验失败：期望 {expected}，实际 {}",
                    inspected.sha256
                ));
            }
        }
        let manifest_id = inspected
            .manifest
            .get("id")
            .and_then(Value::as_str)
            .ok_or_else(|| "manifest.id 缺失".to_string())?;
        let version = inspected
            .manifest
            .get("version")
            .and_then(Value::as_str)
            .ok_or_else(|| "manifest.version 缺失".to_string())?;
        let package_id = input
            .package_id
            .unwrap_or_else(|| format!("local:{manifest_id}"));
        let release_id = input
            .release_id
            .unwrap_or_else(|| format!("local-{}", &inspected.sha256[..16]));
        validate_storage_segment(&release_id, "releaseId")?;
        // IMPROVEMENT_PLAN F2（v1 安全政策）：本地导入的第三方插件仅允许 client 运行时。
        // 进程沙箱（Job Object）是生命周期围栏而非安全边界（CODEBUDDY.md Security model Tier 2），
        // 在插件签名信任根建立前，nodejs/python 进程插件保留给内置/一方签名插件；
        // Team/Marketplace 来源另受 start_installed_plugin 的在线访问权校验门槛约束。
        if enforce_v1_runtime_policy && input.origin == InstallationOrigin::Local {
            let runtime_type = inspected
                .manifest
                .get("runtime_type")
                .and_then(Value::as_str)
                .unwrap_or("client");
            if runtime_type == "nodejs" || runtime_type == "python" {
                self.audit(
                    "plugin.install.runtime_policy_rejected",
                    &release_id,
                    serde_json::json!({
                        "manifest_id": manifest_id,
                        "version": version,
                        "runtime_type": runtime_type,
                    }),
                );
                return Err(
                    "v1 安全政策：本地导入的插件暂仅支持 client 运行时；nodejs/python 进程插件保留给内置或一方签名插件（进程沙箱非安全边界，待插件签名信任根建立后放开，见 IMPROVEMENT_PLAN.md F2）"
                        .to_string(),
                );
            }
        }
        let mut ledger = self.read_installations();
        let existing_index = ledger
            .installations
            .iter()
            .position(|installation| installation.package_id == package_id);
        if let Some(index) = existing_index {
            let current = &ledger.installations[index];
            if current.pending_release.is_some() {
                return Err("已有待激活版本，请先完成启动验证或回滚后再更新".to_string());
            }
            if current.active_release.release_id == release_id
                || current
                    .pending_release
                    .as_ref()
                    .map(|release| release.release_id.as_str())
                    == Some(release_id.as_str())
            {
                return Err("该发行版已经安装且不可覆盖".to_string());
            }
        }
        let installation_id = existing_index
            .map(|index| ledger.installations[index].installation_id.clone())
            .unwrap_or_else(|| Uuid::new_v4().to_string());
        let installation_root = self.installed_root().join(&installation_id);
        let final_package = installation_root
            .join("releases")
            .join(&release_id)
            .join("package");
        if final_package.exists() {
            return Err("发行版目录已存在，拒绝覆盖".to_string());
        }
        let staging = self.staging_root().join(Uuid::new_v4().to_string());
        let staging_package = staging.join("package");
        if let Err(error) = extract_artifact(&artifact_path, &staging_package) {
            let _ = fs::remove_dir_all(&staging);
            return Err(error);
        }
        let shared_data = installation_root.join("data");
        if let Err(error) = fs::create_dir_all(&shared_data) {
            let _ = fs::remove_dir_all(&staging);
            return Err(format!("创建插件 data 目录失败：{error}"));
        }
        if let Err(error) =
            create_directory_link(&staging_package.join("data"), &shared_data, "共享 data")
        {
            let _ = fs::remove_dir_all(&staging);
            if existing_index.is_none() {
                let _ = fs::remove_dir_all(&installation_root);
            }
            return Err(error);
        }
        // 注意：nodejs 插件**不**在此预建 node_modules 联接到 environments/。
        // pnpm 9.x 在 Windows 上无法在一个已存在的 node_modules junction 上 mkdir（ENOTDIR），
        // 会让带依赖的 nodejs 插件安装失败。故 node_modules 由 ensure_node_dependencies 在
        // 首次启动时让 pnpm 以真实目录形式创建在 package/ 内。每个 release 有独立目录，
        // 原本 junction 指向的 environments/{release_id}/node_modules 也不跨 release 共享，
        // 故取消该联接无功能损失。Python venv 仍走 environments/（见 python_venv_dir）。
        if let Some(parent) = final_package.parent() {
            if let Err(error) = fs::create_dir_all(parent) {
                let _ = fs::remove_dir_all(&staging);
                remove_release_environment_path(&installation_root, &release_id);
                if existing_index.is_none() {
                    let _ = fs::remove_dir_all(&installation_root);
                }
                return Err(format!("创建发行版目录失败：{error}"));
            }
        }
        if let Err(error) = fs::rename(&staging_package, &final_package) {
            let _ = fs::remove_dir_all(&staging);
            remove_release_environment_path(&installation_root, &release_id);
            if existing_index.is_none() {
                let _ = fs::remove_dir_all(&installation_root);
            }
            return Err(format!("提交发行版目录失败：{error}"));
        }
        let _ = fs::remove_dir_all(&staging);
        let cache_path = self
            .cache_root()
            .join(format!("{}.lfplugin", inspected.sha256));
        if !cache_path.exists() {
            if let Err(error) = fs::copy(&artifact_path, &cache_path) {
                remove_release_directory(&final_package.to_string_lossy());
                remove_release_environment_path(&installation_root, &release_id);
                if existing_index.is_none() {
                    let _ = fs::remove_dir_all(&installation_root);
                }
                return Err(format!("缓存插件制品失败：{error}"));
            }
        }
        let now = Utc::now().to_rfc3339();
        let release = InstalledRelease {
            release_id: release_id.clone(),
            version: version.to_string(),
            sha256: inspected.sha256,
            path: final_package.to_string_lossy().to_string(),
            dependency_status: DependencyStatus::Pending,
        };
        let previous_ledger = ledger.clone();
        if let Some(index) = existing_index {
            ledger.installations[index].pending_release = Some(release);
            ledger.installations[index].updated_at = now;
        } else {
            ledger.installations.push(LocalInstallation {
                installation_id: installation_id.clone(),
                package_id: package_id.clone(),
                origin: input.origin,
                protected: input.protected,
                active_release: release,
                pending_release: None,
                previous_release: None,
                data_path: shared_data.to_string_lossy().to_string(),
                installed_at: now.clone(),
                updated_at: now,
            });
        }
        if let Err(error) = self.write_installations(&ledger) {
            let _ = fs::remove_dir_all(final_package.parent().unwrap_or(&final_package));
            remove_release_environment_path(&installation_root, &release_id);
            if existing_index.is_none() {
                let _ = fs::remove_dir_all(&installation_root);
            }
            let _ = self.write_installations(&previous_ledger);
            return Err(format!("写入安装账本失败：{error}"));
        }
        self.audit(
            "plugin.installation.installed",
            &installation_id,
            serde_json::json!({ "packageId": package_id.clone(), "releaseId": release_id }),
        );
        ledger
            .installations
            .into_iter()
            .find(|installation| installation.package_id == package_id)
            .ok_or_else(|| "安装账本写入后无法读取安装项".to_string())
    }

    pub(crate) fn selected_release(
        &self,
        installation_id: &str,
    ) -> Result<(LocalInstallation, InstalledRelease, bool), String> {
        let installation = self.installation(installation_id)?;
        if let Some(pending) = installation.pending_release.clone() {
            Ok((installation, pending, true))
        } else {
            let active = installation.active_release.clone();
            Ok((installation, active, false))
        }
    }

    pub(crate) fn load_installed_plugin(
        &self,
        installation_id: &str,
    ) -> Result<InstalledPluginPayload, String> {
        let installation = self.installation(installation_id)?;
        let release = installation.active_release.clone();
        self.load_release_payload(installation, &release)
    }

    pub(crate) fn preview_pending_plugin(
        &self,
        installation_id: &str,
    ) -> Result<InstalledPluginPayload, String> {
        let installation = self.installation(installation_id)?;
        let pending = installation
            .pending_release
            .clone()
            .ok_or_else(|| "没有待激活发行版".to_string())?;
        self.load_release_payload(installation, &pending)
    }

    pub(crate) fn read_installed_plugin_policy_source(
        &self,
        installation_id: &str,
        pending: bool,
    ) -> Result<InstalledPluginPolicySource, String> {
        let installation = self.installation(installation_id)?;
        let release = if pending {
            installation
                .pending_release
                .as_ref()
                .ok_or_else(|| "已安装插件没有待预检发行版".to_string())?
        } else {
            &installation.active_release
        };
        let package = self.checked_release_package_path(
            &installation.installation_id,
            &release.release_id,
            &release.path,
        )?;
        let files = read_tagged_source_files(&package)?;
        let manifest_file = files
            .iter()
            .find(|file| file.path == "manifest.json")
            .ok_or_else(|| "已安装插件发行版缺少 manifest.json".to_string())?;
        if manifest_file.binary {
            return Err("已安装插件 manifest.json 不是 UTF-8 文本".to_string());
        }
        let manifest = serde_json::from_str(&manifest_file.content)
            .map_err(|error| format!("已安装插件 manifest.json 格式错误：{error}"))?;
        Ok(InstalledPluginPolicySource { manifest, files })
    }

    fn checked_release_package_path(
        &self,
        installation_id: &str,
        release_id: &str,
        ledger_path: &str,
    ) -> Result<PathBuf, String> {
        validate_storage_segment(installation_id, "installationId")?;
        validate_storage_segment(release_id, "releaseId")?;
        let installed_root = self
            .installed_root()
            .canonicalize()
            .map_err(|error| format!("已安装插件根目录不可用：{error}"))?;
        let expected = self
            .installed_root()
            .join(installation_id)
            .join("releases")
            .join(release_id)
            .join("package")
            .canonicalize()
            .map_err(|error| format!("已安装插件发行版目录不可用：{error}"))?;
        let actual = Path::new(ledger_path)
            .canonicalize()
            .map_err(|error| format!("安装账本中的发行版目录不可用：{error}"))?;
        if actual != expected || !actual.starts_with(&installed_root) || !actual.is_dir() {
            return Err("安装账本中的发行版路径越出对应 package 目录".to_string());
        }
        Ok(actual)
    }

    pub(crate) fn activate_pending_client_plugin(
        &self,
        installation_id: &str,
    ) -> Result<LocalInstallation, String> {
        let preview = self.preview_pending_plugin(installation_id)?;
        let runtime = preview
            .manifest
            .get("runtime_type")
            .and_then(Value::as_str)
            .unwrap_or("client");
        if !matches!(runtime, "client" | "cloud") {
            return Err("Node/Python 待更新版本必须在进程成功启动后激活".to_string());
        }
        self.activate_pending(installation_id)
    }

    fn load_release_payload(
        &self,
        installation: LocalInstallation,
        release: &InstalledRelease,
    ) -> Result<InstalledPluginPayload, String> {
        let package = PathBuf::from(&release.path);
        let manifest: Value = read_json(&package.join("manifest.json"))
            .ok_or_else(|| "已安装插件 manifest.json 无法读取".to_string())?;
        let entry = manifest
            .get("entry")
            .and_then(Value::as_str)
            .ok_or_else(|| "已安装插件 manifest.entry 缺失".to_string())?;
        let entry_path = package.join(entry);
        let canonical_package = package
            .canonicalize()
            .map_err(|error| format!("已安装插件目录不可用：{error}"))?;
        let canonical_entry = entry_path
            .canonicalize()
            .map_err(|error| format!("已安装插件入口不可用：{error}"))?;
        if !canonical_entry.starts_with(&canonical_package) || !canonical_entry.is_file() {
            return Err("已安装插件入口越出发行版目录".to_string());
        }
        let entry_content = fs::read_to_string(&canonical_entry)
            .map_err(|error| format!("已安装插件入口不是 UTF-8 文本：{error}"))?;
        let readme_markdown = load_legacy_readme(&package.join("README.md"));
        Ok(InstalledPluginPayload {
            installation,
            manifest,
            entry_content,
            readme_markdown,
        })
    }

    pub(crate) fn mark_dependency_status(
        &self,
        installation_id: &str,
        release_id: &str,
        status: DependencyStatus,
    ) -> Result<(), String> {
        let _guard = lock_or_recover(&self.file_lock);
        let mut ledger = self.read_installations();
        let installation = ledger
            .installations
            .iter_mut()
            .find(|installation| installation.installation_id == installation_id)
            .ok_or_else(|| "本机安装项不存在".to_string())?;
        let target = if installation.active_release.release_id == release_id {
            Some(&mut installation.active_release)
        } else if installation
            .pending_release
            .as_ref()
            .map(|release| release.release_id.as_str())
            == Some(release_id)
        {
            installation.pending_release.as_mut()
        } else if installation
            .previous_release
            .as_ref()
            .map(|release| release.release_id.as_str())
            == Some(release_id)
        {
            installation.previous_release.as_mut()
        } else {
            None
        }
        .ok_or_else(|| "安装项中不存在该发行版".to_string())?;
        target.dependency_status = status;
        installation.updated_at = Utc::now().to_rfc3339();
        self.write_installations(&ledger)
    }

    pub(crate) fn activate_pending(
        &self,
        installation_id: &str,
    ) -> Result<LocalInstallation, String> {
        let _guard = lock_or_recover(&self.file_lock);
        let mut ledger = self.read_installations();
        let installation = ledger
            .installations
            .iter_mut()
            .find(|installation| installation.installation_id == installation_id)
            .ok_or_else(|| "本机安装项不存在".to_string())?;
        let obsolete_previous = installation.previous_release.take();
        let mut pending = installation
            .pending_release
            .take()
            .ok_or_else(|| "没有待激活发行版".to_string())?;
        pending.dependency_status = DependencyStatus::Ready;
        let old_active = std::mem::replace(&mut installation.active_release, pending);
        installation.previous_release = Some(old_active);
        installation.updated_at = Utc::now().to_rfc3339();
        let result = installation.clone();
        self.write_installations(&ledger)?;
        self.audit(
            "plugin.installation.activated",
            installation_id,
            serde_json::json!({ "releaseId": result.active_release.release_id }),
        );
        if let Some(obsolete) = obsolete_previous {
            remove_release_environment(&obsolete.path);
            remove_release_directory(&obsolete.path);
        }
        Ok(result)
    }

    pub(crate) fn discard_pending(
        &self,
        installation_id: &str,
        reason: &str,
    ) -> Result<LocalInstallation, String> {
        let _guard = lock_or_recover(&self.file_lock);
        let mut ledger = self.read_installations();
        let installation = ledger
            .installations
            .iter_mut()
            .find(|installation| installation.installation_id == installation_id)
            .ok_or_else(|| "本机安装项不存在".to_string())?;
        let pending = installation
            .pending_release
            .take()
            .ok_or_else(|| "没有待激活发行版".to_string())?;
        installation.updated_at = Utc::now().to_rfc3339();
        let result = installation.clone();
        self.write_installations(&ledger)?;
        self.audit(
            "plugin.installation.pending_discarded",
            installation_id,
            serde_json::json!({ "releaseId": pending.release_id, "reason": reason }),
        );
        remove_release_environment(&pending.path);
        remove_release_directory(&pending.path);
        Ok(result)
    }

    pub(crate) fn rollback(&self, installation_id: &str) -> Result<LocalInstallation, String> {
        let _guard = lock_or_recover(&self.file_lock);
        let mut ledger = self.read_installations();
        let installation = ledger
            .installations
            .iter_mut()
            .find(|installation| installation.installation_id == installation_id)
            .ok_or_else(|| "本机安装项不存在".to_string())?;
        let previous = installation
            .previous_release
            .take()
            .ok_or_else(|| "没有可回滚的上一版本".to_string())?;
        let old_active = std::mem::replace(&mut installation.active_release, previous);
        installation.previous_release = Some(old_active);
        let abandoned_pending = installation.pending_release.take();
        installation.updated_at = Utc::now().to_rfc3339();
        let result = installation.clone();
        self.write_installations(&ledger)?;
        self.audit(
            "plugin.installation.rolled_back",
            installation_id,
            serde_json::json!({ "releaseId": result.active_release.release_id }),
        );
        if let Some(pending) = abandoned_pending {
            remove_release_environment(&pending.path);
            remove_release_directory(&pending.path);
        }
        Ok(result)
    }

    pub(crate) fn uninstall(&self, installation_id: &str) -> Result<(), String> {
        let _guard = lock_or_recover(&self.file_lock);
        let mut ledger = self.read_installations();
        let index = ledger
            .installations
            .iter()
            .position(|installation| installation.installation_id == installation_id)
            .ok_or_else(|| "本机安装项不存在".to_string())?;
        if ledger.installations[index].protected {
            return Err("内置插件受保护，不能卸载".to_string());
        }
        let previous_ledger = ledger.clone();
        let installation = ledger.installations.remove(index);
        let root = self.installed_root().join(&installation.installation_id);
        let trash = self
            .staging_root()
            .join(format!("uninstall-{}", Uuid::new_v4()));
        if root.exists() {
            fs::rename(&root, &trash).map_err(|error| format!("暂存待卸载插件失败：{error}"))?;
        }
        for release in [
            Some(&installation.active_release),
            installation.pending_release.as_ref(),
            installation.previous_release.as_ref(),
        ]
        .into_iter()
        .flatten()
        {
            if let Err(error) = remove_external_python_environment(&release.path) {
                let rollback_error = trash
                    .exists()
                    .then(|| fs::rename(&trash, &root).err())
                    .flatten();
                let detail = rollback_error.map_or_else(
                    || error.clone(),
                    |rollback_error| format!("{error}；恢复插件目录失败：{rollback_error}"),
                );
                self.audit(
                    "plugin.installation.uninstall_failed",
                    installation_id,
                    serde_json::json!({ "stage": "runtime_cleanup", "error": detail.clone() }),
                );
                return Err(detail);
            }
        }
        if let Err(error) = self.write_installations(&ledger) {
            if trash.exists() {
                let _ = fs::rename(&trash, &root);
            }
            return Err(format!("写入卸载账本失败：{error}"));
        }
        if trash.exists() {
            if let Err(error) = fs::remove_dir_all(&trash) {
                let _ = fs::rename(&trash, &root);
                let _ = self.write_installations(&previous_ledger);
                return Err(format!("删除插件代码和数据失败：{error}"));
            }
        }
        self.audit(
            "plugin.installation.uninstalled",
            installation_id,
            serde_json::json!({ "packageId": installation.package_id }),
        );
        Ok(())
    }

    /// `lingfang-plugin dev` 命令：将本地源目录登记为开发态安装（origin = Dev）。
    ///
    /// 与正式安装的关键差异：dev 安装直接以源目录作为 `active_release.path`，
    /// 不经 unpack/校验，也不走 `checked_release_package_path`（目录安全性由源目录本身负责）。
    /// 零服务器模型下，dev 安装仅允许 client 运行时（F2 v1 政策，进程插件保留给内置/一方签名插件）。
    pub(crate) fn register_dev_dir(
        &self,
        input: RegisterDevDirInput,
    ) -> Result<LocalInstallation, String> {
        let _guard = lock_or_recover(&self.file_lock);
        let canonical_dir = input
            .dir
            .canonicalize()
            .map_err(|error| format!("开发目录不可用：{error}"))?;
        if !canonical_dir.is_dir() {
            return Err("开发目录不存在或不是目录".to_string());
        }
        let manifest_path = canonical_dir.join("manifest.json");
        let manifest: Value = read_json(&manifest_path)
            .ok_or_else(|| "开发目录 manifest.json 无法读取".to_string())?;
        let manifest_id = manifest
            .get("id")
            .and_then(Value::as_str)
            .ok_or_else(|| "manifest.id 缺失".to_string())?;
        if manifest_id.trim().is_empty() {
            return Err("manifest.id 不能为空".to_string());
        }
        let runtime_type = manifest
            .get("runtime_type")
            .and_then(Value::as_str)
            .unwrap_or("client");
        if runtime_type != "client" {
            // F2 v1 安全政策 + IMPROVEMENT_PLAN LF-02：v1 中 dev 安装仅支持 client 运行时，
            // nodejs/python 进程插件的开发态挂载待签名信任根建立后再放开。
            return Err(
                "v1 安全政策（LF-02）：开发态安装暂仅支持 client 运行时；nodejs/python 进程插件保留给内置或一方签名插件（进程沙箱非安全边界，见 IMPROVEMENT_PLAN.md F2）"
                    .to_string(),
            );
        }
        let package_id = input
            .package_id
            .clone()
            .unwrap_or_else(|| format!("dev:{manifest_id}"));
        if package_id.trim().is_empty() {
            return Err("开发目录 packageId 不能为空".to_string());
        }
        let mut hasher = Sha256::new();
        hasher.update(canonical_dir.to_string_lossy().as_bytes());
        let digest = hasher.finalize();
        let mut hash_hex = String::with_capacity(16);
        for byte in digest.iter().take(8) {
            hash_hex.push_str(&format!("{byte:02x}"));
        }
        let release_id = format!("dev-{hash_hex}");
        let version = manifest
            .get("version")
            .and_then(Value::as_str)
            .unwrap_or("0.0.0-dev")
            .to_string();
        let canonical_dir_string = canonical_dir.to_string_lossy().to_string();

        let mut ledger = self.read_installations();
        let now = Utc::now().to_rfc3339();
        let existing_index = ledger.installations.iter().position(|installation| {
            installation.origin == InstallationOrigin::Dev
                && (installation.active_release.path == canonical_dir_string
                    || installation.package_id == package_id)
        });
        let (installation_id, installed_at) = match existing_index {
            Some(index) => {
                let current = &ledger.installations[index];
                (current.installation_id.clone(), current.installed_at.clone())
            }
            None => (Uuid::new_v4().to_string(), now.clone()),
        };

        let data_path = self.installed_root().join(&installation_id).join("data");
        fs::create_dir_all(&data_path)
            .map_err(|error| format!("创建开发插件 data 目录失败：{error}"))?;

        let active_release = InstalledRelease {
            release_id,
            version,
            sha256: "dev".to_string(),
            path: canonical_dir_string.clone(),
            dependency_status: DependencyStatus::Ready,
        };
        let installation = LocalInstallation {
            installation_id: installation_id.clone(),
            package_id: package_id.clone(),
            origin: InstallationOrigin::Dev,
            protected: false,
            active_release: active_release.clone(),
            pending_release: None,
            previous_release: None,
            data_path: data_path.to_string_lossy().to_string(),
            installed_at: installed_at.clone(),
            updated_at: now,
        };
        if let Some(index) = existing_index {
            ledger.installations[index] = installation.clone();
        } else {
            ledger.installations.push(installation.clone());
        }
        self.write_installations(&ledger)?;

        // 登记前校验源目录确实可被正常加载（防止登记一个无法读取的开发目录）。
        if let Err(error) = self.load_release_payload(installation.clone(), &active_release) {
            // 校验失败则回滚账本写入。
            if let Some(index) = existing_index {
                let mut rollback = self.read_installations();
                if let Some(entry) = rollback.installations.get_mut(index) {
                    entry.updated_at = installed_at;
                }
                let _ = self.write_installations(&rollback);
            } else {
                let mut rollback = self.read_installations();
                rollback.installations.retain(|item| {
                    !(item.origin == InstallationOrigin::Dev
                        && item.installation_id == installation_id)
                });
                let _ = self.write_installations(&rollback);
            }
            return Err(format!("开发目录无法加载：{error}"));
        }
        Ok(installation)
    }

    /// 移除一个 dev 安装账本条目（幂等）。不删除源目录，也不删除其 data 目录。
    pub(crate) fn unregister_dev_dir(&self, dir: PathBuf) -> Result<(), String> {
        let _guard = lock_or_recover(&self.file_lock);
        let canonical_dir = match dir.canonicalize() {
            Ok(path) => path.to_string_lossy().to_string(),
            Err(_) => {
                // 源目录已不存在，无需报错——直接视为已移除。
                return Ok(());
            }
        };
        let mut ledger = self.read_installations();
        let before = ledger.installations.len();
        ledger.installations.retain(|installation| {
            !(installation.origin == InstallationOrigin::Dev
                && installation.active_release.path == canonical_dir)
        });
        if ledger.installations.len() == before {
            return Ok(());
        }
        self.write_installations(&ledger)
    }

    pub(crate) fn list_workspaces(&self) -> Vec<DraftWorkspace> {
        let mut workspaces = self.read_workspaces().workspaces;
        workspaces.sort_by(|left, right| right.updated_at.cmp(&left.updated_at));
        workspaces
    }

    pub(crate) fn workspace(&self, workspace_id: &str) -> Result<DraftWorkspace, String> {
        self.read_workspaces()
            .workspaces
            .into_iter()
            .find(|workspace| workspace.workspace_id == workspace_id)
            .ok_or_else(|| "草稿工作区不存在".to_string())
    }

    pub(crate) fn read_workspace_files(
        &self,
        workspace_id: &str,
    ) -> Result<Vec<DraftWorkspaceFilePayload>, String> {
        let workspace = self.workspace(workspace_id)?;
        read_tagged_source_files(Path::new(&workspace.path))
    }

    pub(crate) fn create_workspace(
        &self,
        input: CreateWorkspaceInput,
    ) -> Result<DraftWorkspace, String> {
        let _guard = lock_or_recover(&self.file_lock);
        let title = input.title.trim();
        let manifest_id = input.manifest_id.trim();
        if title.is_empty() || manifest_id.is_empty() {
            return Err("草稿标题和 manifestId 不能为空".to_string());
        }
        semver::Version::parse(input.version.trim())
            .map_err(|_| "草稿版本必须是严格 SemVer".to_string())?;
        if !matches!(
            input.runtime.as_str(),
            "client" | "cloud" | "nodejs" | "python" | "workflow"
        ) {
            return Err("草稿 runtime 不受支持".to_string());
        }
        let provenance = normalize_release_provenance(
            input
                .source_kind
                .unwrap_or(PluginReleaseSourceKind::LingfangCreator),
            input.source_label.as_deref(),
        )?;
        let workspace_id = Uuid::new_v4().to_string();
        let path = self.workspaces_root().join(&workspace_id);
        fs::create_dir_all(&path).map_err(|error| format!("创建草稿工作区失败：{error}"))?;
        let manifest = serde_json::json!({
            "id": manifest_id,
            "name": title,
            "version": input.version,
            "description": "",
            "runtime_type": input.runtime,
            "entry": if input.runtime == "python" { "main.py" } else if input.runtime == "nodejs" { "index.js" } else { "ui/index.html" },
            "visibility": "tenant",
            "capabilities": []
        });
        let initialize = (|| {
            write_json(&path.join("manifest.json"), &manifest)?;
            let entry = manifest
                .get("entry")
                .and_then(Value::as_str)
                .unwrap_or("ui/index.html");
            let entry_path = path.join(entry);
            if let Some(parent) = entry_path.parent() {
                fs::create_dir_all(parent)
                    .map_err(|error| format!("创建草稿入口目录失败：{error}"))?;
            }
            fs::write(&entry_path, default_entry(input.runtime.as_str()))
                .map_err(|error| format!("创建草稿入口失败：{error}"))
        })();
        if let Err(error) = initialize {
            let _ = fs::remove_dir_all(&path);
            return Err(error);
        }
        let now = Utc::now().to_rfc3339();
        let workspace = DraftWorkspace {
            workspace_id,
            title: title.to_string(),
            path: path.to_string_lossy().to_string(),
            manifest_id: manifest_id.to_string(),
            current_version: input.version,
            runtime: input.runtime,
            source_kind: provenance.source_kind,
            source_label: provenance.source_label,
            conversation_id: input.conversation_id,
            diagnostic_status: DraftDiagnosticStatus::Idle,
            content_sha256: None,
            last_published_release_id: None,
            last_published_version: None,
            created_at: now.clone(),
            updated_at: now,
        };
        let mut ledger = self.read_workspaces();
        ledger.workspaces.push(workspace.clone());
        if let Err(error) = self.write_workspaces(&ledger) {
            let _ = fs::remove_dir_all(&path);
            return Err(error);
        }
        Ok(workspace)
    }

    fn import_workspace_with_provenance(
        &self,
        artifact_path: &Path,
        provenance: ReleaseProvenance,
    ) -> Result<DraftWorkspace, String> {
        let inspected = inspect_artifact(artifact_path)?;
        let manifest_id = inspected
            .manifest
            .get("id")
            .and_then(Value::as_str)
            .unwrap_or("imported");
        let title = inspected
            .manifest
            .get("name")
            .and_then(Value::as_str)
            .unwrap_or(manifest_id);
        let version = inspected
            .manifest
            .get("version")
            .and_then(Value::as_str)
            .unwrap_or("0.1.0");
        let runtime = inspected
            .manifest
            .get("runtime_type")
            .and_then(Value::as_str)
            .unwrap_or("client");
        let _guard = lock_or_recover(&self.file_lock);
        let workspace_id = Uuid::new_v4().to_string();
        let path = self.workspaces_root().join(&workspace_id);
        extract_artifact(artifact_path, &path)?;
        let now = Utc::now().to_rfc3339();
        let workspace = DraftWorkspace {
            workspace_id,
            title: title.to_string(),
            path: path.to_string_lossy().to_string(),
            manifest_id: manifest_id.to_string(),
            current_version: version.to_string(),
            runtime: runtime.to_string(),
            source_kind: provenance.source_kind,
            source_label: provenance.source_label,
            conversation_id: None,
            diagnostic_status: DraftDiagnosticStatus::Idle,
            // content_sha256 records the last published artifact, not the import source.
            content_sha256: None,
            last_published_release_id: None,
            last_published_version: None,
            created_at: now.clone(),
            updated_at: now,
        };
        let mut ledger = self.read_workspaces();
        ledger.workspaces.push(workspace.clone());
        if let Err(error) = self.write_workspaces(&ledger) {
            let _ = fs::remove_dir_all(&path);
            return Err(error);
        }
        Ok(workspace)
    }

    pub(crate) fn import_workspace(&self, artifact_path: &Path) -> Result<DraftWorkspace, String> {
        let provenance =
            normalize_release_provenance(PluginReleaseSourceKind::LocalArtifact, None)?;
        self.import_workspace_with_provenance(artifact_path, provenance)
    }

    pub(crate) fn copy_installation_to_workspace(
        &self,
        installation_id: &str,
    ) -> Result<DraftWorkspace, String> {
        let installation = self.installation(installation_id)?;
        let artifact_path = self.cache_root().join(format!(
            "workspace-copy-{}-{}.lfplugin",
            installation_id,
            Uuid::new_v4()
        ));
        package_workspace(Path::new(&installation.active_release.path), &artifact_path)?;
        let provenance =
            normalize_release_provenance(PluginReleaseSourceKind::CopiedInstallation, None)?;
        let result = self.import_workspace_with_provenance(&artifact_path, provenance);
        let _ = fs::remove_file(artifact_path);
        result
    }

    pub(crate) fn pack_workspace(
        &self,
        workspace_id: &str,
        output_path: Option<&Path>,
    ) -> Result<PackWorkspaceResult, String> {
        let workspace = self.workspace(workspace_id)?;
        let output = output_path.map(Path::to_path_buf).unwrap_or_else(|| {
            self.cache_root()
                .join(format!("workspace-{workspace_id}.lfplugin"))
        });
        let artifact = package_workspace(Path::new(&workspace.path), &output)?;
        Ok(PackWorkspaceResult {
            artifact_path: output.to_string_lossy().to_string(),
            artifact,
        })
    }

    fn ensure_workspace_publishable(
        &self,
        workspace_id: &str,
        version: &str,
        content_sha256: &str,
    ) -> Result<(), String> {
        let workspace = self.workspace(workspace_id)?;
        if workspace.last_published_version.as_deref() == Some(version) {
            return Err("版本号未提升，不能重复发布".to_string());
        }
        if workspace.content_sha256.as_deref() == Some(content_sha256) {
            return Err("草稿内容未变化，不能重复发布".to_string());
        }
        if let Some(previous) = workspace.last_published_version.as_deref() {
            let previous =
                semver::Version::parse(previous).map_err(|_| "历史发布版本损坏".to_string())?;
            let next = semver::Version::parse(version)
                .map_err(|_| "发布版本必须是严格 SemVer".to_string())?;
            if next <= previous {
                return Err(format!("发布版本必须高于 {previous}"));
            }
        }
        Ok(())
    }

    pub(crate) fn mark_workspace_published(
        &self,
        workspace_id: &str,
        release_id: &str,
        version: &str,
        content_sha256: &str,
    ) -> Result<DraftWorkspace, String> {
        let _guard = lock_or_recover(&self.file_lock);
        let mut ledger = self.read_workspaces();
        let workspace = ledger
            .workspaces
            .iter_mut()
            .find(|workspace| workspace.workspace_id == workspace_id)
            .ok_or_else(|| "草稿工作区不存在".to_string())?;
        if workspace.last_published_version.as_deref() == Some(version)
            || workspace.content_sha256.as_deref() == Some(content_sha256)
        {
            return Err("草稿内容未变化或版本号未提升，不能重复发布".to_string());
        }
        if let Some(previous) = workspace.last_published_version.as_deref() {
            let previous =
                semver::Version::parse(previous).map_err(|_| "历史发布版本损坏".to_string())?;
            let next = semver::Version::parse(version)
                .map_err(|_| "发布版本必须是严格 SemVer".to_string())?;
            if next <= previous {
                return Err(format!("发布版本必须高于 {previous}"));
            }
        }
        workspace.last_published_release_id = Some(release_id.to_string());
        workspace.last_published_version = Some(version.to_string());
        workspace.current_version = version.to_string();
        workspace.content_sha256 = Some(content_sha256.to_string());
        workspace.updated_at = Utc::now().to_rfc3339();
        let result = workspace.clone();
        self.write_workspaces(&ledger)?;
        Ok(result)
    }

    pub(crate) fn delete_workspace(&self, workspace_id: &str) -> Result<(), String> {
        let _guard = lock_or_recover(&self.file_lock);
        let mut ledger = self.read_workspaces();
        let index = ledger
            .workspaces
            .iter()
            .position(|workspace| workspace.workspace_id == workspace_id)
            .ok_or_else(|| "草稿工作区不存在".to_string())?;
        let previous_ledger = ledger.clone();
        let workspace = ledger.workspaces.remove(index);
        let path = PathBuf::from(workspace.path);
        let trash = self
            .staging_root()
            .join(format!("workspace-delete-{}", Uuid::new_v4()));
        if path.exists() {
            fs::rename(&path, &trash).map_err(|error| format!("暂存待删除草稿失败：{error}"))?;
        }
        if let Err(error) = self.write_workspaces(&ledger) {
            if trash.exists() {
                let _ = fs::rename(&trash, &path);
            }
            let _ = self.write_workspaces(&previous_ledger);
            return Err(error);
        }
        if trash.exists() {
            if let Err(error) = fs::remove_dir_all(&trash) {
                let _ = fs::rename(&trash, &path);
                let _ = self.write_workspaces(&previous_ledger);
                return Err(format!("删除草稿工作区失败：{error}"));
            }
        }
        Ok(())
    }

    pub(crate) fn sync_workspace_metadata(
        &self,
        workspace_id: &str,
        conversation_id: Option<String>,
        source_kind: Option<PluginReleaseSourceKind>,
        source_label: Option<String>,
    ) -> Result<DraftWorkspace, String> {
        let _guard = lock_or_recover(&self.file_lock);
        let mut ledger = self.read_workspaces();
        let workspace = ledger
            .workspaces
            .iter_mut()
            .find(|workspace| workspace.workspace_id == workspace_id)
            .ok_or_else(|| "草稿工作区不存在".to_string())?;
        let manifest: Value = read_json(&PathBuf::from(&workspace.path).join("manifest.json"))
            .ok_or_else(|| "草稿 manifest.json 无法读取".to_string())?;
        workspace.title = manifest
            .get("title")
            .or_else(|| manifest.get("name"))
            .and_then(Value::as_str)
            .unwrap_or(&workspace.title)
            .to_string();
        workspace.manifest_id = manifest
            .get("id")
            .and_then(Value::as_str)
            .unwrap_or(&workspace.manifest_id)
            .to_string();
        workspace.current_version = manifest
            .get("version")
            .and_then(Value::as_str)
            .unwrap_or(&workspace.current_version)
            .to_string();
        workspace.runtime = manifest
            .get("runtime_type")
            .and_then(Value::as_str)
            .unwrap_or(&workspace.runtime)
            .to_string();
        if conversation_id.is_some() {
            workspace.conversation_id = conversation_id;
        }
        if source_kind.is_some() || source_label.is_some() {
            let kind = source_kind.unwrap_or(workspace.source_kind);
            let existing_label = workspace.source_label.clone();
            let label = match source_label.as_deref() {
                Some(label) => Some(label),
                None if source_kind.is_none() => Some(existing_label.as_str()),
                None => None,
            };
            let provenance = normalize_release_provenance(kind, label)?;
            workspace.source_kind = provenance.source_kind;
            workspace.source_label = provenance.source_label;
        }
        workspace.updated_at = Utc::now().to_rfc3339();
        let result = workspace.clone();
        self.write_workspaces(&ledger)?;
        Ok(result)
    }
}

fn load_legacy_readme(path: &Path) -> String {
    match fs::read(path) {
        Ok(bytes) if bytes.len() <= 256 * 1024 => match String::from_utf8(bytes) {
            Ok(markdown) => markdown,
            Err(_) => {
                eprintln!("[plugin-readme] 忽略历史安装中的非 UTF-8 README.md：{}", path.display());
                String::new()
            }
        },
        Ok(_) => {
            eprintln!("[plugin-readme] 忽略历史安装中超过 256 KiB 的 README.md：{}", path.display());
            String::new()
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => String::new(),
        Err(error) => {
            eprintln!("[plugin-readme] 读取历史安装 README.md 失败，降级为短摘要：{}：{error}", path.display());
            String::new()
        }
    }
}
