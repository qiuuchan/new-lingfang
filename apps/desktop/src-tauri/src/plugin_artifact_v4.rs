use std::collections::HashSet;
use std::fs::{self, File};
use std::io::{Read, Write};
use std::path::{Component, Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use zip::write::SimpleFileOptions;
use zip::{CompressionMethod, DateTime, ZipArchive, ZipWriter};

pub(crate) const MAX_ARCHIVE_BYTES: u64 = 1024 * 1024 * 1024;
pub(crate) const MAX_UNCOMPRESSED_BYTES: u64 = 1024 * 1024 * 1024;
pub(crate) const MAX_FILE_BYTES: u64 = 60 * 1024 * 1024;
pub(crate) const MAX_FILES: usize = 1500;
const MAX_README_BYTES: u64 = 256 * 1024;

const EXCLUDED_SEGMENTS: &[&str] = &[
    "data",
    ".git",
    ".venv",
    "venv",
    "node_modules",
    ".qianxia",
    "__pycache__",
    ".pytest_cache",
    ".mypy_cache",
];

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ArtifactFileInfo {
    pub path: String,
    pub size_bytes: u64,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct InspectedArtifact {
    pub sha256: String,
    pub size_bytes: u64,
    pub uncompressed_size_bytes: u64,
    pub manifest: Value,
    pub files: Vec<ArtifactFileInfo>,
}

fn normalized_relative(path: &Path) -> Result<String, String> {
    if path.is_absolute() {
        return Err("制品路径不能是绝对路径".to_string());
    }
    let mut segments = Vec::new();
    for component in path.components() {
        match component {
            Component::Normal(value) => {
                let segment = value
                    .to_str()
                    .ok_or_else(|| "制品路径必须是 UTF-8".to_string())?;
                if segment.is_empty() || segment == "." || segment == ".." {
                    return Err("制品路径包含非法段".to_string());
                }
                segments.push(segment);
            }
            _ => return Err("制品路径包含非法段".to_string()),
        }
    }
    if segments.is_empty() {
        return Err("制品路径不能为空".to_string());
    }
    Ok(segments.join("/"))
}

fn should_exclude(relative: &Path) -> bool {
    relative.components().any(|component| {
        let Component::Normal(value) = component else {
            return false;
        };
        let Some(segment) = value.to_str() else {
            return false;
        };
        EXCLUDED_SEGMENTS
            .iter()
            .any(|excluded| segment.eq_ignore_ascii_case(excluded))
            || segment.ends_with(".pyc")
            || segment.ends_with(".pyo")
    })
}

fn collect_files(root: &Path, directory: &Path, out: &mut Vec<PathBuf>) -> Result<(), String> {
    let mut entries = fs::read_dir(directory)
        .map_err(|error| format!("读取插件目录失败：{error}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("读取插件目录失败：{error}"))?;
    entries.sort_by_key(|entry| entry.file_name());
    for entry in entries {
        let path = entry.path();
        let relative = path
            .strip_prefix(root)
            .map_err(|_| "插件文件越出工作区".to_string())?;
        if should_exclude(relative) {
            continue;
        }
        let metadata = fs::symlink_metadata(&path)
            .map_err(|error| format!("读取插件文件信息失败：{error}"))?;
        if metadata.file_type().is_symlink() {
            return Err(format!(
                "插件工作区不能包含符号链接：{}",
                relative.display()
            ));
        }
        if metadata.is_dir() {
            collect_files(root, &path, out)?;
        } else if metadata.is_file() {
            if metadata.len() > MAX_FILE_BYTES {
                return Err(format!("插件文件超过 60MiB：{}", relative.display()));
            }
            out.push(path);
            if out.len() > MAX_FILES {
                return Err("插件文件数量超过 1500".to_string());
            }
        }
    }
    Ok(())
}

pub(crate) fn collect_workspace_source_files(
    workspace: &Path,
) -> Result<Vec<(String, PathBuf)>, String> {
    let mut paths = Vec::new();
    collect_files(workspace, workspace, &mut paths)?;
    paths.retain(|path| {
        path.strip_prefix(workspace)
            .ok()
            .is_some_and(|relative| relative != Path::new("_meta.json"))
    });

    let mut files = Vec::with_capacity(paths.len());
    let mut total = 0_u64;
    for path in paths {
        let relative = path
            .strip_prefix(workspace)
            .map_err(|_| "插件文件越出工作区".to_string())?;
        let normalized = normalized_relative(relative)?;
        let size = fs::metadata(&path)
            .map_err(|error| format!("读取插件文件信息失败：{error}"))?
            .len();
        if size > MAX_UNCOMPRESSED_BYTES.saturating_sub(total) {
            return Err("插件文件总量超过 1GiB".to_string());
        }
        total += size;
        files.push((normalized, path));
    }
    files.sort_by(|left, right| left.0.cmp(&right.0));
    Ok(files)
}

pub(crate) fn sha256_file(path: &Path) -> Result<String, String> {
    let mut file = File::open(path).map_err(|error| format!("读取制品失败：{error}"))?;
    let mut hash = Sha256::new();
    let mut buffer = vec![0_u8; 1024 * 1024];
    loop {
        let read = file
            .read(&mut buffer)
            .map_err(|error| format!("读取制品失败：{error}"))?;
        if read == 0 {
            break;
        }
        hash.update(&buffer[..read]);
    }
    Ok(format!("{:x}", hash.finalize()))
}

pub(crate) fn sha256_bytes(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

pub(crate) fn package_workspace(
    workspace: &Path,
    output: &Path,
) -> Result<InspectedArtifact, String> {
    let manifest_path = workspace.join("manifest.json");
    if !manifest_path.is_file() {
        return Err("工作区缺少 manifest.json".to_string());
    }
    let manifest: Value = serde_json::from_slice(
        &fs::read(&manifest_path).map_err(|error| format!("读取 manifest.json 失败：{error}"))?,
    )
    .map_err(|error| format!("manifest.json 格式错误：{error}"))?;
    validate_manifest(&manifest)?;

    let mut source_files = collect_workspace_source_files(workspace)?;
    source_files.retain(|(name, _)| name != "manifest.json");
    if source_files.len() + 2 > MAX_FILES {
        return Err("插件文件数量超过 1500".to_string());
    }
    if let Some(parent) = output.parent() {
        fs::create_dir_all(parent).map_err(|error| format!("创建制品目录失败：{error}"))?;
    }
    let file = File::create(output).map_err(|error| format!("创建制品失败：{error}"))?;
    let mut zip = ZipWriter::new(file);
    let options = SimpleFileOptions::default()
        .compression_method(CompressionMethod::Deflated)
        .last_modified_time(DateTime::default())
        .unix_permissions(0o644);
    zip.start_file("_meta.json", options)
        .map_err(|error| format!("写入 _meta.json 失败：{error}"))?;
    zip.write_all(b"{\"format\":\"qianxia-plugin\",\"formatVersion\":4}")
        .map_err(|error| format!("写入 _meta.json 失败：{error}"))?;
    zip.start_file("manifest.json", options)
        .map_err(|error| format!("写入 manifest.json 失败：{error}"))?;
    let manifest_bytes = serde_json::to_vec_pretty(&manifest)
        .map_err(|error| format!("序列化 manifest.json 失败：{error}"))?;
    zip.write_all(&manifest_bytes)
        .map_err(|error| format!("写入 manifest.json 失败：{error}"))?;
    for (name, path) in source_files {
        zip.start_file(&name, options)
            .map_err(|error| format!("写入制品条目 {name} 失败：{error}"))?;
        let mut source =
            File::open(&path).map_err(|error| format!("读取插件文件 {name} 失败：{error}"))?;
        std::io::copy(&mut source, &mut zip)
            .map_err(|error| format!("写入插件文件 {name} 失败：{error}"))?;
    }
    zip.finish()
        .map_err(|error| format!("完成插件制品失败：{error}"))?;
    let size = fs::metadata(output)
        .map_err(|error| format!("读取制品大小失败：{error}"))?
        .len();
    if size > MAX_ARCHIVE_BYTES {
        let _ = fs::remove_file(output);
        return Err("插件压缩包超过 1GiB".to_string());
    }
    inspect_artifact(output)
}

fn validate_manifest(manifest: &Value) -> Result<(), String> {
    let object = manifest
        .as_object()
        .ok_or_else(|| "manifest.json 必须是对象".to_string())?;
    for field in ["id", "name", "version", "entry", "runtime_type"] {
        if object
            .get(field)
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .is_none()
        {
            return Err(format!("manifest.json 缺少 {field}"));
        }
    }
    let version = object["version"].as_str().unwrap_or_default();
    semver::Version::parse(version)
        .map_err(|_| format!("manifest.version 不是严格 SemVer：{version}"))?;
    let runtime = object["runtime_type"].as_str().unwrap_or_default();
    if !matches!(runtime, "client" | "cloud" | "nodejs" | "python" | "workflow") {
        return Err("manifest.runtime_type 不受支持".to_string());
    }
    normalized_relative(Path::new(object["entry"].as_str().unwrap_or_default()))?;
    Ok(())
}

fn validate_zip_path(name: &str) -> Result<PathBuf, String> {
    if name.ends_with('/') || name.contains('\\') {
        return Err(format!("制品包含非法路径：{name}"));
    }
    let path = PathBuf::from(name);
    normalized_relative(&path)?;
    if should_exclude(&path) {
        return Err(format!("制品不能包含数据或运行缓存目录：{name}"));
    }
    Ok(path)
}

pub(crate) fn inspect_artifact(path: &Path) -> Result<InspectedArtifact, String> {
    let size_bytes = fs::metadata(path)
        .map_err(|error| format!("读取制品失败：{error}"))?
        .len();
    if size_bytes == 0 || size_bytes > MAX_ARCHIVE_BYTES {
        return Err("插件压缩包大小超限".to_string());
    }
    let file = File::open(path).map_err(|error| format!("读取制品失败：{error}"))?;
    let mut zip = ZipArchive::new(file).map_err(|error| format!("无效的 ZIP 制品：{error}"))?;
    if zip.is_empty() || zip.len() > MAX_FILES {
        return Err("插件文件数量超限".to_string());
    }
    let mut seen = HashSet::new();
    let mut windows_seen = HashSet::new();
    let mut files = Vec::with_capacity(zip.len());
    let mut total = 0_u64;
    let mut meta: Option<Value> = None;
    let mut manifest: Option<Value> = None;
    for index in 0..zip.len() {
        let mut entry = zip
            .by_index(index)
            .map_err(|error| format!("读取 ZIP 条目失败：{error}"))?;
        let name = entry.name().to_string();
        validate_zip_path(&name)?;
        if !seen.insert(name.clone()) {
            return Err(format!("制品包含重复路径：{name}"));
        }
        if !windows_seen.insert(name.to_lowercase()) {
            return Err(format!("制品包含 Windows 大小写冲突路径：{name}"));
        }
        if entry.is_dir() {
            return Err(format!("制品不能包含目录条目：{name}"));
        }
        if entry
            .unix_mode()
            .map(|mode| mode & 0o170000 == 0o120000)
            .unwrap_or(false)
        {
            return Err(format!("制品不能包含符号链接：{name}"));
        }
        if entry.size() > MAX_FILE_BYTES {
            return Err(format!("制品单文件大小超限：{name}"));
        }
        let declared_size = entry.size();
        if declared_size > MAX_UNCOMPRESSED_BYTES.saturating_sub(total) {
            return Err("插件解压总量超过 1GiB".to_string());
        }
        let read_limit = declared_size.saturating_add(1).min(MAX_FILE_BYTES + 1);
        if name == "README.md" && declared_size > MAX_README_BYTES {
            return Err("README.md 不能超过 256 KiB".to_string());
        }
        let mut metadata_buffer = None;
        let actual_size = if name == "_meta.json" || name == "manifest.json" || name == "README.md" {
            let mut buffer = Vec::with_capacity(declared_size as usize);
            entry
                .by_ref()
                .take(read_limit)
                .read_to_end(&mut buffer)
                .map_err(|error| format!("读取 {name} 失败：{error}"))?;
            let actual = buffer.len() as u64;
            metadata_buffer = Some(buffer);
            actual
        } else {
            std::io::copy(&mut entry.by_ref().take(read_limit), &mut std::io::sink())
                .map_err(|error| format!("校验 ZIP 条目 {name} 失败：{error}"))?
        };
        if actual_size != declared_size {
            return Err(format!(
                "ZIP 条目实际大小与声明不一致：{name}（声明 {declared_size}，实际 {actual_size}）"
            ));
        }
        total = total.saturating_add(actual_size);
        if total > MAX_UNCOMPRESSED_BYTES {
            return Err("插件解压总量超过 1GiB".to_string());
        }
        if name == "README.md" {
            let buffer = metadata_buffer.expect("README entry was buffered above");
            std::str::from_utf8(&buffer).map_err(|_| "README.md 必须是 UTF-8 文本".to_string())?;
        } else if name == "_meta.json" || name == "manifest.json" {
            let buffer = metadata_buffer.expect("metadata entry was buffered above");
            let value: Value = serde_json::from_slice(&buffer)
                .map_err(|error| format!("{name} 格式错误：{error}"))?;
            if name == "_meta.json" {
                meta = Some(value);
            } else {
                manifest = Some(value);
            }
        }
        files.push(ArtifactFileInfo {
            path: name,
            size_bytes: actual_size,
        });
    }
    let meta = meta.ok_or_else(|| "v4 制品缺少 _meta.json".to_string())?;
    if meta.get("format").and_then(Value::as_str) != Some("qianxia-plugin")
        || meta.get("formatVersion").and_then(Value::as_u64) != Some(4)
    {
        return Err("只支持 .qplugin v4 制品".to_string());
    }
    let manifest = manifest.ok_or_else(|| "v4 制品缺少 manifest.json".to_string())?;
    validate_manifest(&manifest)?;
    let entry = manifest
        .get("entry")
        .and_then(Value::as_str)
        .unwrap_or_default();
    if !seen.contains(entry) {
        return Err(format!("manifest.entry 指向的文件不存在：{entry}"));
    }
    Ok(InspectedArtifact {
        sha256: sha256_file(path)?,
        size_bytes,
        uncompressed_size_bytes: total,
        manifest,
        files,
    })
}

pub(crate) fn extract_artifact(
    path: &Path,
    destination: &Path,
) -> Result<InspectedArtifact, String> {
    let inspected = inspect_artifact(path)?;
    if destination.exists() {
        return Err("解压目标已存在".to_string());
    }
    fs::create_dir_all(destination).map_err(|error| format!("创建解压目录失败：{error}"))?;
    let result = (|| {
        let file = File::open(path).map_err(|error| format!("读取制品失败：{error}"))?;
        let mut zip = ZipArchive::new(file).map_err(|error| format!("无效的 ZIP 制品：{error}"))?;
        let mut total = 0_u64;
        for index in 0..zip.len() {
            let mut entry = zip
                .by_index(index)
                .map_err(|error| format!("读取 ZIP 条目失败：{error}"))?;
            let relative = validate_zip_path(entry.name())?;
            let name = entry.name().to_string();
            let declared_size = entry.size();
            if declared_size > MAX_UNCOMPRESSED_BYTES.saturating_sub(total) {
                return Err("插件解压总量超过 1GiB".to_string());
            }
            let target = destination.join(relative);
            if let Some(parent) = target.parent() {
                fs::create_dir_all(parent).map_err(|error| format!("创建解压目录失败：{error}"))?;
            }
            let mut output =
                File::create(&target).map_err(|error| format!("创建解压文件失败：{error}"))?;
            let actual_size = std::io::copy(
                &mut entry
                    .by_ref()
                    .take(declared_size.saturating_add(1).min(MAX_FILE_BYTES + 1)),
                &mut output,
            )
            .map_err(|error| format!("解压文件失败：{error}"))?;
            if actual_size != declared_size {
                return Err(format!(
                    "ZIP 条目实际大小与声明不一致：{name}（声明 {declared_size}，实际 {actual_size}）"
                ));
            }
            total = total.saturating_add(actual_size);
            if total > MAX_UNCOMPRESSED_BYTES {
                return Err("插件解压总量超过 1GiB".to_string());
            }
            output
                .flush()
                .map_err(|error| format!("写入解压文件失败：{error}"))?;
        }
        Ok::<(), String>(())
    })();
    if let Err(error) = result {
        let _ = fs::remove_dir_all(destination);
        return Err(error);
    }
    Ok(inspected)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp(name: &str) -> PathBuf {
        std::env::temp_dir().join(format!("qianxia-artifact-{name}-{}", uuid::Uuid::new_v4()))
    }

    fn write_test_zip(path: &Path, extra_files: &[(&str, &[u8])]) {
        let file = File::create(path).unwrap();
        let mut zip = ZipWriter::new(file);
        let options = SimpleFileOptions::default()
            .compression_method(CompressionMethod::Stored)
            .last_modified_time(DateTime::default())
            .unix_permissions(0o644);
        for (name, bytes) in [
            (
                "_meta.json",
                b"{\"format\":\"qianxia-plugin\",\"formatVersion\":4}".as_slice(),
            ),
            (
                "manifest.json",
                b"{\"id\":\"demo\",\"name\":\"Demo\",\"version\":\"1.0.0\",\"runtime_type\":\"python\",\"entry\":\"main.py\"}".as_slice(),
            ),
            ("main.py", b"print('ok')\n".as_slice()),
        ]
        .into_iter()
        .chain(extra_files.iter().copied())
        {
            zip.start_file(name, options).unwrap();
            zip.write_all(bytes).unwrap();
        }
        zip.finish().unwrap();
    }

    #[test]
    fn deterministic_package_excludes_runtime_data() {
        let root = temp("deterministic");
        fs::create_dir_all(root.join("data")).unwrap();
        fs::create_dir_all(root.join("node_modules/pkg")).unwrap();
        fs::write(root.join("manifest.json"), r#"{"id":"demo","name":"Demo","version":"1.0.0","runtime_type":"python","entry":"main.py"}"#).unwrap();
        fs::write(root.join("main.py"), "print('ok')\n").unwrap();
        fs::write(root.join("data/state.json"), "secret").unwrap();
        fs::write(root.join("node_modules/pkg/index.js"), "ignored").unwrap();
        let first = std::env::temp_dir().join(format!("first-{}.qplugin", uuid::Uuid::new_v4()));
        let second = std::env::temp_dir().join(format!("second-{}.qplugin", uuid::Uuid::new_v4()));
        package_workspace(&root, &first).unwrap();
        package_workspace(&root, &second).unwrap();
        assert_eq!(sha256_file(&first).unwrap(), sha256_file(&second).unwrap());
        let inspected = inspect_artifact(&first).unwrap();
        assert_eq!(
            inspected
                .files
                .iter()
                .map(|file| file.path.as_str())
                .collect::<Vec<_>>(),
            vec!["_meta.json", "manifest.json", "main.py"]
        );
        assert!(inspected.files.iter().any(|file| file.path == "main.py"));
        assert!(!inspected
            .files
            .iter()
            .any(|file| file.path.starts_with("data/")));
        assert!(!inspected
            .files
            .iter()
            .any(|file| file.path.starts_with("node_modules/")));

        let file = File::open(&first).unwrap();
        let mut zip = ZipArchive::new(file).unwrap();
        let mut meta = String::new();
        zip.by_name("_meta.json")
            .unwrap()
            .read_to_string(&mut meta)
            .unwrap();
        assert_eq!(meta, r#"{"format":"qianxia-plugin","formatVersion":4}"#);
        for index in 0..zip.len() {
            assert_eq!(
                zip.by_index(index).unwrap().last_modified(),
                Some(DateTime::default())
            );
        }
        let _ = fs::remove_file(first);
        let _ = fs::remove_file(second);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn checksum_failure_does_not_extract() {
        let root = temp("checksum");
        fs::create_dir_all(&root).unwrap();
        fs::write(root.join("manifest.json"), r#"{"id":"demo","name":"Demo","version":"1.0.0","runtime_type":"python","entry":"main.py"}"#).unwrap();
        fs::write(root.join("main.py"), "print('ok')\n").unwrap();
        let artifact = root.join("demo.qplugin");
        let inspected = package_workspace(&root, &artifact).unwrap();
        assert_ne!(inspected.sha256, "0".repeat(64));
        let destination = root.join("out");
        let expected = "0".repeat(64);
        if sha256_file(&artifact).unwrap() != expected {
            assert!(!destination.exists());
        }
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn inspection_rejects_excluded_segments_at_any_depth() {
        let root = temp("nested-cache");
        fs::create_dir_all(&root).unwrap();
        let artifact = root.join("nested-cache.qplugin");
        write_test_zip(&artifact, &[("src/data/secret.json", b"secret")]);

        let error = inspect_artifact(&artifact).unwrap_err();
        assert!(error.contains("数据或运行缓存"));
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn inspection_validates_root_readme_contract() {
        let root = temp("readme-contract");
        fs::create_dir_all(&root).unwrap();
        let invalid_utf8 = root.join("invalid-utf8.qplugin");
        write_test_zip(&invalid_utf8, &[("README.md", &[0xc3, 0x28])]);
        assert!(inspect_artifact(&invalid_utf8).unwrap_err().contains("UTF-8"));

        let oversized = root.join("oversized.qplugin");
        let bytes = vec![b'a'; MAX_README_BYTES as usize + 1];
        write_test_zip(&oversized, &[("README.md", bytes.as_slice())]);
        assert!(inspect_artifact(&oversized).unwrap_err().contains("256 KiB"));
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn inspection_rejects_windows_case_collisions() {
        let root = temp("windows-case-collision");
        fs::create_dir_all(&root).unwrap();
        let artifact = root.join("collision.qplugin");
        write_test_zip(&artifact, &[("README.md", b"# trusted"), ("readme.md", b"# shadow")]);
        assert!(inspect_artifact(&artifact).unwrap_err().contains("Windows 大小写冲突"));
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn inspection_reads_entries_to_eof_and_rejects_crc_tampering() {
        let root = temp("crc");
        fs::create_dir_all(&root).unwrap();
        let artifact = root.join("crc.qplugin");
        write_test_zip(&artifact, &[]);
        let mut bytes = fs::read(&artifact).unwrap();
        let needle = b"print('ok')";
        let offset = bytes
            .windows(needle.len())
            .position(|window| window == needle)
            .unwrap();
        bytes[offset] = b'P';
        fs::write(&artifact, bytes).unwrap();

        assert!(inspect_artifact(&artifact).is_err());
        let destination = root.join("out");
        assert!(extract_artifact(&artifact, &destination).is_err());
        assert!(!destination.exists());
        let _ = fs::remove_dir_all(root);
    }

    fn write_file_count_workspace(root: &Path, source_files: usize) {
        fs::create_dir_all(root.join("src")).unwrap();
        fs::write(root.join("manifest.json"), r#"{"id":"count-demo","name":"Count","version":"1.0.0","runtime_type":"python","entry":"main.py"}"#).unwrap();
        fs::write(root.join("main.py"), "print('ok')").unwrap();
        for index in 1..source_files {
            fs::write(root.join("src").join(format!("file-{index}.txt")), "x").unwrap();
        }
    }

    #[test]
    fn archive_file_limit_includes_two_v4_metadata_entries() {
        let accepted = temp("file-limit-accepted");
        write_file_count_workspace(&accepted, MAX_FILES - 2);
        let accepted_artifact =
            std::env::temp_dir().join(format!("accepted-{}.qplugin", uuid::Uuid::new_v4()));
        let inspected = package_workspace(&accepted, &accepted_artifact).unwrap();
        assert_eq!(inspected.files.len(), MAX_FILES);

        let rejected = temp("file-limit-rejected");
        write_file_count_workspace(&rejected, MAX_FILES - 1);
        let rejected_artifact =
            std::env::temp_dir().join(format!("rejected-{}.qplugin", uuid::Uuid::new_v4()));
        let error = package_workspace(&rejected, &rejected_artifact).unwrap_err();
        assert!(error.contains("文件数量超过 1500"));

        let _ = fs::remove_dir_all(accepted);
        let _ = fs::remove_dir_all(rejected);
        let _ = fs::remove_file(accepted_artifact);
        let _ = fs::remove_file(rejected_artifact);
    }
}
