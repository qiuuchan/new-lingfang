//! 客户端 iframe 插件的 AI 能力代理（C2 决策）。
//!
//! 背景：client HTML 插件运行在 iframe 内，绝不持有 relay 凭证（api_base / auth_token）。
//! 其 AI 调用改由宿主侧新 Tauri 命令代理：命令从 PluginStore 读取用户设置的 relay 凭证，
//! 校验插件在 manifest 声明了对应能力后，构造瞬态 BridgeSession 转发到平台 relay。
//!
//! 与 plugin_llm_bridge 的 nodejs/python 桥的区别：不经 localhost TCP 桥、不入会话表，
//! 直接复用 relay_* 辅助函数转发。凭证只在宿主内存，iframe 拿不到。

use serde_json::Value;
use tauri::State;

use crate::capability::CapabilityRegistry;
use crate::plugin_llm_bridge::{
    build_image_edit_multipart, extract_chat_content, extract_image_urls, parse_model_tier,
    relay_post_json, relay_post_json_timeout, relay_post_raw, BridgeSession,
};
use crate::plugin_store::PluginStore;
use crate::AppState;

/// 校验命令（与 plugin_llm_bridge 的 route 函数同款前缀），前缀供前端检测并展示友好文案。
const ERR_RELAY_NOT_CONFIGURED: &str = "relay_not_configured:";
const ERR_CAPABILITY_NOT_DECLARED: &str = "capability_not_declared:";
const ERR_RELAY_ERROR: &str = "relay_error:";

/// 从 PluginStore 读取 relay 凭证；缺失返回 relay_not_configured 错误（携带中文提示）。
fn require_relay(store: &PluginStore) -> Result<(String, String), String> {
    let settings = store.relay_settings();
    let api_base = settings
        .api_base
        .filter(|s| !s.trim().is_empty())
        .ok_or_else(|| format!("{ERR_RELAY_NOT_CONFIGURED}请在设置中配置 relay api_base 与 auth_token"))?;
    let auth_token = settings
        .auth_token
        .filter(|s| !s.trim().is_empty())
        .ok_or_else(|| format!("{ERR_RELAY_NOT_CONFIGURED}请在设置中配置 relay api_base 与 auth_token"))?;
    Ok((api_base, auth_token))
}

/// 校验插件声明了指定能力（复用 capability gateway 的 registry.find）。
fn require_capability(registry: &CapabilityRegistry, plugin_id: &str, kind: &str) -> Result<(), String> {
    if registry.find(plugin_id, kind).is_none() {
        return Err(format!("{ERR_CAPABILITY_NOT_DECLARED}{kind}"));
    }
    Ok(())
}

/// 把 BridgeError 映射为前端可读的 relay_error 前缀错误。
fn map_relay_err(e: crate::plugin_llm_bridge::BridgeError) -> String {
    format!("{ERR_RELAY_ERROR}{}", e.message)
}

#[tauri::command]
pub fn client_llm_chat(
    store: State<'_, PluginStore>,
    app_state: State<'_, AppState>,
    plugin_id: String,
    args: Value,
) -> Result<Value, String> {
    let (api_base, auth_token) = require_relay(&store)?;
    require_capability(&app_state.registry, &plugin_id, "llm.chat")?;
    let session = BridgeSession::new_transient(
        &plugin_id, &api_base, &auth_token, true, false, false, false, false,
    );
    let messages = args
        .get("messages")
        .and_then(|v| v.as_array())
        .filter(|items| !items.is_empty())
        .cloned()
        .ok_or_else(|| format!("{ERR_RELAY_ERROR}llm.chat 缺少 messages"))?;
    let model = parse_model_tier(&args).map_err(map_relay_err)?;
    let relay_body = serde_json::json!({
        "model": model,
        "messages": messages,
        "stream": false,
    });
    let data = relay_post_json(&session, "/api/relay/v1/chat/completions", &relay_body)
        .map_err(map_relay_err)?;
    let content = extract_chat_content(&data);
    Ok(serde_json::json!({ "content": content }))
}

#[tauri::command]
pub fn client_image_generate(
    store: State<'_, PluginStore>,
    app_state: State<'_, AppState>,
    plugin_id: String,
    args: Value,
) -> Result<Value, String> {
    let (api_base, auth_token) = require_relay(&store)?;
    require_capability(&app_state.registry, &plugin_id, "image.generate")?;
    let session = BridgeSession::new_transient(
        &plugin_id, &api_base, &auth_token, false, true, false, false, false,
    );
    let prompt = args
        .get("prompt")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .ok_or_else(|| format!("{ERR_RELAY_ERROR}image.generate 缺少 prompt"))?
        .to_string();
    let model = parse_model_tier(&args).map_err(map_relay_err)?;
    let n = args
        .get("n")
        .and_then(|v| v.as_u64())
        .unwrap_or(1)
        .clamp(1, 4) as u32;
    let size = args
        .get("size")
        .and_then(|v| v.as_str())
        .unwrap_or("1024x1024")
        .to_string();
    let relay_body = serde_json::json!({
        "model": model,
        "prompt": prompt,
        "n": n,
        "size": size,
    });
    let data = relay_post_json(&session, "/api/relay/v1/images/generations", &relay_body)
        .map_err(map_relay_err)?;
    let images = extract_image_urls(&data);
    Ok(serde_json::json!({ "images": images }))
}

#[tauri::command]
pub fn client_image_edit(
    store: State<'_, PluginStore>,
    app_state: State<'_, AppState>,
    plugin_id: String,
    args: Value,
) -> Result<Value, String> {
    use base64::{engine::general_purpose::STANDARD as BASE64_STANDARD, Engine as _};

    let (api_base, auth_token) = require_relay(&store)?;
    require_capability(&app_state.registry, &plugin_id, "image.edit")?;
    let session = BridgeSession::new_transient(
        &plugin_id, &api_base, &auth_token, false, false, true, false, false,
    );

    let prompt = args
        .get("prompt")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .ok_or_else(|| format!("{ERR_RELAY_ERROR}image.edit 缺少 prompt"))?
        .to_string();
    let images = args
        .get("images")
        .and_then(|v| v.as_array())
        .filter(|items| !items.is_empty())
        .ok_or_else(|| format!("{ERR_RELAY_ERROR}image.edit 缺少 images（至少 1 张参考图）"))?;
    let tier = parse_model_tier(&args).map_err(map_relay_err)?;
    let n = args
        .get("n")
        .and_then(|v| v.as_u64())
        .unwrap_or(1)
        .clamp(1, 4) as u32;
    let size = args
        .get("size")
        .and_then(|v| v.as_str())
        .unwrap_or("1024x1024")
        .to_string();

    // 复用 route_image_edit 的参考图解码逻辑：base64 → 原始字节。
    let mut decoded: Vec<(String, String, Vec<u8>)> = Vec::with_capacity(images.len());
    for (index, item) in images.iter().enumerate() {
        let filename = sanitize_filename(
            item.get("filename").and_then(|v| v.as_str()).unwrap_or("image"),
        );
        let mime = item
            .get("mimeType")
            .and_then(|v| v.as_str())
            .or_else(|| item.get("mime_type").and_then(|v| v.as_str()))
            .unwrap_or("image/jpeg")
            .to_string();
        let data_b64 = item
            .get("data")
            .and_then(|v| v.as_str())
            .ok_or_else(|| format!("{ERR_RELAY_ERROR}image.edit 第 {index} 张图片缺少 data(base64)"))?;
        let bytes = BASE64_STANDARD.decode(data_b64.trim()).map_err(|_| {
            format!("{ERR_RELAY_ERROR}image.edit 第 {index} 张图片 data 不是合法 base64")
        })?;
        if bytes.is_empty() {
            return Err(format!("{ERR_RELAY_ERROR}image.edit 第 {index} 张图片数据为空"));
        }
        decoded.push((filename, mime, bytes));
    }

    let (multipart_body, content_type) = build_image_edit_multipart(&prompt, &decoded, n, &size);
    let path = format!("/api/relay/v1/images/edits?model={tier}");
    let data = relay_post_raw(&session, &path, &content_type, &multipart_body).map_err(map_relay_err)?;
    let images_out = extract_image_urls(&data);
    if images_out.is_empty() {
        return Err(format!("{ERR_RELAY_ERROR}平台未返回编辑后的图片"));
    }
    Ok(serde_json::json!({ "images": images_out }))
}

#[tauri::command]
pub fn client_video_generate(
    store: State<'_, PluginStore>,
    app_state: State<'_, AppState>,
    plugin_id: String,
    args: Value,
) -> Result<Value, String> {
    let (api_base, auth_token) = require_relay(&store)?;
    require_capability(&app_state.registry, &plugin_id, "video.generate")?;
    let session = BridgeSession::new_transient(
        &plugin_id, &api_base, &auth_token, false, false, false, true, false,
    );
    let seconds = args
        .get("seconds")
        .and_then(|v| v.as_u64().map(|n| n as f64).or_else(|| v.as_f64()))
        .filter(|v| *v > 0.0)
        .ok_or_else(|| format!("{ERR_RELAY_ERROR}video.generate 缺少 seconds（正数）"))?;
    let tier = parse_model_tier(&args).map_err(map_relay_err)?;
    let image_b64 = args
        .get("image")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .ok_or_else(|| format!("{ERR_RELAY_ERROR}video.generate 缺少 image(base64)"))?
        .to_string();
    let video_b64 = args
        .get("video")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .ok_or_else(|| format!("{ERR_RELAY_ERROR}video.generate 缺少 video(base64)"))?
        .to_string();
    let image_filename = sanitize_filename(
        args.get("image_filename").and_then(|v| v.as_str()).unwrap_or("image"),
    );
    let video_filename = sanitize_filename(
        args.get("video_filename").and_then(|v| v.as_str()).unwrap_or("video"),
    );
    let image_mime = args
        .get("image_mime_type")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string())
        .unwrap_or_else(|| image_mime_for(&image_filename).to_string());
    let video_mime = args
        .get("video_mime_type")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string())
        .unwrap_or_else(|| video_mime_for(&video_filename).to_string());
    let callback_url = args.get("callback_url").and_then(|v| v.as_str());

    let mut relay_body = serde_json::json!({
        "image": image_b64,
        "video": video_b64,
        "image_filename": image_filename,
        "video_filename": video_filename,
        "image_mime_type": image_mime,
        "video_mime_type": video_mime,
        "seconds": seconds,
        "model": tier,
    });
    if let Some(cb) = callback_url.filter(|s| !s.trim().is_empty()) {
        relay_body["callback_url"] = Value::String(cb.to_string());
    }
    let out = relay_post_json_timeout(
        &session,
        "/api/relay/v1/videos/generations",
        &relay_body,
        std::time::Duration::from_secs(600),
    )
    .map_err(map_relay_err)?;
    Ok(out)
}

#[tauri::command]
pub fn client_audio_generate(
    store: State<'_, PluginStore>,
    app_state: State<'_, AppState>,
    plugin_id: String,
    args: Value,
) -> Result<Value, String> {
    let (api_base, auth_token) = require_relay(&store)?;
    require_capability(&app_state.registry, &plugin_id, "audio.generate")?;
    let session = BridgeSession::new_transient(
        &plugin_id, &api_base, &auth_token, false, false, false, false, true,
    );
    let tier = parse_model_tier(&args).map_err(map_relay_err)?;
    let audio_b64 = args
        .get("audio")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .ok_or_else(|| format!("{ERR_RELAY_ERROR}audio.generate 缺少 audio(base64)"))?
        .to_string();
    let prompt_text = args
        .get("prompt_text")
        .and_then(|v| v.as_str())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .ok_or_else(|| format!("{ERR_RELAY_ERROR}audio.generate 缺少 prompt_text（目标文本）"))?;
    let audio_filename = sanitize_filename(
        args.get("audio_filename").and_then(|v| v.as_str()).unwrap_or("audio"),
    );
    let audio_mime = args
        .get("audio_mime_type")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string())
        .unwrap_or_else(|| audio_mime_for(&audio_filename).to_string());
    let callback_url = args.get("callback_url").and_then(|v| v.as_str());

    let mut relay_body = serde_json::json!({
        "audio": audio_b64,
        "audio_filename": audio_filename,
        "audio_mime_type": audio_mime,
        "prompt_text": prompt_text,
        "model": tier,
    });
    if let Some(cb) = callback_url.filter(|s| !s.trim().is_empty()) {
        relay_body["callback_url"] = Value::String(cb.to_string());
    }
    let out = relay_post_json_timeout(
        &session,
        "/api/relay/v1/audio/generations",
        &relay_body,
        std::time::Duration::from_secs(600),
    )
    .map_err(map_relay_err)?;
    Ok(out)
}

// === 复用 route 函数内的辅助（与 plugin_llm_bridge 同名私有函数对齐） ===

fn sanitize_filename(raw: &str) -> String {
    let base = raw.split(['/', '\\']).next_back().unwrap_or(raw);
    let cleaned: String = base
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '.' || c == '-' || c == '_' {
                c
            } else {
                '_'
            }
        })
        .collect();
    if cleaned.is_empty() {
        "image".to_string()
    } else {
        cleaned
    }
}

fn image_mime_for(filename: &str) -> &'static str {
    let lower = filename.to_ascii_lowercase();
    if lower.ends_with(".jpg") || lower.ends_with(".jpeg") {
        "image/jpeg"
    } else if lower.ends_with(".webp") {
        "image/webp"
    } else if lower.ends_with(".gif") {
        "image/gif"
    } else {
        "image/png"
    }
}

fn video_mime_for(filename: &str) -> &'static str {
    let lower = filename.to_ascii_lowercase();
    if lower.ends_with(".webm") {
        "video/webm"
    } else if lower.ends_with(".mov") {
        "video/quicktime"
    } else if lower.ends_with(".avi") {
        "video/x-msvideo"
    } else {
        "video/mp4"
    }
}

fn audio_mime_for(filename: &str) -> &'static str {
    let lower = filename.to_ascii_lowercase();
    if lower.ends_with(".wav") {
        "audio/wav"
    } else if lower.ends_with(".flac") {
        "audio/flac"
    } else if lower.ends_with(".m4a") {
        "audio/mp4"
    } else if lower.ends_with(".aac") {
        "audio/aac"
    } else if lower.ends_with(".ogg") {
        "audio/ogg"
    } else if lower.ends_with(".opus") {
        "audio/opus"
    } else {
        "audio/mpeg"
    }
}
