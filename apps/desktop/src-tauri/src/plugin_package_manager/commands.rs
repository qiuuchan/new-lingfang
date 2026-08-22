use std::path::{Path, PathBuf};

use crate::plugin_artifact_v4::{inspect_artifact, sha256_file, InspectedArtifact};
use crate::plugin_llm_bridge::PluginLlmBridge;
use crate::plugin_runner::{self, PluginProcessTable, StartPluginResult};

use super::{
    CreateWorkspaceInput, DependencyStatus, DraftWorkspace, DraftWorkspaceFilePayload,
    InstallArtifactInput, InstallationOrigin, InstalledPluginPayload, InstalledPluginPolicySource,
    LocalInstallation, PackWorkspaceResult, PluginPackageManager, PluginReleaseSourceKind,
};

#[tauri::command]
pub(crate) fn list_plugin_installations(
    manager: tauri::State<'_, PluginPackageManager>,
) -> Vec<LocalInstallation> {
    manager.list_installations()
}

#[tauri::command]
pub(crate) fn install_plugin_artifact(
    manager: tauri::State<'_, PluginPackageManager>,
    input: InstallArtifactInput,
) -> Result<LocalInstallation, String> {
    manager.install(input)
}

#[tauri::command]
pub(crate) fn load_installed_plugin(
    manager: tauri::State<'_, PluginPackageManager>,
    installation_id: String,
) -> Result<InstalledPluginPayload, String> {
    manager.load_installed_plugin(&installation_id)
}

#[tauri::command]
pub(crate) fn preview_pending_installed_plugin(
    manager: tauri::State<'_, PluginPackageManager>,
    installation_id: String,
) -> Result<InstalledPluginPayload, String> {
    manager.preview_pending_plugin(&installation_id)
}

#[tauri::command]
pub(crate) fn read_installed_plugin_policy_source(
    manager: tauri::State<'_, PluginPackageManager>,
    installation_id: String,
    pending: bool,
) -> Result<InstalledPluginPolicySource, String> {
    manager.read_installed_plugin_policy_source(&installation_id, pending)
}

#[tauri::command]
pub(crate) fn activate_pending_client_plugin(
    manager: tauri::State<'_, PluginPackageManager>,
    installation_id: String,
) -> Result<LocalInstallation, String> {
    manager.activate_pending_client_plugin(&installation_id)
}

#[tauri::command]
pub(crate) fn discard_pending_plugin_update(
    manager: tauri::State<'_, PluginPackageManager>,
    installation_id: String,
    reason: Option<String>,
) -> Result<LocalInstallation, String> {
    manager.discard_pending(
        &installation_id,
        reason.as_deref().unwrap_or("client preview failed"),
    )
}

#[tauri::command]
pub(crate) fn rollback_plugin_installation(
    manager: tauri::State<'_, PluginPackageManager>,
    installation_id: String,
) -> Result<LocalInstallation, String> {
    manager.rollback(&installation_id)
}

#[tauri::command]
pub(crate) fn uninstall_plugin_installation(
    manager: tauri::State<'_, PluginPackageManager>,
    process_table: tauri::State<'_, PluginProcessTable>,
    bridge: tauri::State<'_, PluginLlmBridge>,
    installation_id: String,
) -> Result<(), String> {
    plugin_runner::stop_plugin_by_id(&process_table, &bridge, &installation_id)?;
    manager.uninstall(&installation_id)
}

#[tauri::command]
pub(crate) async fn start_installed_plugin(
    app: tauri::AppHandle,
    manager: tauri::State<'_, PluginPackageManager>,
    process_table: tauri::State<'_, PluginProcessTable>,
    bridge: tauri::State<'_, PluginLlmBridge>,
    installation_id: String,
    registry_access_granted: Option<bool>,
    api_base: Option<String>,
    auth_token: Option<String>,
) -> Result<StartPluginResult, String> {
    let (installation, release, is_pending) = manager.selected_release(&installation_id)?;
    if matches!(
        installation.origin,
        InstallationOrigin::Team | InstallationOrigin::Marketplace
    ) && registry_access_granted != Some(true)
    {
        return Err("远端插件运行前必须完成在线访问权与发行版校验".to_string());
    }
    manager.mark_dependency_status(
        &installation_id,
        &release.release_id,
        DependencyStatus::Preparing,
    )?;
    // venv/pip/pnpm 装依赖是几十秒~数分钟的阻塞子进程等待，必须 offload 到阻塞线程池：
    // 同步命令跑在 Tauri 主线程上会让窗口"未响应"，且 emit 的 plugin:output /
    // plugin:start-progress 事件需主线程投递，阻塞期间排队发不出去（前端日志面板收不到实时输出）。
    // start_plugin_from_dir 内部 app.emit 走 Emitter trait（线程安全），从 worker 线程发即可。
    let app_handle = app.clone();
    let process_table = process_table.inner().clone();
    let bridge = bridge.inner().clone();
    let release_path = PathBuf::from(&release.path);
    let installation_id_for_runner = installation_id.clone();
    let started = tauri::async_runtime::spawn_blocking(move || {
        plugin_runner::start_plugin_from_dir(
            &app_handle,
            &process_table,
            &bridge,
            &installation_id_for_runner,
            release_path,
            api_base,
            auth_token,
        )
    })
    .await
    .map_err(|join_error| format!("插件启动任务异常退出：{join_error}"))?;
    match started {
        Ok(result) => {
            manager.mark_dependency_status(
                &installation_id,
                &release.release_id,
                DependencyStatus::Ready,
            )?;
            if is_pending {
                manager.activate_pending(&installation_id)?;
            }
            Ok(result)
        }
        Err(error) => {
            let _ = manager.mark_dependency_status(
                &installation_id,
                &release.release_id,
                DependencyStatus::Failed,
            );
            if is_pending {
                let _ = manager.discard_pending(&installation_id, &error);
            }
            Err(error)
        }
    }
}

#[tauri::command]
pub(crate) fn stop_installed_plugin(
    process_table: tauri::State<'_, PluginProcessTable>,
    bridge: tauri::State<'_, PluginLlmBridge>,
    installation_id: String,
) -> Result<(), String> {
    plugin_runner::stop_plugin_by_id(&process_table, &bridge, &installation_id)
}

#[tauri::command]
pub(crate) fn list_draft_workspaces(
    manager: tauri::State<'_, PluginPackageManager>,
) -> Vec<DraftWorkspace> {
    manager.list_workspaces()
}

#[tauri::command]
pub(crate) fn read_draft_workspace_files(
    manager: tauri::State<'_, PluginPackageManager>,
    workspace_id: String,
) -> Result<Vec<DraftWorkspaceFilePayload>, String> {
    manager.read_workspace_files(&workspace_id)
}

#[tauri::command]
pub(crate) fn create_draft_workspace(
    manager: tauri::State<'_, PluginPackageManager>,
    input: CreateWorkspaceInput,
) -> Result<DraftWorkspace, String> {
    manager.create_workspace(input)
}

#[tauri::command]
pub(crate) fn import_draft_workspace(
    manager: tauri::State<'_, PluginPackageManager>,
    artifact_path: String,
) -> Result<DraftWorkspace, String> {
    manager.import_workspace(Path::new(&artifact_path))
}

#[tauri::command]
pub(crate) fn copy_installation_to_draft_workspace(
    manager: tauri::State<'_, PluginPackageManager>,
    installation_id: String,
) -> Result<DraftWorkspace, String> {
    manager.copy_installation_to_workspace(&installation_id)
}

#[tauri::command]
pub(crate) fn pack_draft_workspace(
    manager: tauri::State<'_, PluginPackageManager>,
    workspace_id: String,
    output_path: Option<String>,
) -> Result<PackWorkspaceResult, String> {
    manager.pack_workspace(&workspace_id, output_path.as_deref().map(Path::new))
}

#[tauri::command]
pub(crate) fn mark_draft_workspace_published(
    manager: tauri::State<'_, PluginPackageManager>,
    workspace_id: String,
    release_id: String,
    version: String,
    content_sha256: String,
) -> Result<DraftWorkspace, String> {
    manager.mark_workspace_published(&workspace_id, &release_id, &version, &content_sha256)
}

#[tauri::command]
pub(crate) fn delete_draft_workspace(
    manager: tauri::State<'_, PluginPackageManager>,
    workspace_id: String,
) -> Result<(), String> {
    manager.delete_workspace(&workspace_id)
}

#[tauri::command]
pub(crate) fn sync_draft_workspace_metadata(
    manager: tauri::State<'_, PluginPackageManager>,
    workspace_id: String,
    conversation_id: Option<String>,
    source_kind: Option<PluginReleaseSourceKind>,
    source_label: Option<String>,
) -> Result<DraftWorkspace, String> {
    manager.sync_workspace_metadata(&workspace_id, conversation_id, source_kind, source_label)
}

#[tauri::command]
pub(crate) fn inspect_lfplugin_v4(artifact_path: String) -> Result<InspectedArtifact, String> {
    inspect_artifact(Path::new(&artifact_path))
}

#[tauri::command]
pub(crate) fn sha256_lfplugin(artifact_path: String) -> Result<String, String> {
    sha256_file(Path::new(&artifact_path))
}
