#[path = "src/builtin_plugin_index.rs"]
mod builtin_plugin_index;
#[allow(dead_code)]
#[path = "src/plugin_artifact_v4.rs"]
mod plugin_artifact_v4;

use std::collections::HashSet;
use std::fmt::Write as _;
use std::fs;
use std::path::{Path, PathBuf};

use builtin_plugin_index::{
    parse_builtin_index, BuiltinArtifactIndex, BuiltinArtifactIndexEntry, INDEX_FORMAT,
    INDEX_VERSION,
};
use plugin_artifact_v4::package_workspace;

fn main() {
    if let Err(error) = generate_builtin_bundle() {
        panic!("failed to build builtin plugin artifacts: {error}");
    }
    emit_app_version();
    tauri_build::build()
}

/// 把 tauri.conf.json 的 `version` 注入为编译期常量 `LINGFANG_APP_VERSION`，
/// 供 update.rs `get_app_version` / semver 比较使用（与 installer 侧 `LINGFANG_APP_VERSION`
/// 同源，避免应用侧/安装器侧版本漂移）。
fn emit_app_version() {
    let manifest_dir = PathBuf::from(
        std::env::var_os("CARGO_MANIFEST_DIR")
            .expect("CARGO_MANIFEST_DIR is missing"),
    );
    let conf_path = manifest_dir.join("tauri.conf.json");
    let raw = fs::read_to_string(&conf_path).expect("读取 tauri.conf.json 失败");
    let value: serde_json::Value = serde_json::from_str(&raw).expect("解析 tauri.conf.json 失败");
    let version = value
        .get("version")
        .and_then(|v| v.as_str())
        .expect("tauri.conf.json 缺少 version")
        .to_string();
    println!("cargo:rustc-env=LINGFANG_APP_VERSION={version}");
    println!("cargo:rerun-if-changed={}", conf_path.display());
}

fn generate_builtin_bundle() -> Result<(), String> {
    let manifest_dir = PathBuf::from(
        std::env::var_os("CARGO_MANIFEST_DIR")
            .ok_or_else(|| "CARGO_MANIFEST_DIR is missing".to_string())?,
    );
    let source_root = manifest_dir.join("../builtin-plugins");
    emit_rerun_paths(&source_root)?;

    let output_root =
        PathBuf::from(std::env::var_os("OUT_DIR").ok_or_else(|| "OUT_DIR is missing".to_string())?);
    let bundle_root = output_root.join("builtin-plugin-bundle");
    if bundle_root.exists() {
        fs::remove_dir_all(&bundle_root)
            .map_err(|error| format!("clear generated bundle: {error}"))?;
    }
    fs::create_dir_all(&bundle_root)
        .map_err(|error| format!("create generated bundle: {error}"))?;

    let mut workspaces = fs::read_dir(&source_root)
        .map_err(|error| format!("read {}: {error}", source_root.display()))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("read {}: {error}", source_root.display()))?;
    workspaces.sort_by_key(|entry| entry.file_name());

    let mut entries = Vec::new();
    let mut artifact_files = HashSet::new();
    for workspace in workspaces
        .into_iter()
        .map(|entry| entry.path())
        .filter(|path| path.is_dir())
    {
        if !workspace.join("manifest.json").is_file() {
            return Err(format!(
                "builtin workspace lacks manifest.json: {}",
                workspace.display()
            ));
        }
        let temporary = bundle_root.join(format!("artifact-{}.tmp", entries.len()));
        let inspected = package_workspace(&workspace, &temporary)?;
        let manifest_id = inspected
            .manifest
            .get("id")
            .and_then(serde_json::Value::as_str)
            .ok_or_else(|| format!("builtin manifest.id is missing: {}", workspace.display()))?
            .to_string();
        let version = inspected
            .manifest
            .get("version")
            .and_then(serde_json::Value::as_str)
            .ok_or_else(|| {
                format!(
                    "builtin manifest.version is missing: {}",
                    workspace.display()
                )
            })?
            .to_string();
        let artifact_file = format!("{}.lfplugin", inspected.sha256);
        if !artifact_files.insert(artifact_file.clone()) {
            return Err(format!(
                "duplicate builtin artifact SHA: {}",
                inspected.sha256
            ));
        }
        fs::rename(&temporary, bundle_root.join(&artifact_file))
            .map_err(|error| format!("commit {artifact_file}: {error}"))?;
        entries.push(BuiltinArtifactIndexEntry {
            package_id: format!("builtin:{manifest_id}"),
            release_id: format!("builtin-{}", inspected.sha256),
            manifest_id,
            version,
            artifact_file,
            sha256: inspected.sha256,
            size_bytes: inspected.size_bytes,
        });
    }
    entries.sort_by(|left, right| left.manifest_id.cmp(&right.manifest_id));

    let index = BuiltinArtifactIndex {
        format: INDEX_FORMAT.to_string(),
        format_version: INDEX_VERSION,
        artifacts: entries,
    };
    let mut index_json = serde_json::to_string_pretty(&index)
        .map_err(|error| format!("serialize builtin index: {error}"))?;
    index_json.push('\n');
    parse_builtin_index(&index_json)?;
    fs::write(bundle_root.join("index.json"), index_json)
        .map_err(|error| format!("write builtin index: {error}"))?;

    let mut generated = String::from(
        "pub(crate) const INDEX_JSON: &str = include_str!(concat!(env!(\"OUT_DIR\"), \"/builtin-plugin-bundle/index.json\"));\n\
         pub(crate) const ARTIFACTS: &[(&str, &[u8])] = &[\n",
    );
    for artifact in &index.artifacts {
        writeln!(
            generated,
            "    ({:?}, include_bytes!(concat!(env!(\"OUT_DIR\"), {:?})) as &[u8]),",
            artifact.artifact_file,
            format!("/builtin-plugin-bundle/{}", artifact.artifact_file),
        )
        .map_err(|error| format!("generate builtin Rust module: {error}"))?;
    }
    generated.push_str("];\n");
    fs::write(output_root.join("builtin_plugin_bundle.rs"), generated)
        .map_err(|error| format!("write builtin Rust module: {error}"))?;
    Ok(())
}

fn emit_rerun_paths(path: &Path) -> Result<(), String> {
    println!("cargo:rerun-if-changed={}", path.display());
    if !path.is_dir() {
        return Err(format!(
            "builtin plugin source is missing: {}",
            path.display()
        ));
    }
    let mut entries = fs::read_dir(path)
        .map_err(|error| format!("read {}: {error}", path.display()))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("read {}: {error}", path.display()))?;
    entries.sort_by_key(|entry| entry.file_name());
    for entry in entries {
        let child = entry.path();
        if child.is_dir() {
            emit_rerun_paths(&child)?;
        } else {
            println!("cargo:rerun-if-changed={}", child.display());
        }
    }
    Ok(())
}
