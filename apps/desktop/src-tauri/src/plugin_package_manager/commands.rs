use std::path::{Path, PathBuf};

use crate::plugin_artifact_v4::{inspect_artifact, sha256_file, InspectedArtifact};
use crate::plugin_llm_bridge::PluginLlmBridge;
use crate::plugin_runner::{self, PluginProcessTable, StartPluginResult};

use super::{
    CreateWorkspaceInput, DependencyStatus, DraftWorkspace, DraftWorkspaceFilePayload,
    InstallArtifactInput, InstallationOrigin, InstalledPluginPayload, InstalledPluginPolicySource,
    LocalInstallation, PackWorkspaceResult, PluginPackageManager, PluginReleaseSourceKind,
    RegisterDevDirInput,
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
    app: tauri::AppHandle,
    manager: tauri::State<'_, PluginPackageManager>,
    app_state: tauri::State<'_, crate::AppState>,
    process_table: tauri::State<'_, PluginProcessTable>,
    installation_id: String,
) -> Result<InstalledPluginPayload, String> {
    let payload = manager.load_installed_plugin(&installation_id)?;
    // A4 补全：client 运行时的安装插件不经 start_plugin 进程路径（无进程概念），
    // 打开/加载入口时把 manifest 声明能力注册进网关注册表（幂等），
    // 否则已声明能力调用恒 capability_not_declared。
    let caps = crate::plugins::capabilities_from_manifest(&payload.manifest);
    if !caps.is_empty() {
        app_state.registry.register(&installation_id, caps);
    }
    // QX-02-R：开发态（Dev）来源在「打开/加载」时即启动目录监听（幂等，先停旧监听器）。
    // 前端列表加载/刷新、以及重启应用后的 hydration 均会调用本命令加载插件，
    // 而 start_installed_plugin（原 watch 调用点）前端零调用方——client 插件打开只走本路径，
    // 故 watch 必须补在「加载」入口，否则改文件永不触发 v2 自动重载（实测 30s 无重载）。
    if payload.installation.origin == InstallationOrigin::Dev {
        let dev_dir = std::path::PathBuf::from(&payload.installation.active_release.path);
        let dev_rt = plugin_runner::peek_runtime_type(&dev_dir);
        plugin_runner::watch_dev_dir(&app, &process_table, &installation_id, &dev_dir, &dev_rt);
    }
    Ok(payload)
}

#[tauri::command]
pub(crate) fn register_dev_dir(
    manager: tauri::State<'_, PluginPackageManager>,
    app_state: tauri::State<'_, crate::AppState>,
    input: RegisterDevDirInput,
) -> Result<LocalInstallation, String> {
    let installation = manager.register_dev_dir(input)?;
    // 与 load_installed_plugin 一致：开发态 client 插件无进程，加载/登记时把 manifest
    // 声明能力幂等注册进网关注册表，否则已声明能力调用恒 capability_not_declared。
    let payload = manager.load_installed_plugin(&installation.installation_id)?;
    let caps = crate::plugins::capabilities_from_manifest(&payload.manifest);
    if !caps.is_empty() {
        app_state.registry.register(&installation.installation_id, caps);
    }
    Ok(installation)
}

#[tauri::command]
pub(crate) fn unregister_dev_dir(
    manager: tauri::State<'_, PluginPackageManager>,
    dir: PathBuf,
) -> Result<(), String> {
    manager.unregister_dev_dir(dir)
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
    // 卸载开发态目录时一并停掉文件监听器（best-effort）。
    plugin_runner::stop_dev_watch(&process_table, &installation_id);
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
    // 开发态（Dev）来源：启动即监听源目录，文件变更触发自动重载 / 进程重启（best-effort）。
    // 必须放在 process_table 被 .inner().clone() 遮蔽之前（下方 offload 会移动 State）。
    if installation.origin == InstallationOrigin::Dev {
        let dev_dir = PathBuf::from(&release.path);
        let dev_rt = plugin_runner::peek_runtime_type(&dev_dir);
        plugin_runner::watch_dev_dir(&app, &process_table, &installation_id, &dev_dir, &dev_rt);
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
    plugin_runner::stop_plugin_by_id(&process_table, &bridge, &installation_id)?;
    // 停止开发态插件时一并移除监听器（best-effort）。
    plugin_runner::stop_dev_watch(&process_table, &installation_id);
    Ok(())
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
pub(crate) fn inspect_qplugin_v4(artifact_path: String) -> Result<InspectedArtifact, String> {
    inspect_artifact(Path::new(&artifact_path))
}

#[tauri::command]
pub(crate) fn sha256_qplugin(artifact_path: String) -> Result<String, String> {
    sha256_file(Path::new(&artifact_path))
}
