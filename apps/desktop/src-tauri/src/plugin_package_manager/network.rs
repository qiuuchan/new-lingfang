use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::time::Duration;

use base64::{engine::general_purpose, Engine as _};
use futures_util::StreamExt;
use reqwest::header::{HeaderMap, HeaderName, HeaderValue, CONTENT_LENGTH, CONTENT_TYPE};
use serde_json::Value;
use tauri::ipc::Channel;
use uuid::Uuid;

use crate::plugin_artifact_v4::{inspect_artifact, InspectedArtifact};

use super::{
    normalize_release_provenance, DownloadReleaseInput, InstallArtifactInput, InstallFromUrlInput,
    LocalInstallation, PackageTransferEvent, PluginPackageManager, PluginReleaseSourceKind,
    PublishLocalArtifactInput, PublishWorkspaceInput, ReleaseProvenance,
};

const UPLOAD_CHUNK_SIZE: usize = 64 * 1024;
const SOURCE_KIND_HEADER: HeaderName = HeaderName::from_static("x-plugin-source-kind");
const SOURCE_LABEL_HEADER: HeaderName = HeaderName::from_static("x-plugin-source-label-b64");
const PACKAGE_ID_HEADER: HeaderName = HeaderName::from_static("x-plugin-package-id");
const CLIENT_HEADER: HeaderName = HeaderName::from_static("x-client");

fn resolve_provenance(
    source_kind: Option<PluginReleaseSourceKind>,
    source_label: Option<&str>,
    fallback_kind: PluginReleaseSourceKind,
    fallback_label: &str,
) -> Result<ReleaseProvenance, String> {
    let kind = source_kind.unwrap_or(fallback_kind);
    let label = source_label.or_else(|| source_kind.is_none().then_some(fallback_label));
    normalize_release_provenance(kind, label)
}

fn artifact_upload_headers(
    total_bytes: u64,
    package_id: Option<&str>,
    provenance: &ReleaseProvenance,
) -> Result<HeaderMap, String> {
    let mut headers = HeaderMap::new();
    headers.insert(
        CONTENT_TYPE,
        HeaderValue::from_static("application/vnd.lingfang.plugin+zip"),
    );
    headers.insert(
        CONTENT_LENGTH,
        HeaderValue::from_str(&total_bytes.to_string())
            .map_err(|error| format!("插件制品大小无法写入请求头：{error}"))?,
    );
    headers.insert(CLIENT_HEADER, HeaderValue::from_static("desktop"));
    headers.insert(
        SOURCE_KIND_HEADER,
        HeaderValue::from_static(provenance.source_kind.as_header_value()),
    );
    let label = general_purpose::URL_SAFE_NO_PAD.encode(provenance.source_label.as_bytes());
    headers.insert(
        SOURCE_LABEL_HEADER,
        HeaderValue::from_str(&label)
            .map_err(|error| format!("插件来源标签无法写入请求头：{error}"))?,
    );
    if let Some(package_id) = package_id.map(str::trim).filter(|value| !value.is_empty()) {
        headers.insert(
            PACKAGE_ID_HEADER,
            HeaderValue::from_str(package_id)
                .map_err(|error| format!("插件 packageId 无法写入请求头：{error}"))?,
        );
    }
    Ok(headers)
}

async fn upload_artifact_file(
    path: &Path,
    api_base: &str,
    auth_token: &str,
    package_id: Option<&str>,
    provenance: &ReleaseProvenance,
    on_event: Channel<PackageTransferEvent>,
) -> Result<Value, String> {
    let total_bytes = fs::metadata(path)
        .map_err(|error| format!("读取待上传制品失败：{error}"))?
        .len();
    let file = fs::File::open(path).map_err(|error| format!("读取待上传制品失败：{error}"))?;
    let _ = on_event.send(PackageTransferEvent::Started {
        total_bytes: Some(total_bytes),
    });
    let event = on_event.clone();
    let stream = futures_util::stream::unfold(file, move |mut file| {
        let event = event.clone();
        async move {
            let mut buffer = vec![0_u8; UPLOAD_CHUNK_SIZE];
            match file.read(&mut buffer) {
                Ok(0) => None,
                Ok(read) => {
                    buffer.truncate(read);
                    let _ = event.send(PackageTransferEvent::Progress { chunk_length: read });
                    Some((
                        Ok::<bytes::Bytes, std::io::Error>(bytes::Bytes::from(buffer)),
                        file,
                    ))
                }
                Err(error) => Some((Err(error), file)),
            }
        }
    });
    let headers = artifact_upload_headers(total_bytes, package_id, provenance)?;
    let url = format!(
        "{}/api/plugin-registry/releases",
        api_base.trim_end_matches('/')
    );
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(1800))
        .build()
        .map_err(|error| format!("创建插件上传客户端失败：{error}"))?;
    let response = client
        .post(url)
        .bearer_auth(auth_token.trim())
        .headers(headers)
        .body(reqwest::Body::wrap_stream(stream))
        .send()
        .await
        .map_err(|error| format!("上传插件制品失败：{error}"))?;
    let status = response.status();
    // 先读 body 文本再判定：服务端 / 网关返回非 JSON（如 Node 408、nginx HTML 错误页）时，
    // 直接 .json() 会吞掉响应体只剩「error decoding response body」无从排查。改为先 text()
    // 再按状态码分流，非 JSON 响应体原样回显，定位是服务端 JSON 错误还是网关层超时。
    let body_text = response.text().await.unwrap_or_default();
    if !status.is_success() {
        let parsed = serde_json::from_str::<Value>(&body_text).ok();
        let message = parsed
            .as_ref()
            .and_then(|value| value.get("message"))
            .and_then(Value::as_str);
        return Err(match message {
            Some(msg) => format!("发布插件失败（HTTP {status}）：{msg}"),
            None if body_text.trim().is_empty() => {
                format!("发布插件失败（HTTP {status}）：服务端未返回响应体（常见于网关/Node 请求超时，如大制品上传超过服务端 requestTimeout）")
            }
            None => format!("发布插件失败（HTTP {status}）：{}", body_text.trim()),
        });
    }
    let response_json: Value = serde_json::from_str(&body_text)
        .map_err(|error| format!("解析发布响应失败（HTTP {status}）：{error}"))?;
    Ok(response_json)
}

fn prepare_local_artifact(
    input: &PublishLocalArtifactInput,
) -> Result<(PathBuf, InspectedArtifact, ReleaseProvenance), String> {
    let path = PathBuf::from(input.artifact_path.trim());
    if path.as_os_str().is_empty() {
        return Err("请选择要发布的 .lfplugin 制品".to_string());
    }
    let inspected = inspect_artifact(&path)?;
    let provenance = resolve_provenance(
        input.source_kind,
        input.source_label.as_deref(),
        PluginReleaseSourceKind::LocalArtifact,
        "",
    )?;
    Ok((path, inspected, provenance))
}

/// 把下载制品时的非 2xx 响应渲染成可读错误提示。
///
/// 服务端返回标准错误体 `{code, message, requestId}`：对已知 code 给出中文语义提示，
/// 否则保留 HTTP 状态码与原始 body 便于排查；并尽量附上 requestId（编号 #…）供报修。
fn render_download_error(status: reqwest::StatusCode, body: &str) -> String {
    let parsed = serde_json::from_str::<Value>(body).ok();
    let code = parsed
        .as_ref()
        .and_then(|value| value.get("code"))
        .and_then(Value::as_str)
        .unwrap_or("");
    let request_id = parsed
        .as_ref()
        .and_then(|value| value.get("requestId"))
        .and_then(Value::as_str);

    let request_suffix = |id: Option<&str>| match id {
        Some(id) if !id.is_empty() => format!("（编号 #{id}，报修时提供）"),
        _ => String::new(),
    };

    let hint = match code {
        "plugin_artifact_unavailable" => Some("制品文件已被清理或不可用，请联系作者重新发布"),
        "not_found" => Some("插件发行版不存在或已撤回"),
        "forbidden" => Some("没有该插件的使用授权"),
        "payment_required" => Some("当前团队尚未购买该插件"),
        "plugin_ai_policy_required" => Some("该插件未通过当前 AI 使用政策检查"),
        "client_upgrade_required" => Some("插件协议已停用，请升级桌面客户端后重试"),
        _ => None,
    };
    if let Some(hint) = hint {
        return format!("下载插件制品失败：{hint}{}", request_suffix(request_id));
    }
    let suffix = request_suffix(request_id);
    if suffix.is_empty() {
        format!("下载插件制品失败（HTTP {status}）：{body}")
    } else {
        format!("下载插件制品失败（HTTP {status}）{suffix}：{body}")
    }
}

#[tauri::command]
pub(crate) async fn download_plugin_release(
    manager: tauri::State<'_, PluginPackageManager>,
    input: DownloadReleaseInput,
    on_event: Channel<PackageTransferEvent>,
) -> Result<LocalInstallation, String> {
    let manager = manager.inner().clone();
    let _ = on_event.send(PackageTransferEvent::Stage {
        stage: "downloading".to_string(),
        message: "正在下载插件制品".to_string(),
    });
    let url = format!(
        "{}/api/plugin-releases/{}/artifact",
        input.api_base.trim_end_matches('/'),
        input.release_id
    );
    let response = reqwest::Client::new()
        .get(url)
        .bearer_auth(input.auth_token.trim())
        .header("X-Client", "desktop")
        .send()
        .await
        .map_err(|error| format!("下载插件制品失败：{error}"))?;
    let status = response.status();
    if !status.is_success() {
        let body = response.text().await.unwrap_or_default();
        return Err(render_download_error(status, &body));
    }
    let total = response.content_length();
    let _ = on_event.send(PackageTransferEvent::Started { total_bytes: total });
    let staging = manager
        .staging_root()
        .join(format!("download-{}", Uuid::new_v4()));
    fs::create_dir_all(&staging).map_err(|error| format!("创建下载暂存目录失败：{error}"))?;
    let artifact_path = staging.join("artifact.lfplugin");
    let mut output = fs::File::create(&artifact_path)
        .map_err(|error| format!("创建下载暂存文件失败：{error}"))?;
    let mut stream = response.bytes_stream();
    let download_result = async {
        while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(|error| format!("接收插件制品失败：{error}"))?;
            output
                .write_all(&chunk)
                .map_err(|error| format!("写入插件制品失败：{error}"))?;
            let _ = on_event.send(PackageTransferEvent::Progress {
                chunk_length: chunk.len(),
            });
        }
        output
            .flush()
            .map_err(|error| format!("刷新插件制品失败：{error}"))
    }
    .await;
    if let Err(error) = download_result {
        let _ = fs::remove_dir_all(&staging);
        return Err(error);
    }
    let _ = on_event.send(PackageTransferEvent::Stage {
        stage: "verifying".to_string(),
        message: "正在校验 SHA-256 和 ZIP 结构".to_string(),
    });
    let release_id = input.release_id.clone();
    let installed = manager.install(InstallArtifactInput {
        artifact_path: artifact_path.to_string_lossy().to_string(),
        expected_sha256: Some(input.sha256),
        package_id: Some(input.package_id.clone()),
        release_id: Some(release_id.clone()),
        origin: input.origin,
        protected: false,
    });
    let _ = fs::remove_dir_all(staging);
    let installed = match installed {
        Ok(value) => value,
        Err(error) => {
            if error.contains("SHA-256") {
                let _ = reqwest::Client::new()
                    .post(format!(
                        "{}/api/plugin-releases/{}/report-integrity-failure",
                        input.api_base.trim_end_matches('/'),
                        release_id
                    ))
                    .bearer_auth(input.auth_token.trim())
                    .json(&serde_json::json!({ "detail": error }))
                    .send()
                    .await;
            }
            return Err(error);
        }
    };
    let _ = on_event.send(PackageTransferEvent::Finished);
    Ok(installed)
}

#[tauri::command]
pub(crate) async fn install_plugin_from_url(
    manager: tauri::State<'_, PluginPackageManager>,
    input: InstallFromUrlInput,
    on_event: Channel<PackageTransferEvent>,
) -> Result<LocalInstallation, String> {
    let manager = manager.inner().clone();
    let _ = on_event.send(PackageTransferEvent::Stage {
        stage: "downloading".to_string(),
        message: "正在下载插件制品".to_string(),
    });
    let response = reqwest::Client::new()
        .get(input.url.trim())
        .header("X-Client", "desktop")
        .send()
        .await
        .map_err(|error| format!("下载插件制品失败：{error}"))?;
    let status = response.status();
    if !status.is_success() {
        return Err(format!("下载插件制品失败（HTTP {status}）"));
    }
    let total = response.content_length();
    let _ = on_event.send(PackageTransferEvent::Started { total_bytes: total });
    let staging = manager
        .staging_root()
        .join(format!("download-{}", Uuid::new_v4()));
    fs::create_dir_all(&staging).map_err(|error| format!("创建下载暂存目录失败：{error}"))?;
    let artifact_path = staging.join("artifact.lfplugin");
    let mut output = fs::File::create(&artifact_path)
        .map_err(|error| format!("创建下载暂存文件失败：{error}"))?;
    let mut stream = response.bytes_stream();
    let download_result = async {
        while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(|error| format!("接收插件制品失败：{error}"))?;
            output
                .write_all(&chunk)
                .map_err(|error| format!("写入插件制品失败：{error}"))?;
            let _ = on_event.send(PackageTransferEvent::Progress {
                chunk_length: chunk.len(),
            });
        }
        output
            .flush()
            .map_err(|error| format!("刷新插件制品失败：{error}"))
    }
    .await;
    if let Err(error) = download_result {
        let _ = fs::remove_dir_all(&staging);
        return Err(error);
    }
    let _ = on_event.send(PackageTransferEvent::Stage {
        stage: "verifying".to_string(),
        message: "正在校验 SHA-256 和 ZIP 结构".to_string(),
    });
    let installed = manager.install(InstallArtifactInput {
        artifact_path: artifact_path.to_string_lossy().to_string(),
        expected_sha256: input.sha256.clone(),
        package_id: input.package_id.clone(),
        release_id: None,
        origin: input.origin,
        protected: input.protected,
    });
    let _ = fs::remove_dir_all(staging);
    let _ = on_event.send(PackageTransferEvent::Finished);
    installed
}

#[tauri::command]
pub(crate) async fn publish_draft_workspace(
    manager: tauri::State<'_, PluginPackageManager>,
    input: PublishWorkspaceInput,
    on_event: Channel<PackageTransferEvent>,
) -> Result<Value, String> {
    let manager = manager.inner().clone();
    let workspace = manager.workspace(&input.workspace_id)?;
    let provenance = resolve_provenance(
        input.source_kind,
        input.source_label.as_deref(),
        workspace.source_kind,
        &workspace.source_label,
    )?;
    let _ = on_event.send(PackageTransferEvent::Stage {
        stage: "packing".to_string(),
        message: "正在生成 .lfplugin v4 制品".to_string(),
    });
    let packed = manager.pack_workspace(&input.workspace_id, None)?;
    let version = packed
        .artifact
        .manifest
        .get("version")
        .and_then(Value::as_str)
        .ok_or_else(|| "manifest.version 缺失".to_string())?
        .to_string();
    manager.ensure_workspace_publishable(&input.workspace_id, &version, &packed.artifact.sha256)?;
    let path = PathBuf::from(&packed.artifact_path);
    let _ = on_event.send(PackageTransferEvent::Stage {
        stage: "uploading".to_string(),
        message: "正在上传插件制品".to_string(),
    });
    let response_json = upload_artifact_file(
        &path,
        &input.api_base,
        &input.auth_token,
        input.package_id.as_deref(),
        &provenance,
        on_event.clone(),
    )
    .await?;
    let release = response_json
        .get("release")
        .ok_or_else(|| "发布响应缺少 release".to_string())?;
    let release_id = release
        .get("id")
        .and_then(Value::as_str)
        .ok_or_else(|| "发布响应缺少 release.id".to_string())?;
    let release_version = release
        .get("version")
        .and_then(Value::as_str)
        .ok_or_else(|| "发布响应缺少 release.version".to_string())?;
    manager.mark_workspace_published(
        &input.workspace_id,
        release_id,
        release_version,
        &packed.artifact.sha256,
    )?;
    let _ = on_event.send(PackageTransferEvent::Finished);
    Ok(response_json)
}

#[tauri::command]
pub(crate) async fn publish_local_artifact(
    input: PublishLocalArtifactInput,
    on_event: Channel<PackageTransferEvent>,
) -> Result<Value, String> {
    let _ = on_event.send(PackageTransferEvent::Stage {
        stage: "verifying".to_string(),
        message: "正在校验 .lfplugin v4 制品".to_string(),
    });
    let (path, _, provenance) = prepare_local_artifact(&input)?;
    let _ = on_event.send(PackageTransferEvent::Stage {
        stage: "uploading".to_string(),
        message: "正在上传插件制品".to_string(),
    });
    let response = upload_artifact_file(
        &path,
        &input.api_base,
        &input.auth_token,
        input.package_id.as_deref(),
        &provenance,
        on_event.clone(),
    )
    .await?;
    let _ = on_event.send(PackageTransferEvent::Finished);
    Ok(response)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::plugin_artifact_v4::package_workspace;
    use reqwest::StatusCode;

    fn temp(name: &str) -> PathBuf {
        std::env::temp_dir().join(format!("lingfang-network-{name}-{}", Uuid::new_v4()))
    }

    #[test]
    fn artifact_upload_headers_include_desktop_provenance() {
        let provenance = normalize_release_provenance(
            PluginReleaseSourceKind::ExternalTool,
            Some("Cursor 工作区"),
        )
        .unwrap();
        let headers = artifact_upload_headers(42, Some("package-1"), &provenance).unwrap();
        assert_eq!(headers.get(CLIENT_HEADER).unwrap(), "desktop");
        assert_eq!(headers.get(SOURCE_KIND_HEADER).unwrap(), "EXTERNAL_TOOL");
        assert_eq!(headers.get(PACKAGE_ID_HEADER).unwrap(), "package-1");
        assert_eq!(headers.get(CONTENT_LENGTH).unwrap(), "42");
        let encoded = headers.get(SOURCE_LABEL_HEADER).unwrap().to_str().unwrap();
        let decoded = general_purpose::URL_SAFE_NO_PAD.decode(encoded).unwrap();
        assert_eq!(String::from_utf8(decoded).unwrap(), "Cursor 工作区");
    }

    #[test]
    fn direct_artifact_preparation_inspects_v4_and_drops_absolute_source_path() {
        let root = temp("direct");
        let workspace = root.join("workspace");
        fs::create_dir_all(&workspace).unwrap();
        fs::write(
            workspace.join("manifest.json"),
            r#"{"id":"direct-demo","name":"Direct","version":"1.0.0","runtime_type":"client","entry":"index.html"}"#,
        )
        .unwrap();
        fs::write(workspace.join("index.html"), "<p>direct</p>").unwrap();
        let artifact_path = root.join("direct.lfplugin");
        let artifact = package_workspace(&workspace, &artifact_path).unwrap();
        let input = PublishLocalArtifactInput {
            api_base: "http://localhost:8787".to_string(),
            auth_token: "token".to_string(),
            artifact_path: artifact_path.to_string_lossy().to_string(),
            package_id: None,
            source_kind: Some(PluginReleaseSourceKind::LocalArtifact),
            source_label: Some(artifact_path.to_string_lossy().to_string()),
        };

        let (prepared_path, inspected, provenance) = prepare_local_artifact(&input).unwrap();
        assert_eq!(prepared_path, artifact_path);
        assert_eq!(inspected.sha256, artifact.sha256);
        assert_eq!(
            provenance.source_label,
            PluginReleaseSourceKind::LocalArtifact.default_label()
        );
        assert!(!provenance
            .source_label
            .contains(root.to_string_lossy().as_ref()));
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn render_download_error_maps_known_codes() {
        let unavailable = r#"{"code":"plugin_artifact_unavailable","message":"x","requestId":"abc-123"}"#;
        let msg = render_download_error(StatusCode::GONE, unavailable);
        assert!(msg.contains("制品文件已被清理"));
        assert!(msg.contains("abc-123"));

        let not_found = r#"{"code":"not_found","requestId":"r-1"}"#;
        assert!(render_download_error(StatusCode::NOT_FOUND, not_found).contains("不存在或已撤回"));

        let forbidden = r#"{"code":"forbidden","requestId":"r-2"}"#;
        assert!(render_download_error(StatusCode::FORBIDDEN, forbidden).contains("使用授权"));

        let policy = r#"{"code":"plugin_ai_policy_required","requestId":"r-3"}"#;
        assert!(render_download_error(StatusCode::CONFLICT, policy).contains("AI 使用政策"));
    }

    #[test]
    fn render_download_error_falls_back_for_unknown_body() {
        let msg = render_download_error(StatusCode::INTERNAL_SERVER_ERROR, "not json");
        assert!(msg.contains("HTTP 500"));
        assert!(msg.contains("not json"));

        let internal = r#"{"code":"internal_error","requestId":"r-4"}"#;
        let msg = render_download_error(StatusCode::INTERNAL_SERVER_ERROR, internal);
        assert!(msg.contains("HTTP 500"));
        assert!(msg.contains("r-4"));
    }
}
